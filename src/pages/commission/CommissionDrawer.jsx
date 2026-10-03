// Edit one deal's commission: gross, sides, splits and participants.

import React, { useState } from 'react'
import { Icon, Drawer, pushToast } from '../../components/UI.jsx'
import { formatCurrency, formatMoney } from '../../lib/helpers.js'
import { insertCommission, updateCommission } from '../../lib/services/commissions.js'
import {
  computeCommission, normalizeCommission, agentArrangement, agentFee, hasContractFee, makeSide, makeParticipant, describeDealCommission, partyForSide, PARTY_LABELS,
} from '../../lib/commission.js'
import SideSplit from '../../components/SideSplit.jsx'
import { D_AGENT, D_BROKER } from './commissionDefaults.js'

// ── Commission Drawer (structured editor) ───────────────────────────────────
// Handles the simple case (one side, one agent at their default split) and the
// complex one (both sides represented, a referral on only one side, multiple
// agents each with their own brokerage arrangement) from the same form. The
// agent never has to do mental math — the live breakdown shows every dollar.
// The editor names a side by where its money comes from.
const sideTitle = (key) => (key === 'listing' ? 'Seller side (listing)' : key === 'buyer' ? 'Buyer side' : 'Sale')

export function CommissionDrawer({ open, onClose, deal, commission, agents = [], onSave }) {
  // Seed the form from the stored row (legacy or structured), normalized.
  const buildInitial = () => {
    const norm = normalizeCommission(commission, { deal, agents })
    // Two sides, or one side already placed as listing/buyer (a both-sides
    // deal with only one side entered so far) — either way, label the sides.
    const twoSided = norm.sides.length > 1 || norm.sides.some(s => s.key !== 'sale')
    return {
      sides: norm.sides.map(s => ({ ...s })),
      // Per-side pricing mode. Not persisted — it's derived from which field the
      // stored side actually uses, and drives `effectiveSides` below so the
      // inert field can never leak into the math or the saved row.
      sideModes: Object.fromEntries(norm.sides.map(s => [s.id, Number(s.flat || 0) > 0 ? 'flat' : 'percent'])),
      participants: norm.participants
        .filter(p => p._legacy_co_pct == null) // legacy co marker not editable directly
        .map(p => ({ ...p })),
      twoSided,
      // The deal-level fee only applies to agents without a contract fee (rows
      // saved before per-agent fees). A new deal's agents all bring their own,
      // so it starts at 0; existing rows keep whatever was saved.
      transaction_fee: commission?.id != null ? Number(norm.transaction_fee || 0) : 0,
      notes: commission?.notes ?? '',
    }
  }

  const [form, setForm] = useState(buildInitial)
  const [saving, setSaving] = useState(false)

  React.useEffect(() => { setForm(buildInitial()) /* eslint-disable-next-line */ }, [commission, open, deal?.id])

  const sp = deal?.value || 0

  // What the assigned agent entered on the deal's Details tab — shown as a
  // reference so the back office can see where a seeded number came from.
  const agentEntry = describeDealCommission(deal)

  // A side is priced EITHER by percentage OR by flat fee. Zero out whichever
  // field the current mode doesn't use, so a leftover value can't quietly drive
  // the math (the engine keys on `flat > 0`) or get written back on save.
  const effectiveSides = form.sides.map(s => (
    form.sideModes?.[s.id] === 'flat'
      ? { ...s, rate_pct: 0 }
      : { ...s, flat: 0 }
  ))

  // Live breakdown straight from the engine — identical math to the reports.
  // Each side carries the party its money comes from, so the live breakdown
  // splits by seller and buyer exactly as the reports will.
  const result = computeCommission({
    sale_price: sp,
    sides: effectiveSides.map(s => ({ ...s, party: partyForSide(s.key, deal) })),
    participants: form.participants,
    transaction_fee: form.transaction_fee,
  })

  // ── Side editing ────────────────────────────────────────────────────────
  const setSide = (id, patch) =>
    setForm(p => ({ ...p, sides: p.sides.map(s => s.id === id ? { ...s, ...patch } : s) }))

  const setSideMode = (id, mode) =>
    setForm(p => ({ ...p, sideModes: { ...(p.sideModes || {}), [id]: mode } }))

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

  // Agents on this deal paying the deal-level fee instead of their own.
  const legacyFeePayers = form.participants.filter(p => !hasContractFee(p)).length

  // ── Participant editing ─────────────────────────────────────────────────
  const setPart = (id, patch) =>
    setForm(p => ({ ...p, participants: p.participants.map(x => x.id === id ? { ...x, ...patch } : x) }))

  const pickAgent = (id, agentId) => {
    const a = agents.find(x => x.id === agentId)
    // The agent's own arrangement — their split, pre-paid, or a cap the office
    // has confirmed for this deal's date — so the common case is zero-typing.
    const { split_pct, no_split, basis } = agentArrangement(a, deal)
    setPart(id, { agent_id: agentId, name: a?.name || '', no_split, split_pct, basis, contract_fee: a ? agentFee(a) : null })
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
    // A confirmed cap is applied when the deal is READ, never saved into it:
    // store the agent's underlying split, so undoing the confirmation (or the
    // cap year resetting) puts this deal back on that split by itself.
    const participants = form.participants.map(p => {
      if (p.basis !== 'cap') return p
      const a = agents.find(x => x.id === p.agent_id)
      return { ...p, no_split: false, split_pct: Number(a?.default_split_pct ?? D_AGENT), basis: 'split' }
    })
    const payload = {
      deal_id: deal.id,
      sides: effectiveSides,
      participants,
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
    if (commission?.id) { ;({ error } = await updateCommission(commission.id, payload)) }
    else                { ;({ error } = await insertCommission(payload)) }
    setSaving(false)
    if (error) {
      // If the structured columns don't exist yet (migration 0005 not run), retry
      // with just the legacy columns so the agent isn't blocked.
      if (/sides|participants|column/i.test(error.message)) {
        const { sides, participants, ...legacy } = payload
        const retry = commission?.id
          ? await updateCommission(commission.id, legacy)
          : await insertCommission(legacy)
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
          {agentEntry && (
            <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:2 }}>
              Agent entered:{' '}
              <strong style={{ color:'var(--gw-ink)' }}>
                {agentEntry.type === 'flat' ? `${formatMoney(agentEntry.flat)} flat` : `${agentEntry.pct}%`}
              </strong>
              {agentEntry.gross > 0 && <> → {formatMoney(agentEntry.gross)} gross</>}
              {agentEntry.sides?.length > 0 && agentEntry.gross > 0 && (
                <SideSplit parts={agentEntry.sides.map(x => ({ party: x.party, amount: x.gross }))} />
              )}
            </div>
          )}
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
            const rs   = result.sides[i] || {}
            const flat = form.sideModes?.[s.id] === 'flat'
            return (
              <div key={s.id} style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:8 }}>
                {form.twoSided && <div style={{ fontSize:12, fontWeight:700, marginBottom:8 }}>{sideTitle(s.key)}</div>}

                {/* Percentage of the sale price, or a flat fee for this side. */}
                <div style={{ display:'flex', gap:0, border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden', marginBottom:10 }}>
                  {[['percent','Percentage'],['flat','Flat Fee']].map(([key, label]) => (
                    <button key={key} type="button" onClick={()=>setSideMode(s.id, key)}
                      style={{ flex:1, padding:'6px 0', border:'none', cursor:'pointer', fontFamily:'var(--font-body)', fontSize:11, fontWeight:600, transition:'all 150ms',
                        background: (key === 'flat') === flat ? 'var(--gw-slate)' : '#fff',
                        color:      (key === 'flat') === flat ? '#fff'            : 'var(--gw-mist)' }}>
                      {label}
                    </button>
                  ))}
                </div>

                <div className="form-row" style={{ display:'flex', gap:10 }}>
                  <div style={{ flex:1 }}>
                    {flat ? (
                      <>
                        <label style={fieldLabel}>Flat fee ($)</label>
                        <input className="form-control" type="number" min="0" step="0.01" value={s.flat ?? ''}
                          onChange={e=>setSide(s.id,{ flat:e.target.value })} placeholder="0" />
                      </>
                    ) : (
                      <>
                        <label style={fieldLabel}>Rate (%)</label>
                        <input className="form-control" type="number" min="0" max="100" step="0.1" value={s.rate_pct}
                          onChange={e=>setSide(s.id,{ rate_pct:e.target.value })} />
                      </>
                    )}
                  </div>
                  <div style={{ flex:1 }}>
                    <label style={fieldLabel}>Referral (% of this side)</label>
                    <input className="form-control" type="number" min="0" max="100" step="1" value={s.referral_pct}
                      onChange={e=>setSide(s.id,{ referral_pct:e.target.value })} placeholder="0" />
                  </div>
                </div>
                <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6 }}>
                  Gross {formatMoney(rs.gross || 0)}
                  {rs.referral > 0 && <> · referral ({formatMoney(rs.referral)}) → net {formatMoney(rs.net || 0)}</>}
                </div>
              </div>
            )
          })}
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, fontWeight:700, padding:'4px 2px' }}>
            <span style={{ color:'var(--gw-mist)' }}>Net commission to split</span>
            <span>{formatMoney(result.net_total)}</span>
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

          {/* Deal-level transaction fee — only for agents on this deal who don't
              carry a contract fee (rows saved before per-agent fees existed). */}
          {legacyFeePayers > 0 && (
          <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:8, display:'flex', alignItems:'center', gap:10 }}>
            <div style={{ flex:1 }}>
              <label style={fieldLabel}>Transaction fee ($)</label>
              <input className="form-control" type="number" min="0" step="0.01" value={form.transaction_fee}
                onChange={e=>setForm(p=>({ ...p, transaction_fee:e.target.value }))} placeholder="100" />
            </div>
            <div style={{ flex:1, fontSize:11, color:'var(--gw-mist)', alignSelf:'flex-end', paddingBottom:8 }}>
              Flat brokerage fee, charged on top of the split. Split evenly:
              <strong> {formatMoney((Number(form.transaction_fee)||0) / Math.max(1, legacyFeePayers))} </strong>
              per agent without a contract fee.
            </div>
          </div>
          )}

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
                    <label style={fieldLabel}>Transaction fee ($)</label>
                    <input className="form-control" type="number" min="0" step="0.01" value={p.fee || ''}
                      onChange={e=>setPart(p.id,{ fee:e.target.value })}
                      placeholder={Number(rp.fee || 0).toFixed(2)}
                      title={hasContractFee(p)
                        ? `Their $${Number(p.contract_fee)} contract fee on a ${Number(p.allocation_pct) || 0}% share. Type a figure to override it on this deal.`
                        : 'An even share of the deal-level fee. Type a figure to override it.'} />
                  </div>
                </div>

                {p.basis === 'cap' ? (
                  <div style={{ fontSize:12, margin:'10px 0 6px', padding:'6px 9px', borderRadius:'var(--radius)', background:'var(--gw-green-light)', color:'var(--gw-green)', fontWeight:600 }}>
                    Cap met — keeps 100% (confirmed by the office in Agents &amp; Caps)
                  </div>
                ) : (
                  <label style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, margin:'10px 0 6px', cursor:'pointer' }}>
                    <input type="checkbox" checked={!!p.no_split} onChange={e=>setPart(p.id,{ no_split:e.target.checked })} />
                    <span>Keeps 100% — no brokerage split (pre-paid / referred co-agent)</span>
                  </label>
                )}

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
                  <span style={{ fontWeight:700, color:'var(--gw-green)' }}>{formatMoney(rp.agent_take || 0)}</span>
                </div>
                {result.parties.length > 1 && (
                  <SideSplit align="right" parts={result.parties.map(pt => ({ party: pt.party, amount: rp.by_party?.[pt.party] || 0 }))} />
                )}
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
              { label:'Sale Price', val: sp, color:'var(--gw-ink)' },
              ...result.sides.flatMap(s => [
                { label:`${PARTY_LABELS[s.party] || 'Sale'} — gross (${Number(s.flat || 0) > 0 ? 'flat fee' : `${s.rate_pct}%`})`, val: s.gross, color:'var(--gw-ink)' },
                s.referral > 0 && { label:`  Referral (${s.referral_pct}%)`, val:-s.referral, color:'var(--gw-red)' },
              ]),
              { label:'Net to Split', val: result.net_total, color:'var(--gw-ink)', rule:true },
              ...result.participants.flatMap(p => [
                { label:`${p.name || 'Agent'}${p.no_split ? ' (100%)' : ` (${p.split_pct}%)`}`, val: p.agent_take, color:'var(--gw-green)' },
                ...(result.parties.length > 1
                  ? result.parties.map(pt => ({ label:`  from ${PARTY_LABELS[pt.party].toLowerCase()}`, val: p.by_party?.[pt.party] || 0, color:'var(--gw-mist)' }))
                  : []),
              ]),
              { label:'Brokerage / House', val: result.house_total, color:'var(--gw-azure)', bold:true },
              ...(result.parties.length > 1
                ? result.parties.map(pt => ({ label:`  from ${PARTY_LABELS[pt.party].toLowerCase()}`, val: pt.house, color:'var(--gw-mist)' }))
                : []),
              result.transaction_fee_total > 0 && { label:'  incl. transaction fee', val: result.transaction_fee_total, color:'var(--gw-mist)' },
            ].filter(Boolean).map((row, i) => (
              <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'3px 0', borderTop: row.bold || row.rule ? '1px solid var(--gw-border)' : 'none', marginTop: row.bold||row.rule ? 6 : 0, paddingTop: row.bold||row.rule ? 8 : 3, fontWeight: row.bold ? 700 : 400 }}>
                <span style={{ color:'var(--gw-mist)', whiteSpace:'pre' }}>{row.label}</span>
                <span style={{ color: row.color, fontWeight: row.bold ? 700 : 500 }}>{row.val < 0 ? `(${formatMoney(Math.abs(row.val))})` : formatMoney(row.val)}</span>
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
