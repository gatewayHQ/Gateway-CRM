// The admin commission tracker: every deal's commission, the brokerage
// report and caps.

import React, { useState } from 'react'
import { Icon, Avatar, Badge, EmptyState, pushToast } from '../../components/UI.jsx'
import { formatCurrency, formatMoney } from '../../lib/helpers.js'
import { loadVisibleDeals, loadVisibleCommissions } from '../../lib/services/dealRecords.js'
import { BrokerageReport, CapsEditor } from '../BackOffice.jsx'
import { breakdownForDeal, agentSliceForDeal, capStatusFor, addByParty, partyAmounts } from '../../lib/commission.js'
import SideSplit from '../../components/SideSplit.jsx'
import { D_AGENT, D_BROKER, D_GROSS } from './commissionDefaults.js'
import { COMMISSION_SQL } from './commissionSql.js'
import { CategoryBreakdown } from './CategoryBreakdown.jsx'
import { MonthlyBarChart } from './MonthlyBarChart.jsx'
import { CommissionDrawer } from './CommissionDrawer.jsx'

export function AdminBackOffice({ db, setDb, activeAgent, isAdmin, dealAgentIds }) {
  const [boTab, setBoTab]             = useState('tracker')
  const [drawer, setDrawer]           = useState(false)
  const [selectedDeal, setSelectedDeal] = useState(null)
  const [filterStage, setFilterStage] = useState('all')
  const [filterAgent, setFilterAgent] = useState('')
  const [filterCategory, setFilterCategory] = useState('all')
  const [copied, setCopied]           = useState(false)

  const deals       = db.deals       || []
  const agents      = db.agents      || []
  const contacts    = db.contacts    || []
  const commissions = db.commissions || []
  const hasTable    = db.commissionsReady !== false

  const getComm = (dealId) => commissions.find(c => c.deal_id === dealId)

  // Single source of truth — the engine resolves legacy AND structured rows.
  // Returns the firm-wide view of a deal: total agent dollars (all participants)
  // and total house dollars, plus the legacy-shaped keys the charts consume.
  const calc = (deal) => {
    const r = breakdownForDeal(deal, getComm(deal.id), agents)
    return {
      ...r,
      sp: r.sale_price,
      gross_pct: r.effective_rate_pct,
      agent_pct: r.primary ? Number(r.primary.split_pct) : D_AGENT,
      broker_pct: r.primary ? Math.round((100 - Number(r.primary.split_pct)) * 10) / 10 : D_BROKER,
      gross: r.gross_total,
      agentAmt: r.agent_total,   // sum across ALL participants on the deal
      brokerAmt: r.house_total,
    }
  }

  // One agent's slice of a deal — the shared engine function My Earnings and
  // the Brokerage Report use, so the three can never disagree. `agent` is its
  // take, under the name this page's rollups already read.
  const agentSlice = (deal, agentId) => {
    const slice = agentSliceForDeal(deal, getComm(deal.id), agents, agentId)
    return { ...slice, agent: slice.take }
  }

  // Scoped exactly like the initial App.jsx load — a non-admin's refresh must
  // not replace their scoped deals/commissions with firm-wide data.
  const reload = async () => {
    const dealsRes = await loadVisibleDeals({
      isAdmin, agentId: activeAgent?.id, dealAgentIds,
    })
    const commRes = await loadVisibleCommissions({
      isAdmin, dealIds: (dealsRes.data || []).map(d => d.id),
    })
    setDb(p => ({ ...p, deals: dealsRes.data||[], commissions: commRes.data||[], commissionsReady: !commRes.error }))
    pushToast('Refreshed')
  }

  // ── Compute earnings totals ──────────────────────────────────────────────────
  const closedDeals = deals.filter(d => d.stage === 'closed')
  const closedRes   = closedDeals.filter(d => !d.prop_category || d.prop_category === 'residential')
  const closedComm  = closedDeals.filter(d => d.prop_category === 'commercial')

  // Brokerage total (all closed deals)
  // Every total carries its seller/buyer split alongside it: gross, agent
  // earnings and the house's share, each summed by side.
  const addDealParties = (acc, parties) => {
    acc.grossBy  = addByParty(acc.grossBy,  parties, 'gross')
    acc.agentBy  = addByParty(acc.agentBy,  parties, 'agent_take')
    acc.brokerBy = addByParty(acc.brokerBy, parties, 'house')
  }
  const brokerageTotals = closedDeals.reduce((acc, d) => {
    const { gross, brokerAmt, agentAmt, parties } = calc(d)
    acc.gross += gross; acc.broker += brokerAmt; acc.agent += agentAmt
    addDealParties(acc, parties)
    return acc
  }, { gross:0, broker:0, agent:0, grossBy:{}, agentBy:{}, brokerBy:{} })

  // Per-agent breakdown (closed deals only) — attributes each participant's take
  // to their agent, so a co-agent on someone else's deal still gets credited.
  const agentBreakdown = agents.map(a => {
    const aDeals = closedDeals.filter(d => {
      const r = breakdownForDeal(d, getComm(d.id), agents)
      return d.agent_id === a.id || r.participants.some(p => p.agent_id === a.id)
    })
    const totals = aDeals.reduce((acc, d) => {
      const slice = agentSlice(d, a.id)
      acc.agent += slice.agent; acc.broker += slice.house; acc.deals++
      acc.agentBy = addByParty(acc.agentBy, slice.byParty, 'take')
      return acc
    }, { agent:0, broker:0, gross:0, deals:0, agentBy:{} })
    return { ...a, ...totals }
  }).filter(a => a.deals > 0).sort((a,b) => b.agent - a.agent)

  // Team total
  const teamTotal = agentBreakdown.reduce((s, a) => s + a.agent, 0)

  // Caps the office still has to confirm: agents whose split paid this cap
  // year has reached their cap. Confirming (Agents & Caps) is what switches
  // them to 100% on every deal from then on — no per-deal edits.
  const capsToConfirm = React.useMemo(() => {
    const commByDeal = new Map(commissions.map(c => [c.deal_id, c]))
    return agents
      .map(a => ({ agent: a, status: capStatusFor(a, { deals, commissionsByDeal: commByDeal, agents }) }))
      .filter(x => x.status.awaiting)
  }, [agents, deals, commissions])

  // ── Filtered table ───────────────────────────────────────────────────────────
  let filtered = deals
  if (filterStage === 'closed') filtered = filtered.filter(d => d.stage === 'closed')
  if (filterStage === 'active') filtered = filtered.filter(d => d.stage !== 'closed' && d.stage !== 'lost')
  // "This agent's deals" — the deals they are ON, matching agentBreakdown and
  // the cap tracker above, which both already count a co-agent on someone
  // else's deal. This line alone filtered on ownership, so narrowing the table
  // to a co-agent dropped exactly the deals whose split the reader came to
  // check.
  //
  // The listing's own co-agents reach this through `deals.co_agent_ids`, which
  // the migration 0055 triggers keep in step with the property — this page has
  // no `properties` in scope and does not need them for one filter.
  if (filterAgent) {
    filtered = filtered.filter(d =>
      d.agent_id === filterAgent
      || (d.co_agent_ids || []).includes(filterAgent)
      || breakdownForDeal(d, getComm(d.id), agents).participants.some(p => p.agent_id === filterAgent))
  }
  if (filterCategory === 'residential') filtered = filtered.filter(d => !d.prop_category || d.prop_category === 'residential')
  if (filterCategory === 'commercial')  filtered = filtered.filter(d => d.prop_category === 'commercial')

  const totals = filtered.reduce((acc, d) => {
    const { sp, gross, agentAmt, brokerAmt, parties } = calc(d)
    acc.sp += sp; acc.gross += gross; acc.agent += agentAmt; acc.broker += brokerAmt
    addDealParties(acc, parties)
    return acc
  }, { sp:0, gross:0, agent:0, broker:0, grossBy:{}, agentBy:{}, brokerBy:{} })

  if (!hasTable) return (
    <div className="page-content">
      <div className="page-header"><div><div className="page-title">Commission Tracker</div></div></div>
      <div style={{ background:'#fff8ec', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius-lg)', padding:24 }}>
        <div style={{ fontWeight:600, marginBottom:8 }}>One-time Database Setup Required</div>
        <div style={{ fontSize:13, marginBottom:12 }}>Run this SQL in Supabase → SQL Editor:</div>
        <code style={{ display:'block', background:'#1a1a2e', color:'#c9a84c', fontFamily:'var(--font-mono)', fontSize:11, padding:14, borderRadius:'var(--radius)', whiteSpace:'pre', overflowX:'auto', marginBottom:12 }}>{COMMISSION_SQL}</code>
        <div style={{ display:'flex', gap:8 }}>
          <button className="btn btn--secondary btn--sm" onClick={() => { navigator.clipboard.writeText(COMMISSION_SQL); setCopied(true); setTimeout(()=>setCopied(false),2000) }}><Icon name="copy" size={12} /> {copied?'Copied!':'Copy SQL'}</button>
          <button className="btn btn--primary btn--sm" onClick={reload}><Icon name="refresh" size={12} /> Check Again</button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Back Office</div>
          <div className="page-sub">{deals.length} deals · {formatCurrency(deals.reduce((s,d)=>s+(d.value||0),0))} total pipeline · commissions are entered here and stay private per agent</div>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <div style={{ display:'flex', background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:3, gap:2 }}>
            {[['tracker','Tracker'],['report','Brokerage Report'],['caps','Agents & Caps']].map(([id, label]) => (
              <button key={id} onClick={() => setBoTab(id)} title={id === 'caps' && capsToConfirm.length ? `${capsToConfirm.length} cap${capsToConfirm.length === 1 ? '' : 's'} to confirm` : undefined} style={{
                padding:'5px 14px', border:'none', borderRadius:'var(--radius)', cursor:'pointer',
                fontFamily:'var(--font-body)', fontSize:12, fontWeight:600,
                background: boTab === id ? 'var(--gw-slate)' : 'transparent',
                color: boTab === id ? '#fff' : 'var(--gw-mist)', transition:'all 150ms ease',
              }}>
                {label}
                {id === 'caps' && capsToConfirm.length > 0 && (
                  <span style={{ marginLeft:6, background:'var(--gw-gold)', color:'#fff', borderRadius:9, padding:'0 6px', fontSize:10.5, fontWeight:700 }}>{capsToConfirm.length}</span>
                )}
              </button>
            ))}
          </div>
          {boTab === 'tracker' && <button className="btn btn--secondary btn--sm" onClick={reload}><Icon name="refresh" size={13} /> Refresh</button>}
        </div>
      </div>

      {boTab === 'report' && <BrokerageReport db={db} />}
      {boTab === 'caps'   && <CapsEditor db={db} setDb={setDb} />}

      {boTab === 'tracker' && (<>
      {/* ── Summary stats ── */}
      <div className="stats-grid" style={{ gridTemplateColumns:'repeat(4,1fr)', marginBottom:12 }}>
        <div className="stat-card">
          <div className="stat-card__value">{closedDeals.length}</div>
          <div className="stat-card__label">Closed Deals</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{formatMoney(brokerageTotals.gross)}</div>
          <div className="stat-card__label">Total Gross Comm</div>
          <SideSplit parts={partyAmounts(brokerageTotals.grossBy)} />
        </div>
        <div className="stat-card" style={{ borderLeft:'3px solid var(--gw-green)' }}>
          <div className="stat-card__value" style={{ color:'var(--gw-green)' }}>{formatMoney(brokerageTotals.agent)}</div>
          <div className="stat-card__label">Total Agent Earnings</div>
          <SideSplit parts={partyAmounts(brokerageTotals.agentBy)} />
        </div>
        <div className="stat-card" style={{ borderLeft:'3px solid var(--gw-azure)' }}>
          <div className="stat-card__value" style={{ color:'var(--gw-azure)' }}>{formatMoney(brokerageTotals.broker)}</div>
          <div className="stat-card__label">Brokerage / House</div>
          <SideSplit parts={partyAmounts(brokerageTotals.brokerBy)} />
        </div>
      </div>

      {/* ── Residential vs Commercial mini-stats ── */}
      <div className="stats-grid" style={{ gridTemplateColumns:'repeat(4,1fr)', marginBottom:20 }}>
        <div className="stat-card" style={{ borderTop:'3px solid var(--gw-green)' }}>
          <div style={{ fontSize:10, fontWeight:700, color:'var(--gw-green)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:4 }}>🏠 Residential</div>
          <div className="stat-card__value">{closedRes.length}</div>
          <div className="stat-card__label">Closed Deals</div>
        </div>
        <div className="stat-card" style={{ borderTop:'3px solid var(--gw-green)' }}>
          <div style={{ fontSize:10, fontWeight:700, color:'var(--gw-green)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:4 }}>🏠 Residential</div>
          <div className="stat-card__value" style={{ color:'var(--gw-green)' }}>
            {formatMoney(closedRes.reduce((s,d)=>s+calc(d).agentAmt,0))}
          </div>
          <div className="stat-card__label">Agent Earnings</div>
        </div>
        <div className="stat-card" style={{ borderTop:'3px solid var(--gw-azure)' }}>
          <div style={{ fontSize:10, fontWeight:700, color:'var(--gw-azure)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:4 }}>🏢 Commercial</div>
          <div className="stat-card__value">{closedComm.length}</div>
          <div className="stat-card__label">Closed Deals</div>
        </div>
        <div className="stat-card" style={{ borderTop:'3px solid var(--gw-azure)' }}>
          <div style={{ fontSize:10, fontWeight:700, color:'var(--gw-azure)', textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:4 }}>🏢 Commercial</div>
          <div className="stat-card__value" style={{ color:'var(--gw-azure)' }}>
            {formatMoney(closedComm.reduce((s,d)=>s+calc(d).agentAmt,0))}
          </div>
          <div className="stat-card__label">Agent Earnings</div>
        </div>
      </div>

      {/* ── Caps to confirm ── */}
      {capsToConfirm.length > 0 && (
        <div className="card" style={{ marginBottom:20, padding:'14px 18px', borderLeft:'4px solid var(--gw-gold)', display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
          <div style={{ flex:1, minWidth:220 }}>
            <div style={{ fontWeight:700, fontSize:14 }}>
              {capsToConfirm.length} agent{capsToConfirm.length === 1 ? ' has' : 's have'} reached their cap
            </div>
            <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:2 }}>
              {capsToConfirm.map(x => `${x.agent.name} (${formatMoney(x.status.paid)} of ${formatMoney(x.status.amount)})`).join(' · ')}
              {' '}— confirm to pay them 100% from today.
            </div>
          </div>
          <button className="btn btn--primary btn--sm" onClick={() => setBoTab('caps')}>Review &amp; confirm</button>
        </div>
      )}

      {/* ── Residential vs Commercial Breakdown ── */}
      {closedDeals.length > 0 && <CategoryBreakdown closedDeals={closedDeals} calcFn={calc} />}

      {/* ── Monthly Bar Chart ── */}
      <MonthlyBarChart deals={deals} calcFn={calc} />

      {/* ── Team / Agent Breakdown ── */}
      {agentBreakdown.length > 1 && (
        <div className="card" style={{ marginBottom:20, padding:0, overflow:'hidden' }}>
          <div style={{ padding:'12px 18px', borderBottom:'1px solid var(--gw-border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ fontWeight:600, fontSize:13 }}>Team Earnings (Closed)</div>
            <div style={{ fontSize:12, color:'var(--gw-green)', fontWeight:700 }}>Total: {formatMoney(teamTotal)}</div>
          </div>
          {agentBreakdown.map(a => (
            <div key={a.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 18px', borderBottom:'1px solid var(--gw-border)' }}>
              <Avatar agent={a} size={28} />
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:600, fontSize:13 }}>{a.name}</div>
                <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{a.deals} closed deal{a.deals!==1?'s':''}</div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontWeight:700, color:'var(--gw-green)', fontSize:13 }}>{formatMoney(a.agent)}</div>
                <SideSplit align="right" parts={partyAmounts(a.agentBy)} />
                <div style={{ fontSize:11, color:'var(--gw-mist)' }}>House: {formatMoney(a.broker)}</div>
              </div>
              <div style={{ width:80 }}>
                <div style={{ height:4, background:'var(--gw-border)', borderRadius:2, overflow:'hidden' }}>
                  <div style={{ width:`${teamTotal>0 ? Math.round(a.agent/teamTotal*100) : 0}%`, height:'100%', background:a.color||'var(--gw-azure)', borderRadius:2 }} />
                </div>
                <div style={{ fontSize:10, color:'var(--gw-mist)', textAlign:'right', marginTop:2 }}>
                  {teamTotal>0 ? Math.round(a.agent/teamTotal*100) : 0}% of team
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Filters ── */}
      <div className="filters-bar">
        <select className="filter-select" value={filterStage} onChange={e=>setFilterStage(e.target.value)}>
          <option value="all">All Stages</option>
          <option value="active">Active Only</option>
          <option value="closed">Closed Only</option>
        </select>
        <select className="filter-select" value={filterCategory} onChange={e=>setFilterCategory(e.target.value)}>
          <option value="all">All Types</option>
          <option value="residential">🏠 Residential</option>
          <option value="commercial">🏢 Commercial</option>
        </select>
        <select className="filter-select" value={filterAgent} onChange={e=>setFilterAgent(e.target.value)}>
          <option value="">All Agents</option>
          {agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <span style={{ fontSize:12, color:'var(--gw-mist)', marginLeft:'auto' }}>
          Each agent's split, cap and pre-paid status come from Agents &amp; Caps · {D_GROSS}% gross when none is entered. Click edit to customize a deal.
        </span>
      </div>

      {/* ── Deals Table ── */}
      {filtered.length === 0 ? (
        <EmptyState icon="commission" title="No deals match" message="Add deals in Pipeline, then track commissions here." />
      ) : (
        <div className="card" style={{ padding:0, overflow:'hidden' }}>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Agent</th>
                  <th>Type</th>
                  <th>Stage</th>
                  <th style={{ textAlign:'right' }}>Sale Price</th>
                  <th style={{ textAlign:'right' }}>GC %</th>
                  <th style={{ textAlign:'right' }}>Gross Comm</th>
                  <th style={{ textAlign:'right' }}>Agent %</th>
                  <th style={{ textAlign:'right' }}>Agent $</th>
                  <th style={{ textAlign:'right' }}>House $</th>
                  <th style={{ width:40 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(deal => {
                  const { gross_pct, agent_pct, sp, gross, agentAmt, brokerAmt, parties } = calc(deal)
                  const split = parties.length > 1
                  const agent   = agents.find(a => a.id === deal.agent_id)
                  const contact = contacts.find(c => c.id === deal.contact_id)
                  const isCustom = !!getComm(deal.id)
                  return (
                    <tr key={deal.id} style={{ opacity: deal.stage==='lost'?0.5:1 }}>
                      <td>
                        <div style={{ fontWeight:600, fontSize:13 }}>{deal.title}</div>
                        {contact && <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{contact.first_name} {contact.last_name}</div>}
                        {isCustom && <span style={{ fontSize:10, color:'var(--gw-azure)', fontWeight:600 }}>CUSTOM SPLIT</span>}
                      </td>
                      <td>
                        {agent ? <div style={{ display:'flex', alignItems:'center', gap:6 }}><Avatar agent={agent} size={22} /><span style={{ fontSize:12 }}>{agent.name}</span></div>
                               : <span style={{ color:'var(--gw-mist)', fontSize:12 }}>—</span>}
                      </td>
                      <td>
                        {deal.prop_category === 'commercial'
                          ? <span style={{ fontSize:11, fontWeight:700, color:'var(--gw-azure)', background:'#eff6ff', padding:'2px 7px', borderRadius:8, whiteSpace:'nowrap' }}>🏢 Commercial</span>
                          : <span style={{ fontSize:11, fontWeight:700, color:'var(--gw-green)', background:'#f0fdf4', padding:'2px 7px', borderRadius:8, whiteSpace:'nowrap' }}>🏠 Residential</span>
                        }
                      </td>
                      <td><Badge variant={deal.stage==='under-contract'?'active':deal.stage}>{deal.stage.replace('-',' ')}</Badge></td>
                      <td style={{ textAlign:'right', fontWeight:600 }}>{sp>0?formatCurrency(sp):'—'}</td>
                      <td style={{ textAlign:'right', color:'var(--gw-mist)', fontSize:12 }}>{gross_pct}%</td>
                      <td style={{ textAlign:'right' }}>
                        {sp>0?formatMoney(gross):'—'}
                        {sp>0 && <SideSplit align="right" parts={parties.map(p => ({ party: p.party, amount: p.gross }))} />}
                      </td>
                      <td style={{ textAlign:'right', color:'var(--gw-mist)', fontSize:12 }}>{agent_pct}%</td>
                      <td style={{ textAlign:'right', fontWeight:600, color:'var(--gw-green)' }}>
                        {sp>0?formatMoney(agentAmt):'—'}
                        {sp>0 && split && <SideSplit align="right" parts={parties.map(p => ({ party: p.party, amount: p.agent_take }))} />}
                      </td>
                      <td style={{ textAlign:'right', color:'var(--gw-azure)' }}>
                        {sp>0?formatMoney(brokerAmt):'—'}
                        {sp>0 && split && <SideSplit align="right" parts={parties.map(p => ({ party: p.party, amount: p.house }))} />}
                      </td>
                      <td>
                        <button className="btn btn--ghost btn--icon btn--sm" onClick={()=>{setSelectedDeal(deal);setDrawer(true)}} title="Edit splits">
                          <Icon name="edit" size={13} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ background:'var(--gw-bone)', borderTop:'2px solid var(--gw-border)' }}>
                  <td colSpan={4} style={{ padding:'10px 12px', fontSize:12, fontWeight:700, color:'var(--gw-mist)' }}>TOTALS — {filtered.length} deals</td>
                  <td style={{ textAlign:'right', padding:'10px 12px', fontWeight:700 }}>{formatCurrency(totals.sp)}</td>
                  <td></td>
                  <td style={{ textAlign:'right', padding:'10px 12px', fontWeight:700 }}>{formatMoney(totals.gross)}<SideSplit align="right" parts={partyAmounts(totals.grossBy)} /></td>
                  <td></td>
                  <td style={{ textAlign:'right', padding:'10px 12px', fontWeight:700, color:'var(--gw-green)' }}>{formatMoney(totals.agent)}<SideSplit align="right" parts={partyAmounts(totals.agentBy)} /></td>
                  <td style={{ textAlign:'right', padding:'10px 12px', fontWeight:700, color:'var(--gw-azure)' }}>{formatMoney(totals.broker)}<SideSplit align="right" parts={partyAmounts(totals.brokerBy)} /></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
      </>)}

      {drawer && selectedDeal && (
        <CommissionDrawer open={drawer} onClose={()=>setDrawer(false)} deal={selectedDeal} commission={getComm(selectedDeal.id)} agents={agents} onSave={reload} />
      )}

    </div>
  )
}
