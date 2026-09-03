// ─────────────────────────────────────────────────────────────────────────────
// BoldSign signer state — PURE. No network, no Supabase, no browser globals, so
// the same rules run in the send screen, in the dashboard queue, and inside the
// serverless function (api/boldsign.js imports this the same way it imports
// boldsignCaptions.js).
//
// WHAT THIS FIXES. Every send stores its full signer array, and the UI rendered
// `signer_name` — a comma-joined string of everybody — plus one status chip for
// the document as a whole. On a four-party packet (two principals, two agents)
// an agent could see that it was unsigned and could not see WHO was holding it
// up, which is the only fact that decides what they do next. The data was being
// collected and thrown away.
//
// A DOCUMENT'S STATUS AND A SIGNER'S STATUS ARE DIFFERENT THINGS. The document
// is 'sent' until everyone is done; each signer is somewhere between "hasn't
// opened it" and "signed". Conflating them is what produced "Remind" buttons
// that emailed people who had already signed.
// ─────────────────────────────────────────────────────────────────────────────

// Per-signer states, in lifecycle order. `queued` is not a BoldSign value — it
// is derived, and only on a document that actually uses a signing order: it
// means "it is not this person's turn yet", which is the difference between a
// signer who is ignoring you and one who literally cannot act.
export const SIGNER_STATES = Object.freeze(['queued', 'waiting', 'viewed', 'signed', 'declined', 'expired', 'revoked'])

// A signer who still owes something. `queued` counts: they will owe it, and a
// document is not done until they have acted.
const OUTSTANDING = new Set(['queued', 'waiting', 'viewed'])
export const isOutstanding = (state) => OUTSTANDING.has(state)

const str = (v) => String(v ?? '').trim()

/**
 * BoldSign's per-signer status → ours.
 *
 * BoldSign reports `NotCompleted` for everyone who hasn't finished, whatever
 * the reason, so "has this person even opened it" comes from a separate viewed
 * flag rather than from the status itself.
 */
export function normalizeSignerStatus(raw, { viewed = false } = {}) {
  const v = str(raw).toLowerCase().replace(/[\s_-]+/g, '')
  // ROUND-TRIP SAFE. Normalized rows are persisted to `boldsign_documents.signers`
  // and read back, so this function sees its own output as often as it sees
  // BoldSign's. Without this, `queued` — which is ours, not BoldSign's — was not
  // recognized on the way back in and decayed to `waiting`, turning "it isn't
  // their turn yet" into "chase this person" on every reload.
  if (SIGNER_STATES.includes(v)) return v
  if (v === 'completed' || v === 'signed')   return 'signed'
  if (v === 'declined')                      return 'declined'
  if (v === 'revoked')                       return 'revoked'
  if (v === 'expired')                       return 'expired'
  if (v === 'viewed' || v === 'opened')      return 'viewed'
  // NotCompleted, None, empty — not finished. Whether they have looked at it is
  // the useful distinction, and it is the one an agent acts on.
  return viewed ? 'viewed' : 'waiting'
}

const truthy = (v) => v === true || /^(1|true|yes)$/i.test(str(v))

/**
 * One BoldSign `signerDetails` entry → the shape stored on the row and rendered
 * everywhere. Returns null for an entry with nothing identifying in it.
 */
export function normalizeSigner(raw, index = 0) {
  const name  = str(raw?.signerName || raw?.name)
  const email = str(raw?.signerEmail || raw?.email || raw?.emailAddress)
  if (!name && !email) return null
  const viewed = truthy(raw?.isViewed) || Boolean(raw?.viewedDate || raw?.viewedDateTime)
  return {
    name,
    email,
    role:  str(raw?.signerRole || raw?.role),
    order: Number.isFinite(Number(raw?.order)) ? Number(raw.order) : index + 1,
    status: normalizeSignerStatus(raw?.status ?? raw?.signerStatus, { viewed }),
    // Epoch seconds or an ISO string, depending on which endpoint answered.
    signedAt: toIsoLoose(raw?.signedDate ?? raw?.completedDate ?? raw?.signedDateTime),
    viewedAt: toIsoLoose(raw?.viewedDate ?? raw?.viewedDateTime),
  }
}

// BoldSign hands dates back as Unix seconds from some endpoints and as strings
// from others. Anything unparseable becomes null rather than an Invalid Date
// that renders as "NaN" in a row an agent is reading.
function toIsoLoose(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return new Date(v * 1000).toISOString()
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * A document's signers, normalized, in signing order.
 *
 * `inOrder` turns "not finished" into `queued` for everyone behind the first
 * person who still owes something — on a sequential send those people have not
 * been emailed yet, and showing them as "waiting" makes an agent chase somebody
 * who has never been asked.
 */
export function normalizeSigners(list = [], { inOrder = false } = {}) {
  const rows = (Array.isArray(list) ? list : [])
    .map((s, i) => normalizeSigner(s, i))
    .filter(Boolean)
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))

  if (!inOrder) return rows

  let reachedActive = false
  return rows.map(r => {
    if (!isOutstanding(r.status)) return r
    if (!reachedActive) { reachedActive = true; return r }
    // Behind somebody who hasn't finished, and this document is sequential —
    // BoldSign has not notified them at all yet.
    return r.status === 'viewed' ? r : { ...r, status: 'queued' }
  })
}

/**
 * The signer rows for a stored `boldsign_documents` row.
 *
 * Falls back to the legacy comma-joined `signer_name` / `signer_email` columns
 * so a document sent before per-signer state was captured still renders as
 * people rather than as one string — with an honest `waiting`, because nothing
 * about their individual state was ever recorded.
 */
export function signerRows(doc) {
  const stored = Array.isArray(doc?.signers) ? doc.signers : []
  if (stored.length) return normalizeSigners(stored, { inOrder: Boolean(doc?.signing_in_order) })

  const names  = str(doc?.signer_name).split(',').map(s => s.trim()).filter(Boolean)
  const emails = str(doc?.signer_email).split(',').map(s => s.trim()).filter(Boolean)
  const count  = Math.max(names.length, emails.length)
  const done   = doc?.status === 'completed'
  return Array.from({ length: count }, (_, i) => ({
    name: names[i] || '',
    email: emails[i] || '',
    role: '',
    order: i + 1,
    status: done ? 'signed' : 'waiting',
    signedAt: done ? (doc?.completed_at || null) : null,
    viewedAt: null,
  }))
}

/** Who still owes a signature — exactly who a reminder should go to. */
export const outstandingSigners = (rows = []) => rows.filter(r => isOutstanding(r.status))

/** { signed, total } — the fraction that makes a progress bar honest. */
export function signerProgress(rows = []) {
  const total = rows.length
  return { signed: rows.filter(r => r.status === 'signed').length, total }
}

/**
 * The one line a row leads with: who this document is actually waiting on.
 *
 * This is the sentence the old comma-joined string could never say, and it is
 * the whole point of the feature — an agent reads it and knows who to call.
 */
export function waitingOnLabel(rows = []) {
  if (!rows.length) return 'no recipients recorded'
  const declined = rows.find(r => r.status === 'declined')
  if (declined) return `declined by ${declined.name || declined.email || 'a signer'}`
  const out = outstandingSigners(rows)
  if (!out.length) return 'everyone has signed'
  // Whoever is actually able to act right now leads the sentence. On a
  // sequential send that is one person, and naming the queued ones alongside
  // them would send an agent chasing someone who has not been emailed.
  const active = out.filter(r => r.status !== 'queued')
  const lead = (active.length ? active : out)
  const first = lead[0].name || lead[0].email || 'a signer'
  const rest  = out.length - 1
  if (!rest) return `waiting on ${first}`
  if (rest === 1 && lead.length > 1) return `waiting on ${first} and ${lead[1].name || lead[1].email || '1 other'}`
  return `waiting on ${first} and ${rest} other${rest === 1 ? '' : 's'}`
}

/** Words for one signer's state, in the terms an agent would use out loud. */
export function describeSignerState(row) {
  switch (row?.status) {
    case 'signed':   return row.signedAt ? `signed ${shortDate(row.signedAt)}` : 'signed'
    case 'viewed':   return row.viewedAt ? `opened ${shortDate(row.viewedAt)}` : 'opened, not signed'
    case 'declined': return 'declined'
    case 'expired':  return 'expired'
    case 'revoked':  return 'cancelled'
    case 'queued':   return 'not their turn yet'
    default:         return 'not opened yet'
  }
}

function shortDate(iso) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
