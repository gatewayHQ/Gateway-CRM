import React, { useMemo } from 'react'
import { formatCurrency, formatCurrencyExact, formatDate } from '../lib/helpers.js'
import { CONTACT_SOURCES as SOURCES } from '../lib/enums.js'
import { daysInStage, isRotting, daysBetween } from '../lib/pipeline.js'
import { isOpenStage } from '../lib/stages.js'
import { Avatar, Badge } from '../components/UI.jsx'

const STAGE_LABELS = { lead:'Lead', qualified:'Qualified', showing:'Showing', offer:'Offer Made', 'under-contract':'Under Contract', closed:'Closed' }
const STAGE_COLORS = { lead:'var(--gw-mist)', qualified:'var(--gw-azure)', showing:'#4a6fa5', offer:'var(--gw-amber)', 'under-contract':'var(--gw-purple)', closed:'var(--gw-green)' }

// Median / p90 for a list of numbers (NaN-safe)
const percentile = (arr, p) => {
  const clean = arr.filter(n => Number.isFinite(n)).sort((a, b) => a - b)
  if (!clean.length) return 0
  const idx = Math.max(0, Math.min(clean.length - 1, Math.floor(p * (clean.length - 1))))
  return clean[idx]
}
const avg = (arr) => {
  const clean = arr.filter(n => Number.isFinite(n))
  return clean.length ? clean.reduce((s, n) => s + n, 0) / clean.length : 0
}

export default function ReportsPage({ db, go }) {
  const contacts    = db.contacts    || []
  const deals       = db.deals       || []
  const commissions = db.commissions || []
  const agents      = db.agents      || []

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

  // ── Days-in-stage by stage (live pipeline health) ──────────────────────────
  // Mean + median + p90 days each open deal has been sitting in its stage.
  // p90 is the "long tail" metric: high p90 = a few deals are really stuck.
  const stageVelocity = useMemo(() => {
    const buckets = {}
    for (const d of deals) {
      if (!isOpenStage(d.stage)) continue
      const days = daysInStage(d)
      if (days == null) continue
      if (!buckets[d.stage]) buckets[d.stage] = []
      buckets[d.stage].push(days)
    }
    return Object.entries(buckets).map(([stage, arr]) => ({
      stage,
      count: arr.length,
      mean:   Math.round(avg(arr)),
      median: Math.round(percentile(arr, 0.5)),
      p90:    Math.round(percentile(arr, 0.9)),
    })).sort((a, b) => b.p90 - a.p90)
  }, [deals])

  // ── Stuck deals (open + rotting per pipeline thresholds) ───────────────────
  const stuckDeals = useMemo(() => {
    const out = []
    for (const d of deals) {
      if (!isOpenStage(d.stage)) continue
      if (!isRotting(d)) continue
      out.push({ deal: d, days: daysInStage(d), agent: agents.find(a => a.id === d.agent_id) })
    }
    return out.sort((a, b) => b.days - a.days)
  }, [deals, agents])

  // ── Time-to-close trend by quarter (closed deals only) ─────────────────────
  const closeTrend = useMemo(() => {
    const byQuarter = new Map()
    for (const d of closedDeals) {
      const closed = new Date(d.updated_at || d.created_at)
      const q = Math.floor(closed.getMonth() / 3)
      const key = `${closed.getFullYear()}-Q${q + 1}`
      const created = new Date(d.created_at)
      const ttc = daysBetween(closed, created)
      if (!byQuarter.has(key)) byQuarter.set(key, { key, deals: 0, value: 0, ttcs: [] })
      const e = byQuarter.get(key)
      e.deals += 1
      e.value += Number(d.value) || 0
      e.ttcs.push(ttc)
    }
    return [...byQuarter.values()]
      .map(e => ({ ...e, mean_ttc: Math.round(avg(e.ttcs)), median_ttc: Math.round(percentile(e.ttcs, 0.5)) }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(-6)
  }, [closedDeals])

  // ── Per-agent performance (close rate, avg deal size, avg TTC) ─────────────
  const agentStats = useMemo(() => {
    return agents.map(a => {
      const owned    = deals.filter(d => d.agent_id === a.id)
      const closed   = owned.filter(d => d.stage === 'closed')
      const lost     = owned.filter(d => d.stage === 'lost')
      const decided  = closed.length + lost.length
      const closeRate = decided > 0 ? Math.round(closed.length / decided * 100) : 0
      const avgValue = closed.length ? Math.round(closed.reduce((s, d) => s + (d.value || 0), 0) / closed.length) : 0
      const ttcs = closed.map(d => daysBetween(new Date(d.updated_at || d.created_at), new Date(d.created_at)))
      const avgTtc = Math.round(avg(ttcs))
      return { agent: a, ownedCount: owned.length, closedCount: closed.length, closeRate, avgValue, avgTtc }
    }).filter(r => r.ownedCount > 0)
      .sort((x, y) => y.closedCount - x.closedCount || y.closeRate - x.closeRate)
  }, [agents, deals])

  const maxStageP90 = Math.max(...stageVelocity.map(s => s.p90), 1)

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

      {/* Velocity — days in stage */}
      <div className="card" style={{ marginBottom: 24, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--gw-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Pipeline Velocity</div>
          <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>Open deals only · median &amp; 90th percentile days-in-stage</div>
        </div>
        {stageVelocity.length === 0 ? (
          <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--gw-mist)' }}>No open deals to measure.</div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Open</th>
                  <th>Median days</th>
                  <th>Mean days</th>
                  <th>p90 days (long tail)</th>
                </tr>
              </thead>
              <tbody>
                {stageVelocity.map(s => (
                  <tr key={s.stage}>
                    <td style={{ fontWeight: 600 }}>{STAGE_LABELS[s.stage] || s.stage}</td>
                    <td>{s.count}</td>
                    <td>{s.median}d</td>
                    <td>{s.mean}d</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, maxWidth: 160, height: 6, background: 'var(--gw-border)', borderRadius: 3 }}>
                          <div style={{ width: `${Math.round(s.p90 / maxStageP90 * 100)}%`, height: '100%', background: s.p90 > 21 ? '#dc2626' : s.p90 > 10 ? '#d97706' : 'var(--gw-azure)', borderRadius: 3 }} />
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: s.p90 > 21 ? '#dc2626' : 'var(--gw-ink)' }}>{s.p90}d</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Stuck deals */}
      <div className="card" style={{ marginBottom: 24, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--gw-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Stuck Deals
            <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--gw-mist)' }}>{stuckDeals.length} idle past stage threshold</span>
          </div>
        </div>
        {stuckDeals.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--gw-green)', fontSize: 13 }}>
            ✓ Nothing rotting — every open deal is within its expected window.
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Stage</th>
                  <th>Days idle</th>
                  <th>Value</th>
                  <th>Agent</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {stuckDeals.slice(0, 20).map(({ deal, days, agent }) => (
                  <tr key={deal.id}>
                    <td style={{ fontWeight: 600, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{deal.title}</td>
                    <td><Badge variant="pending">{STAGE_LABELS[deal.stage] || deal.stage}</Badge></td>
                    <td style={{ fontWeight: 700, color: days > 30 ? '#dc2626' : '#d97706' }}>{days}d</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{deal.value > 0 ? formatCurrency(deal.value) : '—'}</td>
                    <td>
                      {agent ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <Avatar agent={agent} size={18} /><span style={{ fontSize: 12 }}>{agent.name}</span>
                        </div>
                      ) : <span style={{ color: 'var(--gw-mist)', fontSize: 12 }}>Unassigned</span>}
                    </td>
                    <td>
                      {go && <button className="btn btn--ghost btn--sm" onClick={() => go(`deal/${deal.id}`)}>Open</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {stuckDeals.length > 20 && (
              <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--gw-mist)' }}>
                +{stuckDeals.length - 20} more — work the queue and they'll thin out.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Time-to-close trend */}
      {closeTrend.length > 0 && (
        <div className="card" style={{ marginBottom: 24, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--gw-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Time to Close — last 6 quarters</div>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Quarter</th><th>Closed deals</th><th>Closed value</th><th>Median days</th><th>Mean days</th></tr>
              </thead>
              <tbody>
                {closeTrend.map(q => (
                  <tr key={q.key}>
                    <td style={{ fontWeight: 600 }}>{q.key}</td>
                    <td>{q.deals}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{formatCurrency(q.value)}</td>
                    <td>{q.median_ttc}d</td>
                    <td>{q.mean_ttc}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Agent performance */}
      {agentStats.length > 0 && (
        <div className="card" style={{ marginBottom: 24, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--gw-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Agent Performance</div>
            <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>Close rate = closed ÷ (closed + lost) · ignores still-open deals</div>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr><th>Agent</th><th>Total deals</th><th>Closed</th><th>Close rate</th><th>Avg deal size</th><th>Avg time to close</th></tr>
              </thead>
              <tbody>
                {agentStats.map(r => (
                  <tr key={r.agent.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Avatar agent={r.agent} size={20} /><span style={{ fontWeight: 600 }}>{r.agent.name}</span>
                      </div>
                    </td>
                    <td>{r.ownedCount}</td>
                    <td style={{ fontWeight: 700 }}>{r.closedCount}</td>
                    <td>
                      <span style={{
                        padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                        background: r.closeRate >= 50 ? 'var(--gw-green-light)' : r.closeRate >= 25 ? '#fff3cd' : 'var(--gw-bone)',
                        color:      r.closeRate >= 50 ? 'var(--gw-green)'      : r.closeRate >= 25 ? '#856404'  : 'var(--gw-mist)',
                      }}>{r.closeRate}%</span>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{r.avgValue > 0 ? formatCurrency(r.avgValue) : '—'}</td>
                    <td>{r.avgTtc > 0 ? `${r.avgTtc}d` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
                      {s.agentEarnings > 0 ? formatCurrencyExact(s.agentEarnings) : '—'}
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
