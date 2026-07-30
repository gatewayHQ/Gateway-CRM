import { describe, it, expect } from 'vitest'
import { buildEarningsSeries, resolveRange, toYmd, RANGE_PRESETS } from '../earnings.js'

// A fixed "today" so range math is deterministic: Mon 2026-07-27.
const NOW = new Date(2026, 6, 27, 14, 30)

const row = (over = {}) => ({
  deal_id: 'd1', title: 'A deal', closed_at: '2026-07-15T12:00:00Z',
  take: 1000, fees: 100, gross: 3000, is_flat: false, ...over,
})

describe('resolveRange', () => {
  it('last 30 days is a 30-day window bucketed by week', () => {
    const r = resolveRange({ preset: '30d', now: NOW })
    expect(r).toMatchObject({ preset: '30d', bucket: 'week', from: '2026-06-28', to: '2026-07-27' })
  })

  it('this year starts on January 1 and buckets by month', () => {
    const r = resolveRange({ preset: 'ytd', now: NOW })
    expect(r).toMatchObject({ preset: 'ytd', bucket: 'month', from: '2026-01-01', to: '2026-07-27' })
  })

  it('last 12 months starts at the first of the month, 11 months back', () => {
    const r = resolveRange({ preset: '12m', now: NOW })
    expect(r).toMatchObject({ bucket: 'month', from: '2025-08-01', to: '2026-07-27' })
  })

  it('an unknown or missing preset falls back to last 12 months', () => {
    expect(resolveRange({ now: NOW }).preset).toBe('12m')
    expect(resolveRange({ preset: 'nonsense', now: NOW }).preset).toBe('12m')
  })

  it('custom ranges honour the given dates and swap them if reversed', () => {
    const r = resolveRange({ preset: 'custom', from: '2026-03-31', to: '2026-01-01', now: NOW })
    expect(r).toMatchObject({ preset: 'custom', from: '2026-01-01', to: '2026-03-31' })
  })

  it('a custom range picks weeks when short and months when long', () => {
    expect(resolveRange({ preset: 'custom', from: '2026-05-01', to: '2026-06-30', now: NOW }).bucket).toBe('week')
    expect(resolveRange({ preset: 'custom', from: '2024-01-01', to: '2026-06-30', now: NOW }).bucket).toBe('month')
  })

  it('an explicit bucket always wins', () => {
    expect(resolveRange({ preset: 'ytd', bucket: 'week', now: NOW }).bucket).toBe('week')
  })

  it('every preset in the picker resolves', () => {
    for (const p of RANGE_PRESETS) {
      const r = resolveRange({ preset: p.id, from: '2026-01-01', to: '2026-02-01', now: NOW })
      expect(r.from <= r.to).toBe(true)
      expect(['week', 'month']).toContain(r.bucket)
    }
  })
})

describe('buildEarningsSeries', () => {
  const range = { from: '2026-05-01', to: '2026-07-31', bucket: 'month' }

  it('buckets takes by month, including the months that earned nothing', () => {
    const s = buildEarningsSeries([
      row({ deal_id: 'a', closed_at: '2026-05-04T00:00:00Z', take: 500 }),
      row({ deal_id: 'b', closed_at: '2026-07-15T00:00:00Z', take: 1500 }),
    ], range)
    expect(s.points.map(p => p.short)).toEqual(['May', 'Jun', 'Jul'])
    expect(s.points.map(p => p.take)).toEqual([500, 0, 1500])
    expect(s.points.map(p => p.deals)).toEqual([1, 0, 1])
  })

  it('splits percentage-based and flat-fee earnings within one bucket', () => {
    const s = buildEarningsSeries([
      row({ deal_id: 'a', closed_at: '2026-07-02T00:00:00Z', take: 1200, is_flat: false }),
      row({ deal_id: 'b', closed_at: '2026-07-20T00:00:00Z', take: 800,  is_flat: true }),
    ], range)
    const jul = s.points.find(p => p.short === 'Jul')
    expect(jul.rate_take).toBe(1200)
    expect(jul.flat_take).toBe(800)
    expect(jul.take).toBe(2000)
    expect(s.totals).toMatchObject({ take: 2000, rate_take: 1200, flat_take: 800, deals: 2 })
  })

  it('keeps the contributing deals per bucket, biggest first', () => {
    const s = buildEarningsSeries([
      row({ deal_id: 'small', title: 'Small', closed_at: '2026-06-10T00:00:00Z', take: 100 }),
      row({ deal_id: 'big',   title: 'Big',   closed_at: '2026-06-11T00:00:00Z', take: 900 }),
    ], range)
    const jun = s.points.find(p => p.short === 'Jun')
    expect(jun.items.map(i => i.deal_id)).toEqual(['big', 'small'])
    expect(jun.items[0]).toMatchObject({ title: 'Big', take: 900, is_flat: false })
  })

  it('ignores deals outside the range and deals with no closing date', () => {
    const s = buildEarningsSeries([
      row({ deal_id: 'before', closed_at: '2026-04-30T12:00:00Z', take: 999 }),
      row({ deal_id: 'after',  closed_at: '2026-08-01T12:00:00Z', take: 999 }),
      row({ deal_id: 'open',   closed_at: null, take: 999 }),
      row({ deal_id: 'bogus',  closed_at: 'not a date', take: 999 }),
      row({ deal_id: 'in',     closed_at: '2026-06-15T12:00:00Z', take: 42 }),
    ], range)
    expect(s.totals.take).toBe(42)
    expect(s.totals.deals).toBe(1)
  })

  it('counts the whole final day of the range', () => {
    const s = buildEarningsSeries([row({ closed_at: '2026-07-31T23:30:00' })], range)
    expect(s.totals.deals).toBe(1)
  })

  it('buckets by week from Monday when asked', () => {
    const s = buildEarningsSeries(
      [row({ closed_at: '2026-07-15T00:00:00' })],   // a Wednesday
      { from: '2026-07-06', to: '2026-07-19', bucket: 'week' },
    )
    expect(s.points.map(p => p.key)).toEqual(['2026-07-06', '2026-07-13'])
    expect(s.points[1].take).toBe(1000)
    expect(s.points[1].label).toBe('Week of Jul 13, 2026')
  })

  it('reports the best bucket, and null when nothing was earned', () => {
    const s = buildEarningsSeries([
      row({ deal_id: 'a', closed_at: '2026-05-04T00:00:00Z', take: 500 }),
      row({ deal_id: 'b', closed_at: '2026-07-15T00:00:00Z', take: 1500 }),
    ], range)
    expect(s.best).toMatchObject({ take: 1500 })
    expect(buildEarningsSeries([], range).best).toBeNull()
  })

  it('an empty range still produces a full timeline of zero buckets', () => {
    const s = buildEarningsSeries([], range)
    expect(s.points).toHaveLength(3)
    expect(s.totals).toMatchObject({ take: 0, deals: 0 })
  })

  it('sums fees and gross alongside the take', () => {
    const s = buildEarningsSeries([
      row({ deal_id: 'a', closed_at: '2026-06-02T00:00:00Z', take: 100, fees: 50, gross: 1000 }),
      row({ deal_id: 'b', closed_at: '2026-06-03T00:00:00Z', take: 200, fees: 25, gross: 2000 }),
    ], range)
    const jun = s.points.find(p => p.short === 'Jun')
    expect(jun.fees).toBe(75)
    expect(jun.gross).toBe(3000)
  })

  it('rounds money to cents rather than accumulating float dust', () => {
    const s = buildEarningsSeries([
      row({ deal_id: 'a', closed_at: '2026-06-02T00:00:00Z', take: 0.1 }),
      row({ deal_id: 'b', closed_at: '2026-06-03T00:00:00Z', take: 0.2 }),
    ], range)
    expect(s.totals.take).toBe(0.3)
  })
})

describe('toYmd', () => {
  it('formats in local time, not UTC', () => {
    expect(toYmd(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})
