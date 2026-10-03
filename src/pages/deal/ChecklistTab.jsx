// Deal drawer → Checklist tab: the transaction steps for this deal.

import React, { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { CHECKLIST_KINDS, checklistKindFor, checklistStateFor, checklistTemplate, checklistRows } from '../../lib/checklistTemplates.js'
import { OPERATING_STATES } from '../../lib/constants.js'
import { Icon, ConfirmDialog, pushToast } from '../../components/UI.jsx'
import { seedChecklist } from '../../lib/services/dealChecklist.js'

const STATUS_BADGE_MAP = {
  complete: { label: 'complete',            bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' },
  approved: { label: 'complete (approved)', bg: '#dcfce7', color: '#15803d', border: '#86efac' },
  na:       { label: 'N/A',                 bg: 'var(--gw-bone)', color: 'var(--gw-mist)', border: 'var(--gw-border)' },
}

const ACTION_BADGE_MAP = {
  upload: { label: 'Upload',    bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  forms:  { label: 'Use forms', bg: '#f5f3ff', color: '#6d28d9', border: '#ddd6fe' },
  sign:   { label: 'Sign',      bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
}

const kindLabel = (kind) => (CHECKLIST_KINDS.find(([id]) => id === kind)?.[1] || kind)

export function ChecklistTab({ deal, property }) {
  const [steps,      setSteps]      = useState([])
  const [loading,    setLoading]    = useState(true)
  const [newTitle,   setNewTitle]   = useState('')
  const [adding,     setAdding]     = useState(false)
  const [ready,      setReady]      = useState(true)
  const [dealState,  setDealState]  = useState('')
  const [kind,       setKind]       = useState('buyer')
  const [replaceAsk, setReplaceAsk] = useState(null)   // { state, kind, lost } awaiting confirmation
  const [replacing,  setReplacing]  = useState(false)

  // State and kind are READ from the deal (and its property), not asked for.
  // An empty checklist fills itself the first time the tab opens; the agent
  // only has to answer something the deal genuinely doesn't say — its state.
  React.useEffect(() => {
    if (!deal?.id) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const [{ data: fresh }, { data: rows, error }] = await Promise.all([
        supabase.from('deals').select('comp_data, prop_category').eq('id', deal.id).single(),
        supabase.from('transaction_steps').select('*').eq('deal_id', deal.id).order('sort_order', { ascending: true }),
      ])
      if (cancelled) return
      if (error) { setReady(false); setLoading(false); return }
      const current = { ...deal, ...(fresh || {}) }
      const st = checklistStateFor(current, property)
      const k  = checklistKindFor(current)
      setDealState(st)
      setKind(k)
      let list = rows || []
      if (!list.length && st) {
        const seeded = await seedChecklist(deal.id, st, k, current.prop_category)
        if (cancelled) return
        if (seeded?.length) list = seeded
      }
      setSteps(list)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [deal?.id])

  // comp_data is re-read before writing so this never overwrites a field
  // another tab changed while this one was open.
  const saveMeta = async (patch) => {
    const { data: cur } = await supabase.from('deals').select('comp_data').eq('id', deal.id).single()
    const { error } = await supabase.from('deals').update({ comp_data: { ...(cur?.comp_data || {}), ...patch } }).eq('id', deal.id)
    if (error) pushToast(`Could not save the checklist settings: ${error.message}`, 'error')
  }

  const isDoneStep = (s) => s.doc_status === 'complete' || s.doc_status === 'approved' || (!s.doc_status && s.completed)

  // Swap in the checklist for a state + kind. Steps that appear in both lists
  // keep their progress, so switching (or reloading) never un-ticks work that
  // still applies; anything completed that the new list drops is counted, and
  // the agent is asked first.
  const replaceChecklist = async (st, k) => {
    setReplacing(true)
    const done = new Map(steps.filter(isDoneStep).map(s => [s.title, s]))
    const rows = checklistRows(deal.id, checklistTemplate(st, k, deal?.prop_category)).map(r => {
      const prev = done.get(r.title)
      return prev ? { ...r, completed: true, doc_status: prev.doc_status || 'complete', completed_at: prev.completed_at || null } : r
    })
    const { error: delErr } = await supabase.from('transaction_steps').delete().eq('deal_id', deal.id)
    if (delErr) { setReplacing(false); pushToast(delErr.message, 'error'); return }
    const { data, error } = await supabase.from('transaction_steps').insert(rows).select()
    setReplacing(false)
    setReplaceAsk(null)
    if (error) { pushToast(error.message, 'error'); return }
    setSteps(data || [])
    pushToast(`${st} ${kindLabel(k).toLowerCase()} checklist loaded`, 'success')
  }

  // Ask before replacing only when completed work would be thrown away.
  const requestReplace = (st, k) => {
    if (!st) return
    const keep = new Set(checklistTemplate(st, k, deal?.prop_category).map(t => t.title))
    const lost = steps.filter(s => isDoneStep(s) && !keep.has(s.title)).length
    if (lost) setReplaceAsk({ state: st, kind: k, lost })
    else replaceChecklist(st, k)
  }

  const changeState = (v) => {
    setDealState(v)
    saveMeta({ state: v })
    if (v) steps.length ? requestReplace(v, kind) : replaceChecklist(v, kind)
  }

  // Its own field — comp_data.transaction_type is the deal's Representing
  // (buyer / seller / both) and is never written from here.
  const changeKind = (v) => {
    setKind(v)
    saveMeta({ checklist_type: v })
    if (dealState) steps.length ? requestReplace(dealState, v) : replaceChecklist(dealState, v)
  }

  const cycleStatus = async (step) => {
    const cur = step.doc_status || (step.completed ? 'complete' : 'pending')
    const next = { pending: 'complete', complete: 'approved', approved: 'na', na: 'pending' }[cur] || 'pending'
    const now  = new Date().toISOString()
    const patch = {
      doc_status:   next,
      completed:    next === 'complete' || next === 'approved',
      completed_at: (next === 'complete' || next === 'approved') ? now : null,
    }
    await supabase.from('transaction_steps').update(patch).eq('id', step.id)
    setSteps(p => p.map(s => s.id === step.id ? { ...s, ...patch } : s))
  }

  const addStep = async () => {
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
    await supabase.from('transaction_steps').delete().eq('id', id)
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
      {/* ── Which checklist this is ── */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--gw-border)', background: 'var(--gw-bone)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <select className="form-control" style={{ flex: 1, fontSize: 12 }} value={dealState} onChange={e => changeState(e.target.value)} aria-label="State">
            <option value="">State…</option>
            {OPERATING_STATES.map(s => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
            {dealState && !OPERATING_STATES.some(s => s.code === dealState) && <option value={dealState}>{dealState}</option>}
          </select>
          <select className="form-control" style={{ flex: 1, fontSize: 12 }} value={kind} onChange={e => changeKind(e.target.value)} aria-label="Checklist type">
            {CHECKLIST_KINDS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          {dealState && (
            <button className="btn btn--ghost btn--sm" style={{ whiteSpace: 'nowrap', fontSize: 11 }}
              onClick={() => requestReplace(dealState, kind)} disabled={replacing}
              title="Load the standard checklist. Steps you have completed that are still on it stay completed.">
              <Icon name="refresh" size={11}/> {steps.length ? 'Reset' : 'Load'}
            </button>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 6, lineHeight: 1.4 }}>
          {dealState
            ? <>Set from this deal. Change either one to switch checklists — completed steps carry over.</>
            : <>Pick the deal&rsquo;s state and its checklist fills in automatically.</>}
        </div>
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
            {dealState
              ? <>No steps yet — add them below, or press <strong>Load</strong> for the standard list.</>
              : <>Pick the state above to load this deal&rsquo;s checklist,<br />or add steps manually below.</>}
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
              <div onClick={() => cycleStatus(step)} style={{ width: 18, height: 18, borderRadius: 3, flexShrink: 0, cursor: 'pointer', transition: 'all 140ms',
                border: `2px solid ${isDone ? 'var(--gw-green)' : 'var(--gw-border)'}`,
                background: isDone ? 'var(--gw-green)' : '#fff',
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

              {/* Remove */}
              <button className="btn btn--ghost btn--icon" style={{ padding: 2, opacity: 0.3, flexShrink: 0 }}
                onClick={e => { e.stopPropagation(); removeStep(step.id) }}>
                <Icon name="x" size={10} />
              </button>
            </div>
          )
        })}

        {/* Add custom step */}
        <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
          <input className="form-control" style={{ flex: 1, fontSize: 12 }}
            placeholder="Add a document or step…"
            value={newTitle} onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addStep()}
            disabled={adding} />
          <button className="btn btn--secondary btn--sm" onClick={addStep} disabled={adding || !newTitle.trim()}>Add</button>
        </div>
      </div>

      {replaceAsk && (
        <ConfirmDialog
          eyebrow="Checklist"
          title={`Switch to the ${replaceAsk.state} ${kindLabel(replaceAsk.kind).toLowerCase()} checklist?`}
          confirmLabel="Switch checklist"
          busyLabel="Switching…"
          busy={replacing}
          onCancel={() => setReplaceAsk(null)}
          onConfirm={() => replaceChecklist(replaceAsk.state, replaceAsk.kind)}
          message={`${replaceAsk.lost} completed step${replaceAsk.lost === 1 ? ' is' : 's are'} not on the new list and will be removed. Steps that appear on both lists keep their progress.`}
        />
      )}
    </div>
  )
}
