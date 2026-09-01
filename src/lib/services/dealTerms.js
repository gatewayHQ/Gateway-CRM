// ─────────────────────────────────────────────────────────────────────────────
// Deal terms — the per-agreement facts that have no column of their own.
//
// WHAT THIS FIXES. `crmTokenValues()` reads twenty terms out of
// `deals.comp_data` — earnest money, title company, lender, protection period,
// possession and inspection dates, the property types a buyer is looking for.
// Every one of them is tokenised end to end and reaches a template field. And
// nothing in the CRM ever wrote them.
//
// So each rendered on the send screen as a named, empty box; the agent typed
// the title company in; the value went onto that one draft and died there. Next
// packet on the same deal, same empty box. The CRM was asking agents for the
// same facts repeatedly and remembering none of them — which is the complaint
// that makes people abandon a transaction system.
//
// THE SCHEMA IS THE SOURCE OF TRUTH, and it is shared. The Deal page renders
// its inputs from this list, and the same keys are what `term()` reads in
// boldsignFields.js. A test asserts the two agree, so a token added there
// without an input here — or an input here with no token — is caught rather
// than shipping as a box that goes nowhere.
//
// TYPES MATCH WHAT THE TOKEN DOES, which is the subtle part. A term the token
// passes through `usDate()` must be stored as ISO or the agreement prints a
// half-converted date; a term the token prints raw must be stored exactly as it
// should appear on the page. See `type` below.
//
// Pure — no Supabase, no browser globals.
// ─────────────────────────────────────────────────────────────────────────────

// `type` says how the value is captured AND how it must be stored:
//
//   text   — printed verbatim on the agreement. Store what should appear.
//   select — same, constrained to known answers so two agents don't write
//            "Conv." and "Conventional" on two halves of the same file.
//   number — printed verbatim; a plain integer with a unit in the label.
//   money   — printed verbatim, so it is normalized to "$1,234" on the way in
//            when the agent typed a bare number. A non-numeric answer ("3% of
//            the purchase price") is kept exactly as typed, because some forms
//            genuinely take a sentence there.
//   date   — the token runs it through usDate(), so it is STORED AS ISO
//            (yyyy-mm-dd) and printed as mm/dd/yyyy. Storing a US-formatted
//            string here would reach the agreement half-converted.
//
// `sides` is which transaction types the term applies to. A buyer deal has no
// listing exclusivity and a seller deal has no property-types-sought, and a
// form of twenty boxes that ignores that is a form nobody fills in. 'both'
// deals see everything.
export const DEAL_TERM_GROUPS = Object.freeze([
  {
    key: 'representation',
    label: 'Representation',
    help: 'How long the brokerage represents this client, and on what basis.',
    terms: [
      {
        key: 'agreement_term_months', label: 'Term of representation', type: 'number', unit: 'months',
        sides: ['buyer', 'seller', 'lease', 'general'],
        // Derived from the listing window unless overridden — see derivedTermHint.
        derivedFrom: 'listing dates',
        help: 'Leave blank to count it from the listing start and end dates.',
      },
      {
        key: 'protection_period_days', label: 'Protection period', type: 'number', unit: 'days',
        sides: ['buyer', 'seller'],
        help: 'How long after the agreement ends the brokerage is still owed a fee on a client it introduced.',
      },
      {
        key: 'listing_exclusivity', label: 'Listing basis', type: 'select',
        options: ['Exclusive right to sell', 'Exclusive agency', 'Open listing'],
        sides: ['seller'],
      },
      {
        key: 'broker_compensation_flat', label: 'Flat fee', type: 'money',
        sides: ['buyer', 'seller', 'lease', 'general'],
        help: 'Only for a flat-fee agreement. A percentage deal fills itself in from the Details tab.',
      },
      {
        key: 'additional_agent_name', label: 'Additional appointed agent', type: 'text',
        sides: ['buyer', 'seller', 'lease', 'general'],
        help: 'A second agent the broker appoints. Defaults to the deal’s second agent.',
      },
      {
        key: 'additional_agent_date', label: 'Appointed on', type: 'date',
        sides: ['buyer', 'seller', 'lease', 'general'],
        dependsOn: 'additional_agent_name',
      },
    ],
  },
  {
    key: 'search',
    label: 'What the buyer is looking for',
    help: 'Printed into the representation agreement as the scope of the search.',
    terms: [
      { key: 'property_types_sought', label: 'Property types', type: 'text', sides: ['buyer'],
        placeholder: 'e.g. Multifamily, 8+ units' },
      { key: 'search_area', label: 'Search area', type: 'text', sides: ['buyer'],
        help: 'Leave blank to use the linked property’s city and county.' },
    ],
  },
  {
    key: 'escrow',
    label: 'Purchase & escrow',
    help: 'The dates and figures a purchase agreement and its addenda ask for.',
    terms: [
      { key: 'earnest_money', label: 'Earnest money', type: 'money', sides: ['buyer', 'seller'] },
      { key: 'down_payment',  label: 'Down payment',  type: 'money', sides: ['buyer'] },
      {
        key: 'financing_type', label: 'Financing', type: 'select',
        options: ['Cash', 'Conventional', 'FHA', 'VA', 'USDA', 'Seller financing', 'Commercial / bank', '1031 exchange', 'Other'],
        sides: ['buyer', 'seller'],
      },
      { key: 'inspection_deadline',    label: 'Inspection deadline',    type: 'date', sides: ['buyer', 'seller'] },
      { key: 'loan_approval_deadline', label: 'Loan approval deadline', type: 'date', sides: ['buyer', 'seller'] },
      { key: 'possession_date',        label: 'Possession',             type: 'date', sides: ['buyer', 'seller'] },
      { key: 'title_company',      label: 'Title company', type: 'text', sides: ['buyer', 'seller'] },
      { key: 'lender_name',        label: 'Lender contact', type: 'text', sides: ['buyer'] },
      { key: 'lender_institution', label: 'Lender',         type: 'text', sides: ['buyer'] },
    ],
  },
  {
    key: 'listing',
    label: 'Listing & MLS',
    help: 'For listing paperwork and MLS change forms.',
    terms: [
      { key: 'year_built',            label: 'Year built',      type: 'number', sides: ['seller'] },
      { key: 'mls_new_price',         label: 'New list price',  type: 'money',  sides: ['seller'],
        help: 'For an MLS price-change form.' },
      { key: 'change_effective_date', label: 'Change effective', type: 'date',  sides: ['seller'],
        dependsOn: 'mls_new_price' },
    ],
  },
])

/** Every term, flat. */
export const ALL_DEAL_TERMS = Object.freeze(DEAL_TERM_GROUPS.flatMap(g => g.terms))

/** Every key this module owns — the set the Deal page is allowed to write. */
export const DEAL_TERM_KEYS = Object.freeze(ALL_DEAL_TERMS.map(t => t.key))

const termByKey = new Map(ALL_DEAL_TERMS.map(t => [t.key, t]))
export const dealTerm = (key) => termByKey.get(key) || null

/**
 * The transaction side a deal is on, for filtering the form.
 *
 * Mirrors `dealClientSide()` in boldsignFields.js but keeps 'both' and 'lease'
 * rather than collapsing them to null: this decides which INPUTS to show, and a
 * both-sided deal needs every one of them.
 */
export function dealSide(deal) {
  const t = String(deal?.comp_data?.transaction_type || '').trim().toLowerCase()
  return ['buyer', 'seller', 'lease', 'both', 'general'].includes(t) ? t : null
}

/**
 * The groups and terms that apply to one deal.
 *
 * A deal whose side is unknown gets everything — better a longer form than a
 * hidden box on the one agreement that needed it. A 'both' deal likewise.
 * `dependsOn` hides a term until the term it belongs with has a value, so
 * "Appointed on" does not sit there on every deal asking to be filled in.
 */
export function termsForDeal(deal, values = {}) {
  const side = dealSide(deal)
  const showAll = !side || side === 'both'
  const applies = (t) => showAll || (t.sides || []).includes(side)
  const satisfied = (t) => !t.dependsOn || String(values?.[t.dependsOn] ?? '').trim() !== ''

  return DEAL_TERM_GROUPS
    .map(g => ({ ...g, terms: g.terms.filter(t => applies(t) && satisfied(t)) }))
    .filter(g => g.terms.length)
}

/** Just this deal's term values out of comp_data — never the rest of the jsonb. */
export function readDealTerms(deal) {
  const cd = deal?.comp_data || {}
  const out = {}
  for (const key of DEAL_TERM_KEYS) out[key] = cd[key] == null ? '' : String(cd[key])
  return out
}

// Bare number → "$1,234". Anything else is left exactly as typed: some forms
// take "3% of the purchase price" or "one month's rent" in the same blank, and
// mangling that would print nonsense on an agreement.
export function normalizeMoney(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const bare = s.replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(bare)) return s
  const n = Number(bare)
  if (!Number.isFinite(n)) return s
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`
}

/** A number term, digits only — "12 months" typed into a months box prints "12". */
export function normalizeNumber(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const digits = s.replace(/[^\d]/g, '')
  return digits
}

/** One value, coerced for storage per its type. Unknown keys pass through. */
export function normalizeTermValue(key, raw) {
  const t = dealTerm(key)
  const s = String(raw ?? '').trim()
  if (!t) return s
  if (t.type === 'money')  return normalizeMoney(s)
  if (t.type === 'number') return normalizeNumber(s)
  // 'date' is already ISO from a date input; text and select are verbatim.
  return s
}

/**
 * The comp_data patch for a set of edited terms.
 *
 * Only keys this module owns, and an EMPTY VALUE IS WRITTEN AS NULL rather than
 * omitted: clearing a term has to actually clear it, and a patch that silently
 * skipped blanks made "delete the earnest money" impossible. The caller merges
 * this over the deal's existing comp_data — never replaces it, because key
 * dates, portal docs and the transaction type live in the same jsonb.
 */
export function buildTermsPatch(values = {}) {
  const patch = {}
  for (const key of DEAL_TERM_KEYS) {
    if (!(key in values)) continue
    const v = normalizeTermValue(key, values[key])
    patch[key] = v === '' ? null : v
  }
  return patch
}

/** How many of a deal's applicable terms carry a value — the "3 of 9" line. */
export function termsFilled(deal, values = {}) {
  const applicable = termsForDeal(deal, values).flatMap(g => g.terms)
  const filled = applicable.filter(t => String(values?.[t.key] ?? '').trim() !== '')
  return { filled: filled.length, total: applicable.length }
}

/**
 * Whole months between two ISO dates — the same calendar count
 * `crmTokenValues()` uses, so the hint under an empty "Term of representation"
 * shows exactly what the agreement will print if it is left blank.
 *
 * Deliberately duplicated rather than imported: boldsignFields.js keeps it
 * private, and a second copy of six lines is cheaper than widening that
 * module's surface. The shared test asserts the two agree.
 */
export function monthsBetween(fromIso, toIso) {
  const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fromIso || '').trim())
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(toIso || '').trim())
  if (!a || !b) return ''
  let months = (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]))
  if (Number(b[3]) < Number(a[3])) months -= 1
  return months > 0 ? String(months) : ''
}

/**
 * What a derived term will print if the agent leaves it blank, as a hint. Null
 * when nothing can be derived, so the input shows no misleading placeholder.
 */
export function derivedTermHint(key, deal) {
  if (key !== 'agreement_term_months') return null
  const cd = deal?.comp_data || {}
  const months = monthsBetween(cd.listing_start, cd.listing_end || deal?.expected_close_date)
  return months ? `${months} from the listing dates` : null
}
