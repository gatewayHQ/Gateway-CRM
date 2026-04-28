import React, { useMemo } from 'react'
import { formatCurrency } from '../lib/helpers.js'

const SOURCES      = ['referral','website','open house','social','cold call','other']
const STAGE_LABELS = { lead:'Lead', qualified:'Qualified', showing:'Showing', offer:'Offer Made', 'under-contract':'Under Contract', closed:'Closed' }
const STAGE_COLORS = { lead:'var(--gw-mist)', qualified:'var(--gw-azure)', showing:'#4a6fa5', offer:'var(--gw-amber)', 'under-contract':'var(--gw-purple)', closed:'var(--gw-green)' }

export default function ReportsPage({ db }) {
  const contacts    = db.contacts    || []
  const deals       = db.deals       || []
  const commissions = db.commissions || []

  const sourceStats = useMemo(() => {
    return SOURCES.map(source => {
      const sc = contacts.filter(c => (c.source || 'other') === source)
      const ids = new Set(sc.map(c => c.id))
      const sd = deals.filter(d => ids.has(d.contact_id))
      const closed = sd.filter(d => d.stage === 'closed')
      const closedValue = closed.reduce((s, d) => s + (d.value || 0), 0)
      const closedIds = new Set(closed.map(d => d.id))
      const agentEarnings = commissions
        .filter(c => closedIds.has(c.deal_id))
        .reduce((s, c) => s + (c.agent_take || 0), 0) || closedValue * 0.021
      const convRate = sc.length > 0 ? Math.round(closed.length / sc.length * 100) : 0
      return { source, count: sc.length, closedCount: closed.length, closedValue, agentEarnings, convRate }
    }).filter(s => s.count > 0)
  }, [contacts, deals, commissions])

  const totalContacts  = contacts.length
  const closedDeals    = deals.filter(d => d.stage === 'closed')
  const totalClosed    = closedDeals.length
  const totalRevenue   = closedDeals.reduce((s, d) => s + (d.value || 0), 0)
  const overallConv    = totalContacts > 0 ? Math.round(totalClosed / totalContacts * 100) : 0
  const maxCount       = Math.max(...sourceStats.map(s => s.count), 1)

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Reports</div>
          <div className="page-sub">Lead source ROI &amp; pipeline analytics</div>
        </div>
      </div>

      {/* Summary stats */}
      <div className="stats-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-card__value">{totalContacts}</div>
          <div className="stat-card__label">Total Contacts</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{totalClosed}</div>
          <div className="stat-card__label">Closed Deals</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{overallConv}%</div>
          <div className="stat-card__label">Overall Conversion</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{formatCurrency(totalRevenue)}</div>
          <div className="stat-card__label">Total Closed Value</div>
        </div>
      </div>

      {/* Lead Source Breakdown */}
      <div className="card" style={{ marginBottom: 24, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--gw-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Lead Source ROI</div>
          <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>Est. agent earnings = closed value × 2.1% (or commission records)</div>
        </div>
        {sourceStats.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--gw-mist)' }}>
            No contacts with source data yet. Add contacts and select their lead source to see ROI.
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Contacts</th>
                  <th>Volume</th>
                  <th>Closed</th>
                  <th>Conversion</th>
                  <th>Closed Value</th>
                  <th>Est. Agent Earnings</th>
                </tr>
              </thead>
              <tbody>
                {[...sourceStats].sort((a, b) => b.count - a.count).map(s => (
                  <tr key={s.source}>
                    <td style={{ fontWeight: 600, textTransform: 'capitalize' }}>{s.source}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, maxWidth: 100, height: 6, background: 'var(--gw-border)', borderRadius: 3 }}>
                          <div style={{ width: `${Math.round(s.count / maxCount * 100)}%`, height: '100%', background: 'var(--gw-azure)', borderRadius: 3 }} />
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>{s.count}</span>
                      </div>
                    </td>
                    <td style={{ fontSize: 12 }}>{totalContacts > 0 ? Math.round(s.count / totalContacts * 100) : 0}%</td>
                    <td style={{ fontWeight: 600 }}>{s.closedCount}</td>
                    <td>
                      <span style={{
                        padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                        background: s.convRate >= 20 ? 'var(--gw-green-light)' : s.convRate >= 8 ? '#fff3cd' : 'var(--gw-bone)',
                        color:      s.convRate >= 20 ? 'var(--gw-green)'      : s.convRate >= 8 ? '#856404'  : 'var(--gw-mist)',
                      }}>{s.convRate}%</span>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.closedValue > 0 ? formatCurrency(s.closedValue) : '—'}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: 'var(--gw-green)' }}>
                      {s.agentEarnings > 0 ? formatCurrency(s.agentEarnings) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pipeline Funnel */}
      <div className="card">
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--gw-border)', fontWeight: 600, fontSize: 14 }}>
          Pipeline Funnel
        </div>
        <div style={{ padding: '20px 24px' }}>
          {deals.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--gw-mist)', padding: '20px 0' }}>No deals yet.</div>
          ) : (
            Object.entries(STAGE_LABELS).map(([stage, label]) => {
              const count = deals.filter(d => d.stage === stage).length
              const pct   = Math.round(count / deals.length * 100)
              return (
                <div key={stage} className="funnel-bar">
                  <div className="funnel-bar__label">{label}</div>
                  <div className="funnel-bar__track">
                    <div className="funnel-bar__fill" style={{ width: `${pct}%`, minWidth: count > 0 ? 32 : 0, background: STAGE_COLORS[stage] }}>
                      {count > 0 && <span>{count}</span>}
                    </div>
                  </div>
                  <div className="funnel-bar__pct">{pct}%</div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
