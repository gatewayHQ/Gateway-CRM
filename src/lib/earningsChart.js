// ─────────────────────────────────────────────────────────────────────────────
// THE EARNINGS YEAR, MONTH BY MONTH.
//
// The Commission page opened with four totals: earned, deals closed, projected,
// fees. Every one of them answers "how much" and none of them answers "when" —
// so an agent could not see that three of their last four months were empty, or
// that the entire projection is one deal in October.
//
// This turns the rows /api/portal?action=my-earnings already returns into the
// twelve buckets a chart draws. No new query, no new column: `closed_at` and
// `take` are in the payload today, and an open deal's `expected_close_date` is
// the month its money would land in.
//
// TWO STATES OF ONE MEASURE, NEVER TWO MEASURES. Earned and projected are both
// commission dollars, so they share one axis and one scale. What separates them
// is certainty, which the chart carries as fill and texture rather than as a
// second y-axis — a projection drawn against its own scale is how a pipeline
// gets mistaken for income.
//
// Pure. No Supabase, no Date.now() except through `now`, so a test can stand
// anywhere in the year.
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Month index 0-11 for an ISO date, or null when it isn't one. */
export function monthIndex(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.getUTCMonth()
}

/** The year an ISO date falls in, or null. */
export function yearOf(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.getUTCFullYear()
}

/**
 * Twelve buckets for one calendar year.
 *
 * A closed deal counts in the month it CLOSED; an open one in the month it is
 * expected to close. An open deal with no expected close date is counted in the
 * returned `unscheduled` total rather than being dropped — money the agent is
 * expecting has to appear somewhere, and silently vanishing from a chart is how
 * a projection stops being trusted.
 *
 * A closed deal from a previous year is ignored: this is a year's chart, and
 * last year's commission belongs on last year's.
 */
export function monthlyEarnings(deals = [], { year, now = Date.now() } = {}) {
  const yr = year ?? new Date(now).getUTCFullYear()
  const months = MONTHS.map((label, i) => ({ i, label, earned: 0, projected: 0, closedDeals: 0, openDeals: 0 }))
  let unscheduled = 0
  let earnedTotal = 0
  let projectedTotal = 0

  for (const deal of deals) {
    const take = Number(deal?.take) || 0
    if (deal?.closed) {
      if (yearOf(deal.closed_at) !== yr) continue
      const m = monthIndex(deal.closed_at)
      if (m == null) continue
      months[m].earned += take
      months[m].closedDeals += 1
      earnedTotal += take
      continue
    }
    // Open. A lost deal is not a projection — it is a deal that is not happening.
    if (String(deal?.stage || '').toLowerCase() === 'lost') continue
    projectedTotal += take
    const m = yearOf(deal?.expected_close_date) === yr ? monthIndex(deal.expected_close_date) : null
    if (m == null) { unscheduled += take; continue }
    months[m].projected += take
    months[m].openDeals += 1
  }

  const peak = months.reduce((n, m) => Math.max(n, m.earned, m.projected), 0)
  return {
    year: yr,
    months,
    peak,
    earnedTotal,
    projectedTotal,
    // What the chart cannot place. Named on the page rather than hidden.
    unscheduled,
    // Where "today" sits, so the chart can mark it — null for a year that is
    // not the current one, where the line would mean nothing.
    todayMonth: new Date(now).getUTCFullYear() === yr ? new Date(now).getUTCMonth() : null,
  }
}

/**
 * A y-axis that ends on a round number at or above the tallest bar.
 *
 * Never below it: a bar drawn past the top of its own scale is a chart lying
 * about its own maximum. Returns { top, ticks } with ticks including 0.
 */
export function axisFor(peak, steps = 2) {
  if (!(peak > 0)) return { top: 1000, ticks: [0, 500, 1000] }
  const rough = peak / steps
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)))
  const step  = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s * steps >= peak) || mag * 10
  const top   = step * steps
  return { top, ticks: Array.from({ length: steps + 1 }, (_, i) => Math.round(step * i)) }
}

/** "$43.9k" / "$920" — a bar's label, short enough to sit above it. */
export function shortMoney(n) {
  const v = Number(n) || 0
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`
  if (Math.abs(v) >= 1_000)     return `$${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`
  return `$${Math.round(v)}`
}

/**
 * The one sentence under the chart. Explains the scale when a single month
 * dwarfs the rest — the honest answer to "why do my closed months look flat".
 */
export function describeYear(summary) {
  if (!summary || !summary.peak) return 'Nothing closed or projected for this year yet.'
  const biggest = summary.months.reduce((best, m) =>
    (Math.max(m.earned, m.projected) > Math.max(best.earned, best.projected) ? m : best), summary.months[0])
  const isProjection = biggest.projected > biggest.earned
  const bits = [`${shortMoney(summary.earnedTotal)} earned`]
  if (summary.projectedTotal) bits.push(`${shortMoney(summary.projectedTotal)} projected`)
  const tail = isProjection
    ? `${biggest.label} is a projection, not money in hand.`
    : `${biggest.label} was the biggest month.`
  const stray = summary.unscheduled
    ? ` ${shortMoney(summary.unscheduled)} of the projection has no expected close date, so it is not on the chart.`
    : ''
  return `${bits.join(' · ')}. ${tail}${stray}`
}
