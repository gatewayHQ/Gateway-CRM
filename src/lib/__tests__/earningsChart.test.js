import { describe, it, expect } from 'vitest'
import { monthlyEarnings, axisFor, shortMoney, describeYear, monthIndex, yearOf } from '../earningsChart.js'

// ─────────────────────────────────────────────────────────────────────────────
// The commission year, bucketed. A chart that puts a deal in the wrong month,
// counts a lost deal as income, or silently drops money with no close date is
// worse than the four totals it replaced — those were at least right.
// ─────────────────────────────────────────────────────────────────────────────
const NOW = new Date('2026-09-12T12:00:00Z').getTime()

const closed = (month, take, over = {}) => ({
  deal_id: `c-${month}-${take}`, closed: true, take,
  closed_at: `2026-${String(month).padStart(2, '0')}-15T00:00:00Z`, stage: 'closed', ...over,
})
const open = (month, take, over = {}) => ({
  deal_id: `o-${month}-${take}`, closed: false, take, stage: 'offer',
  expected_close_date: month ? `2026-${String(month).padStart(2, '0')}-20` : null, ...over,
})

describe('monthlyEarnings', () => {
  it('puts a closed deal in the month it closed, and an open one in the month it should', () => {
    const s = monthlyEarnings([closed(8, 10424), open(10, 43943)], { now: NOW })
    expect(s.months[7].earned).toBe(10424)      // August
    expect(s.months[9].projected).toBe(43943)   // October
    expect(s.earnedTotal).toBe(10424)
    expect(s.projectedTotal).toBe(43943)
  })

  it('adds up several deals in the same month', () => {
    const s = monthlyEarnings([closed(3, 1000), closed(3, 1542)], { now: NOW })
    expect(s.months[2]).toMatchObject({ earned: 2542, closedDeals: 2 })
  })

  it('never counts a lost deal as money coming', () => {
    const s = monthlyEarnings([open(10, 50000, { stage: 'lost' })], { now: NOW })
    expect(s.projectedTotal).toBe(0)
    expect(s.peak).toBe(0)
  })

  it('reports money with no expected close date instead of dropping it', () => {
    // Silently vanishing from the chart is how a projection stops being trusted.
    const s = monthlyEarnings([open(null, 9975)], { now: NOW })
    expect(s.unscheduled).toBe(9975)
    expect(s.projectedTotal).toBe(9975)
    expect(s.months.every(m => m.projected === 0)).toBe(true)
  })

  it('leaves last year’s commission on last year’s chart', () => {
    const s = monthlyEarnings([{ closed: true, take: 5000, closed_at: '2025-11-02' }], { now: NOW })
    expect(s.earnedTotal).toBe(0)
  })

  it('marks where the year has got to, but only on the current year', () => {
    expect(monthlyEarnings([], { now: NOW }).todayMonth).toBe(8)            // September
    expect(monthlyEarnings([], { year: 2025, now: NOW }).todayMonth).toBeNull()
  })

  it('survives a deal with no dates, no take, or nothing at all', () => {
    const s = monthlyEarnings([{}, { closed: true }, { take: 'x', closed: false, stage: 'offer' }], { now: NOW })
    expect(s.earnedTotal).toBe(0)
    expect(s.peak).toBe(0)
  })

  it('takes the peak from whichever series is taller', () => {
    const s = monthlyEarnings([closed(1, 200), open(2, 8000)], { now: NOW })
    expect(s.peak).toBe(8000)
  })
})

describe('axisFor — a scale no bar can exceed', () => {
  it('always reaches at least the tallest bar', () => {
    for (const peak of [1, 999, 1000, 2600, 10424, 43943, 250000]) {
      const { top } = axisFor(peak)
      expect(top).toBeGreaterThanOrEqual(peak)
    }
  })

  it('lands on round numbers, starting at zero', () => {
    expect(axisFor(43943).ticks[0]).toBe(0)
    expect(axisFor(43943).top).toBe(50000)
    expect(axisFor(8000).top).toBe(10000)
  })

  it('has something to draw when there is nothing to show', () => {
    expect(axisFor(0).top).toBeGreaterThan(0)
    expect(axisFor(-5).top).toBeGreaterThan(0)
  })
})

describe('shortMoney', () => {
  it('shortens only where it helps', () => {
    expect(shortMoney(920)).toBe('$920')
    expect(shortMoney(10424)).toBe('$10.4k')
    expect(shortMoney(43943)).toBe('$43.9k')
    expect(shortMoney(2000)).toBe('$2k')
    expect(shortMoney(1200000)).toBe('$1.2M')
    expect(shortMoney(0)).toBe('$0')
  })
})

describe('describeYear — the sentence under the chart', () => {
  it('says when the biggest month is only a projection', () => {
    const s = monthlyEarnings([closed(8, 10424), open(10, 43943)], { now: NOW })
    const line = describeYear(s)
    expect(line).toContain('$10.4k earned')
    expect(line).toContain('$43.9k projected')
    expect(line).toContain('Oct is a projection, not money in hand')
  })

  it('names the best real month when the year is led by closed business', () => {
    const s = monthlyEarnings([closed(6, 20000), open(11, 500)], { now: NOW })
    expect(describeYear(s)).toContain('Jun was the biggest month')
  })

  it('admits what it could not place, and says what to do about it', () => {
    const s = monthlyEarnings([closed(1, 1000), open(null, 9975)], { now: NOW })
    const line = describeYear(s)
    expect(line).toContain('No date')
    expect(line).toContain('set an expected close date')
  })

  it('still speaks when the whole projection is undated', () => {
    // The real case that prompted this: every open deal missing a close date,
    // so the months are empty and the chart would otherwise say "nothing yet"
    // over a six-figure pipeline.
    const s = monthlyEarnings([open(null, 107661)], { now: NOW })
    expect(s.peak).toBe(0)
    const line = describeYear(s)
    expect(line).toContain('$107.7k projected')
    expect(line).not.toContain('Nothing closed or projected')
    expect(line).not.toMatch(/biggest month|not money in hand/)   // no month to name
  })

  it('says so plainly when there is nothing yet', () => {
    expect(describeYear(monthlyEarnings([], { now: NOW }))).toMatch(/Nothing closed or projected/)
  })
})

describe('date helpers', () => {
  it('reads a month and a year, and refuses nonsense', () => {
    expect(monthIndex('2026-03-15')).toBe(2)
    expect(yearOf('2026-03-15')).toBe(2026)
    expect(monthIndex('not a date')).toBeNull()
    expect(monthIndex(null)).toBeNull()
    expect(yearOf(undefined)).toBeNull()
  })
})
