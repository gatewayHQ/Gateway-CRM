import React from 'react'
import { formatCurrency } from '../lib/helpers.js'
import { monthlyEarnings, axisFor, shortMoney, describeYear } from '../lib/earningsChart.js'

// ─────────────────────────────────────────────────────────────────────────────
// COMMISSION BY MONTH — earned, and what is still only projected.
//
// ON THE COLOURS. Gateway's own gold (#c9a84c) and azure (#4a6fa5) are brand
// colours, and neither survives being used as DATA: the gold sits at 2.23:1
// against a white card, and the azure's chroma is low enough that a colourblind
// reader sees grey. Both were checked rather than guessed — the two below are
// deepened relatives that pass the whole battery (chroma floor, CVD separation
// ΔE 24.4, normal-vision ΔE 27.4, contrast ≥ 3:1 on white).
//
// Projected money also carries a HATCH, not just a hue, so "money I have" and
// "money I might have" stay apart in greyscale, in a print-out, and for a reader
// who cannot separate the two colours at all.
//
// ONE AXIS, ALWAYS. Earned and projected are the same measure in two states of
// certainty. Giving the projection its own scale would draw a thin pipeline as
// tall as a fat closed month, which is the single most misleading thing this
// chart could do.
// ─────────────────────────────────────────────────────────────────────────────
const EARNED    = '#a9812a'
const PROJECTED = '#2f5c9e'

// Plot geometry, in the SVG's own units. The viewBox leaves room at the top for
// a direct label and at the bottom for month names — a chart whose labels sit
// outside its own box is a chart that clips on someone's screen.
const W = 760, H = 248, PAD_L = 52, PAD_R = 8, PAD_T = 30, BASE = 200

export default function EarningsChart({ deals = [], now = Date.now() }) {
  const summary = monthlyEarnings(deals, { now })
  const { top, ticks } = axisFor(Math.max(summary.peak, summary.unscheduled))

  // A thirteenth column when there is projected money with no expected close
  // date. It is the honest place for it: the money is real, the MONTH is not
  // known, and spreading it across the autumn would be the chart inventing
  // dates the deals do not have. Set the dates on those deals and the bars move
  // into their months — the caption says so.
  const hasUndated = summary.unscheduled > 0
  const cols  = hasUndated ? 13 : 12
  const slot  = (W - PAD_L - PAD_R) / cols
  const barW  = Math.min(32, slot - 10)
  const xOf   = (i) => PAD_L + slot * i + (slot - barW) / 2
  const yOf   = (v) => BASE - (v / top) * (BASE - PAD_T)
  // A month with money in it never draws as nothing: below ~3 units the bar
  // disappears and the month reads as empty, which is a different fact.
  const hOf   = (v) => (v > 0 ? Math.max(3, BASE - yOf(v)) : 0)


  // Nothing to draw only when there is nothing at all — including the undated
  // column, which is the whole projection on a deal book where nobody has set
  // expected close dates.
  if (!summary.peak && !summary.unscheduled) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--gw-mist)', padding: '4px 0 2px' }}>
        Nothing closed or projected for {summary.year} yet — closed deals and open ones with an expected
        close date appear here by month.
      </div>
    )
  }

  return (
    <figure style={{ margin: 0 }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', fontSize: 11, color: 'var(--gw-mist)', marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 10, height: 10, borderRadius: 2, background: EARNED, display: 'inline-block' }} /> Earned
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 10, height: 10, borderRadius: 2, background: '#e7eefa', border: `1.5px solid ${PROJECTED}`, display: 'inline-block' }} /> Projected from open deals
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', maxWidth: '100%' }}
        role="img"
        aria-label={`Commission by month for ${summary.year}. ${describeYear(summary)}`}
      >
        <defs>
          <pattern id="gw-earn-hatch" width="6" height="6" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <rect width="6" height="6" fill="#eef3fb" />
            <line x1="0" y1="0" x2="0" y2="6" stroke={PROJECTED} strokeWidth="2.4" opacity="0.5" />
          </pattern>
        </defs>

        {/* Grid and the axis it belongs to. Recessive on purpose: the bars are
            the data, the grid is a ruler held up behind them. */}
        {ticks.map((t, i) => {
          const y = yOf(t)
          return (
            <g key={t}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y}
                    stroke={i === 0 ? 'var(--gw-border)' : '#efeee9'} strokeWidth="1" />
              <text x={PAD_L - 8} y={y + 3.5} textAnchor="end" fontSize="10" fill="var(--gw-mist)">
                {t === 0 ? '$0' : shortMoney(t)}
              </text>
            </g>
          )
        })}

        {summary.months.map(m => {
          const x = xOf(m.i)
          const earnedH = hOf(m.earned)
          const projH   = hOf(m.projected)
          return (
            <g key={m.label}>
              {m.earned > 0 && (
                <rect x={x} y={BASE - earnedH} width={barW} height={earnedH} rx="3" fill={EARNED}>
                  <title>{`${m.label} · ${formatCurrency(m.earned)} earned from ${m.closedDeals} deal${m.closedDeals === 1 ? '' : 's'}`}</title>
                </rect>
              )}
              {m.projected > 0 && (
                <rect x={x} y={BASE - projH} width={barW} height={projH} rx="3"
                      fill="url(#gw-earn-hatch)" stroke={PROJECTED} strokeWidth="1.2">
                  <title>{`${m.label} · ${formatCurrency(m.projected)} projected from ${m.openDeals} open deal${m.openDeals === 1 ? '' : 's'}`}</title>
                </rect>
              )}
              {/* THE NUMBER OVER EVERY BAR. A chart an agent has to hover to
                  read is a chart they screenshot and then annotate by hand. */}
              {(m.earned > 0 || m.projected > 0) && (
                <text x={x + barW / 2} y={yOf(Math.max(m.earned, m.projected)) - 6} textAnchor="middle"
                      fontSize="9.5" fontWeight="700" fill="var(--gw-ink)">
                  {shortMoney(Math.max(m.earned, m.projected))}
                </text>
              )}
              <text x={x + barW / 2} y={BASE + 15} textAnchor="middle" fontSize="10"
                    fill={m.i === summary.todayMonth ? 'var(--gw-ink)' : 'var(--gw-mist)'}
                    fontWeight={m.i === summary.todayMonth ? 700 : 400}>
                {m.label}
              </text>
            </g>
          )
        })}

        {/* The undated projection, kept at arm's length from the months by a
            rule so it can never be read as December. */}
        {hasUndated && (
          <g>
            <line x1={PAD_L + slot * 12 - 3} y1={PAD_T - 16} x2={PAD_L + slot * 12 - 3} y2={BASE}
                  stroke="var(--gw-border)" strokeWidth="1" />
            <rect x={xOf(12)} y={BASE - hOf(summary.unscheduled)} width={barW} height={hOf(summary.unscheduled)}
                  rx="3" fill="url(#gw-earn-hatch)" stroke={PROJECTED} strokeWidth="1.2" strokeDasharray="3 2">
              <title>{`${formatCurrency(summary.unscheduled)} projected, with no expected close date set`}</title>
            </rect>
            <text x={xOf(12) + barW / 2} y={yOf(summary.unscheduled) - 6} textAnchor="middle"
                  fontSize="9.5" fontWeight="700" fill="var(--gw-ink)">
              {shortMoney(summary.unscheduled)}
            </text>
            <text x={xOf(12) + barW / 2} y={BASE + 15} textAnchor="middle" fontSize="9" fill="var(--gw-mist)">No date</text>
          </g>
        )}

        {/* Where the year has got to. Only on the current year. */}
        {summary.todayMonth != null && (
          <g>
            <line x1={PAD_L + slot * (summary.todayMonth + 1)} y1={PAD_T - 14}
                  x2={PAD_L + slot * (summary.todayMonth + 1)} y2={BASE + 4}
                  stroke="var(--gw-mist)" strokeWidth="1" strokeDasharray="3 3" />
            <text x={PAD_L + slot * (summary.todayMonth + 1) + 4} y={PAD_T - 6} fontSize="9" fill="var(--gw-mist)">today</text>
          </g>
        )}
      </svg>

      <figcaption style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 6, lineHeight: 1.6 }}>
        {describeYear(summary)} Hover a bar for the exact figure.
      </figcaption>
    </figure>
  )
}
