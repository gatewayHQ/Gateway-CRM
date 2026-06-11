import { describe, it, expect } from 'vitest'
import { agentSliceForDeal, capWindowStart } from '../commission.js'

const AGENTS = [
  { id: 'a-dan', name: 'Daniel', default_split_pct: 70 },
  { id: 'a-nic', name: 'Nic', default_split_pct: 70 },
  { id: 'a-cap', name: 'Capped', default_split_pct: 70, no_brokerage_split: true },
]

describe('agentSliceForDeal', () => {
  const deal = { id: 'd1', value: 1_000_000, agent_id: 'a-dan' }
  const commission = {
    deal_id: 'd1',
    sides: [{ id: 's1', key: 'sale', label: 'Sale', rate_pct: 3, referral_pct: 0, referral_flat: 0 }],
    participants: [
      { id: 'p1', agent_id: 'a-dan', name: 'Daniel', role: 'primary', allocation_pct: 50, split_pct: 70, fee: 0 },
      { id: 'p2', agent_id: 'a-nic', name: 'Nic', role: 'co', allocation_pct: 50, split_pct: 70, fee: 0 },
    ],
    transaction_fee: 0,
  }

  it('each agent on a 50/50 co-listed deal gets exactly their own slice', () => {
    // gross = 3% of 1M = 30k; each allocation 15k; 70% split → take 10.5k, house 4.5k
    const dan = agentSliceForDeal(deal, commission, AGENTS, 'a-dan')
    const nic = agentSliceForDeal(deal, commission, AGENTS, 'a-nic')
    expect(dan.onDeal).toBe(true)
    expect(dan.take).toBeCloseTo(10500, 0)
    expect(dan.cap).toBeCloseTo(4500, 0)
    expect(nic.take).toBeCloseTo(10500, 0)
    expect(dan.splitPct).toBe(70)
  })

  it('an agent not on the deal gets zeros', () => {
    const out = agentSliceForDeal(deal, commission, AGENTS, 'a-cap')
    expect(out).toMatchObject({ onDeal: false, take: 0, cap: 0, fees: 0 })
  })

  it('no_brokerage_split (cap pre-paid) participants keep 100% and pay no cap split', () => {
    const comm = { ...commission, participants: [
      { id: 'p1', agent_id: 'a-cap', name: 'Capped', role: 'primary', allocation_pct: 100, split_pct: 70, no_split: true, fee: 0 },
    ] }
    const s = agentSliceForDeal(deal, comm, AGENTS, 'a-cap')
    expect(s.take).toBeCloseTo(30000, 0)   // full 3% gross
    expect(s.cap).toBe(0)                  // nothing counts toward cap — it's pre-paid
  })

  it('flat transaction fees are attributed to the participant who paid them', () => {
    const comm = { ...commission, transaction_fee: 200 }
    const dan = agentSliceForDeal(deal, comm, AGENTS, 'a-dan')
    expect(dan.fees).toBeCloseTo(100, 0)   // $200 split across 2 participants
    expect(dan.take).toBeCloseTo(10400, 0) // take is net of their fee share
  })

  it('falls back to deal ownership for legacy rows with no participants', () => {
    const s = agentSliceForDeal({ id: 'd2', value: 100000, agent_id: 'a-dan' },
      { deal_id: 'd2', gross_pct: 3, broker_pct: 30, agent_pct: 70, referral_pct: 0, co_agent_pct: 0, sides: [], participants: [] },
      AGENTS, 'a-dan')
    expect(s.onDeal).toBe(true)
    expect(s.take).toBeGreaterThan(0)
  })
})

describe('capWindowStart (anniversary cap years)', () => {
  it('uses the most recent anniversary occurrence', () => {
    const now = new Date(2026, 5, 12)                       // Jun 12 2026
    expect(capWindowStart('2023-03-15', now).getTime())
      .toBe(new Date(2026, 2, 15).getTime())                // Mar 15 2026 (passed)
    expect(capWindowStart('2023-09-01', now).getTime())
      .toBe(new Date(2025, 8, 1).getTime())                 // Sep 1 2025 (not yet this year)
  })
  it('falls back to calendar year when no anniversary is set', () => {
    const now = new Date(2026, 5, 12)
    expect(capWindowStart(null, now).getTime()).toBe(new Date(2026, 0, 1).getTime())
    expect(capWindowStart('garbage', now).getTime()).toBe(new Date(2026, 0, 1).getTime())
  })
})
