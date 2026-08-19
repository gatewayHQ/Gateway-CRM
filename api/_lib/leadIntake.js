/**
 * Website lead intake — the pieces shared by every lead entry point.
 *
 * Lives in api/_lib (an underscore directory) rather than as its own
 * api/*.js file because Vercel turns every non-underscore file under api/ into
 * a serverless function, and CI fails the build above 12 (the Hobby ceiling).
 * The webhook is co-hosted under api/property-public.js and reached at its own
 * URL through a vercel.json rewrite.
 *
 * WHY THE ROUND-ROBIN MOVED INTO SQL
 * The old implementation (pickRoundRobinAgent, below, kept only as a fallback)
 * read the most recent lead_captures row and took the next agent
 * alphabetically. Two leads in the same second read the same row and both got
 * the same agent — the read-modify-write race that cost ~2 of every 3
 * concurrent QR scans until 0031 made that path atomic too. Assignment is now
 * one RPC that advances a locked cursor: see migrations/0037.
 *
 * Everything after assignment is BEST EFFORT and must never throw a lead away.
 * A Resend outage, a missing sequence, an unparseable property URL — each of
 * those degrades one field of one lead. Losing the lead loses a commission.
 */

const LANES = ['residential', 'commercial']

export const INTEREST_TYPES = ['residential', 'commercial', 'both']

// ── PostgREST plumbing ───────────────────────────────────────────────────────
// Raw fetch rather than @supabase/supabase-js, matching api/property-public.js,
// which this handler is co-hosted with.

export function serviceCreds() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  return {
    url: url.trim().replace(/\/+$/, ''),
    headers: {
      'Content-Type': 'application/json',
      apikey: key.trim(),
      Authorization: `Bearer ${key.trim()}`,
    },
  }
}

/** GET rows. Returns [] on any failure — callers treat absence as "not found". */
async function rest(creds, path) {
  const r = await fetch(`${creds.url}/rest/v1/${path}`, { headers: creds.headers })
  if (!r.ok) return []
  return r.json().catch(() => [])
}

/**
 * INSERT one row. Returns { row } on success, { conflict: true } on a unique
 * violation (23505), { error } otherwise. The conflict case is not a failure:
 * it is how the dedupe key rejects a webhook retry.
 */
async function insertRow(creds, table, body, { returning = true } = {}) {
  const r = await fetch(`${creds.url}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...creds.headers, Prefer: returning ? 'return=representation' : 'return=minimal' },
    body: JSON.stringify(body),
  })
  if (r.status === 409) return { conflict: true }
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}))
    if (detail?.code === '23505') return { conflict: true }
    return { error: detail?.message || `${table} insert failed (${r.status})` }
  }
  if (!returning) return { row: null }
  const rows = await r.json().catch(() => [])
  return { row: Array.isArray(rows) ? rows[0] : rows }
}

async function patchRow(creds, table, filter, body) {
  const r = await fetch(`${creds.url}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { ...creds.headers, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  })
  if (!r.ok) return null
  const rows = await r.json().catch(() => [])
  return Array.isArray(rows) ? rows[0] : rows
}

// ── Normalization ────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const UUID_RE  = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** Trim, collapse whitespace, and cap length. Null for anything empty. */
export function clean(value, max = 500) {
  if (value === null || value === undefined) return null
  const s = String(value).replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

export function normalizeEmail(value) {
  const s = clean(value, 320)
  if (!s) return null
  const lower = s.toLowerCase()
  return EMAIL_RE.test(lower) ? lower : null
}

/**
 * Keep the digits (and a leading +) so "712-555-0142" and "(712) 555 0142"
 * store identically. The original is preserved in raw_payload either way.
 */
export function normalizePhone(value) {
  const s = clean(value, 40)
  if (!s) return null
  const plus   = s.trim().startsWith('+')
  const digits = s.replace(/\D/g, '')
  if (digits.length < 7) return null           // not a dialable number
  return (plus ? '+' : '') + digits.slice(0, 15)
}

export function normalizeInterest(value) {
  const s = clean(value, 40)?.toLowerCase()
  return INTEREST_TYPES.includes(s) ? s : 'residential'
}

/** first/last for the contacts table, which requires both. */
export function splitName(name) {
  const parts = (clean(name, 200) || '').split(' ').filter(Boolean)
  return {
    first: parts[0] || '',
    // contacts.last_name is NOT NULL; the existing lead path uses the same
    // em-dash placeholder for a single-word name.
    last:  parts.slice(1).join(' ') || '—',
  }
}

/**
 * viewed_properties accepts a bare string (URL or title) or an object
 * ({ url, title, viewed_at }). Capped so a malformed or hostile payload cannot
 * write thousands of child rows for one lead.
 */
export const MAX_VIEWED_PROPERTIES = 25

export function normalizeViewedProperties(input) {
  if (!Array.isArray(input)) return []
  const out  = []
  const seen = new Set()

  for (const entry of input.slice(0, MAX_VIEWED_PROPERTIES * 2)) {
    let url = null, title = null, viewedAt = null

    if (typeof entry === 'string') {
      const s = clean(entry, 600)
      if (!s) continue
      if (/^https?:\/\//i.test(s)) url = s
      else title = s
    } else if (entry && typeof entry === 'object') {
      url   = clean(entry.url ?? entry.link ?? entry.href, 600)
      title = clean(entry.title ?? entry.name ?? entry.address, 300)
      const at = clean(entry.viewed_at ?? entry.viewedAt, 40)
      // Only a parseable timestamp is stored; a junk value must not fail the
      // insert for the whole lead.
      if (at && !Number.isNaN(Date.parse(at))) viewedAt = new Date(at).toISOString()
      if (url && !/^https?:\/\//i.test(url)) { title = title || url; url = null }
    } else {
      continue
    }

    if (!url && !title) continue
    const key = `${url || ''}|${(title || '').toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    out.push({ url, title, viewed_at: viewedAt, position: out.length })
    if (out.length >= MAX_VIEWED_PROPERTIES) break
  }

  return out
}

// ── Assignment ───────────────────────────────────────────────────────────────

/**
 * Which rotation an "either specialty" lead should come out of: whichever ring
 * has handed out fewer leads, so 'both' traffic does not starve one side.
 * Falls back to residential, which is what the legacy path defaulted to.
 */
async function laneForBoth(creds) {
  const r = await fetch(`${creds.url}/rest/v1/rpc/lead_lane_for_both`, {
    method: 'POST',
    headers: creds.headers,
    body: '{}',
  })
  if (!r.ok) return 'residential'
  const lane = await r.json().catch(() => null)
  return LANES.includes(lane) ? lane : 'residential'
}

/**
 * One atomic rotation step.
 *
 * Returns { agentId, lane }, or null when the ring is empty, or
 * { missing: true } when 0037 has not been applied — PostgREST answers 404 for
 * an unknown function. The caller falls back to the legacy picker on `missing`,
 * so the app and the SQL can deploy in either order.
 */
async function rotate(creds, lane) {
  const r = await fetch(`${creds.url}/rest/v1/rpc/assign_lead_round_robin`, {
    method: 'POST',
    headers: creds.headers,
    body: JSON.stringify({ p_lane: lane }),
  })
  if (r.status === 404) return { missing: true }
  if (!r.ok) return null
  const rows = await r.json().catch(() => [])
  const hit  = Array.isArray(rows) ? rows[0] : rows
  return hit?.agent_id ? { agentId: hit.agent_id, lane: hit.lane || lane } : null
}

/**
 * Decide who owns the lead, and who (if anyone) is told about it as a courtesy.
 *
 * interest_type 'both' is the interesting case, and the decision is: ONE
 * primary owner, plus a notified secondary from the other lane.
 *
 *   • One owner, because a lead assigned to two agents is a lead nobody
 *     follows up on and two agents cold-calling the same person is worse than
 *     one. `leads.assigned_agent_id` is always exactly one agent.
 *   • The owner comes from the ring that has taken fewer leads, so neither
 *     specialty absorbs all the ambiguous traffic.
 *   • The other lane's next agent is emailed a clearly-labeled FYI and recorded
 *     as `secondary_agent_id`. They can talk commercial on a lead that is
 *     mostly residential without owning the follow-up. Their ring advances too,
 *     because a real opportunity did reach them.
 *
 * Set LEAD_BOTH_NOTIFY_SECONDARY=false to make 'both' a single-agent
 * assignment with no cross-notification.
 */
export async function assignAgents(creds, interestType) {
  const notifySecondary = process.env.LEAD_BOTH_NOTIFY_SECONDARY !== 'false'

  /** Fall back to the pre-0037 picker if the rotation function is not there. */
  async function step(lane) {
    const hit = await rotate(creds, lane)
    if (hit?.missing) {
      const agentId = await pickRoundRobinAgentLegacy(creds, lane)
      return { hit: agentId ? { agentId, lane } : null, degraded: true }
    }
    return { hit, degraded: false }
  }

  if (interestType !== 'both') {
    const { hit, degraded } = await step(interestType)
    return { primary: hit, secondary: null, lane: hit?.lane || interestType, degraded }
  }

  const lane                        = await laneForBoth(creds)
  const { hit: primary, degraded }  = await step(lane)
  const otherLane                   = lane === 'residential' ? 'commercial' : 'residential'

  let secondary = null
  if (notifySecondary && primary) {
    secondary = (await step(otherLane)).hit
    // A one-lane brokerage (or a single-agent ring) rotates back to the owner.
    // Notifying someone they own a lead they already own is noise.
    if (secondary?.agentId === primary.agentId) secondary = null
  }

  return { primary, secondary, lane: primary?.lane || lane, degraded }
}

/**
 * The pre-0037 rotation, kept as a fallback for a database where the migration
 * has not been applied yet: the app and the SQL can then deploy in either
 * order, the same way the QR pipeline degraded gracefully in 0031. Racy by
 * construction — see the file header.
 */
export async function pickRoundRobinAgentLegacy(creds, lane) {
  const specialty = lane === 'commercial' ? 'commercial' : 'residential'
  const pools = [
    `specialty=eq.${specialty}`,
    `specialty=eq.${specialty === 'residential' ? 'commercial' : 'residential'}`,
    '',
  ]

  for (const filter of pools) {
    const qs     = filter ? `${filter}&` : ''
    const agents = await rest(creds, `agents?${qs}select=id,name&order=name.asc`)
    if (!agents.length) continue
    if (agents.length === 1) return agents[0].id

    const ids  = agents.map(a => a.id).join(',')
    const last = await rest(
      creds,
      `lead_captures?agent_id=in.(${ids})&select=agent_id&order=created_at.desc&limit=1`
    )
    if (!last.length) return agents[0].id

    const lastIdx = agents.findIndex(a => a.id === last[0].agent_id)
    return agents[(lastIdx === -1 ? 0 : lastIdx + 1) % agents.length].id
  }
  return null
}

// ── Matching viewed properties to CRM listings ───────────────────────────────

/** Strip a URL down to something comparable against properties.address. */
function searchTermFor(view) {
  if (view.title) return view.title
  if (!view.url) return null
  try {
    const path = new URL(view.url).pathname
    const slug = path.split('/').filter(Boolean).pop()
    if (!slug) return null
    return decodeURIComponent(slug).replace(/[-_+]+/g, ' ').replace(/\.(html?|php)$/i, '')
  } catch {
    return null
  }
}

function normalizeForCompare(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Fill in `property_id` where a posted URL or title resolves to a CRM listing.
 * Two bounded queries, never one per view:
 *   1. every uuid found in the payload, in one `id=in.(…)`
 *   2. every remaining text term, in one `or=(address.ilike.…)`
 * A view that matches nothing keeps property_id null and is still stored — an
 * unmatched address is often the most useful line in the agent's email.
 */
export async function matchViewedProperties(creds, views) {
  if (!views.length) return views

  const byId   = new Map()
  const idHits = []

  for (const v of views) {
    const m = UUID_RE.exec(v.url || '') || UUID_RE.exec(v.title || '')
    if (m) { v._uuid = m[0].toLowerCase(); idHits.push(v._uuid) }
  }

  if (idHits.length) {
    const rows = await rest(
      creds,
      `properties?id=in.(${[...new Set(idHits)].join(',')})&select=id,address,city,state`
    )
    for (const row of rows) byId.set(String(row.id).toLowerCase(), row)
  }

  // PostgREST splits an `or=(…)` list on commas and parentheses, so a term
  // containing either would corrupt the filter. Strip them rather than trusting
  // quoting to survive encoding.
  const terms = new Map()
  for (const v of views) {
    if (v._uuid && byId.has(v._uuid)) continue
    const raw = searchTermFor(v)
    const t   = raw ? raw.replace(/[(),*"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : ''
    if (t.length >= 4) terms.set(v, t)
  }

  let candidates = []
  if (terms.size) {
    const uniq = [...new Set(terms.values())].slice(0, MAX_VIEWED_PROPERTIES)
    const or   = uniq.map(t => `address.ilike.*${t}*`).join(',')
    candidates = await rest(
      creds,
      `properties?or=(${encodeURIComponent(or)})&select=id,address,city,state&limit=100`
    )
  }

  for (const v of views) {
    if (v._uuid && byId.has(v._uuid)) {
      const p = byId.get(v._uuid)
      v.property_id = p.id
      v.title = v.title || [p.address, p.city, p.state].filter(Boolean).join(', ')
      delete v._uuid
      continue
    }
    delete v._uuid

    const term = terms.get(v)
    if (!term || !candidates.length) continue
    const needle = normalizeForCompare(term)
    const hit = candidates.find(p => {
      const hay = normalizeForCompare(p.address)
      return hay && (hay.includes(needle) || needle.includes(hay))
    })
    if (hit) {
      v.property_id = hit.id
      v.title = v.title || [hit.address, hit.city, hit.state].filter(Boolean).join(', ')
    }
  }

  return views
}

// ── Contact ──────────────────────────────────────────────────────────────────

/**
 * Look up a contact by email. Separate from creation on purpose: the caller
 * checks for an existing relationship BEFORE spending a rotation turn, because
 * an existing contact keeps their current owner. A lead from someone another
 * agent is already working belongs to that agent — silently reassigning them
 * mid-conversation is the worst thing this endpoint could do, and burning a
 * rotation turn to then discard the result would quietly skip an agent.
 */
export async function findContactByEmail(creds, email) {
  const [row] = await rest(
    creds,
    `contacts?email=eq.${encodeURIComponent(email)}&select=id,assigned_agent_id&limit=1`
  )
  return row || null
}

export async function createContact(creds, { name, email, phone, interestType, message, agentId }) {
  const { first, last } = splitName(name)
  const notes = [
    `Website lead — interest: ${interestType}`,
    message ? `Message: ${message}` : null,
  ].filter(Boolean).join('\n')

  const { row, error } = await insertRow(creds, 'contacts', {
    first_name:        first,
    last_name:         last,
    email,
    phone:             phone || null,
    // Both values are inside the contacts CHECK constraints and enums.js.
    source:            'website',
    type:              'buyer',
    status:            'lead',
    assigned_agent_id: agentId || null,
    notes,
  })
  if (error || !row) return { contactId: null, error }
  return { contactId: row.id }
}

// ── Drip hand-off ────────────────────────────────────────────────────────────

/**
 * Enroll the lead's contact in the lane's auto-enroll sequence, which
 * /api/cron?task=sequence already runs every morning. No new scheduler.
 *
 * Returns the drip_status to store: 'enrolled', or 'skipped' when no sequence
 * is flagged for the lane (or the contact is already in it). 'skipped' is a
 * normal state, not an error — the lead is complete either way, and flagging a
 * sequence later starts enrolling without a deploy.
 */
export async function enrollInDrip(creds, { contactId, lane, agentId }) {
  if (!contactId || !lane) return { drip_status: 'skipped', drip_sequence_id: null }

  const [sequence] = await rest(
    creds,
    `sequences?auto_enroll_lane=eq.${lane}&select=id&limit=1`
  )
  if (!sequence?.id) return { drip_status: 'skipped', drip_sequence_id: null }

  // Re-enrolling a contact who is already mid-drip would email them the whole
  // sequence twice.
  const already = await rest(
    creds,
    `contact_sequences?contact_id=eq.${contactId}&sequence_id=eq.${sequence.id}` +
    `&status=eq.active&select=id&limit=1`
  )
  if (already.length) return { drip_status: 'enrolled', drip_sequence_id: sequence.id }

  const { error } = await insertRow(creds, 'contact_sequences', {
    contact_id:   contactId,
    sequence_id:  sequence.id,
    agent_id:     agentId || null,
    current_step: 0,
    status:       'active',
  }, { returning: false })

  return error
    ? { drip_status: 'skipped',  drip_sequence_id: null }
    : { drip_status: 'enrolled', drip_sequence_id: sequence.id }
}

export { rest, insertRow, patchRow, LANES }
