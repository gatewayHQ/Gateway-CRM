// The split an agent actually works on: their own arrangement with the office,
// and 100% once the office confirms their cap. These are the numbers an agent
// reads as "what I'll really make", so each rule is pinned here.
import { describe, it, expect } from 'vitest'
import {
  agentArrangement, capCovers, capConfirmedUntil, dealCommissionDate,
  breakdownForDeal, agentSliceForDeal, makeSide, capStatusFor, todayIso, agentFee,
} from '../commission.js'

const at = (iso) => new Date(`${iso}T12:00:00`)
const agents = [
  { id: 'ann', name: 'Ann', default_split_pct: 80 },
  { id: 'pre', name: 'Pre-paid Pat', no_brokerage_split: true, default_split_pct: 100 },
  { id: 'cal', name: 'Capped Cal', default_split_pct: 70, cap_amount: 20000, cap_anniversary: '2020-04-01', cap_confirmed_at: '2026-03-10' },
]
const closedOn = (iso, extra = {}) => ({
  id: 'd', value: 500_000, stage: 'closed', updated_at: `${iso}T15:00:00Z`,
  commission_type: 'percent', commission_pct: 3, comp_data: { transaction_type: 'seller' }, ...extra,
})

describe('dealCommissionDate', () => {
  it('is the closing date for a closed deal', () => {
    expect(dealCommissionDate(closedOn('2026-05-02')).toISOString().slice(0, 10)).toBe('2026-05-02')
  })
  it('is the expected close for an open deal, never before today', () => {
    const now = at('2026-06-01')
    expect(dealCommissionDate({ stage: 'psa', expected_close_date: '2026-08-15' }, now).toISOString().slice(0, 10)).toBe('2026-08-15')
    expect(dealCommissionDate({ stage: 'psa', expected_close_date: '2026-01-15' }, now)).toBe(now)
    expect(dealCommissionDate({ stage: 'lead' }, now)).toBe(now)
  })
})

describe('capCovers', () => {
  const cal = agents[2]
  it('runs from the confirmation to the next cap anniversary', () => {
    expect(capConfirmedUntil(cal).toISOString().slice(0, 10)).toBe('2026-04-01')
    expect(capCovers(cal, at('2026-03-10'))).toBe(true)
    expect(capCovers(cal, at('2026-03-31'))).toBe(true)
  })
  it('does not reach back before the confirmation, or past the reset', () => {
    expect(capCovers(cal, at('2026-03-09'))).toBe(false)
    expect(capCovers(cal, at('2026-04-01'))).toBe(false)
  })
  it('resets on the calendar year without an anniversary', () => {
    const noAnniv = { cap_confirmed_at: '2026-09-01' }
    expect(capCovers(noAnniv, at('2026-12-31'))).toBe(true)
    expect(capCovers(noAnniv, at('2027-01-01'))).toBe(false)
  })
  it('is nothing without a confirmation', () => {
    expect(capCovers({ cap_amount: 1 }, at('2026-03-10'))).toBe(false)
  })
})

describe('agentArrangement', () => {
  it('uses the agent’s own split', () => {
    expect(agentArrangement(agents[0], closedOn('2026-05-01'))).toEqual({ split_pct: 80, no_split: false, basis: 'split' })
  })
  it('keeps 100% for a pre-paid agent', () => {
    expect(agentArrangement(agents[1], closedOn('2026-05-01'))).toMatchObject({ split_pct: 100, no_split: true, basis: 'prepaid' })
  })
  it('keeps 100% on a deal inside the confirmed cap, and the split outside it', () => {
    expect(agentArrangement(agents[2], closedOn('2026-03-20'))).toMatchObject({ split_pct: 100, no_split: true, basis: 'cap' })
    expect(agentArrangement(agents[2], closedOn('2026-02-20'))).toMatchObject({ split_pct: 70, basis: 'split' })
  })
})

describe('take-home on a deal the back office has not touched', () => {
  it('pays the agent their own split, less the standard fee', () => {
    const r = breakdownForDeal({ ...closedOn('2026-05-01'), agent_id: 'ann' }, null, agents)
    expect(r.participants[0].split_pct).toBe(80)
    expect(r.agent_total).toBeCloseTo(15_000 * 0.8 - 100, 2)
  })
  it('pays a capped agent everything but the fee, and nothing counts toward cap', () => {
    const slice = agentSliceForDeal({ ...closedOn('2026-03-20'), agent_id: 'cal' }, null, agents, 'cal')
    expect(slice.take).toBeCloseTo(14_900, 2)
    expect(slice.cap).toBe(0)
  })
})

describe('a confirmed cap outranks a split saved on the deal', () => {
  const saved = {
    id: 'c1', sides: [makeSide('sale', 3)], transaction_fee: 100,
    participants: [{ id: 'p1', agent_id: 'cal', role: 'primary', allocation_pct: 100, split_pct: 70, no_split: false }],
  }
  it('switches the saved 70% to 100% inside the cap year', () => {
    const r = breakdownForDeal({ ...closedOn('2026-03-20'), agent_id: 'cal' }, saved, agents)
    expect(r.participants[0]).toMatchObject({ split_pct: 100, no_split: true, basis: 'cap' })
  })
  it('leaves the saved split alone before the confirmation', () => {
    const r = breakdownForDeal({ ...closedOn('2026-02-20'), agent_id: 'cal' }, saved, agents)
    expect(r.participants[0]).toMatchObject({ split_pct: 70, no_split: false })
  })
})

describe('capStatusFor', () => {
  const ann = { id: 'ann', name: 'Ann', default_split_pct: 70, cap_amount: 4000, cap_anniversary: '2020-01-01' }
  const deals = [
    { ...closedOn('2026-02-01'), id: 'd1', agent_id: 'ann' },   // 15,000 × 30% = 4,500 split
    { ...closedOn('2025-12-01'), id: 'd2', agent_id: 'ann' },   // last cap year — not counted
  ]
  const now = at('2026-06-01')

  it('totals the split paid this cap year and flags a reached cap for the office', () => {
    const st = capStatusFor(ann, { deals, agents: [ann], now })
    expect(st.paid).toBeCloseTo(4_500, 2)
    expect(st.reached).toBe(true)
    expect(st.awaiting).toBe(true)
    expect(st.confirmed).toBe(false)
  })

  it('is confirmed once the office confirms it, until the anniversary', () => {
    const confirmedAnn = { ...ann, cap_confirmed_at: '2026-05-01' }
    const st = capStatusFor(confirmedAnn, { deals, agents: [confirmedAnn], now })
    expect(st.confirmed).toBe(true)
    expect(st.awaiting).toBe(false)
    expect(st.until.toISOString().slice(0, 10)).toBe('2027-01-01')
    expect(st.pct).toBe(100)
  })

  it('formats today for a date column', () => {
    expect(todayIso(at('2026-03-05'))).toBe('2026-03-05')
  })
})

describe('each agent’s own transaction fee', () => {
  const team = [
    { id: 'new', name: 'New Nia', default_split_pct: 70, transaction_fee: 50 },
    { id: 'std', name: 'Standard Sam', default_split_pct: 70 },
  ]
  const solo = (agentId, extra = {}) => ({ id: 'd', value: 500_000, stage: 'psa', agent_id: agentId,
    commission_type: 'percent', commission_pct: 3, comp_data: { transaction_type: 'seller' }, ...extra })

  it('is the contract fee, or the $100 standard when none is set', () => {
    expect(agentFee(team[0])).toBe(50)
    expect(agentFee(team[1])).toBe(100)
    expect(agentFee({ transaction_fee: 0 })).toBe(0)
  })

  it('charges a new agent their $50 on a solo deal', () => {
    const r = breakdownForDeal(solo('new'), null, team)
    expect(r.participants[0].fee).toBe(50)
    expect(r.agent_total).toBeCloseTo(15_000 * 0.7 - 50, 2)
  })

  it('charges each co-agent their own fee on their share of the deal', () => {
    const r = breakdownForDeal(solo('new', { co_agent_ids: ['std'] }), null, team)
    expect(r.participants.map(p => p.fee)).toEqual([25, 50])   // 50% of $50, 50% of $100
    expect(r.transaction_fee_total).toBe(75)
  })

  it('keeps the deal-level fee on a row the office saved before per-agent fees', () => {
    const saved = {
      id: 'c1', sides: [makeSide('sale', 3)], transaction_fee: 100,
      participants: [{ id: 'p1', agent_id: 'new', role: 'primary', allocation_pct: 100, split_pct: 70 }],
    }
    expect(breakdownForDeal(solo('new'), saved, team).participants[0].fee).toBe(100)
  })

  it('lets a fee the office typed on the deal win over the contract', () => {
    const saved = {
      id: 'c1', sides: [makeSide('sale', 3)], transaction_fee: 0,
      participants: [{ id: 'p1', agent_id: 'new', role: 'primary', allocation_pct: 100, split_pct: 70, contract_fee: 50, fee: 75 }],
    }
    expect(breakdownForDeal(solo('new'), saved, team).participants[0].fee).toBe(75)
  })
})
