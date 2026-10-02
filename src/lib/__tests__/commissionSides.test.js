// Buyer side / seller side. Every total on a deal is split by where the money
// comes from, and an agent who represents both sides sees how much of their
// take came from each.
import { describe, it, expect } from 'vitest'
import {
  breakdownForDeal, agentSliceForDeal, describeDealCommission, dealSideEntries,
  totalEntryForSides, partyForSide, apportion, makeSide,
} from '../commission.js'

const agents = [
  { id: 'a1', name: 'Ann', default_split_pct: 70 },
  { id: 'a2', name: 'Ben', default_split_pct: 80 },
]
const both = (sides, extra = {}) => ({
  id: 'd1', value: 1_000_000, agent_id: 'a1',
  comp_data: { transaction_type: 'both', commission_sides: sides }, ...extra,
})

describe('partyForSide', () => {
  it('reads listing as seller and buyer as buyer', () => {
    expect(partyForSide('listing', {})).toBe('seller')
    expect(partyForSide('buyer', {})).toBe('buyer')
  })
  it('places a single sale side by what the deal represents', () => {
    expect(partyForSide('sale', { comp_data: { transaction_type: 'seller' } })).toBe('seller')
    expect(partyForSide('sale', { comp_data: { transaction_type: 'buyer' } })).toBe('buyer')
    expect(partyForSide('sale', {})).toBe('buyer')
    expect(partyForSide('sale', { comp_data: { transaction_type: 'both' } })).toBe('unsplit')
  })
})

describe('apportion', () => {
  it('adds back up to the total to the cent', () => {
    const parts = apportion(100, [1, 1, 1])
    expect(parts).toEqual([33.33, 33.33, 33.34])
    expect(parts.reduce((t, x) => t + x, 0)).toBeCloseTo(100, 10)
  })
  it('puts everything on the last part when there is no weight', () => {
    expect(apportion(50, [0, 0])).toEqual([0, 50])
  })
})

describe('per-side entry on a both-sides deal', () => {
  it('is only read when the deal represents both', () => {
    expect(dealSideEntries(both({ seller: { type: 'percent', pct: 3 } }))).not.toBeNull()
    expect(dealSideEntries({ comp_data: { transaction_type: 'seller', commission_sides: { seller: { type: 'percent', pct: 3 } } } })).toBeNull()
  })

  it('totals two percentages as a percentage, and a flat fee as dollars', () => {
    expect(totalEntryForSides({ seller: { type: 'percent', pct: 3 }, buyer: { type: 'percent', pct: 2.5 } }, 1_000_000))
      .toEqual({ commission_type: 'percent', commission_pct: 5.5, commission_flat: null })
    expect(totalEntryForSides({ seller: { type: 'percent', pct: 3 }, buyer: { type: 'flat', flat: 10_000 } }, 1_000_000))
      .toEqual({ commission_type: 'flat', commission_pct: null, commission_flat: 40_000 })
  })

  it('describes each side and the total', () => {
    const d = describeDealCommission(both({ seller: { type: 'percent', pct: 3 }, buyer: { type: 'flat', flat: 10_000 } }))
    expect(d.gross).toBe(40_000)
    expect(d.sides.map(s => [s.party, s.gross])).toEqual([['seller', 30_000], ['buyer', 10_000]])
  })
})

describe('breakdown by side', () => {
  it('splits gross, agent take and house between seller and buyer', () => {
    const r = breakdownForDeal(both({ seller: { type: 'percent', pct: 3 }, buyer: { type: 'percent', pct: 1 } }), null, agents)
    expect(r.gross_total).toBe(40_000)
    const [seller, buyer] = r.parties
    expect([seller.party, seller.gross, buyer.party, buyer.gross]).toEqual(['seller', 30_000, 'buyer', 10_000])
    // Ann keeps her 70% less the $100 fee — $27,900 — split 3:1 by side.
    expect(seller.agent_take + buyer.agent_take).toBeCloseTo(r.agent_total, 2)
    expect(seller.house + buyer.house).toBeCloseTo(r.house_total, 2)
    expect(seller.agent_take).toBeCloseTo(20_925, 2)
    expect(buyer.agent_take).toBeCloseTo(6_975, 2)
  })

  it('places a one-sided deal entirely on its side', () => {
    const r = breakdownForDeal({ id: 'd1', value: 500_000, agent_id: 'a1', commission_type: 'percent', commission_pct: 3, comp_data: { transaction_type: 'seller' } }, null, agents)
    expect(r.parties.map(p => [p.party, p.gross])).toEqual([['seller', 15_000]])
  })

  it('says a both-sides deal with one combined number is not split', () => {
    const r = breakdownForDeal({ id: 'd1', value: 500_000, agent_id: 'a1', commission_type: 'percent', commission_pct: 5, comp_data: { transaction_type: 'both' } }, null, agents)
    expect(r.parties.map(p => p.party)).toEqual(['unsplit'])
  })

  it('uses the back office’s listing and buyer sides when it has saved them', () => {
    const commission = {
      sides: [makeSide('listing', 3), makeSide('buyer', 2)],
      participants: [
        { id: 'p1', agent_id: 'a1', role: 'primary', allocation_pct: 50, split_pct: 70 },
        { id: 'p2', agent_id: 'a2', role: 'co', allocation_pct: 50, split_pct: 80 },
      ],
      transaction_fee: 100,
    }
    const deal = { id: 'd1', value: 1_000_000, agent_id: 'a1', comp_data: { transaction_type: 'both' } }
    const r = breakdownForDeal(deal, commission, agents)
    expect(r.parties.map(p => [p.party, p.gross])).toEqual([['seller', 30_000], ['buyer', 20_000]])
    for (const p of r.participants) {
      expect(p.by_party.seller + p.by_party.buyer).toBeCloseTo(p.agent_take, 2)
    }
    // Each agent sees their own take split by side.
    const ben = agentSliceForDeal(deal, commission, agents, 'a2')
    expect(ben.byParty.map(x => x.party)).toEqual(['seller', 'buyer'])
    expect(ben.byParty[0].take + ben.byParty[1].take).toBeCloseTo(ben.take, 2)
    expect(ben.byParty[0].take / ben.take).toBeCloseTo(0.6, 2)
  })
})
