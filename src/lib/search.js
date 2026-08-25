// ─────────────────────────────────────────────────────────────────────────────
// Global search — pure helpers.
//
// Kept out of components/GlobalSearch.jsx so they can be tested without a DOM.
// The component owns fetching and rendering; everything here is deterministic.
// ─────────────────────────────────────────────────────────────────────────────

import { propertyLabel, streetLine } from './address.js'

export const MIN_SEARCH_CHARS = 2
export const PER_SECTION      = 5

export const contactName  = (c) => `${c?.first_name || ''} ${c?.last_name || ''}`.trim()
// "123 Main St, Suite 200 · Des Moines, IA" — the suite belongs on the street
// line, or two spaces in the same building are indistinguishable in the results.
export const propertyLine = propertyLabel

/** Case-insensitive substring test across a record's searchable fields. */
export function matches(term, ...fields) {
  const t = String(term || '').toLowerCase().trim()
  if (!t) return false
  return fields.some(f => String(f ?? '').toLowerCase().includes(t))
}

/** True when a term is long enough to be worth a query. */
export const isSearchable = (term) => String(term || '').trim().length >= MIN_SEARCH_CHARS

/**
 * Which agents' records a search should span: an admin sees the whole roster,
 * everyone else sees the agents already resolved as visible to them. RLS
 * applies on top of this in the database either way.
 */
export function searchAgentIds({ isAdmin, agents = [], visibleAgentIds = [] }) {
  return isAdmin ? agents.map(a => a.id).filter(Boolean) : visibleAgentIds
}

/** Client-side fallbacks, used only when the server RPC is unavailable. */
export const filterContacts = (rows = [], term) =>
  rows.filter(c => matches(term, contactName(c), c.email, c.phone, c.owner_city)).slice(0, PER_SECTION)

export const filterProperties = (rows = [], term) =>
  rows.filter(p => matches(term, p.address, p.unit, streetLine(p), p.city, p.mls_number)).slice(0, PER_SECTION)

/** Deals are always filtered in memory — App.jsx already holds every visible one. */
export const filterDeals = (rows = [], term) =>
  isSearchable(term) ? rows.filter(d => matches(term, d.title, d.notes)).slice(0, PER_SECTION) : []

/**
 * Flatten the three sections into one ordered list so arrow keys cross section
 * boundaries. `stageLabel` is injected so this stays free of stage imports.
 */
export function flattenResults({ contacts = [], properties = [], deals = [] }, stageLabel = (s) => s) {
  return [
    ...contacts.map(r   => ({ kind: 'contact',  id: r.id, label: contactName(r),  sub: r.email || r.phone || '—', row: r })),
    ...properties.map(r => ({ kind: 'property', id: r.id, label: propertyLine(r), sub: r.type || '—',             row: r })),
    ...deals.map(r      => ({ kind: 'deal',     id: r.id, label: r.title,         sub: stageLabel(r.stage) || '—', row: r })),
  ]
}

/** Wrapping cursor movement for the results list. */
export function moveCursor(cursor, delta, length) {
  if (!length) return 0
  return (((cursor + delta) % length) + length) % length
}

/** Where a chosen result should navigate to. */
export function routeForResult(item) {
  if (!item) return null
  if (item.kind === 'deal')     return { route: `deal/${item.id}`, focus: null }
  if (item.kind === 'contact')  return { route: 'contacts',   focus: { type: 'contact',  id: item.id } }
  if (item.kind === 'property') return { route: 'properties', focus: { type: 'property', id: item.id } }
  return null
}
