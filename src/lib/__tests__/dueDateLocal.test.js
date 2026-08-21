/**
 * Due dates: <input type="datetime-local"> ↔ a stored timestamptz.
 *
 * The task drawer used to round-trip a due date by slicing the ISO string
 * (`task.due_date.slice(0, 16)`) and handing the input's value straight back to
 * Postgres. That is self-consistent but wrong: "2026-09-10T14:00" with no
 * offset is stored as 14:00 UTC, so a task set for 2pm Central was really 9am.
 * Nothing in the CRM displayed a task's time of day, so nobody noticed — until
 * due dates started becoming calendar events, where a five-hour shift is the
 * whole feature failing.
 *
 * These are timezone-agnostic on purpose: CI runs in UTC, the agents don't.
 */
import { describe, it, expect } from 'vitest'
import { toDateTimeLocalInput, fromDateTimeLocalInput } from '../helpers.js'

describe('fromDateTimeLocalInput', () => {
  it('reads the input as LOCAL wall-clock time, not UTC', () => {
    const iso = fromDateTimeLocalInput('2026-09-10T14:00')
    const back = new Date(iso)
    expect(back.getHours()).toBe(14)        // 2pm where the agent is sitting
    expect(back.getMinutes()).toBe(0)
    expect(back.getDate()).toBe(10)
  })

  it('produces a real instant (an offset-bearing ISO string)', () => {
    expect(fromDateTimeLocalInput('2026-09-10T14:00')).toMatch(/Z$/)
  })

  it('treats an empty or unparseable value as no due date', () => {
    expect(fromDateTimeLocalInput('')).toBeNull()
    expect(fromDateTimeLocalInput(null)).toBeNull()
    expect(fromDateTimeLocalInput(undefined)).toBeNull()
    expect(fromDateTimeLocalInput('not a date')).toBeNull()
  })
})

describe('toDateTimeLocalInput', () => {
  it('renders a stored instant in the agent\'s own zone', () => {
    const d = new Date(2026, 8, 10, 14, 0, 0)          // local 2pm
    expect(toDateTimeLocalInput(d.toISOString())).toBe('2026-09-10T14:00')
  })

  it('zero-pads, so the input actually accepts it', () => {
    const d = new Date(2026, 0, 5, 9, 5, 0)
    expect(toDateTimeLocalInput(d.toISOString())).toBe('2026-01-05T09:05')
  })

  it('is empty for a task with no due date', () => {
    expect(toDateTimeLocalInput(null)).toBe('')
    expect(toDateTimeLocalInput('')).toBe('')
    expect(toDateTimeLocalInput('nonsense')).toBe('')
  })
})

describe('the two are exact inverses — what you type is what comes back', () => {
  it.each([
    '2026-09-10T14:00',
    '2026-01-01T00:00',
    '2026-03-08T02:30',   // US spring-forward morning
    '2026-11-01T01:30',   // US fall-back morning (the ambiguous hour)
    '2026-12-31T23:59',
  ])('%s survives the round trip', (typed) => {
    expect(toDateTimeLocalInput(fromDateTimeLocalInput(typed))).toBe(typed)
  })
})
