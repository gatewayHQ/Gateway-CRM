import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Avatar, Badge, Drawer, EmptyState, pushToast } from '../components/UI.jsx'
import { formatCurrency } from '../lib/helpers.js'

const D_GROSS = 3.0
const D_BROKER = 30.0
const D_AGENT = 70.0

const COMMISSION_SQL = `create table if not exists commissions (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid references deals(id) on delete cascade unique not null,
  gross_pct numeric not null default 3.0,
  broker_pct numeric not null default 30.0,
  agent_pct numeric not null default 70.0,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table commissions enable row level security;
create policy "Auth all" on commissions for all using (auth.role() = 'authenticated');`

// ── Cap Celebration Modal ──────────────────────────────────────────────────────
function CapCelebration({ agentName, onClose }) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(10,14,28,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1200, padding:24 }}
      onClick={onClose}>
      <div style={{ background:'#fff', borderRadius:20, padding:'40px 48px', textAlign:'center', maxWidth:440, boxShadow:'0 24px 60px rgba(0,0,0,0.25)', animation:'fabIn 300ms ease' }}
        onClick={e=>e.stopPropagation()}>
        <div style={{ fontSize:64, marginBottom:8 }}>🎉</div>
        <div style={{ fontFamily:'var(--font-display)', fontSize:28, fontWeight:700, color:'var(--gw-slate)', marginBottom:8 }}>
          Cap Hit!
        </div>
        <div style={{ fontSize:15, color:'var(--gw-mist)', lineHeight:1.6, marginBottom:24 }}>
          Congratulations{agentName ? `, ${agentName}` : ''}! 🥳<br />
          You've reached your brokerage cap. Every commission from here on is <strong>100% yours</strong>.
        </div>
        <button className="btn btn--primary" style={{ width:'100%', justifyContent:'center', fontSize:15, padding:'12px 0' }} onClick={onClose}>
          Let's keep closing! 🚀
        </button>
      </div>
    </div>
  )
}

// ── Commission Drawer ──────────────────────────────────────────────────────────
function CommissionDrawer({ open, onClose, deal, commission, onSave }) {
  const init = {
    gross_pct: commission?.gross_pct ?? D_GROSS,
    broker_pct: commission?.broker_pct ?? D_BROKER,
    agent_pct: commission?.agent_pct ?? D_AGENT,
    notes: commission?.notes ?? '',
  }
  const [form, setForm] = useState(init)
  const [saving, setSaving] = useState(false)

  React.useEffect(() => {
    setForm({ gross_pct: commission?.gross_pct ?? D_GROSS, broker_pct: commission?.broker_pct ?? D_BROKER, agent_pct: commission?.agent_pct ?? D_AGENT, notes: commission?.notes ?? '' })
  }, [commission, open])

  const setBroker = (v) => { const b = Math.min(100,Math.max(0,Number(v)||0)); setForm(p=>({...p,broker_pct:b,agent_pct:Math.round((100-b)*10)/10})) }
  const setAgent  = (v) => { const a = Math.min(100,Math.max(0,Number(v)||0)); setForm(p=>({...p,agent_pct:a,broker_pct:Math.round((100-a)*10)/10})) }

  const sp = deal?.value || 0
  const gross     = sp * (Number(form.gross_pct)  || 0) / 100
  const agentAmt  = gross * (Number(form.agent_pct)  || 0) / 100
  const brokerAmt = gross * (Number(form.broker_pct) || 0) / 100
  const splitWarning = Math.abs(Number(form.broker_pct)+Number(form.agent_pct)-100) > 0.5

  const save = async () => {
    setSaving(true)
    const payload = { deal_id:deal.id, gross_pct:Number(form.gross_pct), broker_pct:Number(form.broker_pct), agent_pct:Number(form.agent_pct), notes:form.notes.trim(), updated_at:new Date().toISOString() }
    let error
    if (commission?.id) { ;({error}=await supabase.from('commissions').update(payload).eq('id',commission.id)) }
    else               { ;({error}=await supabase.from('commissions').insert([payload])) }
    setSaving(false)
    if (error) { pushToast(error.message,'error'); return }
    pushToast('Commission updated'); onSave(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title="Edit Commission Split" width={420}>
      <div className="drawer__body">
        <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'12px 14px', marginBottom:20 }}>
          <div style={{ fontSize:11, color:'var(--gw-mist)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:2 }}>Deal</div>
          <div style={{ fontWeight:600 }}>{deal?.title}</div>
          {sp>0 && <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:2 }}>Sale Price: {formatCurrency(sp)}</div>}
        </div>
        <div className="form-group">
          <label className="form-label">Gross Commission Rate (%)</label>
          <input className="form-control" type="number" min="0" max="100" step="0.1" value={form.gross_pct} onChange={e=>setForm(p=>({...p,gross_pct:e.target.value}))} />
          <div className="form-hint">Gross: {formatCurrency(gross)}</div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Broker / House Split (%)</label>
            <input className="form-control" type="number" min="0" max="100" step="1" value={form.broker_pct} onChange={e=>setBroker(e.target.value)} />
            <div className="form-hint">{formatCurrency(brokerAmt)}</div>
          </div>
          <div className="form-group">
            <label className="form-label">Agent Split (%)</label>
            <input className="form-control" type="number" min="0" max="100" step="1" value={form.agent_pct} onChange={e=>setAgent(e.target.value)} />
            <div className="form-hint" style={{ color:'var(--gw-green)' }}>{formatCurrency(agentAmt)}</div>
          </div>
        </div>
        {splitWarning && <div style={{ background:'#fff3cd', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:'8px 12px', fontSize:12, color:'#856404', marginBottom:12 }}>Splits should add up to 100%</div>}
        <div className="form-group">
          <label className="form-label">Notes</label>
          <textarea className="form-control form-control--textarea" value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} placeholder="Any commission notes…" />
        </div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save'}</button>
      </div>
    </Drawer>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function CommissionPage({ db, setDb, activeAgent }) {
  const [drawer, setDrawer]           = useState(false)
  const [selectedDeal, setSelectedDeal] = useState(null)
  const [filterStage, setFilterStage] = useState('all')
  const [filterAgent, setFilterAgent] = useState('')
  const [copied, setCopied]           = useState(false)
  const [celebration, setCelebration] = useState(false)
  const [prevCapHit, setPrevCapHit]   = useState(false)

  // Cap settings stored per-agent in localStorage
  const capKey   = `gw_cap_${activeAgent?.id || 'default'}`
  const [capAmt, setCapAmt] = useState(() => Number(localStorage.getItem(capKey) || 25000))

  const saveCapAmt = (val) => { setCapAmt(val); localStorage.setItem(capKey, String(val)) }

  const deals       = db.deals       || []
  const agents      = db.agents      || []
  const contacts    = db.contacts    || []
  const commissions = db.commissions || []
  const hasTable    = db.commissionsReady !== false

  const getComm = (dealId) => commissions.find(c => c.deal_id === dealId)

  const calc = (deal) => {
    const c = getComm(deal.id)
    const gross_pct  = c?.gross_pct  ?? D_GROSS
    const broker_pct = c?.broker_pct ?? D_BROKER
    const agent_pct  = c?.agent_pct  ?? D_AGENT
    const sp         = deal.value || 0
    const gross      = sp * gross_pct  / 100
    const agentAmt   = gross * agent_pct  / 100
    const brokerAmt  = gross * broker_pct / 100
    return { gross_pct, broker_pct, agent_pct, sp, gross, agentAmt, brokerAmt }
  }

  const reload = async () => {
    const [dealsRes, commRes] = await Promise.all([
      supabase.from('deals').select('*').order('created_at', { ascending: false }),
      supabase.from('commissions').select('*'),
    ])
    setDb(p => ({ ...p, deals: dealsRes.data||[], commissions: commRes.data||[], commissionsReady: !commRes.error }))
    pushToast('Refreshed')
  }

  // ── Compute earnings totals ──────────────────────────────────────────────────
  const closedDeals = deals.filter(d => d.stage === 'closed')

  // Brokerage total (all closed deals)
  const brokerageTotals = closedDeals.reduce((acc, d) => {
    const { gross, brokerAmt, agentAmt } = calc(d)
    acc.gross += gross; acc.broker += brokerAmt; acc.agent += agentAmt; return acc
  }, { gross:0, broker:0, agent:0 })

  // Per-agent breakdown (closed deals only)
  const agentBreakdown = agents.map(a => {
    const aDeals = closedDeals.filter(d => d.agent_id === a.id)
    const totals = aDeals.reduce((acc, d) => {
      const { agentAmt, brokerAmt, gross } = calc(d)
      acc.agent += agentAmt; acc.broker += brokerAmt; acc.gross += gross; acc.deals++; return acc
    }, { agent:0, broker:0, gross:0, deals:0 })
    return { ...a, ...totals }
  }).filter(a => a.deals > 0).sort((a,b) => b.agent - a.agent)

  // Team total
  const teamTotal = agentBreakdown.reduce((s, a) => s + a.agent, 0)

  // Cap tracking — for the active agent's closed deals this year
  const thisYear = new Date().getFullYear()
  const activeAgentClosedDeals = closedDeals.filter(d => d.agent_id === activeAgent?.id && new Date(d.updated_at || d.created_at).getFullYear() === thisYear)
  const ytdBrokerFees = activeAgentClosedDeals.reduce((s, d) => s + calc(d).brokerAmt, 0)
  const ytdAgentEarned = activeAgentClosedDeals.reduce((s, d) => s + calc(d).agentAmt, 0)
  const capPct = capAmt > 0 ? Math.min(100, Math.round(ytdBrokerFees / capAmt * 100)) : 0
  const capHit = capAmt > 0 && ytdBrokerFees >= capAmt

  // Trigger celebration once when cap is first hit
  useEffect(() => {
    if (capHit && !prevCapHit && ytdBrokerFees > 0) {
      setCelebration(true)
    }
    setPrevCapHit(capHit)
  }, [capHit])

  // ── Filtered table ───────────────────────────────────────────────────────────
  let filtered = deals
  if (filterStage === 'closed') filtered = filtered.filter(d => d.stage === 'closed')
  if (filterStage === 'active') filtered = filtered.filter(d => d.stage !== 'closed' && d.stage !== 'lost')
  if (filterAgent) filtered = filtered.filter(d => d.agent_id === filterAgent)

  const totals = filtered.reduce((acc, d) => {
    const { sp, gross, agentAmt, brokerAmt } = calc(d)
    acc.sp += sp; acc.gross += gross; acc.agent += agentAmt; acc.broker += brokerAmt; return acc
  }, { sp:0, gross:0, agent:0, broker:0 })

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
          <div className="page-title">Commission Tracker</div>
          <div className="page-sub">{deals.length} deals · {formatCurrency(deals.reduce((s,d)=>s+(d.value||0),0))} total pipeline</div>
        </div>
        <button className="btn btn--secondary btn--sm" onClick={reload}><Icon name="refresh" size={13} /> Refresh</button>
      </div>

      {/* ── Summary stats ── */}
      <div className="stats-grid" style={{ gridTemplateColumns:'repeat(4,1fr)', marginBottom:20 }}>
        <div className="stat-card">
          <div className="stat-card__value">{closedDeals.length}</div>
          <div className="stat-card__label">Closed Deals</div>
        </div>
        <div className="stat-card">
          <div className="stat-card__value">{formatCurrency(brokerageTotals.gross)}</div>
          <div className="stat-card__label">Total Gross Comm</div>
        </div>
        <div className="stat-card" style={{ borderLeft:'3px solid var(--gw-green)' }}>
          <div className="stat-card__value" style={{ color:'var(--gw-green)' }}>{formatCurrency(brokerageTotals.agent)}</div>
          <div className="stat-card__label">Total Agent Earnings</div>
        </div>
        <div className="stat-card" style={{ borderLeft:'3px solid var(--gw-azure)' }}>
          <div className="stat-card__value" style={{ color:'var(--gw-azure)' }}>{formatCurrency(brokerageTotals.broker)}</div>
          <div className="stat-card__label">Brokerage / House</div>
        </div>
      </div>

      {/* ── Cap Tracker (active agent) ── */}
      {activeAgent && (
        <div className="card" style={{ marginBottom:20, padding:'18px 20px' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <Avatar agent={activeAgent} size={32} />
              <div>
                <div style={{ fontWeight:700, fontSize:14 }}>{activeAgent.name}'s Cap Tracker</div>
                <div style={{ fontSize:12, color:'var(--gw-mist)' }}>
                  {thisYear} YTD · Broker fees paid: <strong>{formatCurrency(ytdBrokerFees)}</strong> of <strong>{formatCurrency(capAmt)}</strong> cap
                </div>
              </div>
            </div>
            {capHit && (
              <span style={{ background:'#fef9ec', border:'1px solid var(--gw-amber)', borderRadius:20, padding:'4px 12px', fontSize:12, fontWeight:700, color:'#856404' }}>
                🎉 CAP HIT!
              </span>
            )}
          </div>

          {/* Progress bar */}
          <div style={{ height:10, background:'var(--gw-border)', borderRadius:5, overflow:'hidden', marginBottom:10 }}>
            <div style={{ width:`${capPct}%`, height:'100%', background: capHit ? 'var(--gw-green)' : capPct > 75 ? 'var(--gw-amber)' : 'var(--gw-azure)', borderRadius:5, transition:'width 400ms ease' }} />
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--gw-mist)', marginBottom:14 }}>
            <span>{capPct}% to cap</span>
            <span>Agent kept YTD: <strong style={{ color:'var(--gw-green)' }}>{formatCurrency(ytdAgentEarned)}</strong></span>
          </div>

          {/* Cap slider */}
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <span style={{ fontSize:12, fontWeight:600, whiteSpace:'nowrap' }}>Set Cap:</span>
            <input type="range" min="5000" max="100000" step="1000" value={capAmt}
              onChange={e => saveCapAmt(Number(e.target.value))}
              style={{ flex:1, accentColor:'var(--gw-azure)' }} />
            <span style={{ fontSize:13, fontWeight:700, minWidth:72, textAlign:'right' }}>{formatCurrency(capAmt)}</span>
            {capHit && <button className="btn btn--secondary btn--sm" onClick={() => setCelebration(true)}>🎉</button>}
          </div>
        </div>
      )}

      {/* ── Team / Agent Breakdown ── */}
      {agentBreakdown.length > 1 && (
        <div className="card" style={{ marginBottom:20, padding:0, overflow:'hidden' }}>
          <div style={{ padding:'12px 18px', borderBottom:'1px solid var(--gw-border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ fontWeight:600, fontSize:13 }}>Team Earnings (Closed)</div>
            <div style={{ fontSize:12, color:'var(--gw-green)', fontWeight:700 }}>Total: {formatCurrency(teamTotal)}</div>
          </div>
          {agentBreakdown.map(a => (
            <div key={a.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 18px', borderBottom:'1px solid var(--gw-border)' }}>
              <Avatar agent={a} size={28} />
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:600, fontSize:13 }}>{a.name}</div>
                <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{a.deals} closed deal{a.deals!==1?'s':''}</div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontWeight:700, color:'var(--gw-green)', fontSize:13 }}>{formatCurrency(a.agent)}</div>
                <div style={{ fontSize:11, color:'var(--gw-mist)' }}>House: {formatCurrency(a.broker)}</div>
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
        <select className="filter-select" value={filterAgent} onChange={e=>setFilterAgent(e.target.value)}>
          <option value="">All Agents</option>
          {agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <span style={{ fontSize:12, color:'var(--gw-mist)', marginLeft:'auto' }}>
          Defaults: {D_GROSS}% gross · {D_AGENT}/{D_BROKER} agent/broker. Click edit to customize.
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
                  const { gross_pct, agent_pct, sp, gross, agentAmt, brokerAmt } = calc(deal)
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
                      <td><Badge variant={deal.stage==='under-contract'?'active':deal.stage}>{deal.stage.replace('-',' ')}</Badge></td>
                      <td style={{ textAlign:'right', fontWeight:600 }}>{sp>0?formatCurrency(sp):'—'}</td>
                      <td style={{ textAlign:'right', color:'var(--gw-mist)', fontSize:12 }}>{gross_pct}%</td>
                      <td style={{ textAlign:'right' }}>{sp>0?formatCurrency(gross):'—'}</td>
                      <td style={{ textAlign:'right', color:'var(--gw-mist)', fontSize:12 }}>{agent_pct}%</td>
                      <td style={{ textAlign:'right', fontWeight:600, color:'var(--gw-green)' }}>{sp>0?formatCurrency(agentAmt):'—'}</td>
                      <td style={{ textAlign:'right', color:'var(--gw-azure)' }}>{sp>0?formatCurrency(brokerAmt):'—'}</td>
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
                  <td colSpan={3} style={{ padding:'10px 12px', fontSize:12, fontWeight:700, color:'var(--gw-mist)' }}>TOTALS — {filtered.length} deals</td>
                  <td style={{ textAlign:'right', padding:'10px 12px', fontWeight:700 }}>{formatCurrency(totals.sp)}</td>
                  <td></td>
                  <td style={{ textAlign:'right', padding:'10px 12px', fontWeight:700 }}>{formatCurrency(totals.gross)}</td>
                  <td></td>
                  <td style={{ textAlign:'right', padding:'10px 12px', fontWeight:700, color:'var(--gw-green)' }}>{formatCurrency(totals.agent)}</td>
                  <td style={{ textAlign:'right', padding:'10px 12px', fontWeight:700, color:'var(--gw-azure)' }}>{formatCurrency(totals.broker)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {drawer && selectedDeal && (
        <CommissionDrawer open={drawer} onClose={()=>setDrawer(false)} deal={selectedDeal} commission={getComm(selectedDeal.id)} onSave={reload} />
      )}

      {celebration && (
        <CapCelebration agentName={activeAgent?.name} onClose={()=>setCelebration(false)} />
      )}
    </div>
  )
}
