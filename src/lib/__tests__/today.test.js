import { describe, it, expect } from 'vitest'
import { todayAgenda } from '../today.js'

const NOW = new Date(2026, 9, 6, 10, 0) // Tue Oct 6 2026, 10am
const iso = (y, m, d, h = 9) => new Date(y, m, d, h).toISOString()

describe('todayAgenda', () => {
  it('lists my open tasks due by tonight, overdue first, and flags overdue', () => {
    const tasks = [
      { id: 'later',    agent_id: 'me', completed: false, due_date: iso(2026, 9, 8) },
      { id: 'today',    agent_id: 'me', completed: false, due_date: iso(2026, 9, 6, 15) },
      { id: 'old',      agent_id: 'me', completed: false, due_date: iso(2026, 9, 2) },
      { id: 'done',     agent_id: 'me', completed: true,  due_date: iso(2026, 9, 2) },
      { id: 'theirs',   agent_id: 'you', completed: false, due_date: iso(2026, 9, 2) },
      { id: 'morning',  agent_id: 'me', completed: false, due_date: iso(2026, 9, 6, 8) },
    ]
    const { tasks: due } = todayAgenda({ tasks, agentId: 'me', now: NOW })
    expect(due.map(t => t.id)).toEqual(['old', 'morning', 'today'])
    expect(due.find(t => t.id === 'old').overdue).toBe(true)
    // Earlier today is due today, not overdue.
    expect(due.find(t => t.id === 'morning').overdue).toBe(false)
  })

  it('new leads are mine, from the last week, and not yet contacted', () => {
    const contacts = [
      { id: 'fresh',  assigned_agent_id: 'me',  created_at: iso(2026, 9, 5) },
      { id: 'called', assigned_agent_id: 'me',  created_at: iso(2026, 9, 5), last_contacted_at: iso(2026, 9, 5, 12) },
      { id: 'stale',  assigned_agent_id: 'me',  created_at: iso(2026, 8, 1) },
      { id: 'theirs', assigned_agent_id: 'you', created_at: iso(2026, 9, 5) },
    ]
    expect(todayAgenda({ contacts, agentId: 'me', now: NOW }).leads.map(c => c.id)).toEqual(['fresh'])
  })

  it('one row per deal that needs attention, co-agented deals included', () => {
    const deals = [
      { id: 'd1', agent_id: 'me', stage: 'under-contract', comp_data: { key_dates: [{ type: 'Inspection', date: '2026-10-07' }] } },
      { id: 'd2', agent_id: 'you', co_agent_ids: ['me'], stage: 'offer', comp_data: {} },
      { id: 'd3', agent_id: 'you', stage: 'offer', comp_data: {} },
      { id: 'd4', agent_id: 'me', stage: 'closed', comp_data: {} },
    ]
    const tasks = [
      { id: 't1', deal_id: 'd1', agent_id: 'me', completed: false, due_date: iso(2026, 9, 1) },
      { id: 't2', deal_id: 'd2', agent_id: 'me', completed: false, due_date: iso(2026, 9, 1) },
      { id: 't3', deal_id: 'd3', agent_id: 'you', completed: false, due_date: iso(2026, 9, 1) },
    ]
    const ids = todayAgenda({ deals, tasks, agentId: 'me', now: NOW }).deals.map(i => i.deal.id)
    expect(ids.sort()).toEqual(['d1', 'd2'])
  })
})
