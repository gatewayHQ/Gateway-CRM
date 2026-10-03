import React from 'react'
import { formatMoney } from '../../lib/helpers.js'

// ── Monthly Bar Chart ─────────────────────────────────────────────────────────
export function MonthlyBarChart({ deals, calcFn }) {
  const [tooltip,  setTooltip]  = React.useState(null)
  const [category, setCategory] = React.useState('all') // 'all' | 'residential' | 'commercial'

  // Build last 12 months of data
  const months = React.useMemo(() => {
    const now   = new Date()
    const out   = []
    for (let i = 11; i >= 0; i--) {
      const d     = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const year  = d.getFullYear()
      const month = d.getMonth()
      const label = d.toLocaleString('en-US', { month: 'short', year: '2-digit' })
      const shortLabel = d.toLocaleString('en-US', { month: 'short' })
      const monthDeals = deals.filter(deal => {
        if (deal.stage !== 'closed') return false
        if (category === 'residential' && deal.prop_category === 'commercial') return false
        if (category === 'commercial'  && deal.prop_category !== 'commercial')  return false
        const closed = new Date(deal.updated_at || deal.created_at)
        return closed.getFullYear() === year && closed.getMonth() === month
      })
      const { agentTotal, brokerTotal } = monthDeals.reduce((acc, deal) => {
        const { agentAmt, brokerAmt } = calcFn(deal)
        acc.agentTotal  += agentAmt
        acc.brokerTotal += brokerAmt
        return acc
      }, { agentTotal: 0, brokerTotal: 0 })
      out.push({ label, shortLabel, agentTotal, brokerTotal, count: monthDeals.length })
    }
    return out
  }, [deals, calcFn, category])

  const maxVal = Math.max(...months.map(m => m.agentTotal + m.brokerTotal), 1)

  // Chart layout constants
  const W           = 780
  const H           = 220
  const PAD_LEFT    = 70
  const PAD_RIGHT   = 16
  const PAD_TOP     = 16
  const PAD_BOTTOM  = 40
  const chartW      = W - PAD_LEFT - PAD_RIGHT
  const chartH      = H - PAD_TOP - PAD_BOTTOM
  const BAR_GAP     = 0.25
  const barW        = chartW / months.length * (1 - BAR_GAP)
  const barSlot     = chartW / months.length

  // Y-axis ticks
  const yTicks = React.useMemo(() => {
    const nice = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000]
    const step = nice.find(n => maxVal / n <= 4) || Math.ceil(maxVal / 4 / 1000) * 1000
    const ticks = []
    for (let v = 0; v <= maxVal * 1.1; v += step) ticks.push(v)
    return ticks
  }, [maxVal])

  const toY  = v => PAD_TOP + chartH - (v / maxVal) * chartH
  const fmtK = v => v >= 1000 ? `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `$${v}`

  const hasAnyData = months.some(m => m.agentTotal > 0 || m.brokerTotal > 0)

  return (
    <div
      className="card"
      style={{ marginBottom: 20, padding: '18px 20px', overflow: 'hidden' }}
      role="figure"
      aria-label="Monthly commissions bar chart"
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Monthly Commissions</div>
          <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>Last 12 months · closed deals only</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Category toggle */}
          <div style={{ display: 'flex', gap: 4, background: 'var(--gw-bone)', borderRadius: 8, padding: 3 }}>
            {[['all','All'],['residential','🏠 Res'],['commercial','🏢 Comm']].map(([val, lbl]) => (
              <button key={val} onClick={() => setCategory(val)}
                style={{ padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: 'none', background: category === val ? '#fff' : 'transparent', color: category === val ? 'var(--gw-ink)' : 'var(--gw-mist)', boxShadow: category === val ? '0 1px 3px rgba(0,0,0,0.1)' : 'none', transition: 'all 150ms' }}>
                {lbl}
              </button>
            ))}
          </div>
          {/* Legend */}
          <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--gw-green)', display: 'inline-block' }} aria-hidden="true" />
              Agent
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--gw-azure)', display: 'inline-block' }} aria-hidden="true" />
              Brokerage
            </span>
          </div>
        </div>
      </div>

      {!hasAnyData ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--gw-mist)', fontSize: 13 }}>
          No closed deals in the last 12 months yet.
        </div>
      ) : (
        <div style={{ position: 'relative', width: '100%', overflowX: 'auto' }}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            style={{ display: 'block', width: '100%', minWidth: 340, height: 'auto' }}
            aria-hidden="true"
          >
            {/* Y-axis grid lines + labels */}
            {yTicks.map(tick => {
              const y = toY(tick)
              if (y < PAD_TOP - 4) return null
              return (
                <g key={tick}>
                  <line
                    x1={PAD_LEFT} y1={y} x2={W - PAD_RIGHT} y2={y}
                    stroke="var(--gw-border)" strokeWidth={tick === 0 ? 1.5 : 0.8}
                    strokeDasharray={tick === 0 ? 'none' : '3 3'}
                  />
                  <text
                    x={PAD_LEFT - 6} y={y + 4}
                    textAnchor="end" fontSize={10}
                    fill="var(--gw-mist)" fontFamily="var(--font-body)"
                  >
                    {fmtK(tick)}
                  </text>
                </g>
              )
            })}

            {/* Bars */}
            {months.map((m, i) => {
              const x      = PAD_LEFT + i * barSlot + (barSlot - barW) / 2
              const totalH = ((m.agentTotal + m.brokerTotal) / maxVal) * chartH
              const agentH = (m.agentTotal / maxVal) * chartH
              const brokerH = totalH - agentH
              const baseY  = PAD_TOP + chartH

              return (
                <g key={m.label}
                  style={{ cursor: m.count > 0 ? 'pointer' : 'default' }}
                  onMouseEnter={e => {
                    if (!m.count) return
                    const svg = e.currentTarget.closest('svg')
                    const rect = svg.getBoundingClientRect()
                    const svgX = (x + barW / 2) / W * rect.width + rect.left
                    setTooltip({ x: svgX, y: rect.top + (toY(m.agentTotal + m.brokerTotal) / H) * rect.height, ...m })
                  }}
                  onMouseLeave={() => setTooltip(null)}
                  role="img"
                  aria-label={`${m.label}: Agent $${m.agentTotal.toFixed(2)}, Brokerage $${m.brokerTotal.toFixed(2)}, ${m.count} deal${m.count !== 1 ? 's' : ''}`}
                >
                  {/* Brokerage segment (bottom) */}
                  {brokerH > 0 && (
                    <rect
                      x={x} y={baseY - brokerH}
                      width={barW} height={brokerH}
                      rx={0} ry={0}
                      fill="var(--gw-azure)" opacity={0.85}
                    />
                  )}
                  {/* Agent segment (top) */}
                  {agentH > 0 && (
                    <rect
                      x={x} y={baseY - totalH}
                      width={barW} height={agentH}
                      rx={2} ry={2}
                      fill="var(--gw-green)" opacity={0.9}
                    />
                  )}
                  {/* Empty bar outline when no data */}
                  {totalH === 0 && (
                    <rect
                      x={x} y={baseY - 3}
                      width={barW} height={3}
                      rx={1} ry={1}
                      fill="var(--gw-border)"
                    />
                  )}

                  {/* X-axis label */}
                  <text
                    x={x + barW / 2}
                    y={H - PAD_BOTTOM + 14}
                    textAnchor="middle"
                    fontSize={10}
                    fill={m.count > 0 ? 'var(--gw-ink)' : 'var(--gw-mist)'}
                    fontFamily="var(--font-body)"
                    fontWeight={m.count > 0 ? 600 : 400}
                  >
                    {m.shortLabel}
                  </text>

                  {/* Deal count badge above bar */}
                  {m.count > 0 && totalH > 0 && (
                    <text
                      x={x + barW / 2}
                      y={baseY - totalH - 5}
                      textAnchor="middle"
                      fontSize={9}
                      fill="var(--gw-mist)"
                      fontFamily="var(--font-body)"
                    >
                      {m.count}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>

          {/* Tooltip */}
          {tooltip && (
            <div
              role="tooltip"
              style={{
                position: 'fixed',
                left: tooltip.x,
                top: tooltip.y - 8,
                transform: 'translate(-50%, -100%)',
                background: 'var(--gw-slate)',
                color: '#fff',
                borderRadius: 'var(--radius)',
                padding: '8px 12px',
                fontSize: 12,
                lineHeight: 1.6,
                pointerEvents: 'none',
                zIndex: 200,
                whiteSpace: 'nowrap',
                boxShadow: 'var(--shadow-modal)',
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{tooltip.label}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--gw-green)', flexShrink: 0 }} />
                Agent: <strong>{formatMoney(tooltip.agentTotal)}</strong>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--gw-azure)', flexShrink: 0 }} />
                House: <strong>{formatMoney(tooltip.brokerTotal)}</strong>
              </div>
              <div style={{ color: 'rgba(255,255,255,0.6)', marginTop: 3, fontSize: 11 }}>
                {tooltip.count} closed deal{tooltip.count !== 1 ? 's' : ''}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
