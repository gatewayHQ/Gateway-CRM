// ─────────────────────────────────────────────────────────────────────────────
// Gateway CRM — agent earnings analytics
//
// Pure bucketing helpers behind the My Earnings chart. They take the rows
// `/api/portal?action=my-earnings` already returns (one per deal the caller is
// paid on) and roll them into calendar months — no I/O, no dollar math of their
// own. Every figure originates in src/lib/commission.js and is only ever summed
// here, so the chart can never disagree with the table beneath it.
// ─────────────────────────────────────────────────────────────────────────────

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

/**
 * Roll an agent's earnings rows into the last `months` calendar months, oldest
 * first and always ending with the current month. Months with no closings are
 * present with zeroed totals — the chart needs the empty slots to keep its
 * x-axis evenly spaced and to show that nothing closed, rather than silently
 * compressing the timeline.
 *
 * Only CLOSED deals contribute. A closed deal with no `closed_at` is skipped
 * rather than guessed at, and anything outside the window is ignored.
 *
 * Note on `closed_at`: the API derives it from `deals.updated_at`, so editing a
 * long-closed deal moves it into the current month. The admin chart shares that
 * quirk — the fix is a real closing-date column, not different bucketing here.
 */
export function monthlyEarnings(deals = [], { months = 12, now = new Date() } = {}) {
  const buckets = []
  const index = new Map()

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const bucket = {
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en-US', { month: 'short', year: '2-digit' }),
      shortLabel: d.toLocaleString('en-US', { month: 'short' }),
      year: d.getFullYear(),
      month: d.getMonth(),
      take: 0,
      fees: 0,
      count: 0,
    }
    buckets.push(bucket)
    index.set(bucket.key, bucket)
  }

  for (const deal of deals) {
    if (!deal?.closed || !deal.closed_at) continue
    const when = new Date(deal.closed_at)
    if (Number.isNaN(when.getTime())) continue
    const bucket = index.get(`${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}`)
    if (!bucket) continue                       // outside the window
    bucket.take += num(deal.take)
    bucket.fees += num(deal.fees)
    bucket.count += 1
  }

  // Round only the surfaced totals, so summing many cents can't drift.
  for (const b of buckets) { b.take = round2(b.take); b.fees = round2(b.fees) }
  return buckets
}

/**
 * Headline figures for the chart: the tallest bar (for scaling), the window
 * total, the best month, and a monthly average taken over months that actually
 * had a closing — averaging across empty months would understate what the agent
 * earns when they close something.
 */
export function earningsSummary(buckets = []) {
  const active = buckets.filter(b => b.count > 0)
  const total = buckets.reduce((s, b) => s + num(b.take), 0)
  const best = active.reduce((a, b) => (b.take > (a?.take ?? -Infinity) ? b : a), null)
  return {
    max: Math.max(...buckets.map(b => num(b.take)), 0),
    total: round2(total),
    deals: buckets.reduce((s, b) => s + num(b.count), 0),
    activeMonths: active.length,
    best,
    avgPerActiveMonth: active.length ? round2(total / active.length) : 0,
  }
}

/**
 * Index of the first bucket inside the agent's current cap year, or -1 when the
 * window start isn't in range. The chart draws a boundary there so a 12-month
 * view reconciles with the cap-year totals in the summary cards above it.
 */
export function capYearBoundaryIndex(buckets = [], windowStart) {
  if (!windowStart) return -1
  // Date-only strings parse as UTC midnight, which shifts a day in negative-
  // offset timezones — anchor to noon so the month is stable everywhere.
  const start = new Date(/^\d{4}-\d{2}-\d{2}$/.test(windowStart) ? `${windowStart}T12:00:00` : windowStart)
  if (Number.isNaN(start.getTime())) return -1
  return buckets.findIndex(b => b.year === start.getFullYear() && b.month === start.getMonth())
}
