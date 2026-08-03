import { describe, it, expect } from 'vitest'
import { monthlyEarnings, earningsSummary, capYearBoundaryIndex } from '../earnings.js'

// Fixed "now" so the 12-month window is deterministic: Jul 2026 back to Aug 2025.
const NOW = new Date(2026, 6, 15)          // 2026-07-15
const closed = (closed_at, take, fees = 0) => ({ closed: true, closed_at, take, fees })

describe('monthlyEarnings', () => {
  it('returns the window oldest-first, ending on the current month', () => {
    const b = monthlyEarnings([], { now: NOW })
    expect(b).toHaveLength(12)
    expect(b[0].key).toBe('2025-08')
    expect(b[11].key).toBe('2026-07')
    expect(b[11].shortLabel).toBe('Jul')
    expect(b[0].label).toBe('Aug 25')
  })

  it('keeps empty months as zeroed slots so the axis stays evenly spaced', () => {
    const b = monthlyEarnings([closed('2026-07-02', 5000)], { now: NOW })
    expect(b).toHaveLength(12)
    expect(b.filter(m => m.count === 0)).toHaveLength(11)
    expect(b[11]).toMatchObject({ take: 5000, count: 1 })
  })

  it('sums several closings in the same month', () => {
    const b = monthlyEarnings([
      closed('2026-06-02', 4000, 50),
      closed('2026-06-20', 6000, 50),
      closed('2026-07-01', 1000, 25),
    ], { now: NOW })
    const jun = b.find(m => m.key === '2026-06')
    expect(jun).toMatchObject({ take: 10000, fees: 100, count: 2 })
    expect(b.find(m => m.key === '2026-07')).toMatchObject({ take: 1000, count: 1 })
  })

  it('ignores open deals — only closed ones are earnings', () => {
    const b = monthlyEarnings([
      { closed: false, closed_at: null, take: 9999 },
      { closed: false, closed_at: '2026-07-01', take: 8888 },   // defensive: open but dated
    ], { now: NOW })
    expect(earningsSummary(b).total).toBe(0)
  })

  it('skips a closed deal with a missing or unparseable date rather than guessing', () => {
    const b = monthlyEarnings([
      { closed: true, closed_at: null, take: 5000 },
      { closed: true, closed_at: 'not-a-date', take: 5000 },
    ], { now: NOW })
    expect(earningsSummary(b).total).toBe(0)
  })

  it('ignores closings outside the window on both ends', () => {
    const b = monthlyEarnings([
      closed('2025-07-31', 5000),   // one month before the window
      closed('2026-08-01', 7000),   // next month, i.e. the future
      closed('2026-07-15', 100),
    ], { now: NOW })
    expect(earningsSummary(b).total).toBe(100)
  })

  it('honors a custom window length', () => {
    const b = monthlyEarnings([], { months: 3, now: NOW })
    expect(b.map(m => m.key)).toEqual(['2026-05', '2026-06', '2026-07'])
  })

  it('treats missing/garbage amounts as zero instead of producing NaN', () => {
    const b = monthlyEarnings([
      { closed: true, closed_at: '2026-07-01', take: null,  fees: undefined },
      { closed: true, closed_at: '2026-07-02', take: 'abc', fees: '25' },
    ], { now: NOW })
    const jul = b.find(m => m.key === '2026-07')
    expect(jul.take).toBe(0)
    expect(jul.fees).toBe(25)
    expect(jul.count).toBe(2)      // they still closed, they just carry no money
  })

  it('rounds only the surfaced totals, so many cents cannot drift', () => {
    const b = monthlyEarnings(
      Array.from({ length: 3 }, () => closed('2026-07-01', 0.005)),
      { now: NOW },
    )
    expect(b.find(m => m.key === '2026-07').take).toBe(0.02)
  })

  it('spans a year boundary correctly', () => {
    const b = monthlyEarnings([closed('2025-12-15', 3000)], { now: NOW })
    expect(b.find(m => m.key === '2025-12')).toMatchObject({ take: 3000, count: 1 })
  })
})

describe('earningsSummary', () => {
  const buckets = monthlyEarnings([
    closed('2026-05-01', 2000),
    closed('2026-06-01', 8000),
    closed('2026-06-15', 2000),
    closed('2026-07-01', 5000),
  ], { now: NOW })

  it('totals the window and counts the deals', () => {
    expect(earningsSummary(buckets)).toMatchObject({ total: 17000, deals: 4, max: 10000 })
  })

  it('identifies the best month', () => {
    expect(earningsSummary(buckets).best).toMatchObject({ key: '2026-06', take: 10000 })
  })

  it('averages over months that had a closing, not all twelve', () => {
    const s = earningsSummary(buckets)
    expect(s.activeMonths).toBe(3)
    expect(s.avgPerActiveMonth).toBeCloseTo(5666.67, 2)
  })

  it('is all zeros with no closings, and reports no best month', () => {
    const s = earningsSummary(monthlyEarnings([], { now: NOW }))
    expect(s).toMatchObject({ total: 0, deals: 0, max: 0, activeMonths: 0, avgPerActiveMonth: 0 })
    expect(s.best).toBeNull()
  })

  it('survives an empty bucket list without returning -Infinity', () => {
    expect(earningsSummary([]).max).toBe(0)
  })
})

describe('capYearBoundaryIndex', () => {
  const buckets = monthlyEarnings([], { now: NOW })

  it('finds the bucket containing the cap-year start', () => {
    expect(capYearBoundaryIndex(buckets, '2026-03-01')).toBe(buckets.findIndex(b => b.key === '2026-03'))
  })

  it('anchors a date-only string to noon so the month is timezone-stable', () => {
    // 2026-01-01 parsed as UTC midnight would land in Dec 2025 west of UTC.
    expect(capYearBoundaryIndex(buckets, '2026-01-01')).toBe(buckets.findIndex(b => b.key === '2026-01'))
  })

  it('returns -1 when the cap year starts before the window', () => {
    expect(capYearBoundaryIndex(buckets, '2024-01-01')).toBe(-1)
  })

  it('returns -1 for a missing or unparseable window start', () => {
    expect(capYearBoundaryIndex(buckets, null)).toBe(-1)
    expect(capYearBoundaryIndex(buckets, 'whenever')).toBe(-1)
  })
})
