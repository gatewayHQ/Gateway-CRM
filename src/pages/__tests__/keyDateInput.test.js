// The Key Dates tab writes to the agent's Outlook calendar on every save, and a
// native <input type="date"> hands you every valid value it passes through on
// the way to the one the agent meant — typing the year of "2026-09-14" produces
// 0002-09-14, then 0020-09-14, then 0202-09-14, then the real one.
//
// All three of those are dates in the past, and a past date gets an overdue
// Outlook reminder, which fires the moment the event is created. This guard is
// what keeps them in the input box instead of on somebody's phone.
import { describe, it, expect } from 'vitest'
import { plausibleKeyDate } from '../Pipeline.jsx'

describe('plausibleKeyDate', () => {
  it('accepts a real date', () => {
    expect(plausibleKeyDate('2026-09-14')).toBe(true)
    expect(plausibleKeyDate('1998-01-01')).toBe(true)
  })

  it('accepts empty — clearing a key date is a real edit', () => {
    expect(plausibleKeyDate('')).toBe(true)
    expect(plausibleKeyDate(null)).toBe(true)
    expect(plausibleKeyDate(undefined)).toBe(true)
  })

  it('rejects the years a date input emits while the year is still being typed', () => {
    expect(plausibleKeyDate('0002-09-14')).toBe(false)
    expect(plausibleKeyDate('0020-09-14')).toBe(false)
    expect(plausibleKeyDate('0202-09-14')).toBe(false)
  })

  it('rejects a year no key date on a live deal could have', () => {
    expect(plausibleKeyDate('1899-12-31')).toBe(false)
    expect(plausibleKeyDate('2201-01-01')).toBe(false)
  })

  it('rejects anything that is not a plain YYYY-MM-DD', () => {
    expect(plausibleKeyDate('2026-9-14')).toBe(false)
    expect(plausibleKeyDate('09/14/2026')).toBe(false)
    expect(plausibleKeyDate('2026-09-14T00:00:00Z')).toBe(false)
  })
})
