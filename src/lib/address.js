// ─────────────────────────────────────────────────────────────────────────────
// Property addresses — one place that knows how a suite/unit is written.
//
// A listing inside a strip mall, an office building or a flex park is not the
// whole building: "2212 Okoboji Ave" is the building, "2212 Okoboji Ave, Suite
// 120" is the space being leased. Agents used to fold that into the street line
// by hand, which meant the suite was invisible to search, to geocoding and to
// every document token — and two spaces in the same building were two rows
// whose addresses only differed by whatever the agent happened to type.
//
// `properties.unit` (migration 0042) holds the suite on its own, and everything
// that renders, searches, geocodes or prints an address goes through the
// helpers here so the same listing reads the same way in the CRM, on the public
// landing page and on a signed listing agreement.
//
// The one deliberate exception is geocoding: a suite number is not on the map,
// and passing it to a geocoder is how "Suite 120" turns into no result at all.
// geocodeQuery() drops it; nothing else does.
// ─────────────────────────────────────────────────────────────────────────────

// The labels agents actually type. A value that already starts with one of
// these is left exactly as written — "Ste 4", "#12", "Bldg C" are all how
// somebody's sign or lease reads, and rewriting them is not our call.
const UNIT_LABEL_RE =
  /^(?:#|(?:suite|ste\.?|unit|apt\.?|apartment|bldg\.?|building|floor|fl\.?|rm\.?|room|space|spc\.?|bay|lot|no\.?)\b)/i

/**
 * Clean up a typed suite/unit into what gets stored and shown.
 *
 *   '  200 '   → 'Suite 200'      (a bare number is a suite number)
 *   'ste 4'    → 'ste 4'          (already labelled — left alone)
 *   '# 12'     → '#12'
 *   ', 3B'     → 'Suite 3B'       (a leading comma is punctuation, not content)
 *   '—' / ''   → ''               (nothing to store)
 */
export function normalizeUnit(raw) {
  const trimmed = String(raw ?? '').replace(/\s+/g, ' ').trim().replace(/^[,\s]+|[,\s]+$/g, '')
  if (!trimmed) return ''
  // No letter or digit anywhere means the agent typed punctuation into an
  // optional field — store nothing rather than a dash that renders as an
  // address with a suite.
  if (!/[a-z0-9]/i.test(trimmed)) return ''
  if (UNIT_LABEL_RE.test(trimmed)) return trimmed.replace(/^#\s+/, '#')
  return `Suite ${trimmed}`
}

/** The stored suite of a property row, normalized and safe to render. */
export const propertyUnit = (p) => normalizeUnit(p?.unit)

/**
 * The street line as it goes on an envelope: "123 Main St, Suite 200".
 * Falls back to the plain street address when there is no suite, so every
 * caller can use this unconditionally.
 */
export function streetLine(p) {
  const street = String(p?.address ?? '').trim()
  const unit   = propertyUnit(p)
  if (!street) return unit
  return unit ? `${street}, ${unit}` : street
}

/** One-line full address: "123 Main St, Suite 200, Des Moines, IA, 50309". */
export function fullAddress(p) {
  if (!p) return ''
  const cityState = [p.city, p.state].filter(Boolean).join(', ')
  return [streetLine(p), cityState, p.zip].filter(Boolean).join(', ')
}

/** "City, ST" — the second line under the street line. */
export const cityStateLine = (p) => [p?.city, p?.state].filter(Boolean).join(', ')

/**
 * What to hand a geocoder or a map embed — the SUITE IS OMITTED ON PURPOSE.
 * Geocoders resolve buildings, not the spaces inside them, and a suite in the
 * query is a common way to get zero results back for an address that exists.
 */
export function geocodeQuery(p) {
  if (!p) return ''
  return [p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')
}

/** Search-result / picker label: "123 Main St, Suite 200 · Des Moines, IA". */
export function propertyLabel(p) {
  return [streetLine(p), cityStateLine(p)].filter(Boolean).join(' · ')
}

/**
 * True when a write or read failed only because `properties.unit` isn't there
 * yet (migration 0042 not applied). Callers retry without it so a deploy that
 * lands ahead of the migration degrades to the old behavior instead of failing
 * — the same pattern isMissingCoAgentColumn() (0025) and isMissingSideColumn()
 * (0040) use.
 */
export function isMissingUnitColumn(error) {
  const msg = String(error?.message || error?.hint || '')
  return /properties\.unit\b/.test(msg)          // 42703 on a select/filter
    || /'unit' column of 'properties'/.test(msg) // PGRST204 on an insert/update
    || /column "unit" of relation "properties"/.test(msg)
}

/**
 * Run a `properties` read that wants the suite column, degrading to the same
 * read without it on a pre-0042 database.
 *
 *   const { data } = await readPropertiesWithUnit(
 *     'id, address, city, state',
 *     (cols) => svc.from('properties').select(cols).in('id', ids),
 *   )
 *
 * `run` is called with the column list to select and must return a Supabase
 * result ({ data, error }).
 */
export async function readPropertiesWithUnit(columns, run) {
  const withUnit = await run(`${columns}, unit`)
  if (!withUnit?.error || !isMissingUnitColumn(withUnit.error)) return withUnit
  return run(columns)
}
