/**
 * POST /api/webhooks/website-lead — website (Manus) → CRM lead intake.
 *
 * Reached at that URL through a vercel.json rewrite onto
 * /api/property-public?action=website-lead. It is not its own api/*.js file
 * because Vercel makes one serverless function per file under api/ and CI fails
 * the build above 12 (the Hobby ceiling) — the same reason api/cron.js hosts
 * seven tasks and api/portal.js hosts the authenticated portal endpoints.
 *
 * ── REQUEST ─────────────────────────────────────────────────────────────────
 *   POST /api/webhooks/website-lead
 *   Content-Type:      application/json
 *   x-gateway-secret:  <WEBSITE_LEAD_WEBHOOK_SECRET>
 *
 *   { "name": "Jane Smith",
 *     "email": "jane@example.com",
 *     "phone": "712-555-0142",
 *     "interest_type": "residential" | "commercial" | "both",
 *     "viewed_properties": ["https://site.com/listing/<uuid>", "123 Main St"],
 *     "message": "optional",
 *     "event_id": "optional — the sender's own id, used for idempotency" }
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────
 *   1. Authenticates the sender against a shared secret (timing-safe).
 *   2. Records the lead FIRST, claiming the dedupe key. Nothing else can run
 *      twice for one delivery.
 *   3. Assigns an owner: the contact's existing agent if the CRM already knows
 *      them, otherwise one atomic round-robin step (migrations/0037).
 *   4. Creates or matches the contact, links the viewed properties, logs the
 *      timeline activity, hands off to the drip.
 *   5. Notifies the agent — bell + email.
 *
 * ── STATUS CODES, AND WHY ───────────────────────────────────────────────────
 * A webhook sender retries on 5xx and gives up on 4xx, so the codes are part of
 * the contract:
 *   400 malformed payload      — retrying will not fix it
 *   401 bad/absent secret      — ditto
 *   413 payload too large      — ditto
 *   500 server misconfigured / the lead insert itself failed — DO retry
 *   200 the lead is stored. Everything after the lead row is best effort and
 *       reported per field in the response; a failed email is not a failed
 *       delivery, and answering 5xx over one would make the sender replay a
 *       lead that is already in the CRM.
 */
import crypto from 'node:crypto'

import {
  serviceCreds, insertRow, patchRow, rest,
  clean, normalizeEmail, normalizePhone, normalizeInterest,
  normalizeViewedProperties, matchViewedProperties,
  findContactByEmail, createContact, assignAgents, enrollInDrip,
  MAX_VIEWED_PROPERTIES,
} from '../_lib/leadIntake.js'
import { notifyAgentOfLead } from '../_lib/leadNotify.js'

// A lead payload is a handful of short strings and at most 25 URLs. Anything
// past this is a mistake or an attack, and rejecting it early keeps a hostile
// body out of raw_payload and out of the function's memory.
const MAX_BODY_BYTES = 64 * 1024

// Retries of the same inquiry collapse into one lead; a genuine second inquiry
// an hour later is a new lead. Only used when the sender provides no event id.
const DEDUPE_WINDOW_MS = 10 * 60 * 1000

/**
 * Constant-time secret comparison.
 *
 * There is deliberately no HMAC-over-raw-body option here: this handler is
 * co-hosted with api/property-public.js, whose other actions rely on Vercel's
 * body parser, so the exact received bytes are not recoverable and any
 * signature would have to be computed over a re-serialization — which differs
 * from what the sender signed on key order and number formatting alone. A
 * rotatable shared secret over TLS is the control. Rotate it by changing
 * WEBSITE_LEAD_WEBHOOK_SECRET in Vercel and in the Manus site's webhook config.
 */
function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || !provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length — hash both sides to a fixed width first.
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

/**
 * Stable key for one logical submission. The sender's own event id when it
 * offers one; otherwise a hash of the identity of the inquiry plus a coarse
 * time bucket, which is what makes a double-clicked form or an at-least-once
 * retry idempotent without making every future inquiry a duplicate.
 */
function dedupeKey({ eventId, email, interestType, views }) {
  if (eventId) return `evt:${eventId}`.slice(0, 200)
  const bucket = Math.floor(Date.now() / DEDUPE_WINDOW_MS)
  const shape  = JSON.stringify([
    email, interestType, bucket,
    views.map(v => v.url || v.title),
  ])
  return `auto:${crypto.createHash('sha256').update(shape).digest('hex').slice(0, 40)}`
}

/** Only the fields worth keeping, so raw_payload cannot become a dumping ground. */
function trimmedPayload(body) {
  const keep = [
    'name', 'first_name', 'last_name', 'email', 'phone', 'interest_type',
    'viewed_properties', 'message', 'source', 'source_detail', 'event_id',
    'utm_source', 'utm_medium', 'utm_campaign', 'page_url', 'session_key',
  ]
  const out = {}
  for (const k of keep) if (body[k] !== undefined) out[k] = body[k]
  return out
}

export default async function handleWebsiteLead(req, res) {
  // Server-to-server only. No CORS headers, on purpose: an endpoint a browser
  // could call would need the shared secret in page source, and the whole
  // rotation would be forgeable by anyone who viewed source. The legacy
  // browser-callable form lives on at POST /api/property-public.
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, error: 'Method not allowed' })
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  // Fails CLOSED when no secret is configured. api/_lib/middleware.js skips the
  // check when GATEWAY_SECRET is unset, which is tolerable for an endpoint
  // behind a login and not for a public write endpoint that assigns leads.
  const expected = process.env.WEBSITE_LEAD_WEBHOOK_SECRET || process.env.GATEWAY_SECRET
  if (!expected) {
    console.error('[website-lead] WEBSITE_LEAD_WEBHOOK_SECRET is not configured; refusing all deliveries')
    return res.status(500).json({ ok: false, error: 'Webhook not configured' })
  }
  if (!secretMatches(req.headers['x-gateway-secret'], expected)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }

  const declaredLength = Number(req.headers['content-length'] || 0)
  if (declaredLength > MAX_BODY_BYTES) {
    return res.status(413).json({ ok: false, error: 'Payload too large' })
  }

  // ── Validate ──────────────────────────────────────────────────────────────
  const body = req.body && typeof req.body === 'object' ? req.body : null
  if (!body) {
    return res.status(400).json({ ok: false, error: 'A JSON object body is required' })
  }
  if (JSON.stringify(body).length > MAX_BODY_BYTES) {
    return res.status(413).json({ ok: false, error: 'Payload too large' })
  }

  const name = clean(body.name, 200)
    || [clean(body.first_name, 100), clean(body.last_name, 100)].filter(Boolean).join(' ')
    || null
  const email = normalizeEmail(body.email)

  const problems = []
  if (!name)  problems.push('name is required')
  if (!email) problems.push('a valid email is required')
  if (body.viewed_properties !== undefined && !Array.isArray(body.viewed_properties)) {
    problems.push('viewed_properties must be an array')
  }
  if (problems.length) {
    return res.status(400).json({ ok: false, error: problems.join('; ') })
  }

  const phone        = normalizePhone(body.phone)
  const interestType = normalizeInterest(body.interest_type)
  const message      = clean(body.message, 2000)
  const views        = normalizeViewedProperties(body.viewed_properties)
  const sourceDetail = clean(body.source_detail, 120)
    || clean(body.source, 120)
    || clean(body.utm_source, 120)
    || 'manus-website'

  const creds = serviceCreds()
  if (!creds) {
    console.error('[website-lead] SUPABASE_URL / SUPABASE_SERVICE_KEY missing')
    return res.status(500).json({ ok: false, error: 'Server configuration error' })
  }

  const key = dedupeKey({
    eventId: clean(body.event_id, 150), email, interestType, views,
  })

  // ── 1. The lead row, before anything else ────────────────────────────────
  // Written first and unassigned, so the unique index on dedupe_key is what
  // decides whether this delivery is new. A retry loses the race here and never
  // reaches the rotation, so it cannot burn an agent's turn or send a second
  // email — the ordering IS the idempotency mechanism.
  const created = await insertRow(creds, 'leads', {
    name, email, phone,
    interest_type: interestType,
    message,
    source:        'website',
    source_detail: sourceDetail,
    raw_payload:   trimmedPayload(body),
    dedupe_key:    key,
    status:        'new',
    drip_status:   'pending',
  })

  if (created.conflict) {
    const [prior] = await rest(
      creds,
      `leads?dedupe_key=eq.${encodeURIComponent(key)}` +
      `&select=id,contact_id,assigned_agent_id,secondary_agent_id,lane&limit=1`
    )
    return res.status(200).json({
      ok: true, deduped: true,
      lead_id:            prior?.id ?? null,
      contact_id:         prior?.contact_id ?? null,
      assigned_agent_id:  prior?.assigned_agent_id ?? null,
      secondary_agent_id: prior?.secondary_agent_id ?? null,
      lane:               prior?.lane ?? null,
    })
  }

  if (created.error || !created.row?.id) {
    // The only genuine 5xx: the lead is NOT stored, so the sender should retry.
    console.error('[website-lead] lead insert failed:', created.error)
    return res.status(500).json({ ok: false, error: 'Failed to record lead' })
  }

  const leadId = created.row.id

  // Everything below is best effort. Each step reports into `result`; none of
  // them can turn a stored lead into a failed delivery.
  const result = {
    ok: true, deduped: false, lead_id: leadId,
    interest_type: interestType,
    contact_id: null, contact_created: false,
    assigned_agent_id: null, secondary_agent_id: null, lane: null,
    assignment: null, properties_linked: 0, properties_matched: 0,
    drip_status: 'pending', notified: {},
  }

  try {
    // ── 2. Who owns it ─────────────────────────────────────────────────────
    const existingContact = await findContactByEmail(creds, email)

    let primaryAgentId   = null
    let secondaryAgentId = null
    let lane             = interestType === 'both' ? null : interestType
    let degraded         = false

    if (existingContact?.assigned_agent_id) {
      // The CRM already knows this person and someone is working them. Their
      // agent keeps them, the rotation is not touched at all, and no
      // cross-specialty courtesy is sent — an established relationship should
      // not suddenly gain a second agent.
      primaryAgentId    = existingContact.assigned_agent_id
      result.assignment = 'existing_contact_owner'
    } else {
      const assigned = await assignAgents(creds, interestType)
      primaryAgentId   = assigned.primary?.agentId ?? null
      secondaryAgentId = assigned.secondary?.agentId ?? null
      lane             = assigned.lane ?? lane
      degraded         = assigned.degraded
      result.assignment = primaryAgentId
        ? (degraded ? 'round_robin_legacy' : 'round_robin')
        : 'unassigned'
      if (!primaryAgentId) {
        // Nobody is in either rotation. The lead is already saved; an
        // unassigned lead an admin can claim beats a 500 and a lost inquiry.
        console.error('[website-lead] no agent in either rotation — lead %s is unassigned', leadId)
      }
      if (degraded) {
        console.warn('[website-lead] assign_lead_round_robin missing — using the racy legacy picker. Apply migrations/0037.')
      }
    }

    result.assigned_agent_id  = primaryAgentId
    result.secondary_agent_id = secondaryAgentId
    result.lane               = lane

    // ── 3. Contact ─────────────────────────────────────────────────────────
    let contactId = existingContact?.id ?? null
    if (contactId) {
      // Keep the contact reachable if the website supplied a phone number the
      // CRM was missing. Never overwrites a number already on file.
      if (phone) {
        await patchRow(creds, 'contacts', `id=eq.${contactId}&phone=is.null`, { phone })
      }
    } else {
      const c = await createContact(creds, {
        name, email, phone, interestType, message, agentId: primaryAgentId,
      })
      contactId = c.contactId
      result.contact_created = Boolean(c.contactId)
      if (c.error) console.error('[website-lead] contact insert failed:', c.error)
    }
    result.contact_id = contactId

    // ── 4. Viewed properties ───────────────────────────────────────────────
    let linkedViews = []
    if (views.length) {
      linkedViews = await matchViewedProperties(creds, views)
      const { error } = await insertRow(
        creds,
        'lead_property_views',
        linkedViews.map(v => ({
          lead_id:     leadId,
          property_id: v.property_id ?? null,
          url:         v.url,
          title:       v.title,
          position:    v.position,
          viewed_at:   v.viewed_at,
        })),
        { returning: false }
      )
      if (error) {
        console.error('[website-lead] property views insert failed:', error)
      } else {
        result.properties_linked  = linkedViews.length
        result.properties_matched = linkedViews.filter(v => v.property_id).length
      }
    }

    // ── 5. Drip hand-off ───────────────────────────────────────────────────
    const drip = await enrollInDrip(creds, {
      contactId, lane: lane || 'residential', agentId: primaryAgentId,
    })
    result.drip_status = drip.drip_status

    // ── 6. Finish the lead row ─────────────────────────────────────────────
    await patchRow(creds, 'leads', `id=eq.${leadId}`, {
      contact_id:         contactId,
      assigned_agent_id:  primaryAgentId,
      secondary_agent_id: secondaryAgentId,
      lane,
      assigned_at:        primaryAgentId ? new Date().toISOString() : null,
      drip_status:        drip.drip_status,
      drip_sequence_id:   drip.drip_sequence_id,
    })

    // ── 7. Timeline ────────────────────────────────────────────────────────
    if (contactId) {
      const viewLines = linkedViews.length
        ? `\nViewed: ${linkedViews.map(v => v.title || v.url).join(' | ')}`
        : ''
      await insertRow(creds, 'activities', {
        contact_id: contactId,
        agent_id:   primaryAgentId,
        type:       'note',
        body:       `Website lead received (${interestType})${message ? `\nMessage: ${message}` : ''}${viewLines}`,
      }, { returning: false })
    }

    // ── 8. Tell the agents ─────────────────────────────────────────────────
    const agentIds = [primaryAgentId, secondaryAgentId].filter(Boolean)
    if (agentIds.length) {
      const agents = await rest(
        creds,
        `agents?id=in.(${agentIds.join(',')})&select=id,name,email`
      )
      const byId    = new Map(agents.map(a => [a.id, a]))
      const crmUrl  = crmBaseUrl(req)
      const leadRow = {
        name, email, phone, message, lane,
        interest_type: interestType,
        contact_id:    contactId,
        source_detail: sourceDetail,
      }

      const primary = byId.get(primaryAgentId)
      if (primary) {
        result.notified.primary = await notifyAgentOfLead(creds, {
          agent: primary, lead: leadRow, views: linkedViews, role: 'owner', crmUrl,
        })
      }
      const secondary = byId.get(secondaryAgentId)
      if (secondary) {
        result.notified.secondary = await notifyAgentOfLead(creds, {
          agent: secondary, lead: leadRow, views: linkedViews,
          role: 'secondary', primaryAgentName: primary?.name || null, crmUrl,
        })
      }
    }
  } catch (err) {
    // The lead row exists, so this is still a successful delivery. Retrying
    // would only re-run the enrichment that just failed, against a dedupe key
    // that now rejects it.
    console.error('[website-lead] post-insert enrichment failed for lead %s:', leadId, err)
    result.warning = 'Lead recorded; some enrichment steps did not complete'
  }

  return res.status(200).json(result)
}

/** Absolute CRM base for the links in the email. */
function crmBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.CRM_BASE_URL
  if (configured) return configured.trim().replace(/\/+$/, '')
  const host = req.headers['x-forwarded-host'] || req.headers.host
  if (!host) return null
  return `${req.headers['x-forwarded-proto'] || 'https'}://${host}`
}

export { MAX_BODY_BYTES, MAX_VIEWED_PROPERTIES, dedupeKey }
