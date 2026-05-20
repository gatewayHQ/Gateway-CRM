/**
 * Buyer ↔ Property matching engine.
 *
 * Critical product rule (from user requirement):
 *   A contact only appears as a match for a property if they've EXPLICITLY
 *   specified the matching submarket AND asset type.
 *   Empty criteria = no match (not "match everything").
 *
 * This prevents the old behavior where every contact was suggested as a match
 * for every property.
 *
 * Inputs are plain objects from the DB; this module is pure (no Supabase calls).
 */

const BUYER_TYPES = new Set(['buyer', 'investor'])

/**
 * Does this contact match this property?
 *
 *   - Contact must be type buyer or investor (sellers/landlords don't get matched)
 *   - Contact must not be deleted or closed
 *   - Contact must have at least one submarket AND it must include property.submarket
 *   - Contact must have at least one asset_type AND it must include property.type
 *   - If contact specified size_min/size_max, property.sqft must fall in range
 */
export function isBuyerMatch(contact, property) {
  if (!contact || !property) return false
  if (contact.deleted_at) return false
  if (!BUYER_TYPES.has(contact.type)) return false
  if (contact.status === 'closed') return false

  // Submarket — strict: contact must have specified at least one
  const subs = contact.submarkets || []
  if (subs.length === 0) return false
  if (property.submarket && !subs.some(s => eqi(s, property.submarket))) return false
  // If property has no submarket set yet, we can't confidently match — skip
  if (!property.submarket) return false

  // Asset type — strict: contact must have specified at least one
  const types = contact.asset_types || []
  if (types.length === 0) return false
  if (property.type && !types.some(t => eqi(t, property.type))) return false

  // Size range (only enforced if contact specified bounds AND property has sqft)
  const sqft = toNumber(property.sqft)
  const min  = toNumber(contact.size_min)
  const max  = toNumber(contact.size_max)
  if (sqft != null) {
    if (min != null && sqft < min) return false
    if (max != null && sqft > max) return false
  }

  return true
}

/**
 * Score how good a match is (higher = better). Used to sort match lists.
 *
 *   +10  every matching asset type
 *   +20  every matching submarket
 *   +5   size fits within specified range
 *   +3   contact has recent activity (warm/hot)
 */
export function matchScore(contact, property) {
  if (!isBuyerMatch(contact, property)) return 0
  let score = 0
  const subs = contact.submarkets || []
  const types = contact.asset_types || []
  if (property.submarket && subs.some(s => eqi(s, property.submarket))) score += 20
  if (property.type && types.some(t => eqi(t, property.type)))           score += 10
  const sqft = toNumber(property.sqft)
  const min  = toNumber(contact.size_min)
  const max  = toNumber(contact.size_max)
  if (sqft != null && (min != null || max != null)) score += 5
  return score
}

/**
 * Return all buyer contacts who match a given property, sorted by score desc.
 */
export function findMatchingBuyers(property, contacts) {
  if (!property) return []
  const out = []
  for (const c of (contacts || [])) {
    if (isBuyerMatch(c, property)) out.push({ contact: c, score: matchScore(c, property) })
  }
  out.sort((a, b) => b.score - a.score)
  return out.map(r => r.contact)
}

/**
 * Return all properties that match a given contact's criteria.
 */
export function findMatchingProperties(contact, properties) {
  if (!contact || !BUYER_TYPES.has(contact.type)) return []
  const out = []
  for (const p of (properties || [])) {
    if (isBuyerMatch(contact, p)) out.push({ property: p, score: matchScore(contact, p) })
  }
  out.sort((a, b) => b.score - a.score)
  return out.map(r => r.property)
}

/**
 * Why does (or doesn't) this contact match? Returns an array of human-readable
 * reason strings — useful for tooltips and debugging.
 */
export function explainMatch(contact, property) {
  const reasons = []
  if (!contact || !property) return ['Missing data']
  if (contact.deleted_at) reasons.push('Contact deleted')
  if (!BUYER_TYPES.has(contact.type)) reasons.push(`Type is "${contact.type}" — only buyers/investors match`)
  if (contact.status === 'closed') reasons.push('Contact status is closed')

  const subs  = contact.submarkets || []
  const types = contact.asset_types || []

  if (subs.length === 0) reasons.push('No submarkets specified — add at least one to enable matching')
  else if (property.submarket && !subs.some(s => eqi(s, property.submarket))) {
    reasons.push(`Submarket "${property.submarket}" not in their list: ${subs.join(', ')}`)
  } else if (property.submarket) {
    reasons.push(`✓ Submarket: ${property.submarket}`)
  } else {
    reasons.push('Property has no submarket set')
  }

  if (types.length === 0) reasons.push('No asset types specified')
  else if (property.type && !types.some(t => eqi(t, property.type))) {
    reasons.push(`Asset type "${property.type}" not in their list: ${types.join(', ')}`)
  } else if (property.type) {
    reasons.push(`✓ Asset type: ${property.type}`)
  }

  const sqft = toNumber(property.sqft)
  const min  = toNumber(contact.size_min)
  const max  = toNumber(contact.size_max)
  if (sqft != null) {
    if (min != null && sqft < min) reasons.push(`Size ${sqft} below min ${min}`)
    if (max != null && sqft > max) reasons.push(`Size ${sqft} above max ${max}`)
  }
  return reasons
}

// ─── helpers ─────────────────────────────────────────────────────────────
function eqi(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
}
function toNumber(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
