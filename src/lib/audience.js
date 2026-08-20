// ─────────────────────────────────────────────────────────────────────────────
// Audience segmentation for mass email.
//
// Answers one question: "who should receive this send?" — expressed as asset
// types (multifamily / retail / office / …) crossed with which SIDE of the
// market a contact sits on.
//
// WHY THE SIDE IS DERIVED FROM contacts.type. There is no separate buyer-
// criteria and seller-criteria table in this schema: `contacts.asset_types` is
// the one criteria field, and whether it reads as "asset types they BUY" or
// "asset types they SELL" is decided by `contacts.type` — which is exactly how
// the contact drawer labels the same field ("Asset Types" for a buyer/investor,
// "Asset Type" for a seller/landlord, src/pages/Contacts/ContactDrawer.jsx).
// So "everyone who buys multifamily OR sells multifamily" is:
//     asset_types overlaps {multifamily}  AND  type in (buyer,investor,seller,landlord)
//
// Matching rules, deliberately strict in the same way src/lib/matching.js is:
//   • Empty criteria on the contact = no match. A contact who never told us
//     what they deal in is not "everyone's audience" — silence isn't consent to
//     be blasted about a retail closing.
//   • No asset types selected = no audience (not "send to the whole database").
//     A mis-click must never turn into a send to every contact in the CRM.
//   • No email, opted out, or closed = never a recipient, whatever else matches.
//
// Pure module — no Supabase, no React — so the same rules run in the browser
// preview, in the send handler's re-check, and in tests.
// ─────────────────────────────────────────────────────────────────────────────

// Which contact types express BUYER-side criteria vs SELLER-side criteria.
// Mirrors BUYER_TYPES in src/lib/matching.js (kept as its own list here because
// that module is about property matching, and adding the seller half there
// would change what "match" means for the buyer-match panel).
export const BUYER_SIDE_TYPES  = ['buyer', 'investor']
export const SELLER_SIDE_TYPES = ['seller', 'landlord']

// The two audience sides an agent can combine in one send.
export const AUDIENCE_SIDES = ['buyer', 'seller']

export const AUDIENCE_SIDE_LABELS = {
  buyer:  'Buyer criteria',
  seller: 'Seller criteria',
}

export const AUDIENCE_SIDE_HINTS = {
  buyer:  'Buyers & investors looking for these asset types',
  seller: 'Sellers & landlords who own these asset types',
}

// A blank audience — the starting state of the filter, and the shape stored on
// email_blasts.audience.
export const BLANK_AUDIENCE = {
  assetTypes: [],
  sides:      ['buyer', 'seller'],   // "both" is the common case for a deal announcement
}

const eqi = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()

/** Contact types covered by the selected sides. */
export function typesForSides(sides = []) {
  const out = []
  if (sides.includes('buyer'))  out.push(...BUYER_SIDE_TYPES)
  if (sides.includes('seller')) out.push(...SELLER_SIDE_TYPES)
  return out
}

/**
 * Is this contact reachable at all? Separate from criteria matching so the UI
 * can explain WHY a contact the agent expected isn't in the list — "no email on
 * file" and "doesn't deal in retail" are different problems with different fixes.
 */
export function isReachable(contact) {
  if (!contact) return false
  if (contact.deleted_at) return false
  if (contact.email_opt_out) return false
  if (contact.status === 'closed') return false
  return Boolean(String(contact.email || '').trim())
}

/** Why a contact can't receive mail, as a short phrase — null when they can. */
export function unreachableReason(contact) {
  if (!contact) return 'Unknown contact'
  if (contact.deleted_at) return 'Deleted'
  if (contact.email_opt_out) return 'Opted out of email'
  if (contact.status === 'closed') return 'Closed contact'
  if (!String(contact.email || '').trim()) return 'No email on file'
  return null
}

/**
 * Does this contact match the audience filter?
 *
 * OR across the selected asset types (any overlap is a match) and OR across the
 * selected sides — a contact needs one matching asset type and a type belonging
 * to one selected side.
 */
export function matchesAudience(contact, audience = BLANK_AUDIENCE) {
  if (!isReachable(contact)) return false

  const assetTypes = audience?.assetTypes || []
  const sides      = audience?.sides || []
  // Both halves are required: an empty selection selects nobody, never everybody.
  if (assetTypes.length === 0 || sides.length === 0) return false

  const allowedTypes = typesForSides(sides)
  if (!allowedTypes.some(t => eqi(t, contact.type))) return false

  const own = contact.asset_types || []
  if (own.length === 0) return false
  return own.some(a => assetTypes.some(sel => eqi(a, sel)))
}

/**
 * Resolve a full audience against a contact list.
 *
 * `manual` carries the agent's hand edits from the preview step:
 *   added[]   — contact ids to include even though the filter didn't match them
 *   removed[] — contact ids to drop even though it did
 * Both are stored on the blast so the recipient list is reproducible from the
 * record alone, rather than only existing in the UI that built it.
 *
 * Returns recipients sorted by name, plus the ids that were requested but can't
 * be mailed, so the review step can say so instead of silently shrinking.
 */
export function resolveAudience(contacts = [], audience = BLANK_AUDIENCE, manual = {}) {
  const added   = new Set(manual.added   || [])
  const removed = new Set(manual.removed || [])

  const recipients = []
  const skipped    = []

  for (const c of contacts) {
    if (!c || removed.has(c.id)) continue
    const included = added.has(c.id) || matchesAudience(c, audience)
    if (!included) continue
    if (!isReachable(c)) {
      // Only manual adds can land here — matchesAudience() already filters the
      // unreachable out — and an agent who typed a name deserves to be told why
      // it won't be mailed.
      skipped.push({ contact: c, reason: unreachableReason(c) })
      continue
    }
    recipients.push(c)
  }

  recipients.sort((a, b) =>
    `${a.last_name || ''} ${a.first_name || ''}`.localeCompare(`${b.last_name || ''} ${b.first_name || ''}`))

  return { recipients, skipped }
}

/**
 * De-duplicate by email address: two contacts sharing a mailbox (spouses on one
 * address, an assistant on two records) must not receive the same blast twice.
 * The first contact wins; the rest are reported so the count stays honest.
 */
export function dedupeByEmail(recipients = []) {
  const seen = new Map()
  const duplicates = []
  for (const c of recipients) {
    const key = String(c.email || '').trim().toLowerCase()
    if (!key) continue
    if (seen.has(key)) { duplicates.push({ contact: c, reason: `Duplicate of ${seen.get(key)}` }); continue }
    seen.set(key, `${c.first_name || ''} ${c.last_name || ''}`.trim() || key)
  }
  const unique = recipients.filter(c => !duplicates.some(d => d.contact.id === c.id))
  return { unique, duplicates }
}

/** Human summary of a filter, for the review step and the blast record. */
export function describeAudience(audience = BLANK_AUDIENCE) {
  const types = audience?.assetTypes || []
  const sides = audience?.sides || []
  if (types.length === 0 || sides.length === 0) return 'No audience selected'
  const sideText = sides.length === AUDIENCE_SIDES.length
    ? 'buyers & sellers'
    : sides.map(s => (s === 'buyer' ? 'buyers' : 'sellers')).join(' & ')
  return `${types.join(', ')} — ${sideText}`
}
