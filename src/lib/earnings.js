/**
 * Gateway CRM — Earnings time series
 *
 * Buckets an agent's per-deal commission slices into a time series for the
 * personal earnings chart. Pure functions, no I/O — the SAME module runs on the
 * server (api/portal.js aggregates before it answers, so a book of business with
 * hundreds of closings never ships row-by-row to a phone) and in the browser for
 * the admin's "any agent" view, where the deals are already in memory.
 *
 * The dollar figures come from src/lib/commission.js — this file never does
 * commission math, it only groups already-computed takes by date. That keeps one
 * source of truth: whatever the office saved (splits, overrides) or the agent set
 * on the deal (rate or flat fee) is what lands in a bar.
 *
 * Rate vs flat: each slice carries `is_flat` from the resolved breakdown, so a
 * bar is split into the part earned on percentage deals and the part earned on
 * flat-fee deals. A two-sided deal that mixes both counts as flat (any flat side
 * makes the "%" reading meaningless — see computeCommission's `is_flat`).
 */

/** Selectable ranges, in the order the picker shows them. */
export const RANGE_PRESETS = [
  { id: '30d',  label: 'Last 30 days',   bucket: 'week'  },
  { id: '3m',   label: 'Last 3 months',  bucket: 'week'  },
  { id: '12m',  label: 'Last 12 months', bucket: 'month' },
  { id: 'ytd',  label: 'This year',      bucket: 'month' },
  { id: 'custom', label: 'Custom range…', bucket: 'month' },
]

const DEFAULT_PRESET = '12m'
const DAY = 86_400_000

const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

/** Local-midnight Date for a 'YYYY-MM-DD' string (never UTC — bars are local). */
const fromYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const toYmd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const startOfDay   = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1)
/** Monday-based week start (US brokerages report Mon–Sun). */
const startOfWeek  = (d) => {
  const s = startOfDay(d)
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7))
  return s
}

/**
 * Resolve a picker selection into concrete inclusive date bounds + a bucket
 * size. `from`/`to` are only read for the 'custom' preset (or when an unknown
 * preset arrives with explicit dates — that's how the API stays forgiving).
 *
 * Returns { preset, bucket, from, to } with from/to as 'YYYY-MM-DD'.
 */
export function resolveRange({ preset = DEFAULT_PRESET, from, to, bucket, now = new Date() } = {}) {
  const today = startOfDay(now)
  const known = RANGE_PRESETS.find(p => p.id === preset)
  const custom = preset === 'custom' || (!known && (isYmd(from) || isYmd(to)))

  let start, end = today
  if (custom) {
    start = isYmd(from) ? fromYmd(from) : new Date(today.getTime() - 29 * DAY)
    end   = isYmd(to)   ? fromYmd(to)   : today
    if (end < start) [start, end] = [end, start]
  } else {
    switch (known?.id || DEFAULT_PRESET) {
      case '30d': start = new Date(today.getTime() - 29 * DAY); break
      case '3m':  start = startOfWeek(new Date(today.getFullYear(), today.getMonth() - 3, today.getDate())); break
      case 'ytd': start = new Date(today.getFullYear(), 0, 1); break
      default:    start = startOfMonth(new Date(today.getFullYear(), today.getMonth() - 11, 1))
    }
  }

  // A custom range picks its own granularity: weeks read well up to ~4 months,
  // months beyond that (a 5-year range as weeks would be 260 unreadable bars).
  const span = Math.round((end - start) / DAY) + 1
  const resolvedBucket = bucket === 'week' || bucket === 'month'
    ? bucket
    : custom ? (span <= 120 ? 'week' : 'month') : (known?.bucket || 'month')

  return {
    preset: custom ? 'custom' : (known?.id || DEFAULT_PRESET),
    bucket: resolvedBucket,
    from: toYmd(start),
    to: toYmd(end),
  }
}

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

/** Every bucket in [from, to], oldest first — including the empty ones, so the
 *  chart shows a real timeline instead of only the months that happened to pay. */
function bucketsFor(from, to, bucket) {
  const start = fromYmd(from)
  const end   = fromYmd(to)
  const out = []
  let cursor = bucket === 'week' ? startOfWeek(start) : startOfMonth(start)
  while (cursor <= end) {
    const next = bucket === 'week'
      ? new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7)
      : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    out.push({
      key: toYmd(cursor),
      start: toYmd(cursor),
      end: toYmd(new Date(next.getTime() - DAY)),
      label: bucket === 'week'
        ? `Week of ${MONTH_SHORT[cursor.getMonth()]} ${cursor.getDate()}, ${cursor.getFullYear()}`
        : `${MONTH_SHORT[cursor.getMonth()]} ${cursor.getFullYear()}`,
      short: bucket === 'week'
        ? `${MONTH_SHORT[cursor.getMonth()]} ${cursor.getDate()}`
        : MONTH_SHORT[cursor.getMonth()],
      rate_take: 0, flat_take: 0, take: 0, fees: 0, gross: 0, deals: 0, items: [],
    })
    cursor = next
  }
  return out
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Group closed-deal slices into buckets.
 *
 * `rows`: [{ deal_id, title, closed_at, take, fees, gross, is_flat }] — one per
 * deal the agent was paid on. Rows outside the range, or with no closing date,
 * are skipped (an open deal has not earned anything yet).
 *
 * Returns { bucket, from, to, points, totals } where each point carries the
 * split between percentage and flat-fee earnings plus the deals behind it (for
 * tooltips and click-to-filter).
 */
export function buildEarningsSeries(rows = [], { from, to, bucket = 'month' } = {}) {
  const range = resolveRange({ preset: 'custom', from, to, bucket })
  const points = bucketsFor(range.from, range.to, range.bucket)
  const startMs = fromYmd(range.from).getTime()
  // Inclusive upper bound: the whole final day counts.
  const endMs = fromYmd(range.to).getTime() + DAY - 1

  // Bucket lookup by index — one pass over the rows, no per-row scan.
  const byKey = new Map(points.map((p, i) => [p.key, i]))
  const keyFor = (d) => toYmd(range.bucket === 'week' ? startOfWeek(d) : startOfMonth(d))

  for (const row of rows) {
    if (!row?.closed_at) continue
    const when = new Date(row.closed_at)
    if (Number.isNaN(when.getTime())) continue
    const ms = when.getTime()
    if (ms < startMs || ms > endMs) continue
    const idx = byKey.get(keyFor(when))
    if (idx == null) continue

    const p = points[idx]
    const take = num(row.take)
    p.take  += take
    p.fees  += num(row.fees)
    p.gross += num(row.gross)
    if (row.is_flat) p.flat_take += take
    else             p.rate_take += take
    p.deals += 1
    p.items.push({
      deal_id: row.deal_id,
      title: row.title || 'Deal',
      take: round2(take),
      closed_at: row.closed_at,
      is_flat: !!row.is_flat,
    })
  }

  for (const p of points) {
    p.take = round2(p.take); p.fees = round2(p.fees); p.gross = round2(p.gross)
    p.rate_take = round2(p.rate_take); p.flat_take = round2(p.flat_take)
    // Biggest contributor first — that's the one worth reading in a tooltip.
    p.items.sort((a, b) => b.take - a.take)
  }

  const totals = points.reduce((acc, p) => ({
    take:      round2(acc.take + p.take),
    rate_take: round2(acc.rate_take + p.rate_take),
    flat_take: round2(acc.flat_take + p.flat_take),
    fees:      round2(acc.fees + p.fees),
    gross:     round2(acc.gross + p.gross),
    deals:     acc.deals + p.deals,
  }), { take: 0, rate_take: 0, flat_take: 0, fees: 0, gross: 0, deals: 0 })

  // The best bucket in the range — the chart labels it so an agent can see their
  // strongest month without hovering every bar.
  const best = points.reduce((b, p) => (b == null || p.take > b.take ? p : b), null)

  return {
    bucket: range.bucket,
    from: range.from,
    to: range.to,
    points,
    totals,
    best: best && best.take > 0 ? { key: best.key, label: best.label, take: best.take } : null,
  }
}
