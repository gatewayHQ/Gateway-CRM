import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Badge, EmptyState, Loading } from '../components/UI.jsx'
import { formatCurrency, formatDate, STAGE_LABELS } from '../lib/helpers.js'
import { monthlyEarnings, earningsSummary, capYearBoundaryIndex } from '../lib/earnings.js'

// ─────────────────────────────────────────────────────────────────────────────
// My Earnings — what a non-admin agent sees on the Commission page since the
// back-office change (2026-06-12): their own takes, cap progress, and fees.
// All numbers come from /api/portal?action=my-earnings, which computes the
// caller's slice server-side — co-agents' splits never reach this browser.
// ─────────────────────────────────────────────────────────────────────────────

// ── My Earnings bar chart ────────────────────────────────────────────────────
// The agent's own take, by month. Deliberately a SINGLE series: the admin chart
// stacks agent-vs-brokerage dollars, but house revenue isn't this agent's
// business and the numbers here must stay to what /api/portal already scoped to
// them. Every figure is summed from the same rows as the table below, so the two
// can never disagree. Visual language matches the admin chart on purpose.
function EarningsChart({ deals, capWindowStart }) {
  const [tooltip, setTooltip] = useState(null)
  const [range, setRange]     = useState(12)      // months

  const buckets  = React.useMemo(() => monthlyEarnings(deals, { months: range }), [deals, range])
  const summary  = React.useMemo(() => earningsSummary(buckets), [buckets])
  const capIdx   = React.useMemo(() => capYearBoundaryIndex(buckets, capWindowStart), [buckets, capWindowStart])

  // Layout — mirrors the admin chart's proportions.
  const W = 780, H = 220
  const PAD_LEFT = 70, PAD_RIGHT = 16, PAD_TOP = 16, PAD_BOTTOM = 40
  const chartW = W - PAD_LEFT - PAD_RIGHT
  const chartH = H - PAD_TOP - PAD_BOTTOM
  const barSlot = chartW / buckets.length
  const barW    = barSlot * 0.75

  // Scale headroom so the tallest bar never touches the top gridline.
  const maxVal = Math.max(summary.max, 1)
  const yTicks = React.useMemo(() => {
    const nice = [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000]
    const step = nice.find(n => maxVal / n <= 4) || Math.ceil(maxVal / 4 / 1000) * 1000
    const ticks = []
    for (let v = 0; v <= maxVal * 1.1; v += step) ticks.push(v)
    return ticks
  }, [maxVal])

  const toY  = v => PAD_TOP + chartH - (v / maxVal) * chartH
  const fmtK = v => v >= 1000 ? `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `$${v}`
  const baseY = PAD_TOP + chartH

  return (
    <div className="card" style={{ marginBottom: 20, padding: '18px 20px', overflow: 'hidden' }}
      role="figure" aria-label="My commissions by month">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>My Commissions by Month</div>
          <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>
            Your take on closed deals
            {summary.deals > 0 && <> · {formatCurrency(summary.total)} across {summary.deals} deal{summary.deals !== 1 ? 's' : ''}</>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--gw-bone)', borderRadius: 8, padding: 3 }}>
          {[[6, '6 mo'], [12, '12 mo'], [24, '24 mo']].map(([val, lbl]) => (
            <button key={val} onClick={() => setRange(val)}
              style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none',
                background: range === val ? '#fff' : 'transparent',
                color: range === val ? 'var(--gw-ink)' : 'var(--gw-mist)',
                boxShadow: range === val ? '0 1px 3px rgba(0,0,0,0.1)' : 'none', transition: 'all 150ms' }}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {summary.deals === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--gw-mist)', fontSize: 13 }}>
          Nothing closed in the last {range} months yet — your first commission will show up here.
        </div>
      ) : (
        <>
          <div style={{ position: 'relative', width: '100%', overflowX: 'auto' }}>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', width: '100%', minWidth: 340, height: 'auto' }} aria-hidden="true">
              {/* Y-axis grid + labels */}
              {yTicks.map(tick => {
                const y = toY(tick)
                if (y < PAD_TOP - 4) return null
                return (
                  <g key={tick}>
                    <line x1={PAD_LEFT} y1={y} x2={W - PAD_RIGHT} y2={y}
                      stroke="var(--gw-border)" strokeWidth={tick === 0 ? 1.5 : 0.8}
                      strokeDasharray={tick === 0 ? 'none' : '3 3'} />
                    <text x={PAD_LEFT - 6} y={y + 4} textAnchor="end" fontSize={10}
                      fill="var(--gw-mist)" fontFamily="var(--font-body)">{fmtK(tick)}</text>
                  </g>
                )
              })}

              {/* Cap-year boundary — reconciles this chart with the cap-year
                  totals in the cards above, which start counting here. */}
              {capIdx > 0 && (
                <g>
                  <line x1={PAD_LEFT + capIdx * barSlot} y1={PAD_TOP - 4}
                    x2={PAD_LEFT + capIdx * barSlot} y2={baseY}
                    stroke="var(--gw-azure)" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
                  <text x={PAD_LEFT + capIdx * barSlot + 4} y={PAD_TOP + 4}
                    fontSize={9} fill="var(--gw-azure)" fontFamily="var(--font-body)" fontWeight={700}>
                    cap year
                  </text>
                </g>
              )}

              {/* Bars */}
              {buckets.map((m, i) => {
                const x = PAD_LEFT + i * barSlot + (barSlot - barW) / 2
                const h = (m.take / maxVal) * chartH
                return (
                  <g key={m.key}
                    style={{ cursor: m.count > 0 ? 'pointer' : 'default' }}
                    onMouseEnter={e => {
                      if (!m.count) return
                      const rect = e.currentTarget.closest('svg').getBoundingClientRect()
                      setTooltip({
                        x: (x + barW / 2) / W * rect.width + rect.left,
                        y: rect.top + (toY(m.take) / H) * rect.height,
                        ...m,
                      })
                    }}
                    onMouseLeave={() => setTooltip(null)}>
                    {h > 0 ? (
                      <rect x={x} y={baseY - h} width={barW} height={h} rx={2} ry={2}
                        fill="var(--gw-green)" opacity={0.9} />
                    ) : (
                      /* Flat stub for a month with no closings — reads as "zero",
                         not as missing data. */
                      <rect x={x} y={baseY - 3} width={barW} height={3} rx={1} ry={1} fill="var(--gw-border)" />
                    )}

                    <text x={x + barW / 2} y={H - PAD_BOTTOM + 14} textAnchor="middle" fontSize={10}
                      fill={m.count > 0 ? 'var(--gw-ink)' : 'var(--gw-mist)'}
                      fontFamily="var(--font-body)" fontWeight={m.count > 0 ? 600 : 400}>
                      {m.shortLabel}
                    </text>

                    {m.count > 0 && h > 0 && (
                      <text x={x + barW / 2} y={baseY - h - 5} textAnchor="middle" fontSize={9}
                        fill="var(--gw-mist)" fontFamily="var(--font-body)">{m.count}</text>
                    )}
                  </g>
                )
              })}
            </svg>

            {tooltip && (
              <div role="tooltip" style={{
                position: 'fixed', left: tooltip.x, top: tooltip.y - 8,
                transform: 'translate(-50%, -100%)',
                background: 'var(--gw-slate)', color: '#fff', borderRadius: 'var(--radius)',
                padding: '8px 12px', fontSize: 12, lineHeight: 1.6, pointerEvents: 'none',
                zIndex: 200, whiteSpace: 'nowrap', boxShadow: 'var(--shadow-modal)',
              }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{tooltip.label}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--gw-green)', flexShrink: 0 }} />
                  Your take: <strong>{formatCurrency(tooltip.take)}</strong>
                </div>
                {tooltip.fees > 0 && (
                  <div style={{ color: 'rgba(255,255,255,0.75)' }}>Fees: {formatCurrency(tooltip.fees)}</div>
                )}
                <div style={{ color: 'rgba(255,255,255,0.6)', marginTop: 3, fontSize: 11 }}>
                  {tooltip.count} closed deal{tooltip.count !== 1 ? 's' : ''}
                </div>
              </div>
            )}
          </div>

          {/* Screen readers get the numbers as a table rather than an SVG. */}
          <table style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
            <caption>My commissions by month, last {range} months</caption>
            <thead><tr><th>Month</th><th>Your take</th><th>Closed deals</th></tr></thead>
            <tbody>
              {buckets.map(m => (
                <tr key={m.key}><td>{m.label}</td><td>{formatCurrency(m.take)}</td><td>{m.count}</td></tr>
              ))}
            </tbody>
          </table>

          {/* Footer stats — the questions a bar chart always prompts. */}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--gw-border)', fontSize: 12, color: 'var(--gw-mist)' }}>
            <span>Best month: <strong style={{ color: 'var(--gw-ink)' }}>
              {summary.best ? `${summary.best.label} · ${formatCurrency(summary.best.take)}` : '—'}
            </strong></span>
            <span>Average when you close: <strong style={{ color: 'var(--gw-ink)' }}>{formatCurrency(summary.avgPerActiveMonth)}</strong></span>
            <span>Months with a closing: <strong style={{ color: 'var(--gw-ink)' }}>{summary.activeMonths} of {range}</strong></span>
          </div>
        </>
      )}
    </div>
  )
}

export default function MyEarnings({ activeAgent }) {
  const [data, setData]   = useState(null)
  const [error, setError] = useState(null)

  const load = async () => {
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setError('Please sign in again.'); return }
      const res = await fetch('/api/portal?action=my-earnings', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const body = await res.json()
      if (!res.ok) { setError(body.error || 'Could not load earnings'); return }
      setData(body)
    } catch {
      setError('Could not reach the server — check your connection.')
    }
  }
  useEffect(() => { load() }, [])

  if (error) return (
    <div className="page-content">
      <div className="page-header"><div><div className="page-title">My Earnings</div></div></div>
      <EmptyState icon="commission" title="Couldn't load your earnings" message={error}
        action={<button className="btn btn--primary" onClick={load}>Try again</button>} />
    </div>
  )
  if (!data) return <div className="page-content"><Loading /></div>

  const { cap, ytd, deals } = data
  const open   = deals.filter(d => !d.closed && d.stage !== 'lost')
  const closed = deals.filter(d => d.closed)
  const capPct = cap.prepaid ? 100 : (cap.amount > 0 ? Math.min(100, Math.round(cap.ytd_cap_paid / cap.amount * 100)) : 0)
  const pipelineTake = open.reduce((s, d) => s + (d.take || 0), 0)

  const dealRow = (d) => (
    <tr key={d.deal_id} style={{ borderTop: '1px solid var(--gw-border)' }}>
      <td style={{ padding: '9px 12px', fontWeight: 600 }}>{d.title}</td>
      <td style={{ padding: '9px 12px' }}><Badge variant={d.stage === 'closed' ? 'closed' : d.stage === 'lost' ? 'lost' : 'lead'}>{STAGE_LABELS[d.stage] || d.stage}</Badge></td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>{d.value > 0 ? formatCurrency(d.value) : '—'}</td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--gw-green)' }}>{formatCurrency(d.take)}</td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--gw-mist)' }}>{d.split_pct != null ? `${d.split_pct}%` : '—'}</td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--gw-mist)' }}>{d.fees > 0 ? formatCurrency(d.fees) : '—'}</td>
      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap', color: 'var(--gw-mist)' }}>{d.closed_at ? formatDate(d.closed_at) : '—'}</td>
    </tr>
  )

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">My Earnings</div>
          <div className="page-sub">Your commissions only — splits are entered and managed by the office.</div>
        </div>
        <button className="btn btn--secondary btn--sm" onClick={() => { setData(null); load() }}><Icon name="refresh" size={13} /> Refresh</button>
      </div>

      {/* ── Summary ── */}
      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 16 }}>
        <div className="stat-card" style={{ borderLeft: '3px solid var(--gw-green)' }}>
          <div className="stat-card__value" style={{ color: 'var(--gw-green)' }}>{formatCurrency(ytd.take)}</div>
          <div className="stat-card__label">Earned this cap year</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{ytd.deals}</div>
          <div className="stat-card__label">Deals closed</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{formatCurrency(pipelineTake)}</div>
          <div className="stat-card__label">Projected from open deals</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{formatCurrency(cap.ytd_fees)}</div>
          <div className="stat-card__label">Transaction fees paid</div>
        </div>
      </div>

      {/* ── Cap tracker ── */}
      <div className="card" style={{ marginBottom: 20, padding: '18px 20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Cap Progress</div>
          <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>
            {cap.prepaid
              ? 'Cap pre-paid — you keep 100% of your splits 🎉'
              : cap.amount > 0
                ? `${formatCurrency(cap.ytd_cap_paid)} of ${formatCurrency(cap.amount)} · resets ${cap.anniversary ? formatDate(cap.anniversary).replace(/, \d{4}$/, '') : 'Jan 1'}`
                : 'No cap configured — ask the office to set yours'}
          </div>
        </div>
        <div style={{ height: 10, background: 'var(--gw-border)', borderRadius: 5, overflow: 'hidden' }}>
          <div style={{ width: `${capPct}%`, height: '100%', borderRadius: 5, transition: 'width 400ms ease',
            background: cap.capped ? 'var(--gw-green)' : 'var(--gw-azure)' }} />
        </div>
        {cap.capped && !cap.prepaid && (
          <div style={{ fontSize: 12, color: 'var(--gw-green)', fontWeight: 700, marginTop: 8 }}>
            🎉 Cap hit — every split from here is 100% yours (flat fees still apply).
          </div>
        )}
      </div>

      {/* ── Monthly bar chart ── */}
      {/* Skipped entirely when there are no deals at all — the empty state below
          already says it, and two "nothing here yet" panels reads as broken. */}
      {deals.length > 0 && <EarningsChart deals={deals} capWindowStart={cap.window_start} />}

      {/* ── Deals ── */}
      {deals.length === 0 ? (
        <EmptyState icon="commission" title="No commission entries yet"
          message="When the office enters a commission on one of your deals, your numbers appear here." />
      ) : (
        <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius-lg)', background: '#fff', overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--gw-bone)', textAlign: 'left' }}>
                {['Deal', 'Stage', 'Sale Price', 'Your Take', 'Your Split', 'Fee', 'Closed'].map(h => (
                  <th key={h} style={{ padding: '9px 12px', fontSize: 11, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {open.map(dealRow)}
              {closed.map(dealRow)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
