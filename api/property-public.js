/**
 * Gateway CRM — Public Property Endpoint
 *
 * GET  /api/property-public?id=<uuid>          — social-share HTML for a listing
 *                                                 (served at /share/:id via rewrite)
 * GET  /api/property-public?sign=<agent_uuid>  — return an HMAC signature for an
 *                                                 agent_id; admin-authed only.
 *                                                 Used by Settings to render
 *                                                 each agent's embed snippet.
 * POST /api/property-public                    — landing-page lead capture (gate).
 *                                                 If LEAD_AGENT_SECRET is set,
 *                                                 the body MUST include a valid
 *                                                 agent_id_sig when agent_id is
 *                                                 present, or agent_id is
 *                                                 ignored and round-robin picks
 *                                                 instead.
 *
 * Two public-facing property actions share one serverless function (Vercel
 * Hobby caps total functions at 12).
 */

import { createHmac, timingSafeEqual } from 'crypto'

// Sign an agent id with the server-side LEAD_AGENT_SECRET. Returned signature
// is base64url, fixed length, easy to embed in HTML attributes. Returns null
// if the secret isn't set — caller decides whether that's a soft failure or
// a hard error.
function signAgentId(agentId) {
  const secret = process.env.LEAD_AGENT_SECRET
  if (!secret || !agentId) return null
  return createHmac('sha256', secret)
    .update(String(agentId))
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Constant-time comparison. Returns true only on a non-empty exact match.
function verifyAgentIdSig(agentId, sig) {
  const expected = signAgentId(agentId)
  if (!expected || !sig) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(String(sig))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const TYPE_LABELS = {
  residential: 'Residential', rental: 'Rental', multifamily: 'Multifamily',
  office: 'Office', land: 'Land', retail: 'Retail',
  industrial: 'Industrial', 'mixed-use': 'Mixed-Use', commercial: 'Commercial',
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ── GET: social-share HTML (formerly /api/share) ─────────────────────────────
async function handleShare(req, res) {
  const id = req.query.id || req.url?.split('/').pop()?.split('?')[0]
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).send('Invalid property ID')

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co'
  const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3Z3dlbWtpaHB3bGdsaWZ0YWdnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNjkzMjAsImV4cCI6MjA5MjY0NTMyMH0.YRaCsDpExXjuPyrssFyzXP9RQktFAW7GTuEMgQq8sZU'

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/properties?id=eq.${id}&select=address,city,state,zip,type,status,list_price,beds,baths,sqft,details,notes&limit=1`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
  )
  if (!r.ok) return res.status(500).send('Database error')
  const rows = await r.json()
  if (!rows?.length) return res.status(404).send('Listing not found')

  const p          = rows[0]
  const proto      = req.headers['x-forwarded-proto'] || 'https'
  const base       = `${proto}://${req.headers.host}`
  const listingUrl = `${base}/listing/${id}`
  const heroPhoto  = (p.details?.photos || [])[0] || ''

  const title = [p.address, p.city, p.state].filter(Boolean).join(', ')
  const price = p.list_price ? `$${Number(p.list_price).toLocaleString()}` : ''
  const type  = TYPE_LABELS[p.type] || p.type || ''
  const specs = [
    type, price,
    p.beds  ? `${p.beds} bd`  : '',
    p.baths ? `${p.baths} ba` : '',
    p.sqft  ? `${Number(p.sqft).toLocaleString()} sqft` : '',
  ].filter(Boolean).join(' · ')

  const desc = p.notes
    ? `${specs} — ${p.notes.slice(0, 120)}${p.notes.length > 120 ? '…' : ''}`
    : specs

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400')

  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — Gateway Real Estate</title>
  <meta name="description" content="${esc(desc)}">

  <!-- ── Open Graph (Facebook · LinkedIn · WhatsApp · iMessage · Slack · Discord) -->
  <meta property="og:type"        content="website">
  <meta property="og:url"         content="${esc(listingUrl)}">
  <meta property="og:title"       content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:site_name"   content="Gateway Real Estate">
  ${heroPhoto ? `<meta property="og:image"        content="${esc(heroPhoto)}">
  <meta property="og:image:width"  content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt"    content="${esc(title)}">` : ''}

  <!-- ── Twitter / X Card -->
  <meta name="twitter:card"        content="${heroPhoto ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title"       content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  ${heroPhoto ? `<meta name="twitter:image" content="${esc(heroPhoto)}">` : ''}

  <!-- ── Redirect real users instantly to the full listing page -->
  <meta http-equiv="refresh" content="0;url=${esc(listingUrl)}">
  <script>window.location.replace(${JSON.stringify(listingUrl)})</script>
</head>
<body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#1e2642">
  <div style="font-size:24px;font-weight:600;margin-bottom:8px">Gateway Real Estate</div>
  <div style="font-size:16px;margin-bottom:24px">${esc(title)}</div>
  <a href="${esc(listingUrl)}" style="color:#4a6fa5">View Listing →</a>
</body>
</html>`)
}

// ── POST: landing-page / website lead capture (formerly /api/property-gate) ──
// Accepts the full lead shape (first_name/last_name OR name, agent_id,
// session_key, property_address, property_type, message). Assigns an agent
// (explicit link, else round-robin by specialty), de-dupes the contact by
// email, and logs an activity + a lead_captures record.
async function handleGate(req, res) {
  const {
    propertyId,
    name, first_name, last_name,
    email, phone,
    agent_id,            // set when the lead comes from a specific agent's page/listing
    agent_id_sig,        // HMAC of agent_id — required when LEAD_AGENT_SECRET is set
    session_key, message, property_address,
    property_type,       // 'residential' | 'commercial' — drives round-robin pool
    source_url,          // explicit landing-page URL (preferred over Referer)
    contact_type,        // 'buyer' | 'seller' — drives drip pick; defaults to buyer
  } = req.body || {}

  // Agent-pinning auth: when LEAD_AGENT_SECRET is configured, the caller must
  // accompany agent_id with a valid HMAC. A missing or wrong signature DOESN'T
  // 4xx the request — we silently fall back to round-robin so a misconfigured
  // marketing site never loses a lead. The console.warn surfaces the mismatch
  // for ops without exposing the secret to attackers probing the endpoint.
  const enforceSig = !!process.env.LEAD_AGENT_SECRET
  let trustedAgentId = null
  if (agent_id) {
    if (!enforceSig) {
      trustedAgentId = agent_id  // legacy / pre-secret behavior
    } else if (verifyAgentIdSig(agent_id, agent_id_sig)) {
      trustedAgentId = agent_id
    } else {
      console.warn('[lead intake] rejected agent_id with bad/missing signature; falling back to round-robin')
    }
  }

  // Source URL: caller-provided wins, else fall back to the Referer header
  // (which is missing in many cross-origin POSTs but is sometimes present).
  const resolvedSourceUrl =
    (typeof source_url === 'string' && source_url.trim()) ||
    (req.headers?.referer || req.headers?.referrer || null)

  // Contact type drives which of the agent's three drip slots gets used.
  // The public form is buyer-side today; commercial property → commercial.
  const resolvedContactType =
    contact_type === 'seller'  ? 'seller' :
    property_type === 'commercial' ? 'buyer'  : // commercial buyer leads → commercial drip below
    'buyer'

  const resolvedFirst = first_name?.trim() || name?.trim().split(/\s+/)[0] || ''
  const resolvedLast  = last_name?.trim()  || name?.trim().split(/\s+/).slice(1).join(' ') || '—'

  if (!resolvedFirst || !email?.trim()) {
    return res.status(400).json({ error: 'name and email are required' })
  }
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email address' })
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Server configuration error' })
  }

  const headers = {
    'Content-Type': 'application/json',
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  }

  // Lead assignment: validated agent link first, else round-robin by specialty.
  // Track HOW we picked so the audit log captures the routing decision.
  let assignedAgentId = trustedAgentId
  let routingMethod   = trustedAgentId ? 'pinned' : null
  if (!assignedAgentId) {
    assignedAgentId = await pickRoundRobinAgent(SUPABASE_URL, headers, property_type)
    routingMethod   = assignedAgentId ? 'round_robin' : 'unassigned'
  }
  const sigRejected = !!agent_id && !trustedAgentId  // request asked for a pin but we couldn't honor it

  // De-duplicate the contact by email.
  const normalEmail = email.trim().toLowerCase()
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/contacts?email=eq.${encodeURIComponent(normalEmail)}&select=id&limit=1`,
    { headers }
  )
  const existing = checkRes.ok ? await checkRes.json() : []

  let contactId
  let isNew = false

  if (existing.length > 0) {
    contactId = existing[0].id
  } else {
    const noteParts = [
      property_address ? `Interested in: ${property_address}` : '',
      message          ? `Message: ${message}`                 : '',
    ].filter(Boolean)

    const createRes = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        first_name:        resolvedFirst,
        last_name:         resolvedLast,
        email:             normalEmail,
        phone:             phone?.trim() || null,
        source:            'website',
        source_url:        resolvedSourceUrl,
        type:              'buyer',
        status:            'active',
        assigned_agent_id: assignedAgentId,
        notes:             noteParts.join('\n') || null,
      }),
    })
    if (!createRes.ok) {
      const d = await createRes.json().catch(() => ({}))
      return res.status(500).json({ error: d.message || 'Failed to create contact' })
    }
    const [created] = await createRes.json()
    contactId = created?.id
    isNew = true
  }

  // Activity note on the contact timeline.
  if (contactId) {
    const activityBody = property_address
      ? `Website lead form submitted — interested in: ${property_address}${message ? `\nMessage: ${message}` : ''}`
      : propertyId
        ? `Landing page inquiry submitted for property ID: ${propertyId}`
        : `Website lead form submitted${message ? `\nMessage: ${message}` : ''}`

    await fetch(`${SUPABASE_URL}/rest/v1/activities`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        contact_id: contactId,
        agent_id:   assignedAgentId,
        type:       'note',
        body:       activityBody,
      }),
    }).catch(() => {})
  }

  // Lead-capture record (already linked to the created/matched contact).
  // ALWAYS written: the round-robin advances by reading the latest
  // lead_captures row, so skipping this (the old session_key-only behavior)
  // froze the rotation on one agent for plain website forms.
  if (contactId) {
    await fetch(`${SUPABASE_URL}/rest/v1/lead_captures`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        session_key:          session_key || null,
        agent_id:             assignedAgentId,
        first_name:           resolvedFirst,
        last_name:            resolvedLast,
        email:                normalEmail,
        phone:                phone?.trim() || null,
        property_address:     property_address || null,
        message:              message || null,
        converted_contact_id: contactId,
      }),
    }).catch(() => {})
  }

  // Routing audit log — one row per decision so admins can see distribution
  // and catch misconfigurations. Best-effort: a logging failure must never
  // break lead intake.
  await fetch(`${SUPABASE_URL}/rest/v1/lead_routing_log`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({
      lead_email:     normalEmail,
      property_type:  property_type || null,
      contact_type:   resolvedContactType,
      source_url:     resolvedSourceUrl,
      method:         routingMethod,
      assigned_agent: assignedAgentId,
      sig_rejected:   sigRejected,
      contact_id:     contactId,
      notes:          sigRejected ? 'agent_id sent but signature missing/invalid; fell back to round-robin' : null,
    }),
  }).catch(() => {})

  // Unassignable lead: the round-robin came back empty (no non-admin agents
  // configured, or all matching agents are admins). The contact is still
  // created — leads must never be lost — but every admin gets a high-priority
  // alert so the office knows to triage it manually.
  if (contactId && !assignedAgentId) {
    await notifyAdminsOfUnassignedLead({
      supabaseUrl: SUPABASE_URL,
      headers,
      leadName: `${resolvedFirst} ${resolvedLast}`.trim(),
      email: normalEmail,
      propertyAddress: property_address,
    }).catch(err => console.error('[lead intake] unassigned-lead alert failed:', err?.message))
  }

  // Outbound webhooks for the lead intake. Always fires 'lead.captured';
  // also fires 'contact.created' the first time we see this email. Both are
  // best-effort — webhook failures never block the lead.
  if (contactId) {
    fireWebhooksServer(SUPABASE_URL, headers, 'lead.captured', {
      contact_id:       contactId,
      first_name:       resolvedFirst,
      last_name:        resolvedLast,
      email:            normalEmail,
      phone:            phone?.trim() || null,
      property_address: property_address || null,
      property_type:    property_type || null,
      message:          message || null,
      source_url:       resolvedSourceUrl,
      assigned_agent_id: assignedAgentId,
      is_new_contact:   isNew,
    }).catch(() => {})
    if (isNew) {
      fireWebhooksServer(SUPABASE_URL, headers, 'contact.created', {
        id:                contactId,
        first_name:        resolvedFirst,
        last_name:         resolvedLast,
        email:             normalEmail,
        phone:             phone?.trim() || null,
        source:            'website',
        source_url:        resolvedSourceUrl,
        type:              'buyer',
        status:            'active',
        assigned_agent_id: assignedAgentId,
      }).catch(() => {})
    }
  }

  // Auto-enroll the new contact in the assigned agent's drip. Only fires for
  // brand-new contacts created via this endpoint (isNew) — manual contact
  // creation in the UI is unaffected. If the agent has no default sequence
  // set for the relevant slot, notify the office admins so they can fix it
  // (option b from the audit) rather than silently dropping the enrollment.
  if (isNew && contactId && assignedAgentId) {
    await autoEnroll({
      supabaseUrl: SUPABASE_URL,
      headers,
      contactId,
      contactType:   resolvedContactType,
      propertyType:  property_type,
      assignedAgentId,
      leadName:      `${resolvedFirst} ${resolvedLast}`.trim(),
    }).catch(err => console.error('[lead intake] auto-enroll failed:', err?.message))
  }

  // Tell the assigned agent — instantly in-app (realtime channel already
  // subscribed in App.jsx) and by email. Both best-effort: a notification
  // failure must never lose the lead.
  if (assignedAgentId) {
    const leadName = `${resolvedFirst} ${resolvedLast}`.replace(/ —$/, '').trim()
    const detail = [
      property_address ? `Interested in ${property_address}` : null,
      phone?.trim() ? `Phone: ${phone.trim()}` : null,
      `Email: ${normalEmail}`,
      message ? `"${message}"` : null,
    ].filter(Boolean)

    await fetch(`${SUPABASE_URL}/rest/v1/agent_notifications`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        agent_id: assignedAgentId,
        title:    `New website lead: ${leadName}`,
        message:  detail.join(' · '),
        type:     'lead',
      }),
    }).catch(() => {})

    const RESEND_KEY = process.env.RESEND_API_KEY
    if (RESEND_KEY) {
      try {
        const agentRes = await fetch(
          `${SUPABASE_URL}/rest/v1/agents?id=eq.${assignedAgentId}&select=name,email&limit=1`,
          { headers }
        )
        const [agentRow] = agentRes.ok ? await agentRes.json() : []
        if (agentRow?.email) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
            body: JSON.stringify({
              from: process.env.RESEND_FROM || 'Gateway CRM <noreply@gatewayreadvisors.com>',
              to: agentRow.email,
              subject: `🔔 New website lead: ${leadName}`,
              html: `<p>Hi ${agentRow.name?.split(' ')[0] || ''},</p>
<p>A new website lead was just assigned to you:</p>
<p><strong>${leadName}</strong><br/>${detail.join('<br/>')}</p>
<p>They're in your CRM contacts now — reach out while it's hot.</p>`,
            }),
          })
        }
      } catch { /* email is best-effort */ }
    }
  }

  return res.json({ ok: true, contactId, isNew, assignedAgentId })
}

// Round-robin: delegate to the atomic RPC (migration 0017). The Postgres
// function takes a transaction-scoped advisory lock so concurrent inbound
// leads can't both observe the same "last assigned" row and double-route.
// Falls back to the JS implementation if the RPC isn't installed yet
// (lets us deploy the API before the migration is run).
async function pickRoundRobinAgent(supabaseUrl, headers, propertyType) {
  const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/pick_round_robin_agent`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({ p_property_type: propertyType || 'residential' }),
  })
  if (rpcRes.ok) {
    const body = await rpcRes.text()
    // RPC returning a scalar uuid comes back as a JSON string ("uuid") or
    // null. Strip the quotes either way.
    const trimmed = body.trim().replace(/^"|"$/g, '')
    return trimmed && trimmed !== 'null' ? trimmed : null
  }
  // Function not installed yet — fall back to the legacy JS picker. Logged
  // so ops notice they should run the migration.
  console.warn('[lead intake] pick_round_robin_agent RPC not available; using JS fallback')
  return pickRoundRobinAgentJs(supabaseUrl, headers, propertyType)
}

// Legacy JS picker. Same algorithm as the RPC but susceptible to the race
// (two concurrent inserts can both read the same "last assigned" row).
// Retained only as a fallback during migration rollout.
async function pickRoundRobinAgentJs(supabaseUrl, headers, propertyType) {
  const specialty = propertyType === 'commercial' ? 'commercial' : 'residential'
  const adminFilter = 'is_admin=is.false'
  const pools = [
    `${adminFilter}&specialty=eq.${specialty}`,
    `${adminFilter}&specialty=eq.${specialty === 'residential' ? 'commercial' : 'residential'}`,
    adminFilter,
  ]

  for (const filter of pools) {
    const agentsRes = await fetch(
      `${supabaseUrl}/rest/v1/agents?${filter}&select=id,name&order=name.asc`,
      { headers }
    )
    if (!agentsRes.ok) continue
    const agents = await agentsRes.json()
    if (!agents.length) continue
    if (agents.length === 1) return agents[0].id

    const idList = agents.map(a => a.id).join(',')
    const lastRes = await fetch(
      `${supabaseUrl}/rest/v1/lead_captures?agent_id=in.(${idList})&select=agent_id&order=created_at.desc&limit=1`,
      { headers }
    )
    const last = lastRes.ok ? await lastRes.json() : []
    if (!last.length) return agents[0].id

    const lastIdx = agents.findIndex(a => a.id === last[0].agent_id)
    const nextIdx = (lastIdx === -1 ? 0 : lastIdx + 1) % agents.length
    return agents[nextIdx].id
  }

  return null
}

// Server-side mirror of src/lib/webhooks.js#fireWebhooks. The client lib uses
// the supabase-js SDK; this endpoint uses raw fetch so we duplicate the read
// here rather than pull in the SDK for one event. Failures are swallowed —
// outbound subscriber issues must never block lead intake.
async function fireWebhooksServer(supabaseUrl, headers, event, data) {
  try {
    const configsRes = await fetch(
      `${supabaseUrl}/rest/v1/webhook_configs?active=is.true&events=cs.{${encodeURIComponent(event)}}&select=id,name,url`,
      { headers }
    )
    if (!configsRes.ok) return
    const configs = await configsRes.json()
    if (!configs?.length) return

    const payload = { event, timestamp: new Date().toISOString(), source: 'gateway-crm', data }
    const body    = JSON.stringify(payload)

    await Promise.allSettled(configs.map(async cfg => {
      const startedAt = Date.now()
      let result
      try {
        const r = await fetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        result = { ok: r.ok, status_code: r.status, error: r.ok ? null : `HTTP ${r.status} ${r.statusText || ''}`.trim() }
      } catch (err) {
        result = { ok: false, status_code: null, error: err?.message || 'Network error' }
        console.warn(`[webhook] "${cfg.name}" failed:`, err?.message)
      }
      // Mirror the client-side delivery log so server-emitted webhooks (lead
      // capture etc.) also show up in the admin debugging UI. On failure,
      // stamp next_retry_at so the retry cron picks it up after 1 minute.
      const nextRetryAt = result.ok ? null : new Date(Date.now() + 60_000).toISOString()
      fetch(`${supabaseUrl}/rest/v1/webhook_deliveries`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          webhook_id:    cfg.id,
          event,
          payload,
          status_code:   result.status_code,
          ok:            result.ok,
          error:         result.error,
          duration_ms:   Date.now() - startedAt,
          next_retry_at: nextRetryAt,
        }),
      }).catch(() => {})
    }))
  } catch (err) {
    console.warn('[fireWebhooksServer]', err?.message)
  }
}

// Tell every admin that a lead arrived with no producing agent to route to.
// Fires when the round-robin returns null — usually means the brokerage has
// no non-admin agents configured yet (e.g. early setup, or every account
// happens to have is_admin=true). Without this alert the lead would sit in
// contacts with assigned_agent_id=null and nobody watching.
async function notifyAdminsOfUnassignedLead({ supabaseUrl, headers, leadName, email, propertyAddress }) {
  const adminsRes = await fetch(
    `${supabaseUrl}/rest/v1/agents?is_admin=is.true&select=id`,
    { headers }
  )
  const admins = adminsRes.ok ? await adminsRes.json() : []
  if (!admins.length) return  // no admins either — nothing more we can do

  const detail = [
    propertyAddress ? `Interested in ${propertyAddress}` : null,
    `Email: ${email}`,
  ].filter(Boolean).join(' · ')

  const payload = admins.map(a => ({
    agent_id: a.id,
    title:    'Lead arrived but couldn\'t be assigned',
    message:  `${leadName} just submitted the website form — no non-admin agent was available to route to. The contact is in the CRM but unassigned; pick it up manually or add a producing agent.`,
    type:     'setup_needed',
  }))

  await fetch(`${supabaseUrl}/rest/v1/agent_notifications`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  }).catch(() => {})
}

// Auto-enroll a new website lead in the assigned agent's chosen drip. Picks
// the sequence slot by lead type: buyer/seller/commercial. If the agent
// hasn't configured that slot, raises a setup_needed notification on every
// admin so the office can backfill the setting (option b from the audit).
async function autoEnroll({ supabaseUrl, headers, contactId, contactType, propertyType, assignedAgentId, leadName }) {
  // Pick which slot to read. Commercial property always wins; otherwise
  // buyer is the default since the public form is buyer-side today.
  const slotColumn =
    propertyType === 'commercial' ? 'default_commercial_sequence_id' :
    contactType === 'seller'      ? 'default_seller_sequence_id'     :
    'default_buyer_sequence_id'
  const slotLabel = slotColumn.replace('default_', '').replace('_sequence_id', '')

  const agentRes = await fetch(
    `${supabaseUrl}/rest/v1/agents?id=eq.${assignedAgentId}&select=name,${slotColumn}&limit=1`,
    { headers }
  )
  if (!agentRes.ok) return
  const [agentRow] = await agentRes.json()
  const sequenceId = agentRow?.[slotColumn]

  if (!sequenceId) {
    // Agent has no default drip for this lead type. Tell every admin so they
    // can either set the agent's default, or step in manually. The lead itself
    // is already created and assigned — this only reports the setup gap.
    const adminsRes = await fetch(
      `${supabaseUrl}/rest/v1/agents?is_admin=is.true&select=id`,
      { headers }
    )
    const admins = adminsRes.ok ? await adminsRes.json() : []
    if (admins.length) {
      const payload = admins.map(a => ({
        agent_id: a.id,
        title:    'Lead routed without a drip',
        message:  `${leadName} was routed to ${agentRow?.name || 'an agent'}, but they don't have a default ${slotLabel} drip configured. Set one on their agent profile so future leads auto-enroll.`,
        type:     'setup_needed',
      }))
      await fetch(`${supabaseUrl}/rest/v1/agent_notifications`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(payload),
      }).catch(() => {})
    }
    return
  }

  // Enroll. The unique partial index on (contact_id, sequence_id) where
  // status='active' makes this idempotent — a duplicate insert from a retried
  // request collapses to a 409 we swallow.
  const enrollRes = await fetch(`${supabaseUrl}/rest/v1/contact_sequences`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({
      contact_id:    contactId,
      sequence_id:   sequenceId,
      agent_id:      assignedAgentId,
      current_step:  0,
      status:        'active',
      auto_enrolled: true,
    }),
  })

  if (enrollRes.ok) {
    // Log it on the contact timeline so the agent sees the auto-enrollment
    // alongside everything else they care about for this lead.
    const seqRes = await fetch(
      `${supabaseUrl}/rest/v1/sequences?id=eq.${sequenceId}&select=name&limit=1`,
      { headers }
    )
    const [seq] = seqRes.ok ? await seqRes.json() : []
    await fetch(`${supabaseUrl}/rest/v1/activities`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        contact_id: contactId,
        agent_id:   assignedAgentId,
        type:       'note',
        body:       `Auto-enrolled in drip: ${seq?.name || 'default sequence'}`,
      }),
    }).catch(() => {})
  }
}

// GET /api/property-public?sign=<agent_uuid>
// Authenticated callers fetch an HMAC for an agent's id so the Settings UI
// can render a copy-paste embed snippet for landing pages.
//
// Auth: pass the Supabase access token as `Authorization: Bearer <token>`.
// We resolve the caller via the Supabase auth endpoint (no JWT decoding),
// then look up their agent row with the service key to check is_admin /
// self. Admins can sign any agent's id; producers can sign their own.
async function handleSign(req, res) {
  const agentId = String(req.query.sign || '')
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' })

  if (!process.env.LEAD_AGENT_SECRET) {
    return res.status(412).json({ error: 'LEAD_AGENT_SECRET is not configured on the server' })
  }

  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authorization required' })

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY
  if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) return res.status(500).json({ error: 'Server configuration error' })

  // Resolve the caller's user id from their access token.
  const meRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY, Authorization: auth },
  })
  if (!meRes.ok) return res.status(401).json({ error: 'Invalid session' })
  const user = await meRes.json().catch(() => null)
  const userId = user?.id
  if (!userId) return res.status(401).json({ error: 'Invalid session' })

  // Look up the caller's agent row with the service key so we get is_admin
  // straight from the source (don't trust client claims).
  const agentRes = await fetch(
    `${SUPABASE_URL}/rest/v1/agents?auth_id=eq.${userId}&select=id,is_admin&limit=1`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  )
  const me = agentRes.ok ? (await agentRes.json())[0] : null
  if (!me) return res.status(403).json({ error: 'No agent profile linked to this user' })

  // Admin can sign anyone's id. Producers can only sign their own.
  if (!me.is_admin && me.id !== agentId) {
    return res.status(403).json({ error: 'Forbidden' })
  }

  return res.json({ agent_id: agentId, sig: signAgentId(agentId) })
}

export default async function handler(req, res) {
  // CORS for the lead-capture POST (landing pages may be embedded externally)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method === 'POST') return handleGate(req, res)
  if (req.query?.sign)       return handleSign(req, res)
  return handleShare(req, res)
}
