import { describe, it, expect } from 'vitest'
import { followUpDue, FOLLOW_UP_CHOICES } from '../followUp.js'
import { heatScoresFor, calcHeatScore } from '../helpers.js'

describe('followUpDue', () => {
  it('is 9am local, the given number of days out', () => {
    const d = followUpDue(1, new Date(2026, 9, 6, 15, 30)) // Tue Oct 6
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 7, 9, 0])
  })
  it('moves a Saturday or Sunday to the Monday after', () => {
    expect(followUpDue(1, new Date(2026, 9, 9, 10)).getDate()).toBe(12) // Fri → Sat → Mon 12th
    expect(followUpDue(2, new Date(2026, 9, 9, 10)).getDate()).toBe(12) // Fri → Sun → Mon 12th
  })
  it('offers no follow-up first', () => {
    expect(FOLLOW_UP_CHOICES[0].id).toBe('')
  })
})

describe('heatScoresFor', () => {
  it('gives the same answer as scoring each contact against everything', () => {
    const now = Date.now()
    const contacts = [{ id: 'a' }, { id: 'b', last_contacted_at: new Date(now - 86400000).toISOString() }, { id: 'c' }]
    const activities = [
      { contact_id: 'a', created_at: new Date(now - 2 * 86400000).toISOString() },
      { contact_id: 'b', created_at: new Date(now - 20 * 86400000).toISOString() },
      { contact_id: null, created_at: new Date().toISOString() },
    ]
    const deals = [{ contact_id: 'a', stage: 'offer' }, { contact_id: 'c', stage: 'lost' }]
    const fast = heatScoresFor(contacts, activities, deals)
    for (const c of contacts) expect(fast[c.id]).toBe(calcHeatScore(c, activities, deals))
    expect(fast.a).toBe('hot')
  })
})
