import React, { useState, useMemo, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatCurrency } from '../lib/helpers.js'
import { Avatar } from '../components/UI.jsx'

const SOURCES      = ['referral','website','open house','social','cold call','other']
const STAGE_LABELS = { lead:'Lead', qualified:'Qualified', showing:'Showing', offer:'Offer Made', 'under-contract':'Under Contract', closed:'Closed' }
const STAGE_COLORS = { lead:'var(--gw-mist)', qualified:'var(--gw-azure)', showing:'#4a6fa5', offer:'var(--gw-amber)', 'under-contract':'var(--gw-purple)', closed:'var(--gw-green)' }
const ACT_TYPES    = ['call','email','meeting','note','other']
const ACT_COLORS   = { call:'var(--gw-azure)', email:'var(--gw-purple)', meeting:'var(--gw-green)', note:'var(--gw-amber)', other:'var(--gw-mist)' }

function periodRange(period) {
  const now = new Date()
  if (period === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  }
  if (period === '30d') {
    const d = new Date(now); d.setDate(d.getDate() - 30); return d.toISOString()
  }
  if (period === 'quarter') {
    const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)
    return qStart.toISOString()
  }
  return new Date(0).toISOString() // all time
}

function MiniBar({ value, max, color }) {
  const pct = max > 0 ? Math.round(value / max * 100) : 0
  return (
    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
      <div style={{ flex:1, maxWidth:80, height:6, background:'var(--gw-border)', borderRadius:3 }}>
        <div style={{ width:`${pct}%`, height:'100%', background: color || 'var(--gw-azure)', borderRadius:3, transition:'width 300ms ease' }} />
      </div>
      <span style={{ fontSize:13, fontWeight:700, minWidth:20 }}>{value}</span>
    </div>
  )
}

function ActivityTypeBar({ types }) {
  const total = Object.values(types).reduce((s, n) => s + n, 0)
  if (total === 0) return <span style={{ fontSize:11, color:'var(--gw-mist)' }}>—</span>
  return (
    <div style={{ display:'flex', gap:3, alignItems:'center', flexWrap:'wrap' }}>
      {ACT_TYPES.filter(t => types[t] > 0).map(t => (
        <span key={t} style={{ fontSize:10, fontWeight:700, padding:'1px 6px', borderRadius:10, background:`${ACT_COLORS[t]}20`, color:ACT_COLORS[t] }}>
          {t}: {types[t]}
        </span>
      ))}
    </div>
  )
}

function LeaderboardTab({ db }) {
  const [period, setPeriod]       = useState('month')
  const [loading, setLoading]     = useState(false)
  const [allActivities, setAllActivities] = useState(null)
  const [allContacts,   setAllContacts]   = useState(null)
  const [allDeals,      setAllDeals]      = useState(null)

  const agents = db.agents || []

  // Fetch wide data once per period change — bypasses agent-scoped db
  useEffect(() => {
    let cancelled = false
    const fetchAll = async () => {
      setLoading(true)
      const since = periodRange(period)
      const [actRes, conRes, dealRes] = await Promise.all([
        supabase.from('activities').select('id,type,agent_id,created_at').gte('created_at', since),
        supabase.from('contacts').select('id,assigned_agent_id,created_at').gte('created_at', since),
        supabase.from('deals').select('id,agent_id,stage,updated_at').gte('updated_at', since),
      ])
      if (cancelled) return
      setAllActivities(actRes.data || [])
      setAllContacts(conRes.data   || [])
      setAllDeals(dealRes.data     || [])
      setLoading(false)
    }
    fetchAll()
    return () => { cancelled = true }
  }, [period])

  const rows = useMemo(() => {
    if (!allActivities || !allContacts || !allDeals) return []
    return agents.map(agent => {
      const acts = allActivities.filter(a => a.agent_id === agent.id)
      const types = Object.fromEntries(ACT_TYPES.map(t => [t, acts.filter(a => a.type === t).length]))
      const contactsAdded = allContacts.filter(c => c.assigned_agent_id === agent.id).length
      // "Deals moved" = deals belonging to agent updated this period AND not stuck in 'lead'
      const dealsMoved = allDeals.filter(d => d.agent_id === agent.id && d.stage !== 'lead').length
      return { agent, actTotal: acts.length, types, contactsAdded, dealsMoved }
    }).sort((a, b) => b.actTotal - a.actTotal)
  }, [agents, allActivities, allContacts, allDeals])

  const maxAct      = Math.max(...rows.map(r => r.actTotal), 1)
  const maxContacts = Math.max(...rows.map(r => r.contactsAdded), 1)
  const maxDeals    = Math.max(...rows.map(r => r.dealsMoved), 1)

  const PERIOD_LABEL = { month: 'This Month', '30d': 'Last 30 Days', quarter: 'This Quarter', all: 'All Time' }

  return (
    <div>
      {/* Period selector */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
        <div style={{ fontSize:13, color:'var(--gw-mist)' }}>
          Accountability metrics for <strong>{agents.length} agent{agents.length !== 1 ? 's' : ''}</strong> · {PERIOD_LABEL[period]}
        </div>
        <div style={{ display:'flex', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
          {[['month','This Month'],['30d','30 Days'],['quarter','Quarter'],['all','All Time']].map(([v, label]) => (
            <button key={v} onClick={() => setPeriod(v)}
              style={{ padding:'5px 12px', border:'none', cursor:'pointer', fontFamily:'var(--font-body)', fontSize:12, fontWeight:600, transition:'all 150ms',
                background: period === v ? 'var(--gw-slate)' : '#fff',
                color:      period === v ? '#fff'            : 'var(--gw-mist)' }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ padding:'40px 0', textAlign:'center', color:'var(--gw-mist)', fontSize:13 }}>Loading activity data…</div>
      ) : rows.every(r => r.actTotal === 0 && r.contactsAdded === 0 && r.dealsMoved === 0) ? (
        <div style={{ padding:'40px 24px', textAlign:'center', color:'var(--gw-mist)', fontSize:13 }}>
          No activity logged {PERIOD_LABEL[period].toLowerCase()} yet.<br/>
          Agents need to log calls, emails, and meetings from contact profiles.
        </div>
      ) : (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th>Activities Logged</th>
                <th>Breakdown</th>
                <th>Contacts Added</th>
                <th>Deals Moved</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.agent.id}>
                  <td style={{ color:'var(--gw-mist)', fontSize:12, width:32 }}>
                    {i === 0 && row.actTotal > 0
                      ? <span title="Top performer" style={{ fontSize:14 }}>🏆</span>
                      : <span style={{ fontWeight:600 }}>{i + 1}</span>
                    }
                  </td>
                  <td>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <Avatar agent={row.agent} size={30} />
                      <div>
                        <div style={{ fontWeight:600, fontSize:13 }}>{row.agent.name}</div>
                        {row.agent.role && <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{row.agent.role}</div>}
                      </div>
                    </div>
                  </td>
                  <td>
                    <MiniBar value={row.actTotal} max={maxAct} color="var(--gw-azure)" />
                  </td>
                  <td>
                    <ActivityTypeBar types={row.types} />
                  </td>
                  <td>
                    <MiniBar value={row.contactsAdded} max={maxContacts} color="var(--gw-green)" />
                  </td>
                  <td>
                    <MiniBar value={row.dealsMoved} max={maxDeals} color="var(--gw-purple)" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop:16, padding:'10px 14px', background:'var(--gw-sky)', border:'1px solid #c5d9f5', borderRadius:'var(--radius)', fontSize:12, color:'var(--gw-azure)', lineHeight:1.7 }}>
        <strong>How to read this:</strong> Activities = calls, emails, meetings and notes logged in contact profiles.
        Contacts Added = new contacts created in the period. Deals Moved = deals updated beyond the Lead stage this period.
        No revenue figures here — this is about consistent CRM usage and follow-through.
      </div>
    </div>
  )
}

export default function ReportsPage({ db }) {
  const [activeTab, setActiveTab] = useState('roi')
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
          <div className="page-sub">Lead source ROI &amp; agent activity</div>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display:'flex', gap:0, border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden', marginBottom:24, alignSelf:'flex-start', width:'fit-content' }}>
        {[['roi','Lead ROI'],['leaderboard','Agent Activity']].map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)}
            style={{ padding:'8px 20px', border:'none', cursor:'pointer', fontFamily:'var(--font-body)', fontSize:13, fontWeight:600, transition:'all 150ms',
              background: activeTab === id ? 'var(--gw-slate)' : '#fff',
              color:      activeTab === id ? '#fff'            : 'var(--gw-mist)' }}>
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'leaderboard' ? (
        <LeaderboardTab db={db} />
      ) : (
        <>
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
        </>
      )}
    </div>
  )
}
