import { describe, it, expect } from 'vitest'
import { normalizeCommission, breakdownForDeal, agentSliceForDeal } from '../commission.js'

// Co-agents copied onto the deal at conversion (deals.co_agent_ids) must show up
// in the commission editor and every report that reads it, WITHOUT disturbing
// deals that have none or that the back office has already split by hand.
const AGENTS = [
  { id: 'a-dan',  name: 'Daniel', default_split_pct: 70 },
  { id: 'a-sam',  name: 'Sam',    default_split_pct: 60 },
  { id: 'a-capd', name: 'Capped', default_split_pct: 70, no_brokerage_split: true },
]
const deal = (over = {}) => ({ id: 'd1', value: 500_000, agent_id: 'a-dan', co_agent_ids: [], ...over })

describe('normalizeCommission — co-agents carried over from the property', () => {
  it('seeds one participant per co-agent, evenly allocated, primary first', () => {
    const n = normalizeCommission(null, { deal: deal({ co_agent_ids: ['a-sam'] }), agents: AGENTS })
    expect(n.participants.map(p => [p.agent_id, p.role, p.allocation_pct])).toEqual([
      ['a-dan', 'primary', 50],
      ['a-sam', 'co', 50],
    ])
  })

  it('gives each co-agent their own stored brokerage arrangement', () => {
    const n = normalizeCommission(null, { deal: deal({ co_agent_ids: ['a-sam', 'a-capd'] }), agents: AGENTS })
    const sam    = n.participants.find(p => p.agent_id === 'a-sam')
    const capped = n.participants.find(p => p.agent_id === 'a-capd')
    expect(sam.split_pct).toBe(60)
    expect(sam.no_split).toBe(false)
    expect(capped.no_split).toBe(true)
    expect(capped.split_pct).toBe(100)
  })

  it('allocations total exactly 100% even when the even split does not divide', () => {
    const n = normalizeCommission(null, { deal: deal({ co_agent_ids: ['a-sam', 'a-capd'] }), agents: AGENTS })
    // 33.4 + 33.3 + 33.3 — exact to the one decimal the UI edits in (the
    // float sum is off by 1e-14, well inside the engine's 0.5% tolerance).
    const total = n.participants.reduce((s, p) => s + p.allocation_pct, 0)
    expect(total).toBeCloseTo(100, 6)
    // The remainder lands on the primary, never on a co-agent.
    expect(n.participants[0].allocation_pct).toBeCloseTo(33.4, 5)
    expect(breakdownForDeal(deal({ co_agent_ids: ['a-sam', 'a-capd'] }), null, AGENTS).warnings).toEqual([])
  })

  it('leaves a solo deal exactly as it was — one participant at 100%', () => {
    const n = normalizeCommission(null, { deal: deal(), agents: AGENTS })
    expect(n.participants).toHaveLength(1)
    expect(n.participants[0].allocation_pct).toBe(100)
  })

  it("never seeds the primary agent as their own co-agent", () => {
    const n = normalizeCommission(null, { deal: deal({ co_agent_ids: ['a-dan', 'a-sam'] }), agents: AGENTS })
    expect(n.participants.map(p => p.agent_id)).toEqual(['a-dan', 'a-sam'])
  })

  it('seeds a placeholder row for a co-agent the caller could not resolve', () => {
    const n = normalizeCommission(null, { deal: deal({ co_agent_ids: ['a-ghost'] }), agents: AGENTS })
    expect(n.participants[1]).toMatchObject({ agent_id: 'a-ghost', role: 'co', name: '' })
  })

  it("the back office's saved split wins — seeding never overrides it", () => {
    const structured = {
      id: 'c1', deal_id: 'd1',
      sides: [{ id: 's1', key: 'sale', label: 'Sale', rate_pct: 3, referral_pct: 0, referral_flat: 0 }],
      participants: [{ id: 'p1', agent_id: 'a-dan', role: 'primary', allocation_pct: 100, split_pct: 70 }],
      transaction_fee: 0,
    }
    const n = normalizeCommission(structured, { deal: deal({ co_agent_ids: ['a-sam'] }), agents: AGENTS })
    expect(n.participants.map(p => p.agent_id)).toEqual(['a-dan'])
  })

  it('leaves the legacy co_agent_pct carve-out untouched (already-paid deals must not move)', () => {
    const legacy = { id: 'c1', deal_id: 'd1', gross_pct: 3, agent_pct: 70, co_agent_pct: 25, sides: [], participants: [] }
    const withLegacy = normalizeCommission(legacy, { deal: deal({ co_agent_ids: ['a-sam'] }), agents: AGENTS })
    expect(withLegacy.participants).toHaveLength(2)
    expect(withLegacy.participants[0].allocation_pct).toBe(100)
    expect(withLegacy.participants[1]._legacy_co_pct).toBe(25)

    // …and the dollars match the same row on a deal with no carried co-agents.
    const before = breakdownForDeal(deal(), legacy, AGENTS)
    const after  = breakdownForDeal(deal({ co_agent_ids: ['a-sam'] }), legacy, AGENTS)
    expect(after.agent_total).toBeCloseTo(before.agent_total, 2)
    expect(after.house_total).toBeCloseTo(before.house_total, 2)
  })
})

describe('breakdownForDeal / agentSliceForDeal — a co-listed deal pays both agents', () => {
  const coListed = deal({ co_agent_ids: ['a-sam'], commission_type: 'percent', commission_pct: 3 })

  it('splits the net evenly and applies each agent’s own split', () => {
    const r = breakdownForDeal(coListed, null, AGENTS)
    expect(r.gross_total).toBe(15_000)              // 3% of 500k
    // 7,500 each; Daniel keeps 70%, Sam keeps 60%. No transaction fee on an
    // unsaved row (the $100 default only applies once the editor saves).
    expect(r.participants.map(p => p.agent_take)).toEqual([5_250, 4_500])
    expect(r.agent_total).toBeCloseTo(9_750, 2)
    expect(r.house_total).toBeCloseTo(5_250, 2)
  })

  it('the co-agent now has a slice of the deal instead of nothing', () => {
    const sam = agentSliceForDeal(coListed, null, AGENTS, 'a-sam')
    expect(sam.onDeal).toBe(true)
    expect(sam.take).toBeCloseTo(4_500, 2)
    expect(sam.cap).toBeCloseTo(3_000, 2)           // brokerage split counts toward cap
  })

  it('an agent on neither end of the deal still gets nothing', () => {
    expect(agentSliceForDeal(coListed, null, AGENTS, 'a-capd').onDeal).toBe(false)
  })

  it('a solo deal pays the primary exactly as before', () => {
    const solo = deal({ commission_type: 'percent', commission_pct: 3 })
    const r = breakdownForDeal(solo, null, AGENTS)
    expect(r.agent_total).toBeCloseTo(10_500, 2)    // 70% of 15,000
    expect(agentSliceForDeal(solo, null, AGENTS, 'a-dan').take).toBeCloseTo(10_500, 2)
  })
})
