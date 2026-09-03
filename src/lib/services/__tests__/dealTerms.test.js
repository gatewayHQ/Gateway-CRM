// Deal terms. The failure this replaces: twenty tokens read comp_data keys that
// nothing in the CRM ever wrote, so each one rendered on the send screen as an
// empty box the agent filled in on every single send.
//
// The load-bearing test in this file is the first one: the schema the Deal page
// renders and the keys the token layer reads must be the same set, or an input
// goes nowhere and a token stays permanently blank.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEAL_TERM_GROUPS, DEAL_TERM_KEYS, ALL_DEAL_TERMS, dealTerm, dealSide,
  termsForDeal, readDealTerms, buildTermsPatch, termsFilled,
  normalizeMoney, normalizeNumber, normalizeTermValue, monthsBetween, derivedTermHint,
} from '../dealTerms.js'
import { crmTokenValues } from '../boldsignFields.js'

describe('the schema and the token layer agree', () => {
  // Read the source rather than exercising every token: `term()` calls are the
  // definitive list of comp_data keys the agreement layer consults, and this
  // catches a drift in EITHER direction at the moment it is introduced.
  const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/services/boldsignFields.js'), 'utf8')
  const tokenKeys = [...source.matchAll(/term\('([a-z_]+)'\)/g)].map(m => m[1])

  it('gives every comp_data term the token layer reads an input on the Deal page', () => {
    const missing = [...new Set(tokenKeys)].filter(k => !DEAL_TERM_KEYS.includes(k))
    expect(missing, `these tokens read comp_data but have no Deal Terms input: ${missing.join(', ')}`).toEqual([])
  })

  it('has no input that writes a key nothing reads', () => {
    const orphans = DEAL_TERM_KEYS.filter(k => !tokenKeys.includes(k))
    expect(orphans, `these Deal Terms inputs write keys no token reads: ${orphans.join(', ')}`).toEqual([])
  })

  // A term the token passes through usDate() must be stored ISO; one it prints
  // raw must be stored exactly as it should appear. Getting this backwards puts
  // a half-converted date on a signed agreement.
  it('marks as `date` exactly the terms the token layer date-formats', () => {
    const dateFormatted = [...source.matchAll(/usDate\(term\('([a-z_]+)'\)/g)].map(m => m[1])
    for (const key of dateFormatted) {
      expect(dealTerm(key)?.type, `${key} is usDate()'d by the token layer, so it must be stored as ISO`).toBe('date')
    }
  })

  it('actually reaches the agreement — a stored term comes back out as a token value', () => {
    const deal = { comp_data: { transaction_type: 'buyer', title_company: 'Hawkeye Title', earnest_money: '$5,000', possession_date: '2026-10-01' } }
    const vals = crmTokenValues({ deal })
    expect(vals.title_company).toBe('Hawkeye Title')
    expect(vals.earnest_money).toBe('$5,000')
    // Stored ISO, printed US — which is why the input type has to be `date`.
    expect(vals.possession_date).toBe('10/01/2026')
  })
})

describe('schema shape', () => {
  it('gives every term a key, a label and a type', () => {
    for (const t of ALL_DEAL_TERMS) {
      expect(t.key, JSON.stringify(t)).toBeTruthy()
      expect(t.label, t.key).toBeTruthy()
      expect(['text', 'select', 'number', 'money', 'date'], t.key).toContain(t.type)
      if (t.type === 'select') expect(t.options?.length, t.key).toBeGreaterThan(1)
    }
  })

  it('has no duplicate keys — two inputs writing one term would fight', () => {
    expect(new Set(DEAL_TERM_KEYS).size).toBe(DEAL_TERM_KEYS.length)
  })

  it('names a real term in every dependsOn', () => {
    for (const t of ALL_DEAL_TERMS) {
      if (t.dependsOn) expect(DEAL_TERM_KEYS, t.key).toContain(t.dependsOn)
    }
  })
})

describe('which terms a deal asks for', () => {
  const buyer  = { comp_data: { transaction_type: 'buyer' } }
  const seller = { comp_data: { transaction_type: 'seller' } }

  it('reads the side from the same field the Form Library filters on', () => {
    expect(dealSide(buyer)).toBe('buyer')
    expect(dealSide({ comp_data: { transaction_type: 'BOTH' } })).toBe('both')
    expect(dealSide({})).toBeNull()
  })

  // A form of twenty boxes that ignores the side is a form nobody fills in.
  it('shows a buyer deal what a buyer agreement asks for, and not the rest', () => {
    const keys = termsForDeal(buyer).flatMap(g => g.terms.map(t => t.key))
    expect(keys).toContain('property_types_sought')
    expect(keys).toContain('down_payment')
    expect(keys).not.toContain('listing_exclusivity')
    expect(keys).not.toContain('mls_new_price')
  })

  it('shows a seller deal the listing terms instead', () => {
    const keys = termsForDeal(seller).flatMap(g => g.terms.map(t => t.key))
    expect(keys).toContain('listing_exclusivity')
    expect(keys).toContain('year_built')
    expect(keys).not.toContain('property_types_sought')
    expect(keys).not.toContain('down_payment')
  })

  // Better a longer form than a hidden box on the one agreement that needed it.
  it('shows everything when the side is unknown or both', () => {
    const unknown = termsForDeal({}).flatMap(g => g.terms.map(t => t.key))
    const both    = termsForDeal({ comp_data: { transaction_type: 'both' } }).flatMap(g => g.terms.map(t => t.key))
    expect(unknown).toContain('listing_exclusivity')
    expect(unknown).toContain('property_types_sought')
    expect(both).toContain('mls_new_price')
  })

  it('hides a dependent term until the one it belongs with has a value', () => {
    const without = termsForDeal(buyer, {}).flatMap(g => g.terms.map(t => t.key))
    expect(without).not.toContain('additional_agent_date')
    const with_ = termsForDeal(buyer, { additional_agent_name: 'Alex Agent' }).flatMap(g => g.terms.map(t => t.key))
    expect(with_).toContain('additional_agent_date')
  })
})

describe('reading and writing comp_data', () => {
  it('reads only its own keys, as strings', () => {
    const vals = readDealTerms({ comp_data: { title_company: 'Hawkeye Title', key_dates: [{ type: 'Closing' }], year_built: 1998 } })
    expect(vals.title_company).toBe('Hawkeye Title')
    expect(vals.year_built).toBe('1998')
    expect(vals).not.toHaveProperty('key_dates')
    expect(Object.keys(vals).sort()).toEqual([...DEAL_TERM_KEYS].sort())
  })

  it('patches only its own keys — key dates and the transaction type are not its business', () => {
    const patch = buildTermsPatch({ title_company: 'Hawkeye Title', transaction_type: 'seller', key_dates: [] })
    expect(patch.title_company).toBe('Hawkeye Title')
    expect(patch).not.toHaveProperty('transaction_type')
    expect(patch).not.toHaveProperty('key_dates')
  })

  // Clearing a term has to actually clear it. A patch that skipped blanks made
  // "delete the earnest money" impossible.
  it('writes a cleared term as null rather than omitting it', () => {
    expect(buildTermsPatch({ earnest_money: '' }).earnest_money).toBeNull()
    expect(buildTermsPatch({ earnest_money: '   ' }).earnest_money).toBeNull()
  })

  it('leaves a key alone when the caller did not touch it', () => {
    expect(buildTermsPatch({ earnest_money: '$1,000' })).toEqual({ earnest_money: '$1,000' })
  })

  it('counts only the terms that apply to this deal', () => {
    const deal = { comp_data: { transaction_type: 'buyer' } }
    const all = termsForDeal(deal).flatMap(g => g.terms).length
    expect(termsFilled(deal, {})).toEqual({ filled: 0, total: all })
    expect(termsFilled(deal, { title_company: 'Hawkeye Title' }).filled).toBe(1)
    // A seller-only term set on a buyer deal is not counted — it is not asked for.
    expect(termsFilled(deal, { listing_exclusivity: 'Open listing' }).filled).toBe(0)
  })
})

describe('normalizing what the agent typed', () => {
  // These print verbatim on the agreement, so "5000" would reach a signed
  // contract as "5000" rather than "$5,000".
  it('formats a bare number as money', () => {
    expect(normalizeMoney('5000')).toBe('$5,000')
    expect(normalizeMoney('5,000')).toBe('$5,000')
    expect(normalizeMoney('$5000')).toBe('$5,000')
    expect(normalizeMoney('1234.5')).toBe('$1,234.50')
  })

  // Some forms take a sentence in the same blank. Mangling that would print
  // nonsense on an agreement.
  it('leaves anything that is not a plain number exactly as typed', () => {
    expect(normalizeMoney('3% of the purchase price')).toBe('3% of the purchase price')
    expect(normalizeMoney("one month's rent")).toBe("one month's rent")
    expect(normalizeMoney('')).toBe('')
  })

  it('reduces a number term to digits — "12 months" in a months box prints 12', () => {
    expect(normalizeNumber('12 months')).toBe('12')
    expect(normalizeNumber('90')).toBe('90')
    expect(normalizeNumber('')).toBe('')
  })

  it('routes each value by its declared type, and never touches a date', () => {
    expect(normalizeTermValue('earnest_money', '5000')).toBe('$5,000')
    expect(normalizeTermValue('protection_period_days', '90 days')).toBe('90')
    expect(normalizeTermValue('possession_date', '2026-10-01')).toBe('2026-10-01')
    expect(normalizeTermValue('title_company', ' Hawkeye Title ')).toBe('Hawkeye Title')
    expect(normalizeTermValue('not_a_term', ' x ')).toBe('x')
  })
})

describe('the derived term hint', () => {
  // Must match crmTokenValues() exactly, or the hint promises one number and
  // the agreement prints another.
  it('counts months on the calendar, the way the agreement does', () => {
    expect(monthsBetween('2026-08-01', '2027-08-15')).toBe('12')
    expect(monthsBetween('2026-08-01', '2027-07-15')).toBe('11')
    expect(monthsBetween('2026-08-01', '')).toBe('')
    expect(monthsBetween('2027-08-01', '2026-08-01')).toBe('')
  })

  it('agrees with what the token layer will actually print', () => {
    const deal = { comp_data: { listing_start: '2026-08-01', listing_end: '2027-08-15' } }
    expect(derivedTermHint('agreement_term_months', deal)).toContain('12')
    expect(crmTokenValues({ deal }).agreement_term_months).toBe('12')
  })

  it('shows no hint when nothing can be derived', () => {
    expect(derivedTermHint('agreement_term_months', { comp_data: {} })).toBeNull()
    expect(derivedTermHint('title_company', { comp_data: {} })).toBeNull()
  })
})
