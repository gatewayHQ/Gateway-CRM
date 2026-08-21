// ─────────────────────────────────────────────────────────────────────────────
// Gateway CRM — one price, two records.
//
// A transaction's price lives on two rows: `properties.list_price` (what the
// listing says) and `deals.value` (what the deal is worth). Both are editable —
// the property drawer and the deal drawer each have a price field — and until
// now neither knew about the other. An agent who reduced the price on the deal
// left the listing advertising the old number, and the reduction never reached
// the property's Price History tab, which is the record the seller is shown.
//
// This module is the whole decision layer for keeping them equal, kept pure so
// the rules are testable without a database:
//
//   • normalizePrice / priceChanged — what counts as a price, and as a change
//   • planPriceSync                  — given an edit on ONE side, everything
//                                      that must be written on BOTH
//   • normalizeHistory / mergeHistory — reading a history that exists in two
//                                      shapes (the `pricing_history` table and
//                                      the legacy `properties.price_history`
//                                      jsonb) as one list
//
// The IO that executes a plan is src/lib/services/pricing.js.
// ─────────────────────────────────────────────────────────────────────────────

/** Where an edit was typed. Mirrors the `pricing_history.source` CHECK. */
export const PRICE_SOURCES = ['deal', 'property', 'import', 'system']

/**
 * A price as the database stores it: a non-negative number, or null.
 *
 * Empty inputs are null rather than 0 — an unpriced listing is not a listing
 * priced at nothing, and `deals.value` has a `>= 0` CHECK that a stray '-' or
 * 'abc' from a number input would otherwise trip. Junk reads as null for the
 * same reason: refusing to sync is better than syncing a NaN.
 */
export function normalizePrice(value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

/** True when two prices differ once normalized ('500000' and 500000 do not). */
export function priceChanged(a, b) {
  return normalizePrice(a) !== normalizePrice(b)
}

/** Stages where a deal no longer tracks the listing price. */
const SETTLED_STAGES = new Set(['closed', 'lost'])

/**
 * Deals a price change on a property should propagate to: the OPEN deals on
 * that property whose value doesn't already match.
 *
 * Closed and lost deals are deliberately left alone — a closed deal's value is
 * what it actually sold for, and rewriting it would rewrite commission history
 * and every report built on it. A relisting at a new price must not reach back
 * into last year's closing.
 */
export function dealsToRepriceFor({ propertyId, deals = [], price, excludeDealId = null }) {
  const target = normalizePrice(price)
  if (!propertyId) return []
  return (deals || []).filter(d =>
    d && d.property_id === propertyId
    && d.id !== excludeDealId
    && !SETTLED_STAGES.has(d.stage)
    && normalizePrice(d.value) !== target
  )
}

/**
 * Everything one price edit implies, on both sides of the link.
 *
 * @param {object}  args
 * @param {*}       args.price          the new price, as typed
 * @param {*}       args.previousPrice  the price on the record being edited, before
 * @param {string}  args.origin         'deal' | 'property' — which drawer typed it
 * @param {object}  [args.property]     the linked property row (null when unlinked)
 * @param {string}  [args.dealId]       the deal being edited, when origin is 'deal'
 * @param {Array}   [args.deals]        every deal in state, to find siblings on the property
 * @param {object}  [args.actor]        the acting agent ({ id, name })
 * @param {string}  [args.at]           ISO timestamp (injected so this stays pure)
 *
 * @returns {{
 *   changed: boolean,                       // is there anything to do at all
 *   price: number|null,                     // the normalized new price
 *   previousPrice: number|null,
 *   propertyUpdate: object|null,            // patch for `properties`, or null
 *   dealUpdates: Array<{id: string, value: number|null}>,
 *   historyRow: object|null,                // row for `pricing_history`
 *   legacyHistory: Array<object>|null,      // the property's full jsonb mirror
 * }}
 */
export function planPriceSync({
  price, previousPrice, origin = 'property', property = null, dealId = null,
  deals = [], actor = null, at = null,
} = {}) {
  const next = normalizePrice(price)
  const prev = normalizePrice(previousPrice)
  const when = at || new Date().toISOString()

  const noop = {
    changed: false, price: next, previousPrice: prev,
    propertyUpdate: null, dealUpdates: [], historyRow: null, legacyHistory: null,
  }
  if (next === prev) return noop
  // Clearing a price is an edit to the record it was typed on, but it is not a
  // price CHANGE worth propagating: a blank deal value must not wipe the
  // listing price off the property (and off the public landing page) as a side
  // effect of someone tidying a field.
  if (next === null) return noop

  const propertyId = property?.id || null

  // The property only needs writing when its own number is out of date. When
  // the edit came FROM the property drawer the caller has already put the new
  // price in its own payload, so there is nothing extra to write.
  const propertyUpdate = (propertyId && origin !== 'property' && normalizePrice(property?.list_price) !== next)
    ? { list_price: next }
    : null

  const dealUpdates = dealsToRepriceFor({
    propertyId, deals, price: next,
    // The origin deal is saved by its own drawer in the same submit.
    excludeDealId: origin === 'deal' ? dealId : null,
  }).map(d => ({ id: d.id, value: next }))

  const historyRow = {
    property_id:     propertyId,
    deal_id:         origin === 'deal' ? (dealId || null) : null,
    price:           next,
    previous_price:  prev,
    source:          PRICE_SOURCES.includes(origin) ? origin : 'system',
    changed_by:      actor?.id   || null,
    changed_by_name: actor?.name || null,
    created_at:      when,
  }

  // The jsonb mirror on the property. Only written when there IS a property —
  // a price change on an unlinked deal has nowhere to mirror to and lives in
  // `pricing_history` alone until the deal is linked.
  const legacyHistory = propertyId
    ? [...normalizeHistory(property?.price_history), normalizeEntry(historyRow)].map(toLegacyEntry)
    : null

  return { changed: true, price: next, previousPrice: prev, propertyUpdate, dealUpdates, historyRow, legacyHistory }
}

/**
 * One history entry, whatever shape it arrived in.
 *
 * Two shapes exist and both are permanent: rows from the `pricing_history`
 * table, and objects from the legacy `properties.price_history` jsonb (which
 * predates the table, carries a date-only `date`, and has no actor). Callers
 * get one shape so nothing downstream has to care which source it read.
 *
 * Returns null for anything that isn't a usable entry.
 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const price = normalizePrice(raw.price)
  const previousPrice = normalizePrice(raw.previous_price ?? raw.previousPrice)
  if (price === null && previousPrice === null) return null
  const at = raw.created_at || raw.changed_at || raw.date || null
  return {
    id:            raw.id || null,
    price,
    previousPrice,
    at,
    source:        raw.source || null,
    dealId:        raw.deal_id || null,
    propertyId:    raw.property_id || null,
    changedById:   raw.changed_by || null,
    changedByName: raw.changed_by_name || null,
    note:          raw.note || null,
    // Positive = the price came down. Null when there is nothing to compare to
    // (the first recorded price), which renders as "Initial price" rather than
    // a fake reduction from zero.
    reduction:     previousPrice === null || price === null ? null : previousPrice - price,
  }
}

/** Normalize a list, dropping junk. Order is preserved. */
export function normalizeHistory(list) {
  if (!Array.isArray(list)) return []
  return list.map(normalizeEntry).filter(Boolean)
}

// Same entry, back in the shape the legacy jsonb mirror uses. `date` is kept
// date-only because that is what every existing reader of `price_history`
// expects; `changed_at` carries the full timestamp alongside it.
// Takes a NORMALIZED entry (normalizeEntry / normalizeHistory), so there is one
// place that understands the raw shapes.
function toLegacyEntry(entry) {
  return {
    price:           entry.price,
    previous_price:  entry.previousPrice,
    date:            entry.at ? String(entry.at).slice(0, 10) : null,
    changed_at:      entry.at,
    source:          entry.source,
    changed_by:      entry.changedById,
    changed_by_name: entry.changedByName,
  }
}

const entryKey = (e) => [e.price, e.previousPrice, String(e.at || '').slice(0, 10)].join('|')

/**
 * The history to show, oldest first, from every source that has one.
 *
 * Migration 0040 imports the legacy jsonb into `pricing_history`, so normally
 * the table is the whole story. But an app deployed ahead of the migration (or
 * a mirror write that landed while the table insert failed) can leave an entry
 * in only one of them — showing the union keeps a real price change from
 * disappearing, and de-duping on price/previous/day keeps the imported copy
 * from showing twice.
 *
 * Rows win over legacy entries on a collision: they carry the actor.
 */
export function mergeHistory(rows, legacy) {
  const out = []
  const seen = new Set()
  for (const entry of [...normalizeHistory(rows), ...normalizeHistory(legacy)]) {
    const key = entryKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0))
}

/**
 * The line an audit entry / toast uses: "$450,000 → $435,000".
 * Formatting of the numbers is the caller's (helpers.formatCurrency).
 */
export function describeChange(entry, format = (n) => String(n)) {
  if (!entry) return ''
  if (entry.previousPrice === null) return `Price set to ${format(entry.price)}`
  const dir = entry.reduction > 0 ? 'reduced' : 'increased'
  return `Price ${dir} ${format(entry.previousPrice)} → ${format(entry.price)}`
}
