// The commission inputs on the deal drawer's Details tab.

import React from 'react'
import { formatCurrency } from '../../lib/helpers.js'
import { describeDealCommission, dealRepresents, totalEntryForSides, agentSliceForDeal, PARTY_LABELS } from '../../lib/commission.js'

// ── Commission entry (deal Details tab) ──────────────────────────────────────
// The one commission number the ASSIGNED AGENT owns: what the client is being
// charged, priced either as a percentage of the deal value or as a flat fee.
// How that gross gets SPLIT (per-agent take-home, referrals, the brokerage's
// share) is back-office data in the admin-only `commissions` table and never
// appears here — this field is its input. `src/lib/commission.js` documents the
// precedence: an admin's explicit entry wins, then this, then the legacy scalar.
// One commission entry — percentage or flat fee — with its live dollar figure.
// The deal's single entry and each side of a both-sides deal are the same control.
function CommissionEntry({ title, type, pct, flat, dealValue, onChange }) {
  const preview = describeDealCommission({ value: dealValue, commission_type: type, commission_pct: pct, commission_flat: flat })
  const gross = preview?.gross || 0
  return (
    <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:10 }}>
      {title && <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginBottom:8 }}>{title}</div>}
      <div style={{ display:'flex', gap:0, border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden', marginBottom:10 }}>
        {[['percent','Percentage'],['flat','Flat Fee']].map(([key, label]) => (
          <button key={key} type="button" onClick={() => onChange({ type: key })}
            style={{ flex:1, padding:'7px 0', border:'none', cursor:'pointer', fontFamily:'var(--font-body)', fontSize:12, fontWeight:600, transition:'all 150ms',
              background: type === key ? 'var(--gw-slate)' : '#fff',
              color:      type === key ? '#fff'            : 'var(--gw-mist)' }}>
            {label}
          </button>
        ))}
      </div>
      {type === 'percent' ? (
        <input className="form-control" type="number" min="0" max="100" step="0.05" aria-label={`${title || 'Commission'} rate (%)`}
          value={pct ?? ''} onChange={e => onChange({ pct: e.target.value })} placeholder="Rate (%) — e.g. 3" />
      ) : (
        <input className="form-control" type="number" min="0" step="100" aria-label={`${title || 'Commission'} flat fee ($)`}
          value={flat ?? ''} onChange={e => onChange({ flat: e.target.value })} placeholder="Flat fee ($) — e.g. 12500" />
      )}
      <div style={{ fontSize:11.5, color:'var(--gw-mist)', marginTop:6 }}>
        {!preview
          ? <>Enter {type === 'flat' ? 'a flat fee' : 'a rate'} to see the dollar amount.</>
          : gross <= 0
            ? <>{preview.pct}% — add a Sale / Deal Value above to see the dollar amount.</>
            : <><strong style={{ color:'var(--gw-ink)' }}>{formatCurrency(gross)}</strong>
                {type === 'flat'
                  ? (Number(dealValue) > 0 ? <> · {(gross / Number(dealValue) * 100).toFixed(2)}% of {formatCurrency(dealValue)}</> : <> · flat fee</>)
                  : <> · {preview.pct}% of {formatCurrency(dealValue)}</>}</>}
      </div>
    </div>
  )
}

// What the deal's agent takes home from what was just typed: their share,
// their split with the office (or 100% once their cap is confirmed), and the
// transaction fee — the same engine My Earnings uses. An estimate, because the
// back office can still set a custom split on the deal.
function TakeHomeEstimate({ form, deal, agents, viewerId }) {
  if (!form.agent_id) return null
  // The saved deal's dates decide which split applies (a closed deal keeps the
  // split it closed on) — the form doesn't carry them.
  const draft = { ...form, id: deal?.id || 'draft', updated_at: deal?.updated_at, created_at: deal?.created_at }
  const slice = agentSliceForDeal(draft, null, agents || [], form.agent_id)
  if (!slice.onDeal || slice.gross <= 0) return null
  const who = form.agent_id === viewerId ? 'You take home' : `${(agents || []).find(a => a.id === form.agent_id)?.name?.split(' ')[0] || 'The agent'} takes home`
  const basis = slice.basis === 'cap' ? '100% — cap met' : slice.basis === 'prepaid' ? '100% — pre-paid' : `${slice.splitPct}% split`
  return (
    <div style={{ background:'var(--gw-green-light)', border:'1px solid #b8dccd', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:12, marginTop:10 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
        <span style={{ color:'var(--gw-green)', fontWeight:600 }}>{who}</span>
        <strong style={{ fontSize:15, color:'var(--gw-green)' }}>{formatCurrency(slice.take)}</strong>
      </div>
      <div style={{ color:'var(--gw-mist)', marginTop:3, lineHeight:1.5 }}>
        {formatCurrency(slice.allocation)} share · {basis}{slice.fees > 0 ? ` · − ${formatCurrency(slice.fees)} transaction fee` : ''}.
        {' '}Estimate — the office confirms the final split.
      </div>
    </div>
  )
}

// The deal's commission, by side. A deal representing ONE side has one entry,
// labeled with the side it comes from. A deal representing BOTH asks for each
// side separately (comp_data.commission_sides) and writes their total back to
// commission_type / commission_pct / commission_flat, so anything that reads
// only the total — agreement fields, older reports — still gets the real number.
export function CommissionFields({ form, deal, set, apply, agents, viewerId }) {
  const value = Number(form.value) || 0
  const represents = dealRepresents(form)

  if (represents !== 'both') {
    const type = form.commission_type === 'flat' ? 'flat' : 'percent'
    return (
      <div style={{ borderTop:'1px solid var(--gw-border)', paddingTop:14, marginTop:4 }}>
        <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:12 }}>
          Commission — {PARTY_LABELS[represents]}
        </div>
        <CommissionEntry
          type={type} pct={form.commission_pct} flat={form.commission_flat} dealValue={value}
          onChange={(patch) => {
            if (patch.type) set('commission_type', patch.type)
            if ('pct' in patch) set('commission_pct', patch.pct)
            if ('flat' in patch) set('commission_flat', patch.flat)
          }}
        />
        <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
          The total commission on your {represents} side.
        </div>
        <TakeHomeEstimate form={form} deal={deal} agents={agents} viewerId={viewerId} />
      </div>
    )
  }

  const stored = form.comp_data?.commission_sides || {}
  const sideOf = (party) => ({ type: 'percent', pct: '', flat: '', ...(stored[party] || {}) })
  const setSide = (party, patch) => {
    const next = { ...stored, [party]: { ...sideOf(party), ...patch } }
    apply({ comp_data: { commission_sides: next }, ...totalEntryForSides(next, value) })
  }
  const summary = describeDealCommission({ ...form, comp_data: { ...(form.comp_data || {}), commission_sides: stored } })
  const split = summary?.sides?.length && summary.sides[0].party !== 'unsplit'
  const legacyTotal = !split && summary && summary.gross > 0 ? summary : null

  return (
    <div style={{ borderTop:'1px solid var(--gw-border)', paddingTop:14, marginTop:4 }}>
      <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:6 }}>Commission — both sides</div>
      <div style={{ fontSize:12, color:'var(--gw-mist)', marginBottom:12, lineHeight:1.5 }}>
        You represent the buyer and the seller, so enter each side&rsquo;s commission — every total in the CRM shows how much came from each.
      </div>
      {legacyTotal && (
        <div style={{ background:'var(--gw-amber-light)', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:'8px 10px', fontSize:12, marginBottom:10, lineHeight:1.5 }}>
          Entered as one total so far ({formatCurrency(legacyTotal.gross)}). Fill in each side below to split it.
        </div>
      )}
      {['seller', 'buyer'].map(party => {
        const e = sideOf(party)
        return (
          <CommissionEntry key={party} title={PARTY_LABELS[party]} type={e.type === 'flat' ? 'flat' : 'percent'}
            pct={e.pct} flat={e.flat} dealValue={value} onChange={(patch) => setSide(party, patch)} />
        )
      })}
      {split && (
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:12 }}>
          <span style={{ color:'var(--gw-mist)' }}>Total commission</span>
          <strong style={{ fontSize:14 }}>{formatCurrency(summary.gross)}</strong>
        </div>
      )}
      <TakeHomeEstimate form={form} deal={deal} agents={agents} viewerId={viewerId} />
    </div>
  )
}
