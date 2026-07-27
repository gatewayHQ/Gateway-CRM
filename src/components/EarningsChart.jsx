import React, { useMemo, useState, useRef, useEffect } from 'react'
import { formatCurrency } from '../lib/helpers.js'
import { RANGE_PRESETS, toYmd } from '../lib/earnings.js'

// ─────────────────────────────────────────────────────────────────────────────
// EarningsChart — an agent's commission income over time.
//
// Presentational and pure: it renders whatever `series` it is handed (the shape
// src/lib/earnings.js produces), so the exact same component serves the agent's
// own chart (series aggregated server-side by /api/portal?action=my-earnings)
// and the admin's per-agent view (series aggregated in the browser from data an
// admin already holds). No fetching, no commission math in here.
//
// Each bar is one bucket (week or month) split into the part earned on
// percentage-rate deals and the part earned on flat-fee deals — the two ways a
// deal can be priced since the agent-set compensation feature.
//
// Hand-rolled SVG, matching the Monthly Commissions chart on the Back Office
// tracker: this project has no charting dependency and one inline <svg> keeps it
// that way (nothing to bundle, nothing to keep patched).
// ─────────────────────────────────────────────────────────────────────────────

const RATE_COLOR = 'var(--gw-green)'
const FLAT_COLOR = 'var(--gw-azure)'

// Visually hidden but read by screen readers — the SVG is decorative, this table
// carries the same numbers.
const SR_ONLY = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
}

const fmtK = (v) => {
  const abs = Math.abs(v)
  if (abs >= 1000) return `$${(v / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`
  return `$${Math.round(v)}`
}

const fmtDay = (ymd) => {
  if (!ymd) return ''
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

// Chart box. The width is measured from the container and used as the viewBox
// width too, so one SVG unit is always one CSS pixel: labels stay exactly 10px
// on a phone instead of being scaled down into illegibility (the failure mode of
// a fixed viewBox stretched to 100%). Bars narrower than MIN_SLOT push the chart
// past the container and it scrolls horizontally instead of turning into slivers.
const H = 230
const MIN_SLOT = 30
const PAD_LEFT = 60, PAD_RIGHT = 12, PAD_TOP = 14, PAD_BOTTOM = 42
const chartH = H - PAD_TOP - PAD_BOTTOM

export default function EarningsChart({
  series,
  loading      = false,
  selectedKey  = null,
  onSelect,                       // (key | null) => void — click/Enter a bar
  title        = 'My Commissions',
  subtitle,
  range,                          // { preset, from, to } — omit to hide the picker
  onRangeChange,                  // ({ preset, from, to }) => void
  headerExtra,                    // e.g. the admin's agent picker
}) {
  const [hover, setHover] = useState(null)   // { key, x, y }

  // Measured container width → chart width (see the H / MIN_SLOT note above).
  const wrapRef = useRef(null)
  const [boxW, setBoxW] = useState(680)

  const points = series?.points || []
  const totals = series?.totals || { take: 0, rate_take: 0, flat_take: 0, deals: 0 }
  const bucket = series?.bucket || 'month'

  const maxVal   = Math.max(...points.map(p => p.take), 1)
  const hasFlat  = totals.flat_take > 0
  const hasRate  = totals.rate_take > 0
  const hasData  = points.some(p => p.take > 0)

  const W       = Math.max(300, boxW, points.length * MIN_SLOT + PAD_LEFT + PAD_RIGHT)
  const chartW  = W - PAD_LEFT - PAD_RIGHT
  const barSlot = points.length ? chartW / points.length : chartW
  const barW    = Math.max(4, Math.min(barSlot * 0.72, 46))

  // Round, readable gridlines rather than exact-max ticks.
  const yTicks = useMemo(() => {
    const nice = [100, 250, 500, 1000, 2500, 5000, 10_000, 25_000, 50_000, 100_000, 250_000]
    const step = nice.find(n => maxVal / n <= 4) || Math.ceil(maxVal / 4 / 1000) * 1000
    const out = []
    for (let v = 0; v <= maxVal * 1.08; v += step) out.push(v)
    return out
  }, [maxVal])

  const toY = (v) => PAD_TOP + chartH - (v / maxVal) * chartH

  // Crowded axes thin the text out; every bar is still drawn. ~44px per label is
  // what a short month/week name needs before neighbours start colliding.
  const labelEvery = Math.max(1, Math.ceil(44 / Math.max(1, barSlot)))

  const tip = hover ? points.find(p => p.key === hover.key) : null

  // Re-attached whenever the plot appears (it isn't mounted while loading or
  // empty), so the first real render measures instead of using the seed width.
  const plotted = !loading && hasData
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = Math.round(entries[0]?.contentRect?.width || 0)
      if (w > 0) setBoxW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [plotted])

  const pick = (key) => { if (onSelect) onSelect(selectedKey === key ? null : key) }

  const showTip = (key, e) => {
    const svg = e.currentTarget.closest('svg')
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const i = points.findIndex(p => p.key === key)
    const cx = PAD_LEFT + i * barSlot + barSlot / 2
    setHover({
      key,
      x: rect.left + (cx / W) * rect.width,
      y: rect.top + (toY(points[i].take) / H) * rect.height,
    })
  }

  return (
    <div className="card" style={{ marginBottom: 20, padding: '16px 18px', overflow: 'visible' }}
      role="figure" aria-label={`${title} — ${bucket === 'week' ? 'weekly' : 'monthly'} commission earnings`}>

      {/* ── Header: title, range picker, legend ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>
          <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>
            {subtitle || `Closed deals · by ${bucket === 'week' ? 'week' : 'month'}`}
            {series?.from && <> · {fmtDay(series.from)} – {fmtDay(series.to)}</>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {headerExtra}
          {range && onRangeChange && (
            <RangeControls range={range} onChange={onRangeChange} />
          )}
        </div>
      </div>

      {/* ── Totals for the visible range ── */}
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 14, fontSize: 12 }}>
        <span>Total earned: <strong style={{ color: 'var(--gw-green)', fontSize: 14 }}>{formatCurrency(totals.take)}</strong></span>
        <span style={{ color: 'var(--gw-mist)' }}>
          {totals.deals} deal{totals.deals === 1 ? '' : 's'}
        </span>
        {hasRate && <span style={{ color: 'var(--gw-mist)' }}>Rate-based: <strong style={{ color: 'var(--gw-ink)' }}>{formatCurrency(totals.rate_take)}</strong></span>}
        {hasFlat && <span style={{ color: 'var(--gw-mist)' }}>Flat fees: <strong style={{ color: 'var(--gw-ink)' }}>{formatCurrency(totals.flat_take)}</strong></span>}
        {series?.best && <span style={{ color: 'var(--gw-mist)' }}>Best: <strong style={{ color: 'var(--gw-ink)' }}>{series.best.label}</strong></span>}
      </div>

      {/* ── Legend ── */}
      <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--gw-mist)', marginBottom: 6 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: RATE_COLOR }} aria-hidden="true" />
          % commission
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: FLAT_COLOR }} aria-hidden="true" />
          Flat fee
        </span>
        {onSelect && hasData && (
          <span style={{ marginLeft: 'auto' }}>
            {selectedKey ? 'Showing one period — click the bar again to clear' : 'Click a bar to see its deals'}
          </span>
        )}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--gw-mist)', fontSize: 13 }}>Loading…</div>
      ) : !hasData ? (
        <div style={{ textAlign: 'center', padding: '36px 0', color: 'var(--gw-mist)', fontSize: 13 }}>
          No commissions in this range yet. Closed deals appear here as soon as the office records them.
        </div>
      ) : (
        <div ref={wrapRef} style={{ position: 'relative', width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block' }}>
            {/* Y grid + labels */}
            {yTicks.map(tick => {
              const y = toY(tick)
              if (y < PAD_TOP - 4) return null
              return (
                <g key={tick} aria-hidden="true">
                  <line x1={PAD_LEFT} y1={y} x2={W - PAD_RIGHT} y2={y}
                    stroke="var(--gw-border)" strokeWidth={tick === 0 ? 1.5 : 0.8}
                    strokeDasharray={tick === 0 ? 'none' : '3 3'} />
                  <text x={PAD_LEFT - 6} y={y + 4} textAnchor="end" fontSize={10}
                    fill="var(--gw-mist)" fontFamily="var(--font-body)">{fmtK(tick)}</text>
                </g>
              )
            })}

            {/* Bars — rate at the bottom, flat fees stacked on top */}
            {points.map((p, i) => {
              const x       = PAD_LEFT + i * barSlot + (barSlot - barW) / 2
              const baseY   = PAD_TOP + chartH
              const rateH   = (p.rate_take / maxVal) * chartH
              const flatH   = (p.flat_take / maxVal) * chartH
              const totalH  = rateH + flatH
              const isSel   = selectedKey === p.key
              const dimmed  = selectedKey && !isSel
              const label   = `${p.label}: ${formatCurrency(p.take)} from ${p.deals} deal${p.deals === 1 ? '' : 's'}`
                + (p.flat_take > 0 && p.rate_take > 0
                    ? ` (${formatCurrency(p.rate_take)} rate-based, ${formatCurrency(p.flat_take)} flat fee)` : '')

              return (
                <g key={p.key}
                  role={onSelect ? 'button' : 'img'}
                  aria-label={label}
                  aria-pressed={onSelect ? isSel : undefined}
                  tabIndex={p.take > 0 ? 0 : -1}
                  style={{ cursor: onSelect && p.take > 0 ? 'pointer' : 'default', opacity: dimmed ? 0.45 : 1, transition: 'opacity 150ms' }}
                  onMouseEnter={e => p.take > 0 && showTip(p.key, e)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={e => p.take > 0 && showTip(p.key, e)}
                  onBlur={() => setHover(null)}
                  onClick={() => p.take > 0 && pick(p.key)}
                  onKeyDown={e => {
                    if ((e.key === 'Enter' || e.key === ' ') && p.take > 0) { e.preventDefault(); pick(p.key) }
                  }}>
                  {/* Full-height hit area so thin bars stay easy to hit/tap */}
                  <rect x={x - (barSlot - barW) / 2} y={PAD_TOP} width={barSlot} height={chartH} fill="transparent" />
                  {rateH > 0 && (
                    <rect x={x} y={baseY - rateH} width={barW} height={rateH}
                      fill={RATE_COLOR} opacity={0.9} rx={flatH > 0 ? 0 : 2} />
                  )}
                  {flatH > 0 && (
                    <rect x={x} y={baseY - totalH} width={barW} height={flatH}
                      fill={FLAT_COLOR} opacity={0.9} rx={2} />
                  )}
                  {totalH === 0 && (
                    <rect x={x} y={baseY - 2} width={barW} height={2} fill="var(--gw-border)" rx={1} />
                  )}
                  {isSel && (
                    <rect x={x - 2} y={baseY - totalH - 3} width={barW + 4} height={totalH + 3}
                      fill="none" stroke="var(--gw-slate)" strokeWidth={1.5} rx={3} />
                  )}
                  {/* X label */}
                  {i % labelEvery === 0 && (
                    <text x={x + barW / 2} y={H - PAD_BOTTOM + 15} textAnchor="middle" fontSize={10}
                      fill={p.take > 0 ? 'var(--gw-ink)' : 'var(--gw-mist)'}
                      fontFamily="var(--font-body)" fontWeight={p.take > 0 ? 600 : 400}>
                      {p.short}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>

          {/* Hover / focus tooltip — fixed-positioned so the scroll container
              can't clip it (same approach as the Back Office chart). */}
          {tip && (
            <div role="tooltip" style={{
              position: 'fixed', left: hover.x, top: hover.y - 10,
              transform: 'translate(-50%, -100%)',
              background: 'var(--gw-slate)', color: '#fff', borderRadius: 'var(--radius)',
              padding: '8px 12px', fontSize: 12, lineHeight: 1.55, pointerEvents: 'none',
              zIndex: 200, maxWidth: 260, boxShadow: 'var(--shadow-modal)',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>{tip.label}</div>
              <div>Earned: <strong>{formatCurrency(tip.take)}</strong></div>
              {tip.rate_take > 0 && tip.flat_take > 0 && (
                <div style={{ color: 'rgba(255,255,255,0.75)' }}>
                  {formatCurrency(tip.rate_take)} rate · {formatCurrency(tip.flat_take)} flat
                </div>
              )}
              {tip.items.slice(0, 3).map(it => (
                <div key={it.deal_id} style={{ color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {it.title} — {formatCurrency(it.take)}{it.is_flat ? ' (flat)' : ''}
                </div>
              ))}
              {tip.items.length > 3 && (
                <div style={{ color: 'rgba(255,255,255,0.6)' }}>+{tip.items.length - 3} more</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Same data, for screen readers and anyone who'd rather read numbers. */}
      {hasData && (
        <table style={SR_ONLY}>
          <caption>{title} by {bucket === 'week' ? 'week' : 'month'}</caption>
          <thead>
            <tr><th>Period</th><th>Total earned</th><th>Rate-based</th><th>Flat fee</th><th>Deals</th></tr>
          </thead>
          <tbody>
            {points.filter(p => p.take > 0).map(p => (
              <tr key={p.key}>
                <td>{p.label}</td>
                <td>{formatCurrency(p.take)}</td>
                <td>{formatCurrency(p.rate_take)}</td>
                <td>{formatCurrency(p.flat_take)}</td>
                <td>{p.deals}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Range picker ─────────────────────────────────────────────────────────────
// Preset dropdown in the app's usual `filter-select` style; picking "Custom
// range…" reveals two date inputs.
function RangeControls({ range, onChange }) {
  const isCustom = range.preset === 'custom'
  const today = toYmd(new Date())

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <label style={SR_ONLY} htmlFor="earnings-range">Time range</label>
      <select id="earnings-range" className="filter-select" value={range.preset}
        onChange={e => onChange({ ...range, preset: e.target.value })}>
        {RANGE_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      {isCustom && (
        <>
          <input className="filter-select" type="date" aria-label="Range start" max={range.to || today}
            value={range.from || ''} onChange={e => onChange({ ...range, preset: 'custom', from: e.target.value })} />
          <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>to</span>
          <input className="filter-select" type="date" aria-label="Range end" min={range.from || undefined}
            value={range.to || ''} onChange={e => onChange({ ...range, preset: 'custom', to: e.target.value })} />
        </>
      )}
    </div>
  )
}
