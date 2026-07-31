import { describe, it, expect } from 'vitest'
import {
  dealCommissionEntry, describeDealCommission, computeCommission,
  normalizeCommission, breakdownForDeal, makeSide, DEFAULTS,
} from '../commission.js'

const AGENTS = [{ id: 'a-dan', name: 'Daniel', default_split_pct: 70 }]
const deal = (over = {}) => ({ id: 'd1', value: 500_000, agent_id: 'a-dan', ...over })

// ── The agent's entry on the deal Details tab ────────────────────────────────
describe('dealCommissionEntry', () => {
  it('reads a percentage deal', () => {
    expect(dealCommissionEntry(deal({ commission_type: 'percent', commission_pct: 2.5 })))
      .toEqual({ type: 'percent', pct: 2.5, flat: 0 })
  })

  it('reads a flat-fee deal', () => {
    expect(dealCommissionEntry(deal({ commission_type: 'flat', commission_flat: 12_500 })))
      .toEqual({ type: 'flat', pct: 0, flat: 12_500 })
  })

  it('treats a missing type flag as a percentage deal (legacy commission_pct rows)', () => {
    expect(dealCommissionEntry(deal({ commission_pct: 3 })))
      .toEqual({ type: 'percent', pct: 3, flat: 0 })
  })

  it('is null when nothing is entered, so the deal falls through to the default gross', () => {
    expect(dealCommissionEntry(deal())).toBeNull()
    expect(dealCommissionEntry(deal({ commission_type: 'percent', commission_pct: null }))).toBeNull()
    expect(dealCommissionEntry(deal({ commission_type: 'flat', commission_flat: 0 }))).toBeNull()
    expect(dealCommissionEntry(null)).toBeNull()
  })

  it('ignores the field the chosen type does not use', () => {
    // A stale percentage left over from before the agent switched to a flat fee
    // must not resurrect itself.
    expect(dealCommissionEntry(deal({ commission_type: 'flat', commission_flat: 9_000, commission_pct: 3 })))
      .toEqual({ type: 'flat', pct: 0, flat: 9_000 })
  })
})

describe('describeDealCommission', () => {
  it('resolves a percentage into gross dollars', () => {
    expect(describeDealCommission(deal({ commission_type: 'percent', commission_pct: 3 })).gross).toBe(15_000)
  })

  it('a flat fee is the gross, independent of the deal value', () => {
    expect(describeDealCommission(deal({ commission_type: 'flat', commission_flat: 12_500 })).gross).toBe(12_500)
    expect(describeDealCommission(deal({ value: 0, commission_type: 'flat', commission_flat: 12_500 })).gross).toBe(12_500)
  })

  it('a percentage on a deal with no value is $0 gross, not an error', () => {
    expect(describeDealCommission(deal({ value: null, commission_type: 'percent', commission_pct: 3 })).gross).toBe(0)
  })
})

// ── Flat-fee sides in the engine ─────────────────────────────────────────────
describe('computeCommission — flat-fee sides', () => {
  it('a flat side grosses the fee itself and ignores the percentage rate', () => {
    const r = computeCommission({
      sale_price: 500_000,
      sides: [{ ...makeSide('sale', 3, 12_500) }],
      participants: [{ id: 'p1', agent_id: 'a-dan', role: 'primary', allocation_pct: 100, split_pct: 70 }],
    })
    expect(r.gross_total).toBe(12_500)          // NOT 15,000 — flat wins over the 3%
    expect(r.net_total).toBe(12_500)
    expect(r.participants[0].agent_take).toBeCloseTo(8_750, 2)   // 70%
  })

  it('reports the blended effective rate for a flat fee', () => {
    const r = computeCommission({
      sale_price: 500_000,
      sides: [{ ...makeSide('sale', 0, 12_500) }],
      participants: [{ id: 'p1', role: 'primary', allocation_pct: 100, split_pct: 70 }],
    })
    expect(r.effective_rate_pct).toBe(2.5)      // 12,500 / 500,000
  })

  it('a flat fee still works when the deal has no sale price', () => {
    const r = computeCommission({
      sale_price: 0,
      sides: [{ ...makeSide('sale', 3, 5_000) }],
      participants: [{ id: 'p1', role: 'primary', allocation_pct: 100, split_pct: 100 }],
    })
    expect(r.gross_total).toBe(5_000)
    expect(r.effective_rate_pct).toBe(0)        // no sale price to blend against
  })

  it('referrals come off a flat side the same way they come off a percentage side', () => {
    const r = computeCommission({
      sale_price: 500_000,
      sides: [{ ...makeSide('sale', 0, 10_000), referral_pct: 25 }],
      participants: [{ id: 'p1', role: 'primary', allocation_pct: 100, split_pct: 100 }],
    })
    expect(r.gross_total).toBe(10_000)
    expect(r.referral_total).toBe(2_500)
    expect(r.net_total).toBe(7_500)
  })

  it('mixes a flat listing side with a percentage buyer side', () => {
    const r = computeCommission({
      sale_price: 1_000_000,
      sides: [{ ...makeSide('listing', 0, 20_000) }, { ...makeSide('buyer', 3) }],
      participants: [{ id: 'p1', role: 'primary', allocation_pct: 100, split_pct: 100 }],
    })
    expect(r.sides[0].gross).toBe(20_000)
    expect(r.sides[1].gross).toBe(30_000)
    expect(r.gross_total).toBe(50_000)
  })

  it('a zero/absent flat leaves the percentage rate in charge (backward compatible)', () => {
    const withZero  = computeCommission({ sale_price: 500_000, sides: [{ ...makeSide('sale', 3, 0) }], participants: [{ id: 'p1', role: 'primary', allocation_pct: 100, split_pct: 100 }] })
    const withoutIt = computeCommission({ sale_price: 500_000, sides: [{ id: 's', key: 'sale', rate_pct: 3 }],  participants: [{ id: 'p1', role: 'primary', allocation_pct: 100, split_pct: 100 }] })
    expect(withZero.gross_total).toBe(15_000)
    expect(withoutIt.gross_total).toBe(15_000)
  })
})

// ── Precedence: structured sides > deal entry > legacy scalar > default ──────
describe('normalizeCommission — where the gross comes from', () => {
  it('uses the default gross when nothing is entered anywhere', () => {
    const n = normalizeCommission(null, { deal: deal(), agents: AGENTS })
    expect(n.sides[0].rate_pct).toBe(DEFAULTS.GROSS_PCT)
    expect(n.sides[0].flat).toBe(0)
  })

  it("seeds from the agent's percentage entry when there is no commission row", () => {
    const n = normalizeCommission(null, { deal: deal({ commission_type: 'percent', commission_pct: 2.75 }), agents: AGENTS })
    expect(n.sides[0].rate_pct).toBe(2.75)
    expect(n.sides[0].flat).toBe(0)
  })

  it("seeds from the agent's flat fee and zeroes the rate so the fee is unambiguous", () => {
    const n = normalizeCommission(null, { deal: deal({ commission_type: 'flat', commission_flat: 12_500 }), agents: AGENTS })
    expect(n.sides[0].flat).toBe(12_500)
    expect(n.sides[0].rate_pct).toBe(0)
  })

  it("the agent's entry outranks a legacy gross_pct scalar", () => {
    const legacy = { id: 'c1', deal_id: 'd1', gross_pct: 3, agent_pct: 70, sides: [], participants: [] }
    const n = normalizeCommission(legacy, { deal: deal({ commission_type: 'percent', commission_pct: 2 }), agents: AGENTS })
    expect(n.sides[0].rate_pct).toBe(2)
  })

  it('a legacy row still drives deals where the agent entered nothing', () => {
    const legacy = { id: 'c1', deal_id: 'd1', gross_pct: 4, agent_pct: 70, sides: [], participants: [] }
    const n = normalizeCommission(legacy, { deal: deal(), agents: AGENTS })
    expect(n.sides[0].rate_pct).toBe(4)
  })

  it("the back office's structured sides beat the agent's entry", () => {
    const structured = {
      id: 'c1', deal_id: 'd1',
      sides: [{ id: 's1', key: 'sale', label: 'Sale', rate_pct: 5, referral_pct: 0, referral_flat: 0 }],
      participants: [{ id: 'p1', agent_id: 'a-dan', role: 'primary', allocation_pct: 100, split_pct: 70 }],
      transaction_fee: 0,
    }
    const n = normalizeCommission(structured, { deal: deal({ commission_type: 'flat', commission_flat: 99_999 }), agents: AGENTS })
    expect(n.sides[0].rate_pct).toBe(5)
    expect(n.sides[0].flat).toBe(0)
  })

  it('preserves a flat fee an admin saved into structured sides', () => {
    const structured = {
      id: 'c1', deal_id: 'd1',
      sides: [{ id: 's1', key: 'sale', label: 'Sale', rate_pct: 0, flat: 8_000, referral_pct: 0, referral_flat: 0 }],
      participants: [{ id: 'p1', agent_id: 'a-dan', role: 'primary', allocation_pct: 100, split_pct: 70 }],
      transaction_fee: 0,
    }
    expect(normalizeCommission(structured, { deal: deal(), agents: AGENTS }).sides[0].flat).toBe(8_000)
  })
})

// ── End to end: the number the agent typed reaches the reports ───────────────
describe('breakdownForDeal — an agent-entered deal with no commission row', () => {
  it('a flat fee flows all the way through to take-home and house dollars', () => {
    const r = breakdownForDeal(deal({ commission_type: 'flat', commission_flat: 10_000 }), null, AGENTS)
    expect(r.gross_total).toBe(10_000)
    expect(r.agent_total).toBeCloseTo(7_000, 2)   // 70% default split
    expect(r.house_total).toBeCloseTo(3_000, 2)
    expect(r.effective_rate_pct).toBe(2)          // 10,000 / 500,000
  })

  it('a percentage flows through the same way', () => {
    const r = breakdownForDeal(deal({ commission_type: 'percent', commission_pct: 2 }), null, AGENTS)
    expect(r.gross_total).toBe(10_000)
    expect(r.agent_total).toBeCloseTo(7_000, 2)
  })
})
