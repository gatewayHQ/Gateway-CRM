import { describe, it, expect } from 'vitest'
import {
  weightedValue, daysInStage, stageSince, isRotting, rotThreshold,
  dealActivityState, nextKeyDate, focusItems, pipelineTotals, daysBetween,
  isBuyerLead,
} from '../pipeline.js'

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString()
const daysAhead = (n) => new Date(Date.now() + n * 86_400_000).toISOString()
const NOW = new Date()

describe('weightedValue', () => {
  it('multiplies value by probability', () => {
    expect(weightedValue({ value: 1000, probability: 50 })).toBe(500)
  })
  it('falls back to raw value when probability is missing (never reads $0)', () => {
    expect(weightedValue({ value: 1000 })).toBe(1000)
    expect(weightedValue({ value: 1000, probability: '' })).toBe(1000)
  })
  it('handles missing value', () => {
    expect(weightedValue({})).toBe(0)
  })
})

describe('stageSince / daysInStage', () => {
  it('prefers comp_data.stage_since, then updated_at, then created_at', () => {
    expect(stageSince({ comp_data: { stage_since: '2026-01-01' }, updated_at: '2026-02-01' })).toBe('2026-01-01')
    expect(stageSince({ updated_at: '2026-02-01', created_at: '2026-01-01' })).toBe('2026-02-01')
    expect(stageSince({ created_at: '2026-01-01' })).toBe('2026-01-01')
    expect(stageSince({})).toBeNull()
  })
  it('counts whole days since entering the stage', () => {
    expect(daysInStage({ comp_data: { stage_since: daysAgo(5) } }, NOW)).toBe(5)
    expect(daysInStage({}, NOW)).toBeNull()
  })
})

describe('isRotting', () => {
  it('flags open deals idle past their stage threshold', () => {
    expect(isRotting({ stage: 'offer', comp_data: { stage_since: daysAgo(8) } }, NOW)).toBe(true)  // threshold 7
    expect(isRotting({ stage: 'offer', comp_data: { stage_since: daysAgo(3) } }, NOW)).toBe(false)
  })
  it('respects longer thresholds for legal/closing stages', () => {
    expect(rotThreshold('psa')).toBeGreaterThan(rotThreshold('offer'))
    expect(isRotting({ stage: 'psa', comp_data: { stage_since: daysAgo(20) } }, NOW)).toBe(false) // threshold 30
  })
  it('never flags closed or lost deals', () => {
    expect(isRotting({ stage: 'closed', comp_data: { stage_since: daysAgo(999) } }, NOW)).toBe(false)
    expect(isRotting({ stage: 'lost', comp_data: { stage_since: daysAgo(999) } }, NOW)).toBe(false)
  })
})

describe('dealActivityState', () => {
  const deal = { id: 'd1' }
  it('reports overdue when an open task is past due', () => {
    const r = dealActivityState(deal, [{ deal_id: 'd1', completed: false, due_date: daysAgo(2) }], NOW)
    expect(r.state).toBe('overdue')
    expect(r.overdueBy).toBe(2)
  })
  it('reports scheduled when only future tasks exist', () => {
    const r = dealActivityState(deal, [{ deal_id: 'd1', completed: false, due_date: daysAhead(3) }], NOW)
    expect(r.state).toBe('scheduled')
  })
  it('reports none when nothing is planned (the nudge)', () => {
    expect(dealActivityState(deal, [], NOW).state).toBe('none')
    expect(dealActivityState(deal, [{ deal_id: 'd1', completed: true, due_date: daysAhead(3) }], NOW).state).toBe('none')
  })
  it('ignores tasks belonging to other deals', () => {
    expect(dealActivityState(deal, [{ deal_id: 'other', completed: false, due_date: daysAgo(1) }], NOW).state).toBe('none')
  })
})

describe('nextKeyDate', () => {
  it('returns the soonest upcoming date', () => {
    const deal = { comp_data: { key_dates: [
      { type: 'Closing', date: daysAhead(10) },
      { type: 'Inspection', date: daysAhead(3) },
    ] } }
    expect(nextKeyDate(deal, NOW).type).toBe('Inspection')
  })
  it('returns null when there are no dated entries', () => {
    expect(nextKeyDate({ comp_data: { key_dates: [{ type: 'Closing' }] } }, NOW)).toBeNull()
    expect(nextKeyDate({}, NOW)).toBeNull()
  })
})

describe('focusItems', () => {
  it('surfaces overdue tasks, near key dates, and rotting deals — sorted by severity', () => {
    const deals = [
      { id: 'a', stage: 'offer', title: 'A', comp_data: { stage_since: daysAgo(1) } },
      { id: 'b', stage: 'psa', title: 'B', comp_data: { stage_since: daysAgo(1), key_dates: [{ type: 'Closing', date: daysAhead(1) }] } },
      { id: 'c', stage: 'offer', title: 'C', comp_data: { stage_since: daysAgo(40) } }, // rotting (threshold 7)
      { id: 'z', stage: 'closed', title: 'Z', comp_data: { stage_since: daysAgo(99) } }, // ignored
    ]
    const tasks = [{ deal_id: 'a', completed: false, due_date: daysAgo(3), title: 'Call seller' }]
    const items = focusItems(deals, tasks, NOW)

    const kinds = items.map(i => i.kind)
    expect(kinds).toContain('task')
    expect(kinds).toContain('date')
    expect(kinds).toContain('rotting')
    expect(items.every(i => i.deal.id !== 'z')).toBe(true)        // closed deal excluded
    // critical (overdue task + 1-day closing) sort before warning (rotting)
    expect(items[0].severity).toBe('critical')
    expect(items[items.length - 1].kind).toBe('rotting')
  })

  it('returns nothing when every deal is healthy', () => {
    const deals = [{ id: 'a', stage: 'offer', comp_data: { stage_since: daysAgo(1) } }]
    const tasks = [{ deal_id: 'a', completed: false, due_date: daysAhead(5) }]
    expect(focusItems(deals, tasks, NOW)).toEqual([])
  })
})

describe('pipelineTotals', () => {
  it('rolls up count, raw value, and weighted value', () => {
    const t = pipelineTotals([
      { value: 1000, probability: 50 },
      { value: 2000, probability: 100 },
    ])
    expect(t).toEqual({ count: 2, value: 3000, weighted: 2500 })
  })
})

describe('daysBetween', () => {
  it('is calendar-day based and sign-aware', () => {
    expect(daysBetween(daysAhead(3), NOW)).toBe(3)
    expect(daysBetween(daysAgo(2), NOW)).toBe(-2)
  })
})

describe('isBuyerLead', () => {
  const contact = { id: 'c1', first_name: 'Sky', last_name: 'Olson' }

  it('flags a no-property deal whose title is exactly the contact name', () => {
    expect(isBuyerLead({ title: 'Sky Olson', contact_id: 'c1' }, contact)).toBe(true)
    expect(isBuyerLead({ title: '  sky olson ', contact_id: 'c1' }, contact)).toBe(true) // case/space-insensitive
  })

  it('does NOT flag a deal with a linked property', () => {
    expect(isBuyerLead({ title: 'Sky Olson', property_id: 'p1' }, contact)).toBe(false)
  })

  it('does NOT flag an address-titled deal (title != contact name)', () => {
    expect(isBuyerLead({ title: '123 Main Street', contact_id: 'c1' }, contact)).toBe(false)
  })

  it('does NOT flag when there is no contact or no name', () => {
    expect(isBuyerLead({ title: 'Sky Olson' }, null)).toBe(false)
    expect(isBuyerLead({ title: '' }, { first_name: '', last_name: '' })).toBe(false)
  })
})
