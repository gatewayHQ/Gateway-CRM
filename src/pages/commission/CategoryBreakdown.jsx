import React from 'react'
import { formatMoney } from '../../lib/helpers.js'

// ── Res/Commercial breakdown card ────────────────────────────────────────────
export function CategoryBreakdown({ closedDeals, calcFn }) {
  const res  = closedDeals.filter(d => !d.prop_category || d.prop_category === 'residential')
  const comm = closedDeals.filter(d => d.prop_category === 'commercial')

  const sum = (arr) => arr.reduce((acc, d) => {
    const { gross, agentAmt, brokerAmt } = calcFn(d)
    acc.gross += gross; acc.agent += agentAmt; acc.broker += brokerAmt; acc.deals++
    return acc
  }, { gross: 0, agent: 0, broker: 0, deals: 0 })

  const rTotals = sum(res)
  const cTotals = sum(comm)
  const maxAgent = Math.max(rTotals.agent, cTotals.agent, 1)

  const col = (label, totals, color, iconChar) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <span style={{ fontSize: 18 }}>{iconChar}</span>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{label}</span>
        <span style={{ fontSize: 11, color: 'var(--gw-mist)', background: 'var(--gw-bone)', padding: '1px 7px', borderRadius: 8, marginLeft: 2 }}>
          {totals.deals} deal{totals.deals !== 1 ? 's' : ''}
        </span>
      </div>
      <div style={{ marginBottom: 6 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--gw-mist)', marginBottom: 3 }}>
          <span>Agent earnings</span>
          <span style={{ fontWeight: 700, color }}>{formatMoney(totals.agent)}</span>
        </div>
        <div style={{ height: 6, background: 'var(--gw-border)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(totals.agent / maxAgent * 100)}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 400ms ease' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--gw-mist)' }}>
        <span>Gross: <strong style={{ color: 'var(--gw-ink)' }}>{formatMoney(totals.gross)}</strong></span>
        <span>House: <strong style={{ color: 'var(--gw-ink)' }}>{formatMoney(totals.broker)}</strong></span>
      </div>
    </div>
  )

  return (
    <div className="card" style={{ marginBottom: 20, padding: '16px 20px' }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 14 }}>Residential vs. Commercial</div>
      <div style={{ display: 'flex', gap: 24 }}>
        {col('Residential', rTotals, 'var(--gw-green)', '🏠')}
        <div style={{ width: 1, background: 'var(--gw-border)', flexShrink: 0 }} />
        {col('Commercial', cTotals, 'var(--gw-azure)', '🏢')}
      </div>
      {(rTotals.deals > 0 && cTotals.deals > 0) && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--gw-border)', display: 'flex', gap: 20, fontSize: 12, color: 'var(--gw-mist)' }}>
          <span>Res share of agent earnings: <strong style={{ color: 'var(--gw-green)' }}>
            {Math.round(rTotals.agent / (rTotals.agent + cTotals.agent) * 100)}%
          </strong></span>
          <span>Comm share: <strong style={{ color: 'var(--gw-azure)' }}>
            {Math.round(cTotals.agent / (rTotals.agent + cTotals.agent) * 100)}%
          </strong></span>
        </div>
      )}
    </div>
  )
}
