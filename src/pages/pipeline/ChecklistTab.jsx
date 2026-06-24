import React, { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, pushToast } from '../../components/UI.jsx'
import {
  STATE_DOC_TEMPLATES, DEFAULT_STEPS_RESIDENTIAL, DEFAULT_STEPS_COMMERCIAL,
  STATUS_BADGE_MAP, ACTION_BADGE_MAP,
} from './checklistConstants.js'

// Per-deal transaction checklist. Admins can add / check off / reload templates;
// agents see a read-only view (transaction_steps RLS enforces the same on the
// server — the UI just hides controls so it's not confusing).
export default function ChecklistTab({ deal, isAdmin = false }) {
  const [steps,      setSteps]      = useState([])
  const [loading,    setLoading]    = useState(true)
  const [newTitle,   setNewTitle]   = useState('')
  const [adding,     setAdding]     = useState(false)
  const [ready,      setReady]      = useState(true)
  const [dealState,  setDealState]  = useState('')
  const [txType,     setTxType]     = useState('')

  React.useEffect(() => {
    if (!deal?.id) return
    supabase.from('deals').select('comp_data').eq('id', deal.id).single()
      .then(({ data }) => {
        const cd = data?.comp_data || {}
        setDealState(cd.state || '')
        setTxType(cd.transaction_type || '')
      })
    loadSteps()
  }, [deal?.id])

  const loadSteps = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('transaction_steps').select('*').eq('deal_id', deal.id).order('sort_order', { ascending: true })
    if (error) { setReady(false); setLoading(false); return }
    setSteps(data || [])
    setLoading(false)
  }

  const saveMeta = async (stateVal, typeVal) => {
    const { data: cur } = await supabase.from('deals').select('comp_data').eq('id', deal.id).single()
    const cd = cur?.comp_data || {}
    await supabase.from('deals').update({ comp_data: { ...cd, state: stateVal, transaction_type: typeVal } }).eq('id', deal.id)
  }

  const getTemplate = (stateVal, typeVal) => {
    const key = `${stateVal}-${typeVal}`
    if (STATE_DOC_TEMPLATES[key]) return STATE_DOC_TEMPLATES[key]
    if (typeVal === 'commercial' && STATE_DOC_TEMPLATES['any-commercial']) return STATE_DOC_TEMPLATES['any-commercial']
    return (deal?.prop_category === 'commercial' ? DEFAULT_STEPS_COMMERCIAL : DEFAULT_STEPS_RESIDENTIAL)
      .map(title => ({ title, doc_action: 'manual' }))
  }

  const loadTemplate = async (stateVal, typeVal) => {
    if (!isAdmin) return
    if (!stateVal || !typeVal) return
    const template = getTemplate(stateVal, typeVal)
    const { error: delErr } = await supabase.from('transaction_steps').delete().eq('deal_id', deal.id)
    if (delErr) { pushToast(delErr.message, 'error'); return }
    const rows = template.map((doc, i) => ({
      deal_id: deal.id, title: doc.title, completed: false, sort_order: i,
      doc_action: doc.doc_action || 'manual', doc_status: 'pending',
      if_applicable: doc.if_applicable || false,
    }))
    const { data, error } = await supabase.from('transaction_steps').insert(rows).select()
    if (error) { pushToast(error.message, 'error'); return }
    setSteps(data || [])
    pushToast(`${stateVal !== 'other' ? stateVal + ' ' : ''}${typeVal} checklist loaded`, 'success')
  }

  const cycleStatus = async (step) => {
    if (!isAdmin) {
      pushToast('Only an admin can check off checklist items', 'info')
      return
    }
    const cur = step.doc_status || (step.completed ? 'complete' : 'pending')
    const next = { pending: 'complete', complete: 'approved', approved: 'na', na: 'pending' }[cur] || 'pending'
    const now  = new Date().toISOString()
    const patch = {
      doc_status:   next,
      completed:    next === 'complete' || next === 'approved',
      completed_at: (next === 'complete' || next === 'approved') ? now : null,
    }
    const { error } = await supabase.from('transaction_steps').update(patch).eq('id', step.id)
    if (error) { pushToast(error.message, 'error'); return }
    setSteps(p => p.map(s => s.id === step.id ? { ...s, ...patch } : s))
  }

  const addStep = async () => {
    if (!isAdmin) return
    if (!newTitle.trim()) return
    setAdding(true)
    const { data, error } = await supabase.from('transaction_steps').insert([{
      deal_id: deal.id, title: newTitle.trim(), completed: false, sort_order: steps.length,
      doc_action: 'manual', doc_status: 'pending', if_applicable: false,
    }]).select().single()
    setAdding(false)
    if (error) { pushToast(error.message, 'error'); return }
    setSteps(p => [...p, data])
    setNewTitle('')
  }

  const removeStep = async (id) => {
    if (!isAdmin) return
    const { error } = await supabase.from('transaction_steps').delete().eq('id', id)
    if (error) { pushToast(error.message, 'error'); return }
    setSteps(p => p.filter(s => s.id !== id))
  }

  if (!ready) return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--gw-mist)' }}>
      <Icon name="alert" size={20} style={{ marginBottom: 8 }} />
      <div style={{ fontSize: 13 }}>transaction_steps table not found.</div>
      <div style={{ fontSize: 12, marginTop: 4 }}>Run the SQL from the setup guide to enable checklists.</div>
    </div>
  )

  if (loading) return <div style={{ padding: 24, color: 'var(--gw-mist)', fontSize: 13 }}>Loading checklist…</div>

  const doneCount = steps.filter(s => s.doc_status === 'complete' || s.doc_status === 'approved' || (!s.doc_status && s.completed)).length
  const pct       = steps.length > 0 ? Math.round(doneCount / steps.length * 100) : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ── State + type selector ── */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--gw-border)', background: 'var(--gw-bone)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <select className="form-control" style={{ flex: 1, fontSize: 12 }}
            value={dealState}
            onChange={e => {
              const v = e.target.value
              setDealState(v); saveMeta(v, txType)
              if (v && txType && steps.length === 0) loadTemplate(v, txType)
            }}>
            <option value="">State…</option>
            <option value="IA">Iowa (IA)</option>
            <option value="SD">South Dakota (SD)</option>
            <option value="NE">Nebraska (NE)</option>
            <option value="other">Other</option>
          </select>
          <select className="form-control" style={{ flex: 1, fontSize: 12 }}
            value={txType}
            onChange={e => {
              const v = e.target.value
              setTxType(v); saveMeta(dealState, v)
              if (dealState && v && steps.length === 0) loadTemplate(dealState, v)
            }}>
            <option value="">Type…</option>
            <option value="seller">Seller (Listing)</option>
            <option value="buyer">Buyer (Purchase)</option>
            <option value="commercial">Commercial</option>
            <option value="lease">Lease / Rental</option>
          </select>
          {dealState && txType && isAdmin && (
            <button className="btn btn--primary btn--sm" style={{ whiteSpace: 'nowrap', fontSize: 11 }}
              onClick={() => loadTemplate(dealState, txType)}>
              {steps.length > 0 ? 'Reload' : 'Load'}
            </button>
          )}
        </div>
        {!isAdmin && (
          <div style={{ fontSize: 11, marginTop: 6, padding: '4px 8px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 4, color: '#9a3412' }}>
            Read-only — only your admin can check items off or modify this checklist.
          </div>
        )}
        {/* Active transaction-type banner — makes buyer vs seller unmistakable */}
        {dealState && txType && (
          <div style={{ fontSize: 11, marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 600, padding: '2px 8px', borderRadius: 10, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em',
              background: txType === 'seller' ? '#fff7ed' : txType === 'buyer' ? '#eff6ff' : 'var(--gw-bone)',
              color:      txType === 'seller' ? '#c2410c' : txType === 'buyer' ? '#1d4ed8' : 'var(--gw-mist)',
              border: `1px solid ${txType === 'seller' ? '#fed7aa' : txType === 'buyer' ? '#bfdbfe' : 'var(--gw-border)'}` }}>
              {txType === 'seller' ? 'Seller / Listing side' : txType === 'buyer' ? 'Buyer / Purchase side' : txType}
            </span>
            <span style={{ color: 'var(--gw-mist)' }}>{dealState !== 'other' ? dealState : 'Custom'} checklist</span>
          </div>
        )}
        {(!dealState || !txType) && (
          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 5, lineHeight: 1.4 }}>
            Select state &amp; transaction type — the correct <strong>buyer</strong> or <strong>seller</strong> document checklist loads automatically.
          </div>
        )}
      </div>

      <div style={{ padding: '12px 14px', overflowY: 'auto', flex: 1 }}>
        {/* Progress */}
        {steps.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 600, marginBottom: 5, color: 'var(--gw-mist)' }}>
              <span>{doneCount} of {steps.length} complete</span>
              <span style={{ color: pct === 100 ? 'var(--gw-green)' : 'var(--gw-mist)' }}>{pct}%</span>
            </div>
            <div style={{ height: 5, background: 'var(--gw-border)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? 'var(--gw-green)' : 'var(--gw-azure)', borderRadius: 3, transition: 'width 300ms' }} />
            </div>
          </div>
        )}

        {steps.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--gw-mist)', fontSize: 13, lineHeight: 1.6 }}>
            {dealState && txType
              ? <>Click <strong>Load</strong> above to populate the {dealState !== 'other' ? dealState + ' ' : ''}{txType} checklist.</>
              : <>Select state &amp; type above to load a checklist,<br />or add steps manually below.</>}
          </div>
        )}

        {/* Document rows */}
        {steps.map(step => {
          const status = step.doc_status || (step.completed ? 'complete' : 'pending')
          const action = step.doc_action  || 'manual'
          const isDone = status === 'complete' || status === 'approved'
          const statusBadge = STATUS_BADGE_MAP[status]
          const actionBadge = !statusBadge && action !== 'manual' ? ACTION_BADGE_MAP[action] : null

          return (
            <div key={step.id}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--gw-border)' }}>
              {/* Checkbox */}
              <div onClick={() => cycleStatus(step)}
                title={isAdmin ? 'Click to cycle status' : 'Admin only'}
                style={{ width: 18, height: 18, borderRadius: 3, flexShrink: 0, cursor: isAdmin ? 'pointer' : 'not-allowed', transition: 'all 140ms',
                border: `2px solid ${isDone ? 'var(--gw-green)' : 'var(--gw-border)'}`,
                background: isDone ? 'var(--gw-green)' : '#fff',
                opacity: isAdmin ? 1 : 0.7,
                display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {isDone && <Icon name="check" size={10} style={{ color: '#fff' }} />}
              </div>

              {/* Title */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12.5, color: isDone ? 'var(--gw-mist)' : 'var(--gw-ink)', textDecoration: isDone ? 'line-through' : 'none' }}>
                  {step.title}
                </span>
                {step.if_applicable && (
                  <span style={{ fontSize: 10, color: 'var(--gw-mist)', marginLeft: 5, fontStyle: 'italic' }}>
                    if applicable
                  </span>
                )}
              </div>

              {/* Status badge or action badge */}
              {statusBadge && (
                <span onClick={() => cycleStatus(step)} style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10, whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
                  background: statusBadge.bg, color: statusBadge.color, border: `1px solid ${statusBadge.border}` }}>
                  {statusBadge.label}
                </span>
              )}
              {actionBadge && (
                <span onClick={() => cycleStatus(step)} style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10, whiteSpace: 'nowrap', cursor: 'pointer', flexShrink: 0,
                  background: actionBadge.bg, color: actionBadge.color, border: `1px solid ${actionBadge.border}` }}>
                  {actionBadge.label}
                </span>
              )}

              {/* Remove (admin only) */}
              {isAdmin && (
                <button className="btn btn--ghost btn--icon" style={{ padding: 2, opacity: 0.3, flexShrink: 0 }}
                  onClick={e => { e.stopPropagation(); removeStep(step.id) }}>
                  <Icon name="x" size={10} />
                </button>
              )}
            </div>
          )
        })}

        {/* Add custom step — admin only */}
        {isAdmin && (
          <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            <input className="form-control" style={{ flex: 1, fontSize: 12 }}
              placeholder="Add a document or step…"
              value={newTitle} onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addStep()}
              disabled={adding} />
            <button className="btn btn--secondary btn--sm" onClick={addStep} disabled={adding || !newTitle.trim()}>Add</button>
          </div>
        )}
      </div>
    </div>
  )
}
