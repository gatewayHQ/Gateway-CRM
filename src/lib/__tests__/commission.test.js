import { describe, it, expect } from 'vitest'
import {
  breakdownForDeal, computeCommission, normalizeCommission, makeSide,
  dealCompensation, dealCompPayload, DEFAULTS,
} from '../commission.js'
import { validateAgentComp } from '../validation.js'

const AGENTS = [{ id: 'a-dan', name: 'Daniel', default_split_pct: 70 }]

// A deal with no agent-set compensation — every deal that predates migration 0024.
const legacyDeal = (over = {}) => ({ id: 'd1', value: 1_000_000, agent_id: 'a-dan', ...over })

describe('dealCompensation', () => {
  it('reads only the amount matching the stored type', () => {
    // A stale flat amount alongside type 'rate' is ignored — that's what makes
    // the two options mutually exclusive no matter what is in the row.
    expect(dealCompensation({ agent_comp_type: 'rate', agent_comp_rate_pct: 2.5, agent_comp_flat: 9999 }))
      .toEqual({ type: 'rate', rate_pct: 2.5, flat: 0 })
    expect(dealCompensation({ agent_comp_type: 'flat', agent_comp_flat: 2500, agent_comp_rate_pct: 3 }))
      .toEqual({ type: 'flat', rate_pct: 0, flat: 2500 })
  })

  it('is null when unset, zero, or unparseable', () => {
    expect(dealCompensation(null)).toBeNull()
    expect(dealCompensation({})).toBeNull()
    expect(dealCompensation({ agent_comp_type: 'rate', agent_comp_rate_pct: 0 })).toBeNull()
    expect(dealCompensation({ agent_comp_type: 'flat', agent_comp_flat: null })).toBeNull()
  })
})

describe('dealCompPayload', () => {
  it('writes the chosen amount and nulls the other', () => {
    expect(dealCompPayload({ agent_comp_type: 'rate', agent_comp_rate_pct: '2.5', agent_comp_flat: '2500' }))
      .toEqual({ agent_comp_type: 'rate', agent_comp_rate_pct: 2.5, agent_comp_flat: null })
    expect(dealCompPayload({ agent_comp_type: 'flat', agent_comp_flat: '2500', agent_comp_rate_pct: '3' }))
      .toEqual({ agent_comp_type: 'flat', agent_comp_rate_pct: null, agent_comp_flat: 2500 })
  })

  it('clears all three columns when the amount is blank', () => {
    expect(dealCompPayload({ agent_comp_type: 'rate', agent_comp_rate_pct: '' }))
      .toEqual({ agent_comp_type: null, agent_comp_rate_pct: null, agent_comp_flat: null })
  })
})

describe('flat-fee sides', () => {
  it('prices a side by its flat fee instead of the rate', () => {
    const r = computeCommission({ sale_price: 1_000_000, sides: [{ ...makeSide('sale', 3, 5_000) }] })
    expect(r.gross_total).toBe(5_000)
    expect(r.is_flat).toBe(true)
    // Effective rate is still reported so the "GC %" column has a number.
    expect(r.effective_rate_pct).toBeCloseTo(0.5, 3)
  })

  it('a flat fee earns even when the deal has no value yet', () => {
    const r = computeCommission({ sale_price: 0, sides: [{ ...makeSide('sale', 0, 2_500) }] })
    expect(r.gross_total).toBe(2_500)
  })

  it('a referral percentage comes off the flat fee', () => {
    const r = computeCommission({ sale_price: 0, sides: [{ ...makeSide('sale', 0, 10_000), referral_pct: 25 }] })
    expect(r.net_total).toBe(7_500)
  })

  it('rate pricing is untouched when no flat fee is set', () => {
    const r = computeCommission({ sale_price: 1_000_000, sides: [makeSide('sale', 3)] })
    expect(r.gross_total).toBe(30_000)
    expect(r.is_flat).toBe(false)
  })
})

describe('agent-set compensation as the default', () => {
  it('a rate the agent entered prices the deal when no commission row exists', () => {
    const deal = legacyDeal({ agent_comp_type: 'rate', agent_comp_rate_pct: 2 })
    const r = breakdownForDeal(deal, null, AGENTS)
    expect(r.gross_total).toBe(20_000)          // 2% of 1M, not the firm's 3%
    expect(r.comp_source).toBe('agent')
    expect(r.agentAmt).toBeCloseTo(14_000, 2)   // 70% default split
  })

  it('a flat fee the agent entered prices the deal', () => {
    const deal = legacyDeal({ agent_comp_type: 'flat', agent_comp_flat: 7_500 })
    const r = breakdownForDeal(deal, null, AGENTS)
    expect(r.gross_total).toBe(7_500)
    expect(r.is_flat).toBe(true)
    expect(r.comp_source).toBe('agent')
  })

  it('an admin-saved commission row overrides the agent entry', () => {
    const deal = legacyDeal({ agent_comp_type: 'flat', agent_comp_flat: 7_500 })
    const admin = { id: 'c1', deal_id: 'd1', gross_pct: 4, agent_pct: 70, transaction_fee: 0 }
    const r = breakdownForDeal(deal, admin, AGENTS)
    expect(r.gross_total).toBe(40_000)
    expect(r.is_flat).toBe(false)
    expect(r.comp_source).toBe('admin')
  })

  it('an admin structured row (splits) overrides the agent entry', () => {
    const deal = legacyDeal({ agent_comp_type: 'rate', agent_comp_rate_pct: 1 })
    const admin = {
      id: 'c1', deal_id: 'd1',
      sides: [{ id: 's1', key: 'sale', label: 'Sale', rate_pct: 3, referral_pct: 0 }],
      participants: [{ id: 'p1', agent_id: 'a-dan', role: 'primary', allocation_pct: 100, split_pct: 70, fee: 0 }],
      transaction_fee: 0,
    }
    const r = breakdownForDeal(deal, admin, AGENTS)
    expect(r.gross_total).toBe(30_000)
    expect(r.comp_source).toBe('admin')
  })

  it('deals that predate the field are unchanged — the firm default still applies', () => {
    const r = breakdownForDeal(legacyDeal(), null, AGENTS)
    expect(r.gross_total).toBe(1_000_000 * DEFAULTS.GROSS_PCT / 100)
    expect(r.comp_source).toBe('default')
    expect(r.is_flat).toBe(false)
  })

  it('normalizeCommission keeps a stored flat side in flat mode', () => {
    const stored = {
      id: 'c1', deal_id: 'd1',
      sides: [{ id: 's1', key: 'sale', label: 'Sale', rate_pct: 0, flat: 4_000, referral_pct: 0 }],
      participants: [{ id: 'p1', agent_id: 'a-dan', role: 'primary', allocation_pct: 100, split_pct: 70 }],
    }
    const norm = normalizeCommission(stored, { deal: legacyDeal(), agents: AGENTS })
    expect(norm.sides[0].flat).toBe(4_000)
    expect(computeCommission(norm).gross_total).toBe(4_000)
  })
})

describe('validateAgentComp', () => {
  it('accepts a sane rate and a sane flat fee', () => {
    expect(validateAgentComp({ type: 'rate', rate_pct: '3' }).valid).toBe(true)
    expect(validateAgentComp({ type: 'flat', flat: '2500' }).valid).toBe(true)
  })

  it('rejects zero, negative, non-numeric, and out-of-range rates', () => {
    expect(validateAgentComp({ type: 'rate', rate_pct: '0' }).valid).toBe(false)
    expect(validateAgentComp({ type: 'flat', flat: '-100' }).valid).toBe(false)
    expect(validateAgentComp({ type: 'rate', rate_pct: 'abc' }).valid).toBe(false)
    expect(validateAgentComp({ type: 'rate', rate_pct: '120' }).valid).toBe(false)
  })

  it('a flat fee above 100 is fine — only rates are capped', () => {
    expect(validateAgentComp({ type: 'flat', flat: '12000' }).valid).toBe(true)
  })

  it('only the chosen field is checked', () => {
    // Flat chosen, rate left blank → still valid.
    expect(validateAgentComp({ type: 'flat', flat: '2500', rate_pct: '' }).valid).toBe(true)
  })

  it('required on create, optional when editing a pre-existing deal', () => {
    expect(validateAgentComp({ type: 'rate', rate_pct: '' }).valid).toBe(false)
    expect(validateAgentComp({ type: 'rate', rate_pct: '' }, { required: false }).valid).toBe(true)
  })
})
