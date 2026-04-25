import React, { useState } from 'react'
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

function StatCard({ label, value, sub }) {
  return (
    <div className="card">
      <div className="card__label">{label}</div>
      <div className="card__value">{value}</div>
      {sub && <div className="card__sub">{sub}</div>}
    </div>
  )
}

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
    setForm({
      gross_pct: commission?.gross_pct ?? D_GROSS,
      broker_pct: commission?.broker_pct ?? D_BROKER,
      agent_pct: commission?.agent_pct ?? D_AGENT,
      notes: commission?.notes ?? '',
    })
  }, [commission, open])

  const setBroker = (v) => {
    const b = Math.min(100, Math.max(0, Number(v) || 0))
    setForm(p => ({ ...p, broker_pct: b, agent_pct: Math.round((100 - b) * 10) / 10 }))
  }
  const setAgent = (v) => {
    const a = Math.min(100, Math.max(0, Number(v) || 0))
    setForm(p => ({ ...p, agent_pct: a, broker_pct: Math.round((100 - a) * 10) / 10 }))
  }

  const sp = deal?.value || 0
  const gross = sp * (Number(form.gross_pct) || 0) / 100
  const agentAmt = gross * (Number(form.agent_pct) || 0) / 100
  const brokerAmt = gross * (Number(form.broker_pct) || 0) / 100
  const splitWarning = Math.abs(Number(form.broker_pct) + Number(form.agent_pct) - 100) > 0.5

  const save = async () => {
    setSaving(true)
    const payload = {
      deal_id: deal.id,
      gross_pct: Number(form.gross_pct),
      broker_pct: Number(form.broker_pct),
      agent_pct: Number(form.agent_pct),
      notes: form.notes.trim(),
      updated_at: new Date().toISOString(),
    }
    let error
    if (commission?.id) {
      ;({ error } = await supabase.from('commissions').update(payload).eq('id', commission.id))
    } else {
      ;({ error } = await supabase.from('commissions').insert([payload]))
    }
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast('Commission updated')
    onSave(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title="Edit Commission Split" width={420}>
      <div className="drawer__body">
        <div style={{ background: 'var(--gw-bone)', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Deal</div>
          <div style={{ fontWeight: 600 }}>{deal?.title}</div>
          {sp > 0 && <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 2 }}>Sale Price: {formatCurrency(sp)}</div>}
        </div>

        <div className="form-group">
          <label className="form-label">Gross Commission Rate (%)</label>
          <input className="form-control" type="number" min="0" max="100" step="0.1"
            value={form.gross_pct} onChange={e => setForm(p => ({ ...p, gross_pct: e.target.value }))} />
          <div className="form-hint">Gross commission amount: {formatCurrency(gross)}</div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Broker Split (%)</label>
            <input className="form-control" type="number" min="0" max="100" step="1"
              value={form.broker_pct} onChange={e => setBroker(e.target.value)} />
            <div className="form-hint">{formatCurrency(brokerAmt)}</div>
          </div>
          <div className="form-group">
            <label className="form-label">Agent Split (%)</label>
            <input className="form-control" type="number" min="0" max="100" step="1"
              value={form.agent_pct} onChange={e => setAgent(e.target.value)} />
            <div className="form-hint" style={{ color: 'var(--gw-green)' }}>{formatCurrency(agentAmt)}</div>
          </div>
        </div>

        {splitWarning && (
          <div style={{ background: 'var(--gw-amber-light)', border: '1px solid var(--gw-amber)', borderRadius: 'var(--radius)', padding: '8px 12px', fontSize: 12, color: 'var(--gw-amber)', marginBottom: 12 }}>
            Agent + Broker splits should add up to 100%
          </div>
        )}

        <div className="form-group">
          <label className="form-label">Notes</label>
          <textarea className="form-control form-control--textarea" value={form.notes}
            onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} placeholder="Any commission notes…" />
        </div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Drawer>
  )
}

export default function CommissionPage({ db, setDb }) {
  const [drawer, setDrawer] = useState(false)
  const [selectedDeal, setSelectedDeal] = useState(null)
  const [filterStage, setFilterStage] = useState('all')
  const [filterAgent, setFilterAgent] = useState('')
  const [copied, setCopied] = useState(false)

  const deals = db.deals || []
  const agents = db.agents || []
  const contacts = db.contacts || []
  const commissions = db.commissions || []
  const hasTable = db.commissionsReady !== false

  const getComm = (dealId) => commissions.find(c => c.deal_id === dealId)

  const calc = (deal) => {
    const c = getComm(deal.id)
    const gross_pct = c?.gross_pct ?? D_GROSS
    const broker_pct = c?.broker_pct ?? D_BROKER
    const agent_pct = c?.agent_pct ?? D_AGENT
    const sp = deal.value || 0
    const gross = sp * gross_pct / 100
    const agentAmt = gross * agent_pct / 100
    const brokerAmt = gross * broker_pct / 100
    return { gross_pct, broker_pct, agent_pct, sp, gross, agentAmt, brokerAmt }
  }

  const reload = async () => {
    const [dealsRes, commRes] = await Promise.all([
      supabase.from('deals').select('*').order('created_at', { ascending: false }),
      supabase.from('commissions').select('*'),
    ])
    setDb(p => ({
      ...p,
      deals: dealsRes.data || [],
      commissions: commRes.data || [],
      commissionsReady: !commRes.error,
    }))
    pushToast('Refreshed')
  }

  const copySQL = () => {
    navigator.clipboard.writeText(COMMISSION_SQL)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
    pushToast('SQL copied to clipboard')
  }

  let filtered = deals
  if (filterStage === 'closed') filtered = filtered.filter(d => d.stage === 'closed')
  if (filterStage === 'active') filtered = filtered.filter(d => d.stage !== 'closed' && d.stage !== 'lost')
  if (filterAgent) filtered = filtered.filter(d => d.agent_id === filterAgent)

  const totals = filtered.reduce((acc, d) => {
    const { sp, gross, agentAmt, brokerAmt } = calc(d)
    acc.sp += sp; acc.gross += gross; acc.agent += agentAmt; acc.broker += brokerAmt
    return acc
  }, { sp: 0, gross: 0, agent: 0, broker: 0 })

  const closedDeals = deals.filter(d => d.stage === 'closed')
  const closedTotals = closedDeals.reduce((acc, d) => {
    const { gross, agentAmt } = calc(d)
    acc.gross += gross; acc.agent += agentAmt
    return acc
  }, { gross: 0, agent: 0 })

  if (!hasTable) return (
    <div className="page-content">
      <div className="page-header"><div><div className="page-title">Commission Tracker</div></div></div>
      <div style={{ background: 'var(--gw-amber-light)', border: '1px solid var(--gw-amber)', borderRadius: 'var(--radius-lg)', padding: 24 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, color: 'var(--gw-amber)' }}>One-time Database Setup Required</div>
        <div style={{ fontSize: 13, marginBottom: 12 }}>Run this SQL in Supabase → SQL Editor to create the commissions table:</div>
        <code style={{ display: 'block', background: '#1a1a2e', color: '#c9a84c', fontFamily: 'var(--font-mono)', fontSize: 11, padding: 14, borderRadius: 'var(--radius)', whiteSpace: 'pre', overflowX: 'auto', marginBottom: 12 }}>{COMMISSION_SQL}</code>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--secondary btn--sm" onClick={copySQL}><Icon name="copy" size={12} /> {copied ? 'Copied!' : 'Copy SQL'}</button>
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
          <div className="page-sub">{deals.length} deals · {formatCurrency(deals.reduce((s, d) => s + (d.value || 0), 0))} total pipeline</div>
        </div>
        <button className="btn btn--secondary btn--sm" onClick={reload}><Icon name="refresh" size={13} /> Refresh</button>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 20 }}>
        <StatCard label="Closed Deals" value={closedDeals.length} sub="Commissions earned" />
        <StatCard label="Gross Comm (Closed)" value={formatCurrency(closedTotals.gross)} sub="Total gross" />
        <StatCard label="Agent Take-Home (Closed)" value={formatCurrency(closedTotals.agent)} sub="Net to agents" />
      </div>

      <div className="filters-bar">
        <select className="filter-select" value={filterStage} onChange={e => setFilterStage(e.target.value)}>
          <option value="all">All Stages</option>
          <option value="active">Active Only</option>
          <option value="closed">Closed Only</option>
        </select>
        <select className="filter-select" value={filterAgent} onChange={e => setFilterAgent(e.target.value)}>
          <option value="">All Agents</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <span style={{ fontSize: 12, color: 'var(--gw-mist)', marginLeft: 'auto' }}>
          Defaults: {D_GROSS}% gross · {D_AGENT}/{D_BROKER} agent/broker split. Click edit to customize per deal.
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="commission" title="No deals match your filter" message="Add deals in the Pipeline, then track commissions here." />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Agent</th>
                  <th>Stage</th>
                  <th style={{ textAlign: 'right' }}>Sale Price</th>
                  <th style={{ textAlign: 'right' }}>GC %</th>
                  <th style={{ textAlign: 'right' }}>Gross Comm</th>
                  <th style={{ textAlign: 'right' }}>Agent %</th>
                  <th style={{ textAlign: 'right' }}>Agent $</th>
                  <th style={{ textAlign: 'right' }}>Broker $</th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(deal => {
                  const { gross_pct, agent_pct, sp, gross, agentAmt, brokerAmt } = calc(deal)
                  const agent = agents.find(a => a.id === deal.agent_id)
                  const contact = contacts.find(c => c.id === deal.contact_id)
                  const isCustom = !!getComm(deal.id)
                  return (
                    <tr key={deal.id} style={{ opacity: deal.stage === 'lost' ? 0.5 : 1 }}>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{deal.title}</div>
                        {contact && <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{contact.first_name} {contact.last_name}</div>}
                        {isCustom && <span style={{ fontSize: 10, color: 'var(--gw-azure)', fontWeight: 600 }}>CUSTOM SPLIT</span>}
                      </td>
                      <td>
                        {agent ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Avatar agent={agent} size={22} />
                            <span style={{ fontSize: 12 }}>{agent.name}</span>
                          </div>
                        ) : <span style={{ color: 'var(--gw-mist)', fontSize: 12 }}>—</span>}
                      </td>
                      <td><Badge variant={deal.stage === 'under-contract' ? 'active' : deal.stage}>{deal.stage.replace('-', ' ')}</Badge></td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{sp > 0 ? formatCurrency(sp) : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--gw-mist)', fontSize: 12 }}>{gross_pct}%</td>
                      <td style={{ textAlign: 'right' }}>{sp > 0 ? formatCurrency(gross) : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--gw-mist)', fontSize: 12 }}>{agent_pct}%</td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--gw-green)' }}>{sp > 0 ? formatCurrency(agentAmt) : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--gw-mist)' }}>{sp > 0 ? formatCurrency(brokerAmt) : '—'}</td>
                      <td>
                        <button className="btn btn--ghost btn--icon btn--sm"
                          onClick={() => { setSelectedDeal(deal); setDrawer(true) }}
                          title="Edit commission splits">
                          <Icon name="edit" size={13} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ background: 'var(--gw-bone)', borderTop: '2px solid var(--gw-border)' }}>
                  <td colSpan={3} style={{ padding: '10px 12px', fontSize: 12, fontWeight: 700, color: 'var(--gw-mist)' }}>
                    TOTALS — {filtered.length} deals
                  </td>
                  <td style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>{formatCurrency(totals.sp)}</td>
                  <td></td>
                  <td style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>{formatCurrency(totals.gross)}</td>
                  <td></td>
                  <td style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700, color: 'var(--gw-green)' }}>{formatCurrency(totals.agent)}</td>
                  <td style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700, color: 'var(--gw-mist)' }}>{formatCurrency(totals.broker)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {drawer && selectedDeal && (
        <CommissionDrawer
          open={drawer}
          onClose={() => setDrawer(false)}
          deal={selectedDeal}
          commission={getComm(selectedDeal.id)}
          onSave={reload}
        />
      )}
    </div>
  )
}
