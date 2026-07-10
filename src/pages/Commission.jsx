import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Avatar, Badge, Drawer, EmptyState, pushToast } from '../components/UI.jsx'
import { formatCurrency, formatCurrencyExact } from '../lib/helpers.js'
import { fetchVisibleDeals, fetchVisibleCommissions } from '../lib/services/deals.js'
import MyEarnings from './MyEarnings.jsx'
import { BrokerageReport, CapsEditor } from './BackOffice.jsx'
import {
  computeCommission, normalizeCommission, breakdownForDeal,
  makeSide, makeParticipant, DEFAULTS,
} from '../lib/commission.js'

const D_GROSS = DEFAULTS.GROSS_PCT
const D_BROKER = 30.0
const D_AGENT = DEFAULTS.SPLIT_PCT

const COMMISSION_SQL = `create table if not exists commissions (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid references deals(id) on delete cascade unique not null,
  gross_pct numeric not null default 3.0,
  broker_pct numeric not null default 30.0,
  agent_pct numeric not null default 70.0,
  referral_pct numeric not null default 0,
  co_agent_pct numeric not null default 0,
  transaction_fee numeric not null default 0,
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

// ── Commission Drawer (structured editor) ───────────────────────────────────
// Handles the simple case (one side, one agent at their default split) and the
// complex one (both sides represented, a referral on only one side, multiple
// agents each with their own brokerage arrangement) from the same form. The
// agent never has to do mental math — the live breakdown shows every dollar.
function CommissionDrawer({ open, onClose, deal, commission, agents = [], onSave }) {
  // Seed the form from the stored row (legacy or structured), normalized.
  const buildInitial = () => {
    const norm = normalizeCommission(commission, { deal, agents })
    const twoSided = norm.sides.length > 1
    return {
      sides: norm.sides.map(s => ({ ...s })),
      participants: norm.participants
        .filter(p => p._legacy_co_pct == null) // legacy co marker not editable directly
        .map(p => ({ ...p })),
      twoSided,
      // Flat brokerage transaction fee for the whole deal. New deals default to
      // $100; existing rows keep whatever was saved.
      transaction_fee: commission?.id != null ? Number(norm.transaction_fee || 0) : DEFAULTS.TRANSACTION_FEE,
      notes: commission?.notes ?? '',
    }
  }

  const [form, setForm] = useState(buildInitial)
  const [saving, setSaving] = useState(false)

  React.useEffect(() => { setForm(buildInitial()) /* eslint-disable-next-line */ }, [commission, open, deal?.id])

  const sp = deal?.value || 0

  // Live breakdown straight from the engine — identical math to the reports.
  const result = computeCommission({
    sale_price: sp,
    sides: form.sides,
    participants: form.participants,
    transaction_fee: form.transaction_fee,
  })

  // ── Side editing ────────────────────────────────────────────────────────
  const setSide = (id, patch) =>
    setForm(p => ({ ...p, sides: p.sides.map(s => s.id === id ? { ...s, ...patch } : s) }))

  const toggleTwoSided = (on) => {
    setForm(p => {
      if (on) {
        // Convert the single side into a Listing side and add a Buyer side.
        const first = p.sides[0] || makeSide()
        return {
          ...p, twoSided: true,
          sides: [
            { ...first, key: 'listing', label: 'Listing side' },
            makeSide('buyer', 0),
          ],
        }
      }
      // Collapse back to one Sale side, keeping the first side's numbers.
      const keep = p.sides[0] || makeSide()
      return { ...p, twoSided: false, sides: [{ ...keep, key: 'sale', label: 'Sale' }] }
    })
  }

  // ── Participant editing ─────────────────────────────────────────────────
  const setPart = (id, patch) =>
    setForm(p => ({ ...p, participants: p.participants.map(x => x.id === id ? { ...x, ...patch } : x) }))

  const pickAgent = (id, agentId) => {
    const a = agents.find(x => x.id === agentId)
    setPart(id, {
      agent_id: agentId,
      name: a?.name || '',
      // Pull this agent's stored default arrangement so the common case is zero-typing.
      no_split: a?.no_brokerage_split === true,
      split_pct: a?.no_brokerage_split ? 100 : Number(a?.default_split_pct ?? D_AGENT),
    })
  }

  const addParticipant = () => {
    setForm(p => {
      const used = p.participants.length
      // Re-balance allocations: split evenly across all participants by default.
      const evenly = Math.round((100 / (used + 1)) * 10) / 10
      const next = makeParticipant({ role: 'co', allocation_pct: evenly })
      const rebalanced = p.participants.map(x => ({ ...x, allocation_pct: evenly }))
      return { ...p, participants: [...rebalanced, next] }
    })
  }

  const removeParticipant = (id) =>
    setForm(p => {
      const rest = p.participants.filter(x => x.id !== id)
      // Give the removed share back to the first participant.
      if (rest.length) {
        const total = rest.reduce((s, x) => s + Number(x.allocation_pct || 0), 0)
        if (Math.abs(total - 100) > 0.1) rest[0] = { ...rest[0], allocation_pct: Math.round((Number(rest[0].allocation_pct || 0) + (100 - total)) * 10) / 10 }
      }
      return { ...p, participants: rest.length ? rest : [makeParticipant({ allocation_pct: 100 })] }
    })

  const save = async () => {
    setSaving(true)
    // Write BOTH the structured shape (authoritative) and best-effort legacy
    // scalar columns, so any older report path still renders something sane.
    const primary = result.primary
    const payload = {
      deal_id: deal.id,
      sides: form.sides,
      participants: form.participants,
      // Legacy mirror (single-side blended view):
      gross_pct:       result.effective_rate_pct,
      referral_pct:    result.gross_total > 0 ? Math.round(result.referral_total / result.gross_total * 1000) / 10 : 0,
      agent_pct:       primary ? Number(primary.split_pct) : D_AGENT,
      broker_pct:      primary ? Math.round((100 - Number(primary.split_pct)) * 10) / 10 : D_BROKER,
      co_agent_pct:    0,
      transaction_fee: Number(form.transaction_fee || 0),
      notes: form.notes.trim(),
      updated_at: new Date().toISOString(),
    }
    let error
    if (commission?.id) { ;({ error } = await supabase.from('commissions').update(payload).eq('id', commission.id)) }
    else                { ;({ error } = await supabase.from('commissions').insert([payload])) }
    setSaving(false)
    if (error) {
      // If the structured columns don't exist yet (migration 0005 not run), retry
      // with just the legacy columns so the agent isn't blocked.
      if (/sides|participants|column/i.test(error.message)) {
        const { sides, participants, ...legacy } = payload
        const retry = commission?.id
          ? await supabase.from('commissions').update(legacy).eq('id', commission.id)
          : await supabase.from('commissions').insert([legacy])
        if (retry.error) { pushToast(retry.error.message, 'error'); return }
        pushToast('Saved (run migration 0005 to enable two-sided deals)')
        onSave(); onClose(); return
      }
      pushToast(error.message, 'error'); return
    }
    pushToast('Commission updated'); onSave(); onClose()
  }

  const fieldLabel = { display:'block', fontSize:11, fontWeight:600, color:'var(--gw-mist)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:4 }
  const sectionTitle = { fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginBottom:10, display:'flex', alignItems:'center', justifyContent:'space-between' }

  return (
    <Drawer open={open} onClose={onClose} title="Edit Commission Split" width={460}>
      <div className="drawer__body">
        <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'12px 14px', marginBottom:18 }}>
          <div style={{ fontSize:11, color:'var(--gw-mist)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:2 }}>Deal</div>
          <div style={{ fontWeight:600 }}>{deal?.title}</div>
          {sp>0 && <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:2 }}>Sale Price: {formatCurrency(sp)}</div>}
        </div>

        {/* ── SIDES ─────────────────────────────────────────────────────── */}
        <div style={{ marginBottom:18 }}>
          <div style={sectionTitle}>
            <span>Commission Sides</span>
          </div>
          <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, marginBottom:12, cursor:'pointer' }}>
            <input type="checkbox" checked={form.twoSided} onChange={e=>toggleTwoSided(e.target.checked)} />
            <span>We represented <strong>both sides</strong> (listing + buyer)</span>
          </label>

          {form.sides.map((s, i) => {
            const rs = result.sides[i] || {}
            return (
              <div key={s.id} style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:8 }}>
                {form.twoSided && <div style={{ fontSize:12, fontWeight:700, marginBottom:8 }}>{s.label}</div>}
                <div className="form-row" style={{ display:'flex', gap:10 }}>
                  <div style={{ flex:1 }}>
                    <label style={fieldLabel}>Rate (%)</label>
                    <input className="form-control" type="number" min="0" max="100" step="0.1" value={s.rate_pct}
                      onChange={e=>setSide(s.id,{ rate_pct:e.target.value })} />
                  </div>
                  <div style={{ flex:1 }}>
                    <label style={fieldLabel}>Referral (% of this side)</label>
                    <input className="form-control" type="number" min="0" max="100" step="1" value={s.referral_pct}
                      onChange={e=>setSide(s.id,{ referral_pct:e.target.value })} placeholder="0" />
                  </div>
                </div>
                <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6 }}>
                  Gross {formatCurrencyExact(rs.gross || 0)}
                  {rs.referral > 0 && <> · referral ({formatCurrencyExact(rs.referral)}) → net {formatCurrencyExact(rs.net || 0)}</>}
                </div>
              </div>
            )
          })}
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, fontWeight:700, padding:'4px 2px' }}>
            <span style={{ color:'var(--gw-mist)' }}>Net commission to split</span>
            <span>{formatCurrencyExact(result.net_total)}</span>
          </div>
        </div>

        {/* ── PARTICIPANTS ──────────────────────────────────────────────── */}
        <div style={{ marginBottom:18 }}>
          <div style={sectionTitle}>
            <span>Who splits it</span>
            <button className="btn btn--ghost btn--sm" onClick={addParticipant} style={{ fontSize:12 }}>
              <Icon name="plus" size={12} /> Add agent
            </button>
          </div>

          {/* Deal-level transaction fee — flat brokerage fee, split across agents. */}
          <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:8, display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ flex:1 }}>
              <label style={fieldLabel}>Transaction fee ($)</label>
              <input className="form-control" type="number" min="0" step="25" value={form.transaction_fee}
                onChange={e=>setForm(p=>({ ...p, transaction_fee:e.target.value }))} placeholder="100" />
            </div>
            <div style={{ flex:1, fontSize:11, color:'var(--gw-mist)', alignSelf:'flex-end', paddingBottom:8 }}>
              Flat brokerage fee, charged on top of the split. Split evenly:
              <strong> {formatCurrencyExact((Number(form.transaction_fee)||0) / Math.max(1, form.participants.length))} </strong>
              per agent.
            </div>
          </div>

          {form.participants.map((p, i) => {
            const rp = result.participants.find(x => x.id === p.id) || {}
            return (
              <div key={p.id} style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:8 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                  <select className="form-control" value={p.agent_id} onChange={e=>pickAgent(p.id, e.target.value)} style={{ flex:1 }}>
                    <option value="">Select agent…</option>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  {form.participants.length > 1 && (
                    <button className="btn btn--ghost btn--icon btn--sm" onClick={()=>removeParticipant(p.id)} title="Remove">
                      <Icon name="trash" size={13} />
                    </button>
                  )}
                </div>

                <div className="form-row" style={{ display:'flex', gap:10 }}>
                  <div style={{ flex:1 }}>
                    <label style={fieldLabel}>Allocation (% of net)</label>
                    <input className="form-control" type="number" min="0" max="100" step="1" value={p.allocation_pct}
                      onChange={e=>setPart(p.id,{ allocation_pct:e.target.value })} />
                  </div>
                  <div style={{ flex:1 }}>
                    <label style={fieldLabel}>Fee override ($)</label>
                    <input className="form-control" type="number" min="0" step="25" value={p.fee || ''}
                      onChange={e=>setPart(p.id,{ fee:e.target.value })}
                      placeholder={String(Math.round((Number(form.transaction_fee)||0) / Math.max(1, form.participants.length)))} />
                  </div>
                </div>

                <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, margin:'10px 0 6px', cursor:'pointer' }}>
                  <input type="checkbox" checked={!!p.no_split} onChange={e=>setPart(p.id,{ no_split:e.target.checked })} />
                  <span>Keeps 100% — no brokerage split (capped / referred co-agent)</span>
                </label>

                {!p.no_split && (
                  <div>
                    <label style={fieldLabel}>Agent's split (%) — house keeps the rest</label>
                    <input className="form-control" type="number" min="0" max="100" step="1" value={p.split_pct}
                      onChange={e=>setPart(p.id,{ split_pct:e.target.value })} />
                  </div>
                )}

                <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginTop:8, paddingTop:8, borderTop:'1px dashed var(--gw-border)' }}>
                  <span style={{ color:'var(--gw-mist)' }}>
                    {p.role === 'primary' ? 'Take-home' : 'Co-agent take-home'}
                  </span>
                  <span style={{ fontWeight:700, color:'var(--gw-green)' }}>{formatCurrencyExact(rp.agent_take || 0)}</span>
                </div>
              </div>
            )
          })}

          {result.warnings.map((w, i) => (
            <div key={i} style={{ background:'#fff3cd', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:'8px 12px', fontSize:12, color:'#856404', marginBottom:8 }}>{w}</div>
          ))}
        </div>

        {/* ── BREAKDOWN ─────────────────────────────────────────────────── */}
        {sp > 0 && (
          <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'12px 14px', marginBottom:16, fontSize:12 }}>
            <div style={{ fontWeight:700, marginBottom:8, fontSize:11, textTransform:'uppercase', letterSpacing:'0.06em', color:'var(--gw-mist)' }}>Commission Breakdown</div>
            {[
              { label:'Sale Price', val: sp, color:'var(--gw-ink)', whole:true },
              ...result.sides.flatMap(s => [
                { label:`${form.twoSided ? s.label + ' — ' : ''}Gross (${s.rate_pct}%)`, val: s.gross, color:'var(--gw-ink)' },
                s.referral > 0 && { label:`  Referral (${s.referral_pct}%)`, val:-s.referral, color:'var(--gw-red)' },
              ]),
              { label:'Net to Split', val: result.net_total, color:'var(--gw-ink)', rule:true },
              ...result.participants.map(p => ({
                label:`${p.name || 'Agent'}${p.no_split ? ' (100%)' : ` (${p.split_pct}%)`}`,
                val: p.agent_take, color:'var(--gw-green)',
              })),
              { label:'Brokerage / House', val: result.house_total, color:'var(--gw-azure)', bold:true },
              result.transaction_fee_total > 0 && { label:'  incl. transaction fee', val: result.transaction_fee_total, color:'var(--gw-mist)' },
            ].filter(Boolean).map((row, i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'3px 0', borderTop: row.bold || row.rule ? '1px solid var(--gw-border)' : 'none', marginTop: row.bold||row.rule ? 6 : 0, paddingTop: row.bold||row.rule ? 8 : 3, fontWeight: row.bold ? 700 : 400 }}>
                <span style={{ color:'var(--gw-mist)', whiteSpace:'pre' }}>{row.label}</span>
                <span style={{ color: row.color, fontWeight: row.bold ? 700 : 500 }}>{row.val < 0 ? `(${formatCurrencyExact(Math.abs(row.val))})` : (row.whole ? formatCurrency(row.val) : formatCurrencyExact(row.val))}</span>
              </div>
            ))}
          </div>
        )}

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

// ── Monthly Bar Chart ─────────────────────────────────────────────────────────
function MonthlyBarChart({ deals, calcFn }) {
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
                Agent: <strong>{formatCurrencyExact(tooltip.agentTotal)}</strong>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--gw-azure)', flexShrink: 0 }} />
                House: <strong>{formatCurrencyExact(tooltip.brokerTotal)}</strong>
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

// ── Res/Commercial breakdown card ────────────────────────────────────────────
function CategoryBreakdown({ closedDeals, calcFn }) {
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
          <span style={{ fontWeight: 700, color }}>{formatCurrencyExact(totals.agent)}</span>
        </div>
        <div style={{ height: 6, background: 'var(--gw-border)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(totals.agent / maxAgent * 100)}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 400ms ease' }} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--gw-mist)' }}>
        <span>Gross: <strong style={{ color: 'var(--gw-ink)' }}>{formatCurrencyExact(totals.gross)}</strong></span>
        <span>House: <strong style={{ color: 'var(--gw-ink)' }}>{formatCurrencyExact(totals.broker)}</strong></span>
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

// ── Main Page ─────────────────────────────────────────────────────────────────
// Back office (2026-06-12): admins get the full tracker + brokerage report +
// caps management; every other agent gets My Earnings — their own slice only.
export default function CommissionPage({ db, setDb, activeAgent, isAdmin, dealAgentIds }) {
  if (!isAdmin) return <MyEarnings activeAgent={activeAgent} />
  return <AdminBackOffice db={db} setDb={setDb} activeAgent={activeAgent} isAdmin={isAdmin} dealAgentIds={dealAgentIds} />
}

function AdminBackOffice({ db, setDb, activeAgent, isAdmin, dealAgentIds }) {
  const [boTab, setBoTab]             = useState('tracker')
  const [drawer, setDrawer]           = useState(false)
  const [selectedDeal, setSelectedDeal] = useState(null)
  const [filterStage, setFilterStage] = useState('all')
  const [filterAgent, setFilterAgent] = useState('')
  const [filterCategory, setFilterCategory] = useState('all')
  const [copied, setCopied]           = useState(false)
  const [celebration, setCelebration] = useState(false)
  const [prevCapHit, setPrevCapHit]   = useState(false)

  // Cap amount: database first (Agents & Caps tab), legacy localStorage fallback
  const capKey   = `gw_cap_${activeAgent?.id || 'default'}`
  const [capAmt, setCapAmt] = useState(() => Number(activeAgent?.cap_amount ?? localStorage.getItem(capKey) ?? 25000))

  const saveCapAmt = (val) => { setCapAmt(val); localStorage.setItem(capKey, String(val)) }

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

  // One agent's slice of a deal (their take + the house fees they generated),
  // summing every participant row that belongs to them. Used for per-agent
  // rollups and the cap tracker so co-agents are attributed correctly.
  const agentSlice = (deal, agentId) => {
    const r = breakdownForDeal(deal, getComm(deal.id), agents)
    const mine = r.participants.filter(p => p.agent_id === agentId)
    if (mine.length) {
      return {
        agent: mine.reduce((s,p)=>s+p.agent_take,0),
        house: mine.reduce((s,p)=>s+p.house_from,0),
        // Cap counts the brokerage SPLIT only — the flat transaction fee is on top.
        cap:   mine.reduce((s,p)=>s+(p.house_split||0),0),
      }
    }
    // No structured participant matched — fall back to deal.agent_id ownership.
    return deal.agent_id === agentId
      ? { agent: r.agent_total, house: r.house_total, cap: r.house_split_total }
      : { agent: 0, house: 0, cap: 0 }
  }

  // Scoped exactly like the initial App.jsx load — a non-admin's refresh must
  // not replace their scoped deals/commissions with firm-wide data.
  const reload = async () => {
    const dealsRes = await fetchVisibleDeals(supabase, {
      isAdmin, agentId: activeAgent?.id, dealAgentIds,
    })
    const commRes = await fetchVisibleCommissions(supabase, {
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
  const brokerageTotals = closedDeals.reduce((acc, d) => {
    const { gross, brokerAmt, agentAmt } = calc(d)
    acc.gross += gross; acc.broker += brokerAmt; acc.agent += agentAmt; return acc
  }, { gross:0, broker:0, agent:0 })

  // Per-agent breakdown (closed deals only) — attributes each participant's take
  // to their agent, so a co-agent on someone else's deal still gets credited.
  const agentBreakdown = agents.map(a => {
    const aDeals = closedDeals.filter(d => {
      const r = breakdownForDeal(d, getComm(d.id), agents)
      return d.agent_id === a.id || r.participants.some(p => p.agent_id === a.id)
    })
    const totals = aDeals.reduce((acc, d) => {
      const slice = agentSlice(d, a.id)
      acc.agent += slice.agent; acc.broker += slice.house; acc.deals++; return acc
    }, { agent:0, broker:0, gross:0, deals:0 })
    return { ...a, ...totals }
  }).filter(a => a.deals > 0).sort((a,b) => b.agent - a.agent)

  // Team total
  const teamTotal = agentBreakdown.reduce((s, a) => s + a.agent, 0)

  // Cap tracking — for the active agent's closed deals this year
  const thisYear = new Date().getFullYear()
  const activeAgentClosedDeals = closedDeals.filter(d => {
    if (new Date(d.updated_at || d.created_at).getFullYear() !== thisYear) return false
    const r = breakdownForDeal(d, getComm(d.id), agents)
    return d.agent_id === activeAgent?.id || r.participants.some(p => p.agent_id === activeAgent?.id)
  })
  const ytdBrokerFees  = activeAgentClosedDeals.reduce((s, d) => s + agentSlice(d, activeAgent?.id).cap, 0)
  const ytdAgentEarned = activeAgentClosedDeals.reduce((s, d) => s + agentSlice(d, activeAgent?.id).agent, 0)
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
  if (filterCategory === 'residential') filtered = filtered.filter(d => !d.prop_category || d.prop_category === 'residential')
  if (filterCategory === 'commercial')  filtered = filtered.filter(d => d.prop_category === 'commercial')

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
          <div className="page-title">Back Office</div>
          <div className="page-sub">{deals.length} deals · {formatCurrency(deals.reduce((s,d)=>s+(d.value||0),0))} total pipeline · commissions are entered here and stay private per agent</div>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <div style={{ display:'flex', background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:3, gap:2 }}>
            {[['tracker','Tracker'],['report','Brokerage Report'],['caps','Agents & Caps']].map(([id, label]) => (
              <button key={id} onClick={() => setBoTab(id)} style={{
                padding:'5px 14px', border:'none', borderRadius:'var(--radius)', cursor:'pointer',
                fontFamily:'var(--font-body)', fontSize:12, fontWeight:600,
                background: boTab === id ? 'var(--gw-slate)' : 'transparent',
                color: boTab === id ? '#fff' : 'var(--gw-mist)', transition:'all 150ms ease',
              }}>{label}</button>
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
          <div className="stat-card__value">{formatCurrencyExact(brokerageTotals.gross)}</div>
          <div className="stat-card__label">Total Gross Comm</div>
        </div>
        <div className="stat-card" style={{ borderLeft:'3px solid var(--gw-green)' }}>
          <div className="stat-card__value" style={{ color:'var(--gw-green)' }}>{formatCurrencyExact(brokerageTotals.agent)}</div>
          <div className="stat-card__label">Total Agent Earnings</div>
        </div>
        <div className="stat-card" style={{ borderLeft:'3px solid var(--gw-azure)' }}>
          <div className="stat-card__value" style={{ color:'var(--gw-azure)' }}>{formatCurrencyExact(brokerageTotals.broker)}</div>
          <div className="stat-card__label">Brokerage / House</div>
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
            {formatCurrencyExact(closedRes.reduce((s,d)=>s+calc(d).agentAmt,0))}
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
            {formatCurrencyExact(closedComm.reduce((s,d)=>s+calc(d).agentAmt,0))}
          </div>
          <div className="stat-card__label">Agent Earnings</div>
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
                  {thisYear} YTD · Broker fees paid: <strong>{formatCurrencyExact(ytdBrokerFees)}</strong> of <strong>{formatCurrency(capAmt)}</strong> cap
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
            <span>Agent kept YTD: <strong style={{ color:'var(--gw-green)' }}>{formatCurrencyExact(ytdAgentEarned)}</strong></span>
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

      {/* ── Residential vs Commercial Breakdown ── */}
      {closedDeals.length > 0 && <CategoryBreakdown closedDeals={closedDeals} calcFn={calc} />}

      {/* ── Monthly Bar Chart ── */}
      <MonthlyBarChart deals={deals} calcFn={calc} />

      {/* ── Team / Agent Breakdown ── */}
      {agentBreakdown.length > 1 && (
        <div className="card" style={{ marginBottom:20, padding:0, overflow:'hidden' }}>
          <div style={{ padding:'12px 18px', borderBottom:'1px solid var(--gw-border)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ fontWeight:600, fontSize:13 }}>Team Earnings (Closed)</div>
            <div style={{ fontSize:12, color:'var(--gw-green)', fontWeight:700 }}>Total: {formatCurrencyExact(teamTotal)}</div>
          </div>
          {agentBreakdown.map(a => (
            <div key={a.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 18px', borderBottom:'1px solid var(--gw-border)' }}>
              <Avatar agent={a} size={28} />
              <div style={{ flex:1 }}>
                <div style={{ fontWeight:600, fontSize:13 }}>{a.name}</div>
                <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{a.deals} closed deal{a.deals!==1?'s':''}</div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontWeight:700, color:'var(--gw-green)', fontSize:13 }}>{formatCurrencyExact(a.agent)}</div>
                <div style={{ fontSize:11, color:'var(--gw-mist)' }}>House: {formatCurrencyExact(a.broker)}</div>
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
                      <td>
                        {deal.prop_category === 'commercial'
                          ? <span style={{ fontSize:11, fontWeight:700, color:'var(--gw-azure)', background:'#eff6ff', padding:'2px 7px', borderRadius:8, whiteSpace:'nowrap' }}>🏢 Commercial</span>
                          : <span style={{ fontSize:11, fontWeight:700, color:'var(--gw-green)', background:'#f0fdf4', padding:'2px 7px', borderRadius:8, whiteSpace:'nowrap' }}>🏠 Residential</span>
                        }
                      </td>
                      <td><Badge variant={deal.stage==='under-contract'?'active':deal.stage}>{deal.stage.replace('-',' ')}</Badge></td>
                      <td style={{ textAlign:'right', fontWeight:600 }}>{sp>0?formatCurrency(sp):'—'}</td>
                      <td style={{ textAlign:'right', color:'var(--gw-mist)', fontSize:12 }}>{gross_pct}%</td>
                      <td style={{ textAlign:'right' }}>{sp>0?formatCurrencyExact(gross):'—'}</td>
                      <td style={{ textAlign:'right', color:'var(--gw-mist)', fontSize:12 }}>{agent_pct}%</td>
                      <td style={{ textAlign:'right', fontWeight:600, color:'var(--gw-green)' }}>{sp>0?formatCurrencyExact(agentAmt):'—'}</td>
                      <td style={{ textAlign:'right', color:'var(--gw-azure)' }}>{sp>0?formatCurrencyExact(brokerAmt):'—'}</td>
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
                  <td style={{ textAlign:'right', padding:'10px 12px', fontWeight:700 }}>{formatCurrencyExact(totals.gross)}</td>
                  <td></td>
                  <td style={{ textAlign:'right', padding:'10px 12px', fontWeight:700, color:'var(--gw-green)' }}>{formatCurrencyExact(totals.agent)}</td>
                  <td style={{ textAlign:'right', padding:'10px 12px', fontWeight:700, color:'var(--gw-azure)' }}>{formatCurrencyExact(totals.broker)}</td>
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

      {celebration && (
        <CapCelebration agentName={activeAgent?.name} onClose={()=>setCelebration(false)} />
      )}
    </div>
  )
}
