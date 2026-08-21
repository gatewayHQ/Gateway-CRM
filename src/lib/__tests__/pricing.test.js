import { describe, it, expect } from 'vitest'
import {
  normalizePrice, priceChanged, dealsToRepriceFor, planPriceSync,
  normalizeEntry, normalizeHistory, mergeHistory, describeChange,
} from '../pricing.js'

// The bug this guards: a price lives on `properties.list_price` AND on
// `deals.value`, both editable from their own drawer. Reducing it on the deal
// left the listing advertising the old number and never reached the Price
// History tab the seller is shown; reducing it on the property left every open
// deal — and the commission math on it — stale.

const AT = '2026-08-21T15:00:00.000Z'
const ACTOR = { id: 'agent-1', name: 'Daniel Stillson' }
const property = { id: 'prop-1', list_price: 500000, price_history: [] }

describe('normalizePrice', () => {
  it('accepts what a number input actually produces', () => {
    expect(normalizePrice('450000')).toBe(450000)
    expect(normalizePrice(450000)).toBe(450000)
    expect(normalizePrice(0)).toBe(0)
  })

  it('reads an empty or unusable field as "no price", never as zero', () => {
    // A blank listing price is not a listing priced at nothing, and deals.value
    // carries a >= 0 CHECK a NaN or a stray '-' would trip.
    expect(normalizePrice('')).toBeNull()
    expect(normalizePrice(null)).toBeNull()
    expect(normalizePrice(undefined)).toBeNull()
    expect(normalizePrice('-')).toBeNull()
    expect(normalizePrice('abc')).toBeNull()
    expect(normalizePrice(-1)).toBeNull()
    expect(normalizePrice(Infinity)).toBeNull()
  })
})

describe('priceChanged', () => {
  it('compares numbers, not the strings they arrived as', () => {
    expect(priceChanged('500000', 500000)).toBe(false)
    expect(priceChanged('', null)).toBe(false)
    expect(priceChanged('485000', 500000)).toBe(true)
  })
})

describe('dealsToRepriceFor', () => {
  const deals = [
    { id: 'd-open',    property_id: 'prop-1', stage: 'under-contract', value: 500000 },
    { id: 'd-lead',    property_id: 'prop-1', stage: 'lead',           value: null },
    { id: 'd-closed',  property_id: 'prop-1', stage: 'closed',         value: 500000 },
    { id: 'd-lost',    property_id: 'prop-1', stage: 'lost',           value: 500000 },
    { id: 'd-other',   property_id: 'prop-2', stage: 'lead',           value: 500000 },
    { id: 'd-current', property_id: 'prop-1', stage: 'offer',          value: 485000 },
  ]

  it('repriced the open deals on that property that are out of date', () => {
    expect(dealsToRepriceFor({ propertyId: 'prop-1', deals, price: 485000 }).map(d => d.id))
      .toEqual(['d-open', 'd-lead'])
  })

  it('never touches a closed or lost deal', () => {
    // A closed deal's value is what it actually sold for; rewriting it would
    // rewrite the commission and every report built on it.
    const ids = dealsToRepriceFor({ propertyId: 'prop-1', deals, price: 485000 }).map(d => d.id)
    expect(ids).not.toContain('d-closed')
    expect(ids).not.toContain('d-lost')
  })

  it('skips the deal the edit came from, and needs a property to propagate', () => {
    expect(dealsToRepriceFor({ propertyId: 'prop-1', deals, price: 485000, excludeDealId: 'd-open' }).map(d => d.id))
      .toEqual(['d-lead'])
    expect(dealsToRepriceFor({ propertyId: null, deals, price: 485000 })).toEqual([])
  })
})

describe('planPriceSync — edit on the deal', () => {
  const plan = planPriceSync({
    price: '485000', previousPrice: 500000, origin: 'deal', property, dealId: 'd-1',
    deals: [
      { id: 'd-1', property_id: 'prop-1', stage: 'offer', value: 500000 },
      { id: 'd-2', property_id: 'prop-1', stage: 'lead',  value: 500000 },
    ],
    actor: ACTOR, at: AT,
  })

  it('pushes the new price onto the property', () => {
    expect(plan.changed).toBe(true)
    expect(plan.propertyUpdate).toEqual({ list_price: 485000 })
  })

  it('repriced the OTHER open deals but not the one being saved', () => {
    // The origin deal's own drawer writes its value in the same submit.
    expect(plan.dealUpdates).toEqual([{ id: 'd-2', value: 485000 }])
  })

  it('records who changed it, when, and which deal it was typed on', () => {
    expect(plan.historyRow).toEqual({
      property_id: 'prop-1', deal_id: 'd-1',
      price: 485000, previous_price: 500000,
      source: 'deal', changed_by: 'agent-1', changed_by_name: 'Daniel Stillson',
      created_at: AT,
    })
  })

  it('mirrors the entry into the property jsonb the landing page reads', () => {
    expect(plan.legacyHistory).toEqual([{
      price: 485000, previous_price: 500000,
      date: '2026-08-21', changed_at: AT,
      source: 'deal', changed_by: 'agent-1', changed_by_name: 'Daniel Stillson',
    }])
  })

  it('appends to an existing history rather than replacing it', () => {
    const withHistory = planPriceSync({
      price: 470000, previousPrice: 485000, origin: 'deal', dealId: 'd-1', at: AT,
      property: { id: 'prop-1', list_price: 485000, price_history: [{ price: 485000, previous_price: 500000, date: '2026-07-01' }] },
    })
    expect(withHistory.legacyHistory.map(e => e.price)).toEqual([485000, 470000])
  })
})

describe('planPriceSync — edit on the property', () => {
  it('leaves the property alone (its own drawer saves it) and repriced every open deal', () => {
    const plan = planPriceSync({
      price: 485000, previousPrice: 500000, origin: 'property', property,
      deals: [
        { id: 'd-1', property_id: 'prop-1', stage: 'offer',  value: 500000 },
        { id: 'd-2', property_id: 'prop-1', stage: 'closed', value: 500000 },
      ],
      actor: ACTOR, at: AT,
    })
    expect(plan.propertyUpdate).toBeNull()
    expect(plan.dealUpdates).toEqual([{ id: 'd-1', value: 485000 }])
    expect(plan.historyRow.source).toBe('property')
    expect(plan.historyRow.deal_id).toBeNull()
  })
})

describe('planPriceSync — when there is nothing to do', () => {
  it('is a no-op when the price did not really change', () => {
    const plan = planPriceSync({ price: '500000', previousPrice: 500000, origin: 'deal', property, at: AT })
    expect(plan.changed).toBe(false)
    expect(plan.historyRow).toBeNull()
    expect(plan.dealUpdates).toEqual([])
    expect(plan.legacyHistory).toBeNull()
  })

  it('never lets a cleared field wipe the price off the other record', () => {
    // Tidying the deal's value field must not blank the listing price — and the
    // public landing page — as a side effect.
    const plan = planPriceSync({ price: '', previousPrice: 500000, origin: 'deal', property, at: AT })
    expect(plan.changed).toBe(false)
    expect(plan.propertyUpdate).toBeNull()
  })

  it('records the first price on a deal with no property, with nothing to mirror to', () => {
    const plan = planPriceSync({ price: 300000, previousPrice: null, origin: 'deal', dealId: 'd-1', at: AT })
    expect(plan.changed).toBe(true)
    expect(plan.historyRow).toMatchObject({ property_id: null, deal_id: 'd-1', previous_price: null })
    expect(plan.legacyHistory).toBeNull()
  })
})

describe('normalizeEntry', () => {
  it('reads a pricing_history row and a legacy jsonb entry the same way', () => {
    const row = normalizeEntry({
      id: 'ph-1', property_id: 'prop-1', deal_id: 'd-1', price: 485000, previous_price: 500000,
      source: 'deal', changed_by: 'agent-1', changed_by_name: 'Daniel Stillson', created_at: AT,
    })
    const legacy = normalizeEntry({ price: 485000, previous_price: 500000, date: '2026-08-21' })
    expect(row).toMatchObject({ price: 485000, previousPrice: 500000, reduction: 15000, changedByName: 'Daniel Stillson' })
    expect(legacy).toMatchObject({ price: 485000, previousPrice: 500000, reduction: 15000, changedByName: null, at: '2026-08-21' })
  })

  it('marks a first-ever price as having nothing to compare to', () => {
    // Rendered as "Initial price" — not as a reduction from zero.
    expect(normalizeEntry({ price: 500000, previous_price: null }).reduction).toBeNull()
  })

  it('reports an increase as a negative reduction', () => {
    expect(normalizeEntry({ price: 520000, previous_price: 500000 }).reduction).toBe(-20000)
  })

  it('drops junk instead of rendering an empty row', () => {
    expect(normalizeEntry(null)).toBeNull()
    expect(normalizeEntry('nope')).toBeNull()
    expect(normalizeEntry({ note: 'no prices here' })).toBeNull()
    expect(normalizeHistory(null)).toEqual([])
    expect(normalizeHistory([null, { price: 1 }])).toHaveLength(1)
  })
})

describe('mergeHistory', () => {
  it('shows the union, oldest first, when the two sources disagree', () => {
    // An app deployed ahead of migration 0040 writes the jsonb mirror while the
    // table insert fails — the change must still be visible.
    const rows   = [{ price: 485000, previous_price: 500000, created_at: '2026-07-01T00:00:00Z', changed_by_name: 'Daniel' }]
    const legacy = [{ price: 470000, previous_price: 485000, date: '2026-08-01' }]
    expect(mergeHistory(rows, legacy).map(e => e.price)).toEqual([485000, 470000])
  })

  it('does not show the imported copy twice', () => {
    // Migration 0040 copies the jsonb into the table; both are then present.
    const rows   = [{ price: 485000, previous_price: 500000, created_at: '2026-07-01T09:00:00Z', changed_by_name: 'Daniel' }]
    const legacy = [{ price: 485000, previous_price: 500000, date: '2026-07-01' }]
    const merged = mergeHistory(rows, legacy)
    expect(merged).toHaveLength(1)
    // The table row wins the collision: it is the one carrying the actor.
    expect(merged[0].changedByName).toBe('Daniel')
  })

  it('tolerates either source being missing', () => {
    expect(mergeHistory(null, null)).toEqual([])
    expect(mergeHistory(undefined, [{ price: 1, previous_price: 2 }])).toHaveLength(1)
  })
})

describe('describeChange', () => {
  const fmt = (n) => `$${Number(n).toLocaleString()}`
  it('reads as an audit line', () => {
    expect(describeChange(normalizeEntry({ price: 485000, previous_price: 500000 }), fmt))
      .toBe('Price reduced $500,000 → $485,000')
    expect(describeChange(normalizeEntry({ price: 520000, previous_price: 500000 }), fmt))
      .toBe('Price increased $500,000 → $520,000')
    expect(describeChange(normalizeEntry({ price: 500000, previous_price: null }), fmt))
      .toBe('Price set to $500,000')
    expect(describeChange(null)).toBe('')
  })
})
