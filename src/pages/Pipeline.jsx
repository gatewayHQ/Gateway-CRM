import React, { useState, useRef, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { fetchVisibleDeals } from '../lib/services/deals.js'
import { formatCurrency, formatDate, STAGE_LABELS, getKeyDateUrgency, getNearestKeyDate } from '../lib/helpers.js'
import { TRACKS, UNIFIED, boardStageFor, STAGE_AUTO_TASKS, isOpenStage } from '../lib/stages.js'
import {
  weightedValue, daysInStage, isRotting, dealActivityState, nextKeyDate,
  focusItems, pipelineTotals,
} from '../lib/pipeline.js'
import { isResidentialPropertyType } from '../lib/enums.js'
import { OPERATING_STATES } from '../lib/constants.js'
import { documentEmbedUrl, getDocStatus, downloadSigned as apiDownloadSigned, templateEmbedUrl, templateDetails, crmTokenValues, isFillableField, normalizeState } from '../lib/services/boldsign.js'
import BoldSignFrame from '../components/BoldSignFrame.jsx'
import { Icon, Badge, Avatar, Drawer, Modal, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'

const DEFAULT_STEPS_RESIDENTIAL = [
  'Title Search Ordered',
  'Earnest Money Deposited',
  'Home Inspection Scheduled',
  'Inspection Report Reviewed',
  'Appraisal Ordered',
  'Appraisal Report Received',
  'Financing Conditionally Approved',
  'Financing Fully Approved',
  'Final Walkthrough Scheduled',
  'Closing Disclosure Reviewed',
  'Closing Documents Signed',
  'Keys & Possession Transferred',
]

const DEFAULT_STEPS_COMMERCIAL = [
  'Title Search Ordered',
  'Earnest Money Deposited',
  'Environmental Due Diligence (Phase I)',
  'Property Inspection Ordered',
  'Inspection Report Reviewed',
  'Survey Ordered',
  'Survey Received & Approved',
  'Zoning & Entitlements Verified',
  'Financing Commitment Received',
  'Lease Review (if applicable)',
  'Closing Disclosure Reviewed',
  'Closing Documents Signed',
  'Keys & Possession Transferred',
]

const CHECKLIST_STAGES = ['under-contract','closed']

// Per-state, per-transaction-type document checklists (BoldTrail-style)
const STATE_DOC_TEMPLATES = {
  'SD-seller': [
    { title: 'Submit Listing into MLS',                                                             doc_action: 'manual' },
    { title: 'All SD Agency & Listing Paperwork',                                                   doc_action: 'manual' },
    { title: 'Install Yard Sign',                                                                   doc_action: 'manual' },
    { title: 'Lockbox Authorization/Put on Property',                                               doc_action: 'manual' },
    { title: 'MLS Change Form',                                                                     doc_action: 'manual' },
    { title: 'Addendum to SPD',                                                                     doc_action: 'manual' },
    { title: "Seller's Property Disclosure",                                                        doc_action: 'manual' },
    { title: 'Lead-Based Paint/Radon Pamphlets Given',                                              doc_action: 'manual' },
    { title: 'Completed Purchase Agreement',                                                        doc_action: 'forms'  },
    { title: 'Earnest Money Deposit Receipt',                                                       doc_action: 'upload' },
    { title: "HOA Info/Disclosures sent to Buyer's Agent",                                          doc_action: 'manual' },
    { title: 'Termite Inspection Scheduled',                                                        doc_action: 'manual' },
    { title: 'Appraisal Scheduled',                                                                 doc_action: 'manual' },
    { title: 'Abstract dropped off at closing/abstract company',                                    doc_action: 'manual' },
    { title: 'Escrow Sheet',                                                                        doc_action: 'forms'  },
    { title: 'Closing Disclosure/Settlement Statement — Admin Only',                                doc_action: 'upload', admin_only: true },
    { title: 'Commission — Proof of Payment — Admin Only',                                          doc_action: 'upload', admin_only: true },
    { title: 'Retrieve Yard Sign',                                                                  doc_action: 'manual' },
    { title: 'Retrieve and Unassign Lockbox',                                                       doc_action: 'manual' },
    { title: 'Update Listing Site',                                                                 doc_action: 'manual' },
    { title: 'Inspection Addendums Submitted if any',                                               doc_action: 'upload', if_applicable: true },
    { title: 'Order Home Warranty if applicable',                                                   doc_action: 'forms',  if_applicable: true },
    { title: 'Addendums to Contract if applicable',                                                 doc_action: 'forms',  if_applicable: true },
    { title: 'MLS Listing Change Form if applicable',                                               doc_action: 'forms',  if_applicable: true },
  ],
  'SD-commercial': [
    { title: 'All SD Agency/Listing Paperwork',                                                     doc_action: 'manual' },
    { title: "Seller's Property & Lead Based Paint Disclosure",                                     doc_action: 'forms'  },
    { title: 'Lead-Based Paint/Radon Pamphlets Given',                                              doc_action: 'manual' },
    { title: 'Put onto listing site if applicable',                                                 doc_action: 'manual', if_applicable: true },
    { title: 'Install Sign if applicable',                                                          doc_action: 'manual', if_applicable: true },
    { title: 'Lockbox Authorization/Put on Property',                                               doc_action: 'manual' },
    { title: 'Completed Purchase Agreement',                                                        doc_action: 'forms'  },
    { title: 'Earnest Money Deposit Receipt',                                                       doc_action: 'upload' },
    { title: 'Escrow Sheet',                                                                        doc_action: 'forms'  },
    { title: 'Inspection Addendums Submitted if any',                                               doc_action: 'upload', if_applicable: true },
    { title: 'Closing Disclosure/Settlement Statement — Admin Only',                                doc_action: 'upload', admin_only: true },
    { title: 'Commission — Proof of Payment — Admin Only',                                          doc_action: 'upload', admin_only: true },
    { title: 'Retrieve and Unassign Lockbox',                                                       doc_action: 'manual' },
    { title: 'Remove Sign if applicable',                                                           doc_action: 'manual', if_applicable: true },
    { title: 'Update listing site if applicable',                                                   doc_action: 'manual', if_applicable: true },
    { title: 'Leases/expenses/rent/deposit prorations submitted to closing company if applicable',  doc_action: 'manual', if_applicable: true },
    { title: 'Any Addendums to Contract if applicable',                                             doc_action: 'manual', if_applicable: true },
  ],
  'SD-buyer': [
    { title: 'Buyer Representation Agreement',             doc_action: 'manual' },
    { title: 'Agency Disclosure',                          doc_action: 'manual' },
    { title: 'Purchase Agreement',                         doc_action: 'forms'  },
    { title: 'Lead-Based Paint Disclosure',                doc_action: 'manual', if_applicable: true },
    { title: 'Earnest Money Deposit Receipt',              doc_action: 'upload' },
    { title: 'Pre-Approval Letter',                        doc_action: 'upload' },
    { title: 'Home Inspection Report',                     doc_action: 'upload' },
    { title: 'Inspection Addendum / Response',             doc_action: 'forms',  if_applicable: true },
    { title: 'Financing Commitment Letter',                doc_action: 'upload' },
    { title: 'Appraisal Report',                           doc_action: 'upload', if_applicable: true },
    { title: 'Final Walkthrough Completed',                doc_action: 'manual' },
    { title: 'Closing Disclosure Reviewed',                doc_action: 'manual' },
    { title: 'Commission — Proof of Payment — Admin Only', doc_action: 'upload', admin_only: true },
    { title: 'Addendums to Contract if applicable',        doc_action: 'forms',  if_applicable: true },
  ],
  'IA-seller': [
    { title: 'All Iowa Agency & Listing Paperwork',                                                 doc_action: 'manual' },
    { title: 'Seller & Lead Based Paint Disclosure',                                                doc_action: 'forms'  },
    { title: 'Iowa Radon & Lead-Based Paint Pamphlets Given',                                       doc_action: 'manual' },
    { title: 'Submit Listing into MLS',                                                             doc_action: 'manual' },
    { title: 'Install yard sign if applicable',                                                     doc_action: 'manual', if_applicable: true },
    { title: 'Lockbox Authorization/Put on Property',                                               doc_action: 'manual' },
    { title: 'Termite Inspection Scheduled',                                                        doc_action: 'manual' },
    { title: 'Appraisal Scheduled',                                                                 doc_action: 'manual' },
    { title: 'Earnest Money Deposit Receipt',                                                       doc_action: 'upload' },
    { title: 'Abstract Dropped off at Closing Company/Abstract Company',                            doc_action: 'manual' },
    { title: 'Escrow Sheet',                                                                        doc_action: 'forms'  },
    { title: 'Closing Disclosure/Settlement Statement — Admin Only',                                doc_action: 'upload', admin_only: true },
    { title: 'Commission — Proof of Payment — Admin Only',                                          doc_action: 'upload', admin_only: true },
    { title: 'Update MLS',                                                                          doc_action: 'manual' },
    { title: 'Retrieve yard sign if applicable',                                                    doc_action: 'manual', if_applicable: true },
    { title: 'Retrieve lockbox & unassign property',                                                doc_action: 'manual' },
    { title: 'MLS Listing Change Form if applicable',                                               doc_action: 'forms',  if_applicable: true },
    { title: 'Any Addendums to Contract if applicable',                                             doc_action: 'upload', if_applicable: true },
    { title: 'Order Home Warranty if applicable',                                                   doc_action: 'forms',  if_applicable: true },
    { title: 'Inspection Addendums Submitted if any',                                               doc_action: 'upload', if_applicable: true },
  ],
  'IA-commercial': [
    { title: 'All IA Agency/Listing Paperwork',                                                     doc_action: 'manual' },
    { title: 'Put onto Listing site if applicable',                                                 doc_action: 'manual', if_applicable: true },
    { title: 'Install sign if applicable',                                                          doc_action: 'manual', if_applicable: true },
    { title: 'Lockbox Authorization/Put on property',                                               doc_action: 'manual' },
    { title: 'Purchase Agreement',                                                                  doc_action: 'forms'  },
    { title: 'Inspection Scheduled',                                                                doc_action: 'manual' },
    { title: 'Leases/expenses/rent/deposit prorations submitted to closing company if applicable',  doc_action: 'manual', if_applicable: true },
    { title: 'Escrow Sheet',                                                                        doc_action: 'forms'  },
    { title: 'Earnest Money Deposit Receipt',                                                       doc_action: 'upload' },
    { title: 'Closing Disclosure/Settlement Statement — Admin Only',                                doc_action: 'upload', admin_only: true },
    { title: 'Commission — Proof of Payment — Admin Only',                                          doc_action: 'upload', admin_only: true },
    { title: 'Update Listing site if applicable',                                                   doc_action: 'manual', if_applicable: true },
    { title: 'Retrieve lockbox/unassign from property',                                             doc_action: 'manual' },
    { title: 'Retrieve Sign if applicable',                                                         doc_action: 'manual', if_applicable: true },
    { title: 'Any Addendums to Contract if applicable',                                             doc_action: 'upload', if_applicable: true },
    { title: 'MLS Listing Change Form if applicable',                                               doc_action: 'forms',  if_applicable: true },
  ],
  'IA-buyer': [
    { title: 'Buyer Agency Agreement',                     doc_action: 'manual' },
    { title: 'Agency Disclosure',                          doc_action: 'manual' },
    { title: 'Purchase Agreement',                         doc_action: 'forms'  },
    { title: 'Earnest Money Deposit Receipt',              doc_action: 'upload' },
    { title: 'Pre-Approval Letter',                        doc_action: 'upload' },
    { title: 'Home Inspection Report',                     doc_action: 'upload' },
    { title: 'Inspection Addendum / Response',             doc_action: 'forms',  if_applicable: true },
    { title: 'Financing Commitment Letter',                doc_action: 'upload' },
    { title: 'Appraisal Report',                           doc_action: 'upload', if_applicable: true },
    { title: 'Final Walkthrough Completed',                doc_action: 'manual' },
    { title: 'Closing Disclosure Reviewed',                doc_action: 'manual' },
    { title: 'Commission — Proof of Payment — Admin Only', doc_action: 'upload', admin_only: true },
    { title: 'Addendums to Contract if applicable',        doc_action: 'forms',  if_applicable: true },
  ],
  'NE-seller': [
    { title: 'All NE Agency & Listing Paperwork',          doc_action: 'manual' },
    { title: 'NE Seller Property Condition Disclosure',    doc_action: 'manual' },
    { title: 'MLS Change Form',                            doc_action: 'manual' },
    { title: 'Lead-Based Paint Disclosure',                doc_action: 'manual', if_applicable: true },
    { title: 'Completed Purchase Agreement',               doc_action: 'forms'  },
    { title: 'Earnest Money Deposit Receipt',              doc_action: 'upload' },
    { title: 'Title Insurance Ordered',                    doc_action: 'manual' },
    { title: 'Escrow / Settlement Sheet',                  doc_action: 'forms'  },
    { title: 'Closing Disclosure/Settlement Statement — Admin Only', doc_action: 'upload', admin_only: true },
    { title: 'Commission — Proof of Payment — Admin Only', doc_action: 'upload', admin_only: true },
    { title: 'Inspection Addendums Submitted if any',      doc_action: 'upload', if_applicable: true },
    { title: 'Home Warranty Order if applicable',          doc_action: 'forms',  if_applicable: true },
    { title: 'Addendums to Contract if applicable',        doc_action: 'forms',  if_applicable: true },
    { title: 'MLS Listing Change Form if applicable',      doc_action: 'forms',  if_applicable: true },
  ],
  'NE-buyer': [
    { title: 'Buyer Representation Agreement',             doc_action: 'manual' },
    { title: 'Agency Disclosure',                          doc_action: 'manual' },
    { title: 'Purchase Agreement',                         doc_action: 'forms'  },
    { title: 'Lead-Based Paint Disclosure',                doc_action: 'manual', if_applicable: true },
    { title: 'Earnest Money Deposit Receipt',              doc_action: 'upload' },
    { title: 'Pre-Approval Letter',                        doc_action: 'upload' },
    { title: 'Home Inspection Report',                     doc_action: 'upload' },
    { title: 'Inspection Addendum / Response',             doc_action: 'forms',  if_applicable: true },
    { title: 'Financing Commitment Letter',                doc_action: 'upload' },
    { title: 'Title Commitment Received',                  doc_action: 'manual' },
    { title: 'Appraisal Report',                           doc_action: 'upload', if_applicable: true },
    { title: 'Final Walkthrough Completed',                doc_action: 'manual' },
    { title: 'Closing Disclosure Reviewed',                doc_action: 'manual' },
    { title: 'Commission — Proof of Payment — Admin Only', doc_action: 'upload', admin_only: true },
    { title: 'Addendums to Contract if applicable',        doc_action: 'forms',  if_applicable: true },
  ],
}

const DEFAULT_KEY_DATE_TYPES = ['Closing','Financing Contingency','Inspection','HUD Approval','Appraisal','Lease Start Date','Possession Date']

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

function ChecklistTab({ deal }) {
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
    if (!stateVal || !typeVal) return
    const template = getTemplate(stateVal, typeVal)
    await supabase.from('transaction_steps').delete().eq('deal_id', deal.id)
    const rows = template.map((doc, i) => ({
      deal_id: deal.id, title: doc.title, completed: false, sort_order: i,
      doc_action: doc.doc_action || 'manual', doc_status: 'pending',
      if_applicable: doc.if_applicable || false,
    }))
    const { data } = await supabase.from('transaction_steps').insert(rows).select()
    setSteps(data || [])
    pushToast(`${stateVal !== 'other' ? stateVal + ' ' : ''}${typeVal} checklist loaded`, 'success')
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
            {OPERATING_STATES.map(s => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
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
          {dealState && txType && (
            <button className="btn btn--primary btn--sm" style={{ whiteSpace: 'nowrap', fontSize: 11 }}
              onClick={() => loadTemplate(dealState, txType)}>
              {steps.length > 0 ? 'Reload' : 'Load'}
            </button>
          )}
        </div>
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
    </div>
  )
}

// Urgency: returns 'urgent' (≤1d), 'warning' (2-3d), 'ok' (4-7d), null (>7d or past)
function dateUrgency(dateStr) {
  if (!dateStr) return null
  const days = Math.ceil((new Date(dateStr + 'T00:00:00') - new Date().setHours(0,0,0,0)) / 86400000)
  if (days < 0) return null
  if (days <= 1) return 'urgent'
  if (days <= 3) return 'warning'
  if (days <= 7) return 'ok'
  return null
}

const URGENCY_COLORS = { urgent: 'var(--gw-red)', warning: 'var(--gw-amber)', ok: 'var(--gw-green)' }

function KeyDatesTab({ deal }) {
  const [dates, setDates]         = useState([])
  const [saving, setSaving]       = useState(false)
  const [newType, setNewType]     = useState('')
  const [customType, setCustomType] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const [sentReminders, setSentReminders] = useState([])   // [{date_type, threshold}]
  const [testSending, setTestSending]     = useState(false)

  React.useEffect(() => {
    if (!deal?.id) return
    // Always fetch fresh from DB so custom dates survive tab switches
    supabase.from('deals').select('comp_data').eq('id', deal.id).single()
      .then(({ data }) => {
        const existing = data?.comp_data?.key_dates
        if (existing && existing.length > 0) {
          setDates(existing)
        } else {
          setDates(DEFAULT_KEY_DATE_TYPES.map(type => ({ type, date: '' })))
        }
      })
    // Load sent reminders for this deal
    supabase.from('deadline_reminders').select('date_type, threshold').eq('deal_id', deal.id)
      .then(({ data }) => setSentReminders(data || []))
  }, [deal?.id])

  const sendTestReminder = async () => {
    setTestSending(true)
    try {
      const resp = await fetch('/api/cron?task=reminders&secret=' + encodeURIComponent(window.__gwCronSecret || ''))
      const data = await resp.json()
      pushToast(`Test run: ${data.sent || 0} sent, ${data.skipped || 0} skipped`)
      // Refresh sent status
      const { data: fresh } = await supabase.from('deadline_reminders').select('date_type, threshold').eq('deal_id', deal.id)
      setSentReminders(fresh || [])
    } catch (e) {
      pushToast('Could not run reminders: ' + e.message, 'error')
    } finally {
      setTestSending(false)
    }
  }

  const persist = async (updated) => {
    setSaving(true)
    const comp_data = { ...(deal.comp_data || {}), key_dates: updated }
    await supabase.from('deals').update({ comp_data, updated_at: new Date().toISOString() }).eq('id', deal.id)
    setSaving(false)
  }

  const updateDate = (i, date) => {
    const updated = dates.map((d, idx) => idx === i ? { ...d, date } : d)
    setDates(updated)
    persist(updated)
  }

  const addRow = (type) => {
    const t = type.trim()
    if (!t || dates.some(d => d.type.toLowerCase() === t.toLowerCase())) return
    const updated = [...dates, { type: t, date: '' }]
    setDates(updated)
    persist(updated)
    setNewType(''); setCustomType(''); setShowCustom(false)
  }

  const removeRow = (i) => {
    const updated = dates.filter((_, idx) => idx !== i)
    setDates(updated)
    persist(updated)
  }

  const usedTypes = new Set(dates.map(d => d.type))
  const availableTypes = DEFAULT_KEY_DATE_TYPES.filter(t => !usedTypes.has(t))

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>{saving ? 'Saving…' : 'Changes auto-saved'}</div>
        <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={sendTestReminder} disabled={testSending}>
          <Icon name="send" size={11} /> {testSending ? 'Checking…' : 'Run Reminders'}
        </button>
      </div>

      {dates.map((row, i) => {
        const urgency = dateUrgency(row.date)
        const thresholdsSent = sentReminders.filter(r => r.date_type === row.type).map(r => r.threshold)
        return (
          <div key={row.type} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {urgency && <div style={{ width: 6, height: 6, borderRadius: '50%', background: URGENCY_COLORS[urgency], flexShrink: 0 }} />}
              {!urgency && <div style={{ width: 6, flexShrink: 0 }} />}
              <div style={{ flex: '0 0 148px', fontSize: 13, fontWeight: 600, color: urgency ? URGENCY_COLORS[urgency] : 'var(--gw-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {row.type}
              </div>
              <input
                type="date"
                className="form-control"
                style={{ flex: 1, fontSize: 13 }}
                value={row.date || ''}
                onChange={e => updateDate(i, e.target.value)}
              />
              <button className="btn btn--ghost btn--icon btn--sm" title="Remove" onClick={() => removeRow(i)} style={{ opacity: 0.5 }}>
                <Icon name="x" size={12} />
              </button>
            </div>
            {thresholdsSent.length > 0 && (
              <div style={{ marginLeft: 22, marginTop: 3, display: 'flex', gap: 4 }}>
                {thresholdsSent.map(t => (
                  <span key={t} style={{ fontSize: 9, fontWeight: 700, background: 'var(--gw-green-light)', color: 'var(--gw-green)', padding: '1px 6px', borderRadius: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {t} ✓
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Add date row */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--gw-border)', paddingTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--gw-mist)', marginBottom: 8 }}>Add Date</div>
        {!showCustom ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {availableTypes.map(t => (
              <button key={t} className="btn btn--secondary btn--sm" style={{ fontSize: 11 }} onClick={() => addRow(t)}>
                + {t}
              </button>
            ))}
            <button className="btn btn--secondary btn--sm" style={{ fontSize: 11 }} onClick={() => setShowCustom(true)}>
              + Custom…
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="form-control"
              style={{ flex: 1, fontSize: 13 }}
              placeholder="Date type name…"
              value={customType}
              onChange={e => setCustomType(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addRow(customType)}
              autoFocus
            />
            <button className="btn btn--primary btn--sm" onClick={() => addRow(customType)} disabled={!customType.trim()}>Add</button>
            <button className="btn btn--secondary btn--sm" onClick={() => { setShowCustom(false); setCustomType('') }}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  )
}

const BUCKET = 'deal-documents'

function formatBytes(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const FORM_PACKET_BUCKET = 'form-packets'
const TX_TYPE_LABELS = { buyer: 'Buyer Contract', seller: 'Listing / Seller', lease: 'Lease / Rental', general: 'General / Other' }

function RequiredFormsPanel() {
  const [open, setOpen]           = React.useState(false)
  const [state, setState]         = React.useState('')
  const [txType, setTxType]       = React.useState('buyer')
  const [packets, setPackets]     = React.useState([])
  const [searching, setSearching] = React.useState(false)
  const [downloading, setDownloading] = React.useState({})

  const search = async () => {
    if (!state.trim()) { pushToast('Enter a state abbreviation', 'error'); return }
    setSearching(true)
    const { data } = await supabase.from('form_packets').select('*')
      .eq('state', state.trim().toUpperCase()).eq('transaction_type', txType)
    setPackets(data || [])
    setSearching(false)
  }

  const downloadPacket = async (packet) => {
    if (!packet.storage_path) { pushToast('No file uploaded for this packet yet', 'error'); return }
    setDownloading(p => ({ ...p, [packet.id]: true }))
    const { data, error } = await supabase.storage.from(FORM_PACKET_BUCKET).createSignedUrl(packet.storage_path, 300)
    setDownloading(p => ({ ...p, [packet.id]: false }))
    if (error) { pushToast(error.message, 'error'); return }
    window.open(data.signedUrl, '_blank')
  }

  return (
    <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', marginBottom: 14, background: '#fff', overflow: 'hidden' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', cursor: 'pointer', background: open ? 'var(--gw-bone)' : '#fff' }}
        onClick={() => setOpen(o => !o)}
      >
        <Icon name="document" size={15} style={{ color: 'var(--gw-azure)', flexShrink: 0 }} />
        <div style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>Required Forms</div>
        <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>Get state-specific form packets</div>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} style={{ color: 'var(--gw-mist)' }} />
      </div>
      {open && (
        <div style={{ borderTop: '1px solid var(--gw-border)', padding: '12px 12px 14px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <input
              className="form-control"
              style={{ width: 70, fontSize: 13, textTransform: 'uppercase' }}
              placeholder="State"
              maxLength={2}
              value={state}
              onChange={e => setState(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && search()}
            />
            <select className="form-control" style={{ fontSize: 13, flex: 1, minWidth: 140 }} value={txType} onChange={e => setTxType(e.target.value)}>
              {Object.entries(TX_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button className="btn btn--primary btn--sm" onClick={search} disabled={searching}>
              {searching ? 'Searching…' : 'Find Forms'}
            </button>
          </div>
          {packets.length === 0 && !searching && state && (
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', padding: '6px 0' }}>No packets found for {state} / {TX_TYPE_LABELS[txType]}. Ask your admin to upload one in the Form Library.</div>
          )}
          {packets.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--gw-bone)', borderRadius: 'var(--radius)', marginBottom: 6 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{p.name}</div>
                {p.description && <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2 }}>{p.description}</div>}
              </div>
              <button className="btn btn--primary btn--sm" onClick={() => downloadPacket(p)} disabled={!p.storage_path || downloading[p.id]}>
                <Icon name="download" size={12} /> {downloading[p.id] ? 'Opening…' : 'Get Forms'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DocumentsTab({ deal }) {
  const [files, setFiles]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [uploading, setUploading] = useState(false)
  const [bucketReady, setBucketReady] = useState(true)
  const [dragOver, setDragOver]   = useState(false)
  const [sharedDocs, setSharedDocs] = useState([])   // filenames shared to the client portal
  const fileRef                   = React.useRef()

  React.useEffect(() => {
    if (!deal?.id) return
    loadFiles()
    // Load which docs are shared with the client portal (fresh from DB)
    supabase.from('deals').select('comp_data').eq('id', deal.id).single()
      .then(({ data }) => setSharedDocs(Array.isArray(data?.comp_data?.portal_docs) ? data.comp_data.portal_docs : []))
  }, [deal?.id])

  const toggleShare = async (fileName) => {
    const next = sharedDocs.includes(fileName)
      ? sharedDocs.filter(n => n !== fileName)
      : [...sharedDocs, fileName]
    setSharedDocs(next)
    // Re-fetch comp_data so we don't clobber concurrent edits (key dates, etc.)
    const { data } = await supabase.from('deals').select('comp_data').eq('id', deal.id).single()
    const comp_data = { ...(data?.comp_data || {}), portal_docs: next }
    const { error } = await supabase.from('deals').update({ comp_data }).eq('id', deal.id)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(next.includes(fileName) ? 'Shared with client' : 'Removed from client portal', 'info')
  }

  const loadFiles = async () => {
    setLoading(true)
    const { data, error } = await supabase.storage.from(BUCKET).list(`deal-${deal.id}`, { sortBy: { column: 'created_at', order: 'desc' } })
    if (error?.message?.includes('not found') || error?.message?.includes('does not exist')) {
      setBucketReady(false); setLoading(false); return
    }
    setFiles((data || []).filter(f => f.name !== '.emptyFolderPlaceholder'))
    setLoading(false)
  }

  const upload = async (file) => {
    if (!file) return
    if (file.size > 50 * 1024 * 1024) { pushToast('File must be under 50 MB', 'error'); return }
    setUploading(true)
    const path = `deal-${deal.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false })
    setUploading(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(`${file.name} uploaded`)
    loadFiles()
  }

  const download = async (fileName) => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(`deal-${deal.id}/${fileName}`, 60)
    if (error) { pushToast('Could not create download link', 'error'); return }
    const a = document.createElement('a')
    a.href = data.signedUrl; a.download = fileName; a.target = '_blank'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  const remove = async (fileName) => {
    const { error } = await supabase.storage.from(BUCKET).remove([`deal-${deal.id}/${fileName}`])
    if (error) { pushToast(error.message, 'error'); return }
    pushToast('File deleted', 'info')
    setFiles(p => p.filter(f => f.name !== fileName))
  }

  if (!bucketReady) return (
    <div style={{ padding: 20 }}>
      <div style={{ background: '#fff8ec', border: '1px solid var(--gw-amber)', borderRadius: 'var(--radius)', padding: 16, fontSize: 13, lineHeight: 1.7 }}>
        <strong>Storage bucket setup required.</strong><br />
        In your <strong>Supabase dashboard → Storage</strong>, create a private bucket named <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3 }}>deal-documents</code>, then add this RLS policy:
        <pre style={{ background: 'var(--gw-slate)', color: '#e2e8f0', padding: 10, borderRadius: 6, fontSize: 11, marginTop: 8, overflowX: 'auto' }}>
{`create policy "agents_deal_docs"
on storage.objects for all to authenticated
using  (bucket_id = 'deal-documents')
with check (bucket_id = 'deal-documents');`}
        </pre>
        <button className="btn btn--secondary btn--sm" style={{ marginTop: 8 }} onClick={() => { setBucketReady(true); loadFiles() }}>
          <Icon name="refresh" size={12} /> Retry
        </button>
      </div>
    </div>
  )

  if (loading) return <div style={{ padding: 24, fontSize: 13, color: 'var(--gw-mist)' }}>Loading files…</div>

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      {/* Required Forms — state-specific packet lookup */}
      <RequiredFormsPanel />

      {/* Drop zone */}
      <div
        style={{ border: `2px dashed ${dragOver ? 'var(--gw-azure)' : 'var(--gw-border)'}`, borderRadius: 'var(--radius)', padding: '20px 16px', textAlign: 'center', cursor: 'pointer', marginBottom: 16, background: dragOver ? 'var(--gw-sky)' : 'transparent', transition: 'all 150ms' }}
        onClick={() => fileRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files[0]) }}>
        <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={e => upload(e.target.files[0])} />
        {uploading ? (
          <div style={{ fontSize: 13, color: 'var(--gw-azure)', fontWeight: 600 }}>Uploading…</div>
        ) : (
          <>
            <Icon name="upload" size={22} style={{ color: 'var(--gw-border)', marginBottom: 6 }} />
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gw-ink)' }}>Drop a file or click to upload</div>
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 3 }}>PDF, Word, images — max 50 MB · Stored securely in Supabase</div>
          </>
        )}
      </div>

      {/* File list */}
      {files.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--gw-mist)', fontSize: 13, padding: '16px 0' }}>
          No documents yet. Upload contracts, inspections, or any deal files.
        </div>
      ) : (
        files.map(file => {
          const ext = file.name.split('.').pop().toUpperCase()
          const displayName = file.name.replace(/^\d+-/, '')
          return (
            <div key={file.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', marginBottom: 6, background: '#fff' }}>
              <div style={{ width: 34, height: 34, borderRadius: 6, background: 'var(--gw-sky)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 9, fontWeight: 700, color: 'var(--gw-azure)', letterSpacing: '0.03em' }}>
                {ext.slice(0, 4)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={displayName}>{displayName}</span>
                  {sharedDocs.includes(file.name) && (
                    <span style={{ fontSize: 9, fontWeight: 700, background: 'var(--gw-green-light)', color: 'var(--gw-green)', padding: '1px 6px', borderRadius: 8, flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Client</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>
                  {formatBytes(file.metadata?.size)}
                  {file.created_at && <> · {new Date(file.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</>}
                </div>
              </div>
              <button
                className="btn btn--ghost btn--icon btn--sm"
                title={sharedDocs.includes(file.name) ? 'Shared with client — click to unshare' : 'Share with client portal'}
                onClick={() => toggleShare(file.name)}
                style={{ color: sharedDocs.includes(file.name) ? 'var(--gw-green)' : undefined }}
              >
                <Icon name="eye" size={13} />
              </button>
              <button className="btn btn--ghost btn--icon btn--sm" title="Download" onClick={() => download(file.name)}>
                <Icon name="download" size={13} />
              </button>
              <button className="btn btn--ghost btn--icon btn--sm" title="Delete" onClick={() => remove(file.name)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}

const DS_STATUS = {
  draft:     { bg: '#fff3cd', color: '#856404' },
  sent:      { bg: '#e8f4fd', color: 'var(--gw-azure)' },
  delivered: { bg: '#fff3cd', color: '#856404' },
  completed: { bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  declined:  { bg: 'var(--gw-red-light)',   color: 'var(--gw-red)' },
  voided:    { bg: 'var(--gw-bone)',         color: 'var(--gw-mist)' },
}

const FIELD_TYPES = {
  signature: { label: 'Sign Here', color: '#2563eb', bg: '#dbeafe' },
  initials:  { label: 'Initials',  color: '#7c3aed', bg: '#ede9fe' },
  date:      { label: 'Date',      color: '#059669', bg: '#d1fae5' },
}

// Document-level annotation tools (not tied to a signer)
const ANNOTATION_TYPES = {
  highlight:     { label: 'Highlight',     color: '#d97706', bg: 'rgba(253,224,71,0.45)', w: 160, h: 14 },
  strikethrough: { label: 'Strike-through', color: '#dc2626', bg: 'rgba(220,38,38,0.7)',  w: 160, h: 3  },
  checkbox:      { label: 'Checkbox',       color: '#1a2236', bg: 'rgba(26,34,54,0.06)',  w: 18,  h: 18 },
}

// Per-signer accent colors for multi-signer field placement
const SIGNER_COLORS = ['#2563eb','#d97706','#dc2626','#0891b2']
const SIGNER_BGS    = ['#dbeafe','#fef3c7','#fee2e2','#cffafe']

const PDF_SCALE = 1.3

// allFields = flat array of all signers' tabs, each with signerIndex for color-coding
// docAnnotations = document-level highlight/strikethrough marks (not per-signer)
function PDFPlacer({ file, fileUrl, allFields, onPlace, onRemove, activeTool, setActiveTool, activeSignerIndex, docAnnotations, onPlaceAnnotation, onRemoveAnnotation }) {
  const [pages,   setPages]   = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const canvasRefs = React.useRef({})

  React.useEffect(() => { loadPDF() }, [])
  React.useEffect(() => { if (pages.length > 0) renderPages() }, [pages])

  const loadPDF = async () => {
    setLoading(true)
    if (!window.pdfjsLib) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
        s.onload = resolve; s.onerror = reject
        document.head.appendChild(s)
      })
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
    }
    let buf
    if (file) { buf = await file.arrayBuffer() }
    else { buf = await fetch(fileUrl).then(r => r.arrayBuffer()) }
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise
    const list = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const pageObj  = await pdf.getPage(i)
      const viewport = pageObj.getViewport({ scale: PDF_SCALE })
      list.push({ pageObj, viewport })
    }
    setPages(list)
    setLoading(false)
  }

  const renderPages = async () => {
    for (let i = 0; i < pages.length; i++) {
      const canvas = canvasRefs.current[i]
      if (!canvas) continue
      const { pageObj, viewport } = pages[i]
      canvas.width  = viewport.width
      canvas.height = viewport.height
      await pageObj.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    }
  }

  const handleClick = (e, pageIndex) => {
    if (!activeTool) return
    const rect    = e.currentTarget.getBoundingClientRect()
    const xCanvas = e.clientX - rect.left
    const yCanvas = e.clientY - rect.top
    // Annotation tools are document-level, not per-signer
    if (ANNOTATION_TYPES[activeTool]) {
      const ann = ANNOTATION_TYPES[activeTool]
      onPlaceAnnotation({
        id: Date.now(), type: activeTool,
        page: pageIndex + 1, pageIndex,
        xCanvas: xCanvas - ann.w / 2,
        yCanvas: yCanvas - ann.h / 2,
        xPosition: String(Math.round((xCanvas - ann.w / 2) / PDF_SCALE)),
        yPosition: String(Math.round((yCanvas - ann.h / 2) / PDF_SCALE)),
        width: ann.w, height: ann.h,
      })
    } else {
      onPlace({
        id: Date.now(), type: activeTool,
        page: pageIndex + 1,
        xPosition: String(Math.round(xCanvas / PDF_SCALE)),
        yPosition: String(Math.round(yCanvas / PDF_SCALE)),
        xCanvas, yCanvas, pageIndex,
        signerIndex: activeSignerIndex,
      })
    }
  }

  if (loading) return <div style={{ padding:'40px 0', textAlign:'center', color:'var(--gw-mist)', fontSize:13 }}>Loading PDF…</div>

  return (
    <div>
      <div style={{ display:'flex', gap:6, marginBottom:6, alignItems:'center', flexWrap:'wrap' }}>
        <span style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--gw-mist)', flexBasis:'100%' }}>Signature Fields</span>
        {Object.entries(FIELD_TYPES).map(([key, { label }]) => {
          const color = SIGNER_COLORS[activeSignerIndex] || SIGNER_COLORS[0]
          const bg    = SIGNER_BGS[activeSignerIndex]    || SIGNER_BGS[0]
          const active = activeTool === key
          return (
            <button key={key} onClick={() => setActiveTool(active ? null : key)}
              style={{ padding:'5px 12px', borderRadius:'var(--radius)', fontSize:12, fontWeight:700, cursor:'pointer', border:`2px solid ${active?color:'var(--gw-border)'}`, background:active?bg:'#fff', color:active?color:'var(--gw-mist)' }}>
              + {label}
            </button>
          )
        })}
      </div>
      <div style={{ display:'flex', gap:6, marginBottom:10, alignItems:'center', flexWrap:'wrap' }}>
        <span style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--gw-mist)', flexBasis:'100%' }}>Document Markup</span>
        {Object.entries(ANNOTATION_TYPES).map(([key, { label, color, bg }]) => {
          const active = activeTool === key
          return (
            <button key={key} onClick={() => setActiveTool(active ? null : key)}
              style={{ padding:'5px 12px', borderRadius:'var(--radius)', fontSize:12, fontWeight:700, cursor:'pointer', border:`2px solid ${active?color:'var(--gw-border)'}`, background:active?bg:'#fff', color:active?color:'var(--gw-mist)' }}>
              {key === 'highlight' ? '🖊 ' : key === 'strikethrough' ? '—— ' : '☐ '}{label}
            </button>
          )
        })}
        <span style={{ fontSize:11, color:'var(--gw-mist)', marginLeft:4 }}>
          {activeTool ? (ANNOTATION_TYPES[activeTool] ? 'Click to mark area' : 'Click PDF to place') : 'Select a tool above'}
        </span>
        {(allFields.length + (docAnnotations?.length||0)) > 0 && (
          <span style={{ marginLeft:'auto', fontSize:11, fontWeight:700 }}>
            {allFields.length} field{allFields.length !== 1 ? 's' : ''}
            {(docAnnotations?.length||0) > 0 && ` · ${docAnnotations.length} mark${docAnnotations.length !== 1 ? 's' : ''}`}
          </span>
        )}
      </div>
      <div style={{ maxHeight:420, overflowY:'auto', overflowX:'auto', background:'#e5e7eb', borderRadius:'var(--radius)', padding:12, display:'flex', flexDirection:'column', alignItems:'flex-start', gap:12 }}>
        {pages.map((_, i) => (
          <div key={i} style={{ position:'relative' }}>
            <div style={{ fontSize:10, color:'#6b7280', marginBottom:4, textAlign:'center' }}>Page {i + 1}</div>
            <canvas ref={el => { if (el) canvasRefs.current[i] = el }} style={{ display:'block', boxShadow:'0 2px 8px rgba(0,0,0,0.2)' }}/>
            <div style={{ position:'absolute', inset:0, cursor:activeTool?'crosshair':'default', marginTop:18 }} onClick={e => handleClick(e, i)}/>
            {allFields.filter(f => f.pageIndex === i).map(f => {
              const color = SIGNER_COLORS[f.signerIndex] || SIGNER_COLORS[0]
              const bg    = SIGNER_BGS[f.signerIndex]    || SIGNER_BGS[0]
              const ft    = FIELD_TYPES[f.type]
              const dim   = f.signerIndex !== activeSignerIndex
              return (
                <div key={f.id} style={{ position:'absolute', left:f.xCanvas - 42, top:f.yCanvas - 10 + 18, display:'flex', alignItems:'center', gap:3, background:bg, border:`1.5px solid ${color}`, borderRadius:3, padding:'2px 6px', fontSize:10, fontWeight:700, color, whiteSpace:'nowrap', zIndex:10, pointerEvents:'auto', opacity: dim ? 0.4 : 1 }}>
                  {ft?.label}
                  <span onClick={e => { e.stopPropagation(); onRemove(f.id) }} style={{ cursor:'pointer', fontSize:12, lineHeight:1, opacity:0.6, marginLeft:1 }}>×</span>
                </div>
              )
            })}
            {/* Document annotations (highlight / strikethrough) */}
            {(docAnnotations||[]).filter(a => a.pageIndex === i).map(a => {
              const ann = ANNOTATION_TYPES[a.type]
              return (
                <div key={a.id} style={{
                  position:'absolute',
                  left: a.xCanvas, top: a.yCanvas + 18,
                  width: a.width, height: a.height,
                  background: ann?.bg,
                  border: `${a.type === 'checkbox' ? 2 : 1}px solid ${ann?.color}`,
                  borderRadius: a.type === 'highlight' ? 2 : 0,
                  zIndex: 9, pointerEvents:'auto', cursor:'default',
                  display:'flex', alignItems:'center', justifyContent: a.type === 'checkbox' ? 'center' : 'flex-end',
                }}>
                  {a.type === 'checkbox'
                    ? <span onClick={e => { e.stopPropagation(); onRemoveAnnotation(a.id) }} style={{ fontSize:9, cursor:'pointer', color: ann?.color, lineHeight:1, opacity:0.7 }}>×</span>
                    : <span onClick={e => { e.stopPropagation(); onRemoveAnnotation(a.id) }} style={{ fontSize:10, cursor:'pointer', color: ann?.color, lineHeight:1, padding:'0 2px', opacity:0.8 }}>×</span>
                  }
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Send for Signature modal — drives BoldSign document creation ────────────
// Flow:
//   1. Agent fills in signers + picks a PDF here in the CRM
//   2. We POST the PDF + signers to /api/boldsign, which auto-places a
//      signature + date field per signer and sends immediately via BoldSign
//   3. BoldSign emails each signer; they sign in their browser
//   4. BoldSign webhook hits /api/boldsign → status flips sent → completed
function SendSignatureModal({ deal, contacts, properties, dealFiles, activeAgent, onClose, onSent }) {
  // Primary signer: contact linked directly to the deal
  const contact      = contacts?.find(c => c.id === deal?.contact_id)
  const defaultName  = `${contact?.first_name || ''} ${contact?.last_name || ''}`.trim()
  const defaultEmail = contact?.email || ''

  // Secondary signer: property owner contact (if different from primary)
  const linkedProperty   = properties?.find(p => p.id === deal?.property_id)
  const ownerContact     = linkedProperty?.linked_contact_id
    ? contacts?.find(c => c.id === linkedProperty.linked_contact_id)
    : null
  const ownerIsDifferent = ownerContact && ownerContact.id !== deal?.contact_id
  const ownerName        = ownerIsDifferent ? `${ownerContact.first_name || ''} ${ownerContact.last_name || ''}`.trim() : ''
  const ownerEmail       = ownerIsDifferent ? (ownerContact.email || '') : ''

  const [subject,    setSubject]   = React.useState(`Please sign: ${deal?.title || 'Document'}`)
  const [file,       setFile]      = React.useState(null)
  const [pickedFile, setPickedFile]= React.useState('')
  const [agentSigns, setAgentSigns]= React.useState(false)
  const [sending,    setSending]   = React.useState(false)
  const [dragOver,   setDragOver]  = React.useState(false)
  const [embedUrl,   setEmbedUrl]  = React.useState(null)   // BoldSign prepare/send iframe URL
  const fileRef = React.useRef()

  const [signers, setSigners] = React.useState(() => {
    // Signer 1: deal contact. If they have no email, fall back to property owner.
    let s1Name  = defaultName
    let s1Email = defaultEmail
    if (!s1Email && ownerContact?.email) {
      s1Name  = ownerName
      s1Email = ownerContact.email
    }
    const base = [{ id: 1, name: s1Name, email: s1Email }]
    if (ownerIsDifferent && ownerEmail && ownerEmail !== s1Email) {
      base.push({ id: 2, name: ownerName, email: ownerEmail })
    }
    return base
  })

  const addSigner    = () => setSigners(p => [...p, { id: Date.now(), name:'', email:'' }])
  const removeSigner = (id) => setSigners(p => p.filter(s => s.id !== id))
  const updateSigner = (id, k, v) => setSigners(p => p.map(s => s.id===id ? {...s,[k]:v} : s))

  const allSigners = React.useMemo(() => {
    const clients = signers.map(s => ({ ...s, routingOrder: 1 }))
    if (agentSigns && activeAgent) {
      clients.push({ id:'agent', name: activeAgent.name, email: activeAgent.email, routingOrder: 2 })
    }
    return clients
  }, [signers, agentSigns, activeAgent])

  const toBase64 = f => new Promise((res, rej) => {
    const r = new FileReader(); r.onload = e => res(e.target.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(f)
  })

  const sendForSignature = async () => {
    const invalid = signers.find(s => !s.name.trim() || !s.email.trim())
    if (invalid) { pushToast('All signers need a name and email', 'error'); return }
    if (!file && !pickedFile) { pushToast('Select or upload a document', 'error'); return }
    setSending(true)

    let base64, finalDocName
    try {
      if (file) {
        base64 = await toBase64(file)
        finalDocName = file.name
      } else {
        const { data: urlData, error: urlErr } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(`deal-${deal.id}/${pickedFile}`, 300)
        if (urlErr) throw new Error(urlErr.message)
        const blob = await fetch(urlData.signedUrl).then(r => r.blob())
        base64 = await toBase64(blob)
        finalDocName = pickedFile.replace(/^\d+-/, '')
      }
    } catch (err) {
      setSending(false)
      pushToast('Could not read document: ' + err.message, 'error')
      return
    }

    const signerPayload = allSigners.map(s => ({
      name: s.name, email: s.email, routingOrder: s.routingOrder,
    }))

    let data
    try {
      // Open BoldSign's embedded prepare/send UI (auto-placed fields + signers
      // passed through); the agent reviews field placement and sends in-frame.
      data = await documentEmbedUrl({
        emailSubject:   subject,
        documentBase64: base64,
        documentName:   finalDocName,
        signers:        signerPayload,
        redirectUrl:    window.location.href,
      })
    } catch (err) {
      setSending(false); pushToast(err.message, 'error'); return
    }
    setSending(false)
    if (!data.url) { pushToast('BoldSign did not return a send URL', 'error'); return }

    // Track the draft so status updates land when the agent sends + it's signed.
    if (data.documentId) {
      await supabase.from('boldsign_documents').insert([{
        deal_id:       deal.id,
        agent_id:      activeAgent?.id || null,
        document_id:   data.documentId,
        signer_name:   allSigners.map(s => s.name).join(', '),
        signer_email:  allSigners.map(s => s.email).join(', '),
        document_name: finalDocName,
        subject,
        signers:       signerPayload,
        status:        'draft',
      }])
    }
    setEmbedUrl(data.url)
  }

  // Step 2 — BoldSign's embedded prepare/send UI in-frame.
  if (embedUrl) {
    return (
      <Modal open={true} onClose={onClose} width={900}>
        <div className="modal__head">
          <div>
            <div className="eyebrow-label">BoldSign · Review &amp; Send</div>
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>Place fields &amp; send</h3>
          </div>
          <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
        </div>
        <div className="modal__body" style={{ padding: 0 }}>
          <BoldSignFrame
            url={embedUrl}
            onDone={() => { pushToast('Sent for signature', 'success'); onSent() }}
            onError={() => pushToast('Send was cancelled in BoldSign', 'info')}
          />
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={true} onClose={onClose} width={520}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">BoldSign · Send for Signature</div>
          <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>Set Up Signers</h3>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body">
        {/* Email subject */}
        <div className="form-group">
          <label className="form-label">Email Subject</label>
          <input className="form-control" value={subject} onChange={e=>setSubject(e.target.value)}/>
        </div>

        {/* Signers */}
        <div className="form-group">
          <label className="form-label required">Signers <span style={{fontSize:11,fontWeight:400,color:'var(--gw-mist)'}}>— sign in parallel (same step)</span></label>
          {signers.map((s, i) => (
            <div key={s.id} style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8 }}>
              <div style={{ width:22, height:22, borderRadius:'50%', background:SIGNER_COLORS[i]||SIGNER_COLORS[0], display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:700, flexShrink:0 }}>{i+1}</div>
              <input className="form-control" style={{ flex:1 }} placeholder="Full name" value={s.name} onChange={e=>updateSigner(s.id,'name',e.target.value)}/>
              <input className="form-control" style={{ flex:1 }} placeholder="Email" type="email" value={s.email} onChange={e=>updateSigner(s.id,'email',e.target.value)}/>
              {signers.length > 1 && <button className="btn btn--ghost btn--icon btn--sm" onClick={()=>removeSigner(s.id)}><Icon name="x" size={13}/></button>}
            </div>
          ))}
          <button className="btn btn--secondary btn--sm" onClick={addSigner} style={{marginTop:2}}>+ Add another signer</button>
        </div>

        {/* Agent signs last */}
        {activeAgent && (
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', marginBottom:16, background:'var(--gw-bone)' }}>
            <input type="checkbox" id="agentSigns" checked={agentSigns} onChange={e=>setAgentSigns(e.target.checked)} style={{width:15,height:15,cursor:'pointer'}}/>
            <label htmlFor="agentSigns" style={{ fontSize:13, cursor:'pointer', flex:1 }}>
              <strong>I need to sign as well</strong> — {activeAgent.name} signs <em>after</em> the client{signers.length>1?'s':''}
            </label>
            {agentSigns && <div style={{ width:22, height:22, borderRadius:'50%', background:SIGNER_COLORS[signers.length]||'#6b7280', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:700 }}>{signers.length+1}</div>}
          </div>
        )}

        {/* Document */}
        <div className="form-group">
          <label className="form-label required">Document (PDF)</label>
          {dealFiles.length > 0 && (
            <div style={{ marginBottom:10 }}>
              <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:6 }}>Pick from deal documents:</div>
              {dealFiles.map(f => {
                const name = f.name.replace(/^\d+-/,'')
                const picked = pickedFile === f.name
                return (
                  <div key={f.name} onClick={()=>{ setPickedFile(picked?'':f.name); if(!picked){setFile(null)} }}
                    style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', border:`1px solid ${picked?'var(--gw-azure)':'var(--gw-border)'}`, borderRadius:'var(--radius)', marginBottom:4, cursor:'pointer', background:picked?'var(--gw-sky)':'#fff' }}>
                    <Icon name="file" size={13} style={{ color:'var(--gw-mist)', flexShrink:0 }}/>
                    <span style={{ fontSize:12, flex:1, fontWeight:picked?700:400 }}>{name}</span>
                    {picked && <Icon name="check" size={13} style={{ color:'var(--gw-azure)' }}/>}
                  </div>
                )
              })}
              <div style={{ fontSize:11, color:'var(--gw-mist)', margin:'8px 0 4px' }}>— or upload a different file —</div>
            </div>
          )}
          <div style={{ border:`2px dashed ${dragOver?'var(--gw-azure)':file?'var(--gw-green)':'var(--gw-border)'}`, borderRadius:'var(--radius)', padding:'14px 16px', textAlign:'center', cursor:'pointer', background:dragOver?'var(--gw-sky)':file?'var(--gw-green-light)':'transparent', transition:'all 150ms' }}
            onClick={()=>fileRef.current.click()}
            onDragOver={e=>{e.preventDefault();setDragOver(true)}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={e=>{e.preventDefault();setDragOver(false);setFile(e.dataTransfer.files[0]);setPickedFile('')}}>
            <input ref={fileRef} type="file" accept=".pdf" style={{display:'none'}} onChange={e=>{setFile(e.target.files[0]);setPickedFile('')}}/>
            {file ? <div style={{fontSize:12,fontWeight:600,color:'var(--gw-green)'}}>{file.name}</div>
              : <><Icon name="upload" size={18} style={{color:'var(--gw-border)',marginBottom:4}}/><div style={{fontSize:12}}>Drop PDF or click to browse</div></>}
          </div>
        </div>

        {/* What happens next */}
        <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:12, color:'var(--gw-mist)', lineHeight:1.5 }}>
          <strong style={{ color:'var(--gw-ink)' }}>Next:</strong> BoldSign opens here in the app.
          A signature and date field are pre-placed for each signer — review/adjust field placement, then click Send inside BoldSign. The status here updates automatically as they sign.
        </div>
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={sendForSignature} disabled={sending}>
          {sending ? 'Opening…' : 'Continue in BoldSign'}
        </button>
      </div>
    </Modal>
  )
}

function SignaturesTab({ deal, contacts, properties, activeAgent }) {
  const [envelopes,   setEnvelopes]   = React.useState([])
  const [loading,     setLoading]     = React.useState(true)
  const [tableReady,  setTableReady]  = React.useState(true)
  const [sendOpen,    setSendOpen]    = React.useState(false)
  const [tplOpen,     setTplOpen]     = React.useState(false)
  const [templates,   setTemplates]   = React.useState([])
  const [dealFiles,   setDealFiles]   = React.useState([])
  const [downloading, setDownloading] = React.useState({})

  React.useEffect(() => {
    if (!deal?.id) return
    loadEnvelopes()
    loadDealFiles()
    loadTemplates()

    // Realtime subscription — auto-update status when webhook fires
    const channel = supabase.channel(`sig-documents-${deal.id}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'boldsign_documents',
        filter: `deal_id=eq.${deal.id}`,
      }, payload => {
        setEnvelopes(prev => prev.map(e => e.id === payload.new.id ? { ...e, ...payload.new } : e))
        if (payload.new.status === 'completed' && payload.old?.status !== 'completed') {
          loadDealFiles() // signed copy should now be in storage
          pushToast('Document fully signed — signed copy saved to Documents tab', 'success')
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [deal?.id])

  const loadEnvelopes = async () => {
    setLoading(true)
    const { data, error } = await supabase.from('boldsign_documents').select('*').eq('deal_id', deal.id).order('created_at', { ascending: false })
    if (error?.code === '42P01') { setTableReady(false); setLoading(false); return }
    setEnvelopes(data || [])
    setLoading(false)
  }

  const loadTemplates = async () => {
    const { data } = await supabase.from('boldsign_templates').select('*').eq('active', true).order('name')
    setTemplates(data || [])
  }

  const loadDealFiles = async () => {
    const { data } = await supabase.storage.from(BUCKET).list(`deal-${deal.id}`, { sortBy: { column: 'created_at', order: 'desc' } })
    setDealFiles((data || []).filter(f => f.name !== '.emptyFolderPlaceholder'))
  }

  const refreshStatus = async (env) => {
    let data
    try { data = await getDocStatus(env.document_id) }
    catch (err) { pushToast(err.message, 'error'); return }
    const patch = { status: data.status, completed_at: data.completedDateTime || null }
    await supabase.from('boldsign_documents').update(patch).eq('id', env.id)
    setEnvelopes(prev => prev.map(e => e.id === env.id ? { ...e, ...patch } : e))
    pushToast(`Status: ${data.status}`, 'info')
  }

  const downloadSigned = async (env) => {
    setDownloading(p => ({ ...p, [env.id]: true }))

    // First check if the signed copy was saved to storage by the webhook
    const signedFile = dealFiles.find(f => f.name.includes('signed-') && f.name.includes(env.document_id?.slice(0, 8) || ''))
      || dealFiles.find(f => f.name.includes('signed-'))

    if (signedFile) {
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(`deal-${deal.id}/${signedFile.name}`, 120)
      if (data?.signedUrl) {
        window.open(data.signedUrl, '_blank')
        setDownloading(p => ({ ...p, [env.id]: false }))
        return
      }
    }

    // Fall back: download directly from BoldSign API
    let data
    try { data = await apiDownloadSigned(env.document_id) }
    catch (err) { setDownloading(p => ({ ...p, [env.id]: false })); pushToast(err.message, 'error'); return }
    setDownloading(p => ({ ...p, [env.id]: false }))

    // Trigger browser download
    const link = document.createElement('a')
    link.href = `data:application/pdf;base64,${data.base64}`
    link.download = `signed-${env.document_name || 'document.pdf'}`
    link.click()
  }

  if (!tableReady) return (
    <div style={{ padding:20 }}>
      <div style={{ background:'#fff8ec', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:16, fontSize:13, lineHeight:1.7 }}>
        <strong>Run this SQL in your Supabase dashboard:</strong>
        <pre style={{ background:'var(--gw-slate)', color:'#e2e8f0', padding:10, borderRadius:6, fontSize:11, marginTop:8, overflowX:'auto' }}>
{`create table if not exists boldsign_documents (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid references deals(id) on delete cascade,
  document_id   text not null,
  signer_name   text,
  signer_email  text,
  document_name text,
  subject       text,
  status        text default 'sent',
  sent_at       timestamptz default now(),
  completed_at  timestamptz,
  created_at    timestamptz default now()
);
alter table boldsign_documents enable row level security;
create policy "agents_boldsign_documents" on boldsign_documents
  for all to authenticated using (true) with check (true);

-- Also run this for agent notifications:
create table if not exists agent_notifications (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid references agents(id) on delete cascade,
  deal_id      uuid references deals(id) on delete set null,
  envelope_id  text,
  title        text,
  message      text,
  type         text default 'document_signed',
  read         boolean default false,
  created_at   timestamptz default now()
);
alter table agent_notifications enable row level security;
create policy "agent_notifications_policy" on agent_notifications
  for all to authenticated using (true) with check (true);`}
        </pre>
        <button className="btn btn--secondary btn--sm" style={{ marginTop:8 }} onClick={() => { setTableReady(true); loadEnvelopes() }}>
          <Icon name="refresh" size={12}/> Retry
        </button>
      </div>
    </div>
  )

  return (
    <div style={{ padding:16, overflowY:'auto', flex:1 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <div style={{ fontSize:13, color:'var(--gw-mist)' }}>{envelopes.length} document{envelopes.length !== 1 ? 's' : ''} sent</div>
        <div style={{ display:'flex', gap:8 }}>
          {templates.length > 0 && (
            <button className="btn btn--secondary btn--sm" onClick={() => setTplOpen(true)}>
              <Icon name="file" size={13}/> Send from Template
            </button>
          )}
          <button className="btn btn--primary btn--sm" onClick={() => setSendOpen(true)}>
            <Icon name="send" size={13}/> Send for Signature
          </button>
        </div>
      </div>

      {loading
        ? <div style={{ fontSize:13, color:'var(--gw-mist)' }}>Loading…</div>
        : envelopes.length === 0
          ? <div style={{ textAlign:'center', color:'var(--gw-mist)', fontSize:13, padding:'32px 0' }}>No documents sent yet.<br/>Click "Send for Signature" to get started.</div>
          : envelopes.map(env => {
              const sc        = DS_STATUS[env.status] || DS_STATUS.sent
              const completed = env.status === 'completed'
              return (
                <div key={env.id} style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', marginBottom:8, background:'#fff', overflow:'hidden' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px' }}>
                    <Icon name="file" size={18} style={{ color:'var(--gw-mist)', flexShrink:0 }}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{env.document_name || 'Document'}</div>
                      <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>
                        To: {env.signer_name} · {new Date(env.sent_at || env.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}
                        {completed && env.completed_at && (
                          <span> · Signed {new Date(env.completed_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}</span>
                        )}
                      </div>
                    </div>
                    <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700, background:sc.bg, color:sc.color, flexShrink:0, textTransform:'capitalize' }}>{env.status}</span>
                    <button className="btn btn--ghost btn--icon btn--sm" title="Refresh status" onClick={() => refreshStatus(env)}>
                      <Icon name="refresh" size={12}/>
                    </button>
                  </div>
                  {completed && (
                    <div style={{ borderTop:'1px solid var(--gw-border)', padding:'8px 12px', background:'var(--gw-green-light)', display:'flex', alignItems:'center', gap:8 }}>
                      <Icon name="check" size={13} style={{ color:'var(--gw-green)', flexShrink:0 }}/>
                      <span style={{ fontSize:12, color:'var(--gw-green)', flex:1, fontWeight:600 }}>Fully signed — copy saved to Documents tab</span>
                      <button
                        className="btn btn--sm"
                        style={{ background:'var(--gw-green)', color:'#fff', border:'none', fontSize:11 }}
                        onClick={() => downloadSigned(env)}
                        disabled={downloading[env.id]}
                      >
                        {downloading[env.id] ? 'Downloading…' : 'Download Signed PDF'}
                      </button>
                    </div>
                  )}
                </div>
              )
            })
      }

      {sendOpen && (
        <SendSignatureModal
          deal={deal} contacts={contacts} properties={properties} dealFiles={dealFiles} activeAgent={activeAgent}
          onClose={() => setSendOpen(false)}
          onSent={() => { setSendOpen(false); loadEnvelopes() }}
        />
      )}

      {tplOpen && (
        <SendFromTemplateModal
          deal={deal} contacts={contacts} properties={properties} templates={templates} activeAgent={activeAgent}
          onClose={() => setTplOpen(false)}
          onSent={() => { setTplOpen(false); loadEnvelopes() }}
        />
      )}
    </div>
  )
}

// ── Send from Template modal — dynamic. Reads the template's actual roles +
//    fillable fields from BoldSign, renders a signer input per role and an
//    editable (CRM-prefilled) input per field, then sends via /api/boldsign.
const prettyLabel = (id) => String(id || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

function SendFromTemplateModal({ deal, contacts, properties, templates, activeAgent, onClose, onSent }) {
  const contact  = contacts?.find(c => c.id === deal?.contact_id)
  const property = properties?.find(p => p.id === deal?.property_id)

  // Filter templates to the deal's state (comp_data.state preferred, else the
  // normalized property state); fall back to all if none match.
  const dealState = normalizeState(deal?.comp_data?.state || property?.state || '')
  const matched   = templates.filter(t => !t.state || normalizeState(t.state) === dealState)
  const visible   = (dealState && matched.length) ? matched : templates

  const [templateId, setTemplateId] = React.useState(visible[0]?.template_id || '')
  const [subject,    setSubject]    = React.useState(`Please sign: ${deal?.title || 'Document'}`)
  const [embedUrl,   setEmbedUrl]   = React.useState(null)   // BoldSign prepare/send iframe URL
  const [sending,    setSending]    = React.useState(false)
  const [details,    setDetails]    = React.useState(null)   // { roles, fields }
  const [loadingDet, setLoadingDet] = React.useState(false)
  const [signers,    setSigners]    = React.useState({})     // roleIndex → { name, email }
  const [values,     setValues]     = React.useState({})     // fieldId → value

  const tpl = templates.find(t => t.template_id === templateId)

  // Load the template's roles + fields whenever the selection changes, and seed
  // signer/field inputs from the deal.
  React.useEffect(() => {
    if (!templateId) { setDetails(null); return }
    let cancelled = false
    setLoadingDet(true)
    templateDetails(templateId)
      .then(det => {
        if (cancelled) return
        const roles  = det.roles?.length ? det.roles : [{ index: 1, name: 'Signer' }]
        const fields = (det.fields || []).filter(f => isFillableField(f.type))
        setDetails({ roles, fields })

        // Seed signers: match role name to the deal's people (first match wins).
        const tokenVals = crmTokenValues({ deal, property, contact, agent: activeAgent })
        const seededSigners = {}
        let usedContact = false, usedAgent = false
        for (const r of roles) {
          const n = String(r.name).toLowerCase()
          if (!usedAgent && /agent/.test(n) && activeAgent?.email) {
            seededSigners[r.index] = { name: activeAgent.name || '', email: activeAgent.email || '' }; usedAgent = true
          } else if (!usedContact && /(seller|buyer|client|owner)/.test(n) && contact) {
            seededSigners[r.index] = { name: `${contact.first_name || ''} ${contact.last_name || ''}`.trim(), email: contact.email || '' }; usedContact = true
          } else {
            seededSigners[r.index] = { name: r.defaultName || '', email: r.defaultEmail || '' }
          }
        }
        setSigners(seededSigners)

        const seededValues = {}
        for (const f of fields) seededValues[f.id] = tokenVals[f.id] || ''
        setValues(seededValues)
      })
      .catch(err => { if (!cancelled) { setDetails({ roles: [{ index: 1, name: 'Signer' }], fields: [] }); pushToast(`Couldn't load template fields: ${err.message}`, 'error') } })
      .finally(() => { if (!cancelled) setLoadingDet(false) })
    return () => { cancelled = true }
  }, [templateId])

  const setSigner = (idx, k, v) => setSigners(p => ({ ...p, [idx]: { ...(p[idx] || {}), [k]: v } }))
  const setValue  = (id, v)     => setValues(p => ({ ...p, [id]: v }))

  const submit = async () => {
    if (!templateId) { pushToast('Pick a template', 'error'); return }
    const roleList = details?.roles || []
    const filled   = roleList.filter(r => (signers[r.index]?.name || '').trim() && (signers[r.index]?.email || '').trim())
    if (!filled.length) { pushToast('At least one signer needs a name and email', 'error'); return }
    setSending(true)

    // Attach each filled field value to the role that owns it (or the first
    // filled role if the field isn't role-scoped). CRM-entered values are locked.
    const firstIdx = filled[0].index
    const byRole = {}
    for (const f of (details.fields || [])) {
      const v = (values[f.id] || '').trim()
      if (!v) continue
      const idx = (f.roleIndex && filled.some(r => r.index === f.roleIndex)) ? f.roleIndex : firstIdx
      ;(byRole[idx] ||= []).push({ id: f.id, value: v, isReadOnly: true })
    }
    const roles = filled.map(r => ({
      roleIndex: r.index, signerName: signers[r.index].name, signerEmail: signers[r.index].email,
      signerOrder: r.index, existingFormFields: byRole[r.index] || [],
    }))
    const roleRemovalIndices = roleList.filter(r => !filled.includes(r)).map(r => r.index)

    const docName = [tpl?.name || deal?.title, property?.address].filter(Boolean).join(' — ')
    const labels  = [tpl?.state, tpl?.doc_type, `deal:${deal.id}`].filter(Boolean)
    const args    = { templateId, deal_id: deal.id, roles, roleRemovalIndices, emailSubject: subject, documentName: docName, labels }

    try {
      // Open BoldSign's embedded prepare/send UI in-frame with the signers +
      // prefilled values passed through; the agent reviews and sends there.
      const { url } = await templateEmbedUrl({ ...args, redirectUrl: window.location.href })
      if (!url) { pushToast('BoldSign did not return a send URL', 'error'); return }
      setEmbedUrl(url)
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setSending(false)
    }
  }

  const fields = details?.fields || []

  // Step 2 — BoldSign's embedded prepare/send UI (replaces our own send popup).
  if (embedUrl) {
    return (
      <Modal open={true} onClose={onClose} width={900}>
        <div className="modal__head">
          <div>
            <div className="eyebrow-label">BoldSign · Review &amp; Send</div>
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>Place fields &amp; send</h3>
          </div>
          <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
        </div>
        <div className="modal__body" style={{ padding: 0 }}>
          <BoldSignFrame
            url={embedUrl}
            onDone={() => { pushToast('Sent for signature', 'success'); onSent() }}
            onError={() => pushToast('Send was cancelled in BoldSign', 'info')}
          />
        </div>
      </Modal>
    )
  }

  return (
    <Modal open={true} onClose={onClose} width={520}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">BoldSign · Send from Template</div>
          <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>Send for Signature</h3>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body">
        <div className="form-group">
          <label className="form-label required">Template</label>
          <select className="form-control" value={templateId} onChange={e => setTemplateId(e.target.value)}>
            {visible.map(t => <option key={t.template_id} value={t.template_id}>{t.name}{t.state ? ` (${t.state})` : ''}</option>)}
          </select>
          {dealState && (
            <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6 }}>
              Showing templates for {dealState}{matched.length ? '' : ' — none registered for this state yet, showing all'}.
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">Email Subject</label>
          <input className="form-control" value={subject} onChange={e => setSubject(e.target.value)}/>
        </div>

        {loadingDet && <div style={{ fontSize:13, color:'var(--gw-mist)', padding:'8px 0' }}>Loading template…</div>}

        {!loadingDet && details && (
          <>
            {/* One signer input per template role; leave a role blank to omit it. */}
            <div className="form-group">
              <label className="form-label required">Signers</label>
              {details.roles.map((r, i) => (
                <div key={r.index} style={{ marginBottom:10 }}>
                  <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)', marginBottom:4 }}>
                    <span style={{ display:'inline-flex', width:18, height:18, borderRadius:'50%', background:SIGNER_COLORS[i]||'#6b7280', color:'#fff', alignItems:'center', justifyContent:'center', fontSize:10, marginRight:6 }}>{r.index}</span>
                    {r.name}
                  </div>
                  <div style={{ display:'flex', gap:8 }}>
                    <input className="form-control" style={{ flex:1 }} placeholder="Full name" value={signers[r.index]?.name || ''} onChange={e => setSigner(r.index, 'name', e.target.value)}/>
                    <input className="form-control" style={{ flex:1 }} placeholder="Email" type="email" value={signers[r.index]?.email || ''} onChange={e => setSigner(r.index, 'email', e.target.value)}/>
                  </div>
                </div>
              ))}
              <div style={{ fontSize:11, color:'var(--gw-mist)' }}>Roles left blank are removed from this send.</div>
            </div>

            {/* Editable, CRM-prefilled detail fields the sellers see filled in. */}
            {fields.length > 0 && (
              <div className="form-group">
                <label className="form-label">Document details <span style={{ fontSize:11, fontWeight:400, color:'var(--gw-mist)' }}>— prefilled from the deal; edit as needed</span></label>
                {fields.map(f => (
                  <div key={f.id} style={{ marginBottom:8 }}>
                    <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:2 }}>{prettyLabel(f.id)}</div>
                    <input className="form-control" value={values[f.id] || ''} onChange={e => setValue(f.id, e.target.value)}/>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div style={{ fontSize:12, color:'var(--gw-mist)', padding:'2px 2px' }}>
          Next: BoldSign opens here in the app with these signers &amp; details filled in — review field placement and click Send.
        </div>
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={submit} disabled={sending || loadingDet}>
          {sending ? 'Opening…' : 'Continue in BoldSign'}
        </button>
      </div>
    </Modal>
  )
}

// ── Client Portal tab — enable a shareable read-only link for the client ──────
function PortalTab({ deal }) {
  const [enabled, setEnabled] = React.useState(false)
  const [token, setToken]     = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy]       = React.useState(false)
  const [copied, setCopied]   = React.useState(false)

  React.useEffect(() => {
    if (!deal?.id) return
    supabase.from('deals').select('portal_token, portal_enabled').eq('id', deal.id).single()
      .then(({ data, error }) => {
        if (!error && data) { setEnabled(!!data.portal_enabled); setToken(data.portal_token || null) }
        setLoading(false)
      })
  }, [deal?.id])

  const portalUrl = token ? `${window.location.origin}/portal/${token}` : ''

  const enable = async () => {
    setBusy(true)
    const newToken = token || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const { error } = await supabase.from('deals').update({ portal_token: newToken, portal_enabled: true }).eq('id', deal.id)
    setBusy(false)
    if (error) { pushToast(error.message, 'error'); return }
    setToken(newToken); setEnabled(true)
    pushToast('Client portal enabled')
  }

  const disable = async () => {
    setBusy(true)
    const { error } = await supabase.from('deals').update({ portal_enabled: false }).eq('id', deal.id)
    setBusy(false)
    if (error) { pushToast(error.message, 'error'); return }
    setEnabled(false)
    pushToast('Client portal disabled', 'info')
  }

  const copy = () => {
    navigator.clipboard.writeText(portalUrl)
    setCopied(true); setTimeout(() => setCopied(false), 1800)
  }

  if (loading) return <div style={{ padding: 24, color: 'var(--gw-mist)', fontSize: 13 }}>Loading…</div>

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      <div style={{ fontSize: 13, color: 'var(--gw-mist)', lineHeight: 1.6, marginBottom: 16 }}>
        Give your client a private, read-only link to track their transaction — closing progress,
        key dates, shared documents, and your contact info. Updates in real time as you work the deal.
      </div>

      {!enabled ? (
        <button className="btn btn--primary" onClick={enable} disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          <Icon name="link" size={14} /> {busy ? 'Enabling…' : 'Enable Client Portal'}
        </button>
      ) : (
        <>
          <div style={{ background: 'var(--gw-green-light)', border: '1px solid var(--gw-green)', borderRadius: 'var(--radius)', padding: '10px 12px', fontSize: 12, color: 'var(--gw-green)', fontWeight: 600, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="check" size={13} /> Portal is live
          </div>

          <label className="form-label">Shareable Link</label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input className="form-control" readOnly value={portalUrl} style={{ flex: 1, fontSize: 12 }} onFocus={e => e.target.select()} />
            <button className="btn btn--secondary btn--sm" onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <a className="btn btn--secondary btn--sm" href={portalUrl} target="_blank" rel="noopener noreferrer" style={{ flex: 1, justifyContent: 'center' }}>
              <Icon name="eye" size={12} /> Preview
            </a>
            <button className="btn btn--ghost btn--sm" onClick={disable} disabled={busy} style={{ color: 'var(--gw-red)' }}>
              Disable
            </button>
          </div>

          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 14, lineHeight: 1.6, borderTop: '1px solid var(--gw-border)', paddingTop: 12 }}>
            Anyone with this link can view the portal — no login required. Only documents you mark
            <strong> “Share with client”</strong> on the Documents tab appear. Disable any time to revoke access.
          </div>
        </>
      )}
    </div>
  )
}

export function DealDrawer({ open, onClose, deal, agents, contacts, properties, activeAgent, onSave, initialTab = 'details' }) {
  const blank = { title:'', contact_id:'', property_id:'', agent_id:'', stage:'lead', value:'', probability:0, expected_close_date:'', notes:'', prop_category:'residential', prop_subtype:'', comp_data:{} }
  const [form, setForm]     = useState(deal || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [tab, setTab]       = useState(initialTab)

  React.useEffect(() => {
    setForm(deal ? { ...blank, ...deal, expected_close_date: deal.expected_close_date ? deal.expected_close_date.slice(0,10) : '', comp_data: deal.comp_data || {} } : blank)
    setErrors({})
    setTab(deal?.id ? initialTab : 'details')
  }, [deal, open, initialTab])

  const set  = (k, v) => setForm(p => ({...p, [k]: v}))
  const setCD = (k, v) => setForm(p => ({...p, comp_data: {...(p.comp_data||{}), [k]: v}}))
  const cd = form.comp_data || {}

  // One unified stage list for every deal. Deals stored with an off-list token
  // (from the brief track-split era) display as the nearest column and are
  // rewritten only when the agent actually changes the stage.
  const formTrack  = UNIFIED
  const formStages = TRACKS[UNIFIED].stages
  const applyTrackChange = (patch) => setForm(p => (
    { ...p, ...patch, comp_data: { ...(p.comp_data || {}), ...(patch.comp_data || {}) } }
  ))

  const COMM_SUBTYPES = ['multifamily','office','land','retail','industrial','mixed-use']

  const save = async () => {
    const e = {}
    if (!form.title.trim()) e.title = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    try {
      // Explicit whitelist — never spread full form object (prevents unknown-column schema errors)
      const payload = {
        title:               form.title.trim(),
        stage:               form.stage,
        value:               form.value !== '' && form.value !== null ? Number(form.value) : null,
        probability:         Number(form.probability) || 0,
        expected_close_date: form.expected_close_date || null,
        contact_id:          form.contact_id   || null,
        property_id:         form.property_id  || null,
        agent_id:            form.agent_id     || null,
        notes:               form.notes        || null,
        prop_category:       form.prop_category || null,
        prop_subtype:        form.prop_subtype  || null,
        comp_data:           form.comp_data     || null,
      }
      let error
      if (deal?.id) {
        ;({ error } = await supabase.from('deals').update(payload).eq('id', deal.id))
      } else {
        ;({ error } = await supabase.from('deals').insert([payload]))
      }
      if (error) { pushToast(error.message, 'error'); return }
      pushToast(deal?.id ? 'Deal updated' : 'Deal added')
      await onSave()
      onClose()
    } catch(err) {
      console.error('[DealDrawer] save error:', err)
      pushToast('Something went wrong.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const isExisting = !!deal?.id

  return (
    <Drawer open={open} onClose={onClose} title={deal?.id ? (form.title || 'Edit Deal') : 'Add Deal'} width={500}>
      {/* Tab bar — only for existing deals */}
      {isExisting && (
        <div className="drawer-tabs">
          {[['details','Details'],['dates','Key Dates'],['checklist','Checklist'],['documents','Documents'],['signatures','Signatures'],['portal','Client Portal']].map(([id, label]) => (
            <button key={id} className={`drawer-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Details tab */}
      {tab === 'details' && (
        <>
          <div className="drawer__body">
            <div className="form-group"><label className="form-label required">Deal Title</label><input className={`form-control${errors.title?' error':''}`} value={form.title} onChange={e=>set('title',e.target.value)} placeholder="e.g. 123 Main St Purchase" /></div>

            {/* Residential / Commercial toggle */}
            <div className="form-group">
              <label className="form-label">Property Category</label>
              <div style={{ display:'flex', gap:0, border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                {['residential','commercial'].map(cat => (
                  <button key={cat} type="button" onClick={() => applyTrackChange({ prop_category: cat, ...(cat === 'residential' ? { prop_subtype: '' } : {}) })}
                    style={{ flex:1, padding:'7px 0', border:'none', cursor:'pointer', fontFamily:'var(--font-body)', fontSize:12, fontWeight:600, transition:'all 150ms',
                      background: form.prop_category === cat ? 'var(--gw-slate)' : '#fff',
                      color:      form.prop_category === cat ? '#fff'            : 'var(--gw-mist)' }}>
                    {cat.charAt(0).toUpperCase()+cat.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Residential: which side of the deal we represent — decides the
                buyer/seller board and stage track. Shares the Forms tab's
                comp_data.transaction_type field. */}
            {form.prop_category !== 'commercial' && (
              <div className="form-group">
                <label className="form-label">Representing</label>
                <div style={{ display:'flex', gap:0, border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                  {[['buyer','Buyer'],['seller','Seller']].map(([side, label]) => {
                    const selected = (cd.transaction_type === 'seller') === (side === 'seller')
                    return (
                      <button key={side} type="button" onClick={() => applyTrackChange({ comp_data: { transaction_type: side } })}
                        style={{ flex:1, padding:'7px 0', border:'none', cursor:'pointer', fontFamily:'var(--font-body)', fontSize:12, fontWeight:600, transition:'all 150ms',
                          background: selected ? 'var(--gw-slate)' : '#fff',
                          color:      selected ? '#fff'            : 'var(--gw-mist)' }}>
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Commercial subtype */}
            {form.prop_category === 'commercial' && (
              <div className="form-group">
                <label className="form-label">Commercial Type</label>
                <select className="form-control" value={form.prop_subtype||''} onChange={e=>set('prop_subtype',e.target.value)}>
                  <option value="">— Select type —</option>
                  {COMM_SUBTYPES.map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
                </select>
              </div>
            )}

            <div className="form-group"><label className="form-label">Stage</label><select className="form-control" value={formStages.includes(form.stage) ? form.stage : boardStageFor(form, formTrack)} onChange={e=>set('stage',e.target.value)}>{formStages.map(s=><option key={s} value={s}>{STAGE_LABELS[s]}</option>)}</select></div>
            <div className="form-row">
              <div className="form-group"><label className="form-label">Sale / Deal Value</label><input className="form-control" type="number" value={form.value||''} onChange={e=>set('value',e.target.value)} placeholder="0" /></div>
              <div className="form-group"><label className="form-label">Probability %</label><input className="form-control" type="number" min="0" max="100" value={form.probability||0} onChange={e=>set('probability',e.target.value)} /></div>
            </div>
            <div className="form-group"><label className="form-label">Expected Close Date</label><input className="form-control" type="date" value={form.expected_close_date||''} onChange={e=>set('expected_close_date',e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Contact</label><SearchDropdown items={contacts} value={form.contact_id} onSelect={v=>set('contact_id',v)} placeholder="Search contacts…" labelKey={c=>`${c.first_name} ${c.last_name}`} /></div>
            <div className="form-group"><label className="form-label">Property</label><SearchDropdown items={properties} value={form.property_id} onSelect={v=>set('property_id',v)} placeholder="Search properties…" labelKey="address" /></div>
            <div className="form-group"><label className="form-label">Assigned Agent</label><select className="form-control" value={form.agent_id||''} onChange={e=>set('agent_id',e.target.value)}><option value="">Unassigned</option>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></div>

            {/* ── Comp Data ─────────────────────────────────────── */}
            <div style={{ borderTop:'1px solid var(--gw-border)', paddingTop:14, marginTop:4 }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:12 }}>Comp Data</div>

              {form.prop_category === 'residential' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Beds</label><input className="form-control" type="number" value={cd.beds||''} onChange={e=>setCD('beds',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Baths</label><input className="form-control" type="number" step="0.5" value={cd.baths||''} onChange={e=>setCD('baths',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Garage</label>
                      <select className="form-control" value={cd.garage??''} onChange={e=>setCD('garage',e.target.value)}>
                        <option value="">—</option><option value="0">No Garage</option><option value="1">1 Car</option><option value="2">2 Car</option><option value="3">3+ Car</option>
                      </select>
                    </div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'multifamily' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Total Units</label><input className="form-control" type="number" value={cd.total_units||''} onChange={e=>setCD('total_units',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / Unit</label><input className="form-control" type="number" value={cd.price_per_unit||''} onChange={e=>setCD('price_per_unit',e.target.value)} /></div>
                  </div>
                  <div className="form-group"><label className="form-label">Unit Mix</label><input className="form-control" value={cd.unit_mix||''} onChange={e=>setCD('unit_mix',e.target.value)} placeholder="e.g. 10×1BR, 5×2BR" /></div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">City / County</label><input className="form-control" value={cd.city||''} onChange={e=>setCD('city',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Sq Ft (total)</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'land' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Acres</label><input className="form-control" type="number" step="0.01" value={cd.acres||''} onChange={e=>setCD('acres',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Status</label>
                      <select className="form-control" value={cd.land_status||''} onChange={e=>setCD('land_status',e.target.value)}>
                        <option value="">—</option><option value="raw">Raw Land</option><option value="developed">Developed</option><option value="ready">Ready to Build</option>
                      </select>
                    </div>
                    <div className="form-group"><label className="form-label">Zoning</label><input className="form-control" value={cd.zoning||''} onChange={e=>setCD('zoning',e.target.value)} placeholder="R-1, C-2…" /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'office' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / SF</label><input className="form-control" type="number" step="0.01" value={cd.price_per_sf||''} onChange={e=>setCD('price_per_sf',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Class</label>
                      <select className="form-control" value={cd.class||''} onChange={e=>setCD('class',e.target.value)}>
                        <option value="">—</option><option value="A">Class A</option><option value="B">Class B</option><option value="C">Class C</option>
                      </select>
                    </div>
                    <div className="form-group"><label className="form-label">Floors</label><input className="form-control" type="number" value={cd.floors||''} onChange={e=>setCD('floors',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'retail' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / SF</label><input className="form-control" type="number" step="0.01" value={cd.price_per_sf||''} onChange={e=>setCD('price_per_sf',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Frontage (ft)</label><input className="form-control" type="number" value={cd.frontage||''} onChange={e=>setCD('frontage',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Parking Spaces</label><input className="form-control" type="number" value={cd.parking||''} onChange={e=>setCD('parking',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'industrial' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / SF</label><input className="form-control" type="number" step="0.01" value={cd.price_per_sf||''} onChange={e=>setCD('price_per_sf',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Clear Height (ft)</label><input className="form-control" type="number" value={cd.clear_height||''} onChange={e=>setCD('clear_height',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Loading Docks</label><input className="form-control" type="number" value={cd.loading_docks||''} onChange={e=>setCD('loading_docks',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && !form.prop_subtype && (
                <div style={{ fontSize:12, color:'var(--gw-mist)', textAlign:'center', padding:'8px 0' }}>Select a commercial type above to enter comp data.</div>
              )}
            </div>

            <div className="form-group" style={{ marginTop:4 }}><label className="form-label">Notes</label><textarea className="form-control form-control--textarea" value={form.notes||''} onChange={e=>set('notes',e.target.value)} /></div>
          </div>
          <div className="drawer__foot">
            <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Deal'}</button>
          </div>
        </>
      )}

      {/* Key Dates tab */}
      {tab === 'dates' && isExisting && (
        <KeyDatesTab deal={deal} />
      )}

      {/* Checklist tab */}
      {tab === 'checklist' && isExisting && (
        <ChecklistTab deal={deal} />
      )}

      {/* Documents tab */}
      {tab === 'documents' && isExisting && (
        <DocumentsTab deal={deal} />
      )}

      {/* Signatures tab */}
      {tab === 'signatures' && isExisting && (
        <SignaturesTab deal={deal} contacts={contacts} properties={properties} activeAgent={activeAgent} />
      )}

      {/* Client Portal tab */}
      {tab === 'portal' && isExisting && (
        <PortalTab deal={deal} />
      )}
    </Drawer>
  )
}

const AUTO_TASKS = STAGE_AUTO_TASKS

const LISTING_STATUS_ORDER  = ['active','pending','off-market','sold','leased','cancelled']
const LISTING_STATUS_LABELS = { active:'Active', pending:'Pending', 'off-market':'Off Market', sold:'Sold', leased:'Leased', cancelled:'Cancelled' }
const LISTING_STATUS_COLORS = { active:'#10b981', pending:'#f59e0b', 'off-market':'#9ca3af', sold:'#3b82f6', leased:'#8b5cf6', cancelled:'#dc2626' }

function daysOnMarket(dateStr) {
  if (!dateStr) return null
  return Math.max(0, Math.floor((Date.now() - new Date(dateStr)) / 86_400_000))
}

function ListingCard({ property, agent, deals = [], onClick, onDelete, draggable, onDragStart, onDragEnd, dragging }) {
  const dom         = daysOnMarket(property.created_at)
  const isRes       = isResidentialPropertyType(property.type)
  const statusColor = LISTING_STATUS_COLORS[property.status] || '#9ca3af'
  const domAlert    = dom !== null && dom > 30 && property.status === 'active'

  // Expiry alert
  let daysToExpiry = null
  let expiryAlert  = false
  if (property.listing_expiry_date && property.status === 'active') {
    daysToExpiry = Math.ceil((new Date(property.listing_expiry_date) - Date.now()) / 86_400_000)
    expiryAlert  = daysToExpiry >= 0 && daysToExpiry <= 14
  }

  // Offer / under-contract badge from linked deals
  const linkedDeals    = deals.filter(d => d.property_id === property.id)
  const underContract  = linkedDeals.some(d => d.stage === 'under-contract')
  const offerCount     = linkedDeals.filter(d => ['offer','under-contract'].includes(d.stage)).length

  // Most recent price reduction
  const priceHistory  = Array.isArray(property.price_history) ? property.price_history : []
  const lastReduction = priceHistory.length > 0 ? priceHistory[priceHistory.length - 1] : null

  return (
    <div className={`deal-card${dragging ? ' dragging' : ''}`} style={{ cursor: onClick ? 'pointer' : 'default' }}
         onClick={onClick} draggable={draggable} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      {expiryAlert && (
        <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:5, fontSize:10, fontWeight:700, color: daysToExpiry === 0 ? '#dc2626' : '#d97706' }}>
          <span>⚠</span>
          <span>Listing expires {daysToExpiry === 0 ? 'today' : `in ${daysToExpiry}d`}</span>
        </div>
      )}
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:6, marginBottom:4 }}>
        <div style={{ fontSize:12, fontWeight:600, color:'var(--gw-ink)', lineHeight:1.35 }}>{property.address}</div>
        <span style={{ fontSize:10, fontWeight:700, color: statusColor, whiteSpace:'nowrap', flexShrink:0 }}>
          {LISTING_STATUS_LABELS[property.status] || property.status}
        </span>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4, flexWrap:'wrap' }}>
        <Badge variant="neutral" style={{ fontSize:10 }}>{property.type}</Badge>
        {property.list_price > 0 && (
          <span style={{ fontSize:12, fontWeight:700, color:'var(--gw-slate)' }}>{formatCurrency(property.list_price)}</span>
        )}
        {offerCount > 0 && (
          <span style={{ fontSize:10, fontWeight:700, padding:'1px 6px', borderRadius:10, background: underContract ? '#dcfce7' : '#fef3c7', color: underContract ? '#16a34a' : '#d97706', whiteSpace:'nowrap' }}>
            {underContract ? 'Under contract' : `${offerCount} offer${offerCount !== 1 ? 's' : ''}`}
          </span>
        )}
      </div>
      {isRes && (property.beds || property.baths) && (
        <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:3 }}>
          {property.beds ? `${property.beds} bd` : ''}{property.beds && property.baths ? ' · ' : ''}{property.baths ? `${property.baths} ba` : ''}
          {property.sqft ? ` · ${Number(property.sqft).toLocaleString()} sqft` : ''}
        </div>
      )}
      {lastReduction && (
        <div style={{ fontSize:10, color:'#dc2626', marginBottom:3, fontWeight:600 }}>
          ↓ {formatCurrency(Math.abs(Number(lastReduction.previous_price) - Number(lastReduction.price)))}
          {' · '}{Math.floor((Date.now() - new Date(lastReduction.date)) / 86_400_000)}d ago
        </div>
      )}
      <div className="deal-card__meta" style={{ marginTop:4 }}>
        <div style={{ fontSize:10, color: domAlert ? '#dc2626' : 'var(--gw-mist)', fontWeight: domAlert ? 700 : 400 }}>
          {property.mls_number ? `MLS# ${property.mls_number}` : ''}
          {property.mls_number && dom !== null ? ' · ' : ''}
          {dom !== null ? `${dom}d on market` : ''}
          {domAlert ? ' ⚠' : ''}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:4 }}>
          {agent && <Avatar agent={agent} size={20} />}
          {onDelete && (
            <button className="btn btn--ghost btn--icon" style={{ padding:2 }} title="Remove listing"
              onClick={e => { e.stopPropagation(); onDelete() }}>
              <Icon name="trash" size={11} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function PipelinePage({ db, setDb, activeAgent, isAdmin, dealAgentIds, go }) {
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState(null)
  const [defaultStage, setDefaultStage] = useState('lead')
  const [pipelineTab, setPipelineTab] = useState('deals')
  // Board | List | Focus — remembered per agent; first visit defaults by specialty
  // (commercial agents read few high-value deals best as a table).
  const viewKey = `gw_deal_view_${activeAgent?.id || 'default'}`
  const [dealView, setDealView] = useState(() => {
    const saved = localStorage.getItem(viewKey)
    if (['board', 'list', 'focus'].includes(saved)) return saved
    return activeAgent?.specialty === 'commercial' ? 'list' : 'board'
  })
  const pickView = (v) => { setDealView(v); localStorage.setItem(viewKey, v) }
  const [sortBy, setSortBy] = useState({ col: 'updated', dir: 'desc' })
  const [confirm, setConfirm] = useState(null)
  const [confirmProp, setConfirmProp] = useState(null)
  const [dragging, setDragging] = useState(null)
  const [dragOver, setDragOver] = useState(null)
  const [dragListing, setDragListing] = useState(null)
  const [dragOverStatus, setDragOverStatus] = useState(null)
  const [agentFilter, setAgentFilter] = useState('all')

  const deals      = db.deals      || []
  const agents     = db.agents     || []
  const contacts   = db.contacts   || []
  const properties = db.properties || []
  const tasks      = db.tasks      || []

  // O(1) lookups — built once per data change, not per-card in render loop
  const contactMap  = useMemo(() => Object.fromEntries(contacts.map(c => [c.id, c])),   [contacts])
  const agentMap    = useMemo(() => Object.fromEntries(agents.map(a => [a.id, a])),     [agents])
  const propertyMap = useMemo(() => Object.fromEntries(properties.map(p => [p.id, p])), [properties])

  // Filter deals for admin view (by agent) or show all
  const visibleDeals = useMemo(() => {
    if (!isAdmin || agentFilter === 'all') return deals
    return deals.filter(d => d.agent_id === agentFilter)
  }, [deals, isAdmin, agentFilter])

  // One unified pipeline — every deal on the same board (no res/comm split).
  const resolvedTrack = UNIFIED
  const track = TRACKS[UNIFIED]
  const trackDeals = visibleDeals

  // Single-pass O(n) grouping into the active track's columns. Foreign stage
  // tokens (legacy data) land in the nearest column via boardStageFor — the
  // stored stage is rewritten only when the card is dragged.
  const { stageGroups, stageTotals, totalValue } = useMemo(() => {
    const groups = Object.fromEntries(track.stages.map(s => [s, []]))
    const totals = Object.fromEntries(track.stages.map(s => [s, 0]))
    let total = 0
    trackDeals.forEach(d => {
      const col = boardStageFor(d, resolvedTrack)
      groups[col].push(d)
      totals[col] += d.value || 0
      total += d.value || 0
    })
    return { stageGroups: groups, stageTotals: totals, totalValue: total }
  }, [trackDeals, track, resolvedTrack])

  // ── Intelligence bar: open-deal rollups for the active track ───────────────
  const openTrackDeals = useMemo(() => trackDeals.filter(d => isOpenStage(d.stage)), [trackDeals])
  const intel = useMemo(() => {
    const t = pipelineTotals(openTrackDeals)
    const now = new Date(); const eom = new Date(now.getFullYear(), now.getMonth() + 1, 0)
    const closingThisMonth = openTrackDeals
      .filter(d => d.expected_close_date && new Date(d.expected_close_date) <= eom)
      .reduce((s, d) => s + (Number(d.value) || 0), 0)
    return { ...t, closingThisMonth }
  }, [openTrackDeals])

  // ── List view: flat, sortable rows for the active track ────────────────────
  const listRows = useMemo(() => {
    const now = new Date()
    const rows = trackDeals.map(d => {
      const act = dealActivityState(d, tasks, now)
      const kd  = nextKeyDate(d, now)
      return {
        deal: d, contact: contactMap[d.contact_id], agent: agentMap[d.agent_id],
        weighted: weightedValue(d), dis: daysInStage(d, now), rotting: isRotting(d, now),
        activity: act, keyDate: kd,
      }
    })
    const dir = sortBy.dir === 'asc' ? 1 : -1
    const val = (r) => {
      switch (sortBy.col) {
        case 'title':    return (r.deal.title || '').toLowerCase()
        case 'stage':    return track.stages.indexOf(boardStageFor(r.deal, resolvedTrack))
        case 'value':    return Number(r.deal.value) || 0
        case 'weighted': return r.weighted
        case 'close':    return r.deal.expected_close_date ? new Date(r.deal.expected_close_date).getTime() : Infinity * dir
        case 'keydate':  return r.keyDate ? r.keyDate.daysUntil : Infinity * dir
        case 'stale':    return r.dis ?? -1
        default:         return new Date(r.deal.updated_at || r.deal.created_at || 0).getTime()
      }
    }
    return rows.sort((a, b) => {
      const av = val(a), bv = val(b)
      if (typeof av === 'string') return av.localeCompare(bv) * dir
      return (av - bv) * dir
    })
  }, [trackDeals, tasks, contactMap, agentMap, sortBy, track, resolvedTrack])
  const toggleSort = (col) => setSortBy(s => s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: col === 'title' ? 'asc' : 'desc' })

  // ── Focus view: cross-track "needs attention today" ───────────────────────
  const focus = useMemo(() => focusItems(visibleDeals, tasks, new Date()), [visibleDeals, tasks])
  const focusCount = focus.length

  // Listings board — filter by agent if needed, group by property status
  const visibleListings = useMemo(() => {
    const all = properties
    if (!isAdmin || agentFilter === 'all') {
      if (!isAdmin && activeAgent) return all.filter(p => p.assigned_agent_id === activeAgent.id)
      return all
    }
    return all.filter(p => p.assigned_agent_id === agentFilter)
  }, [properties, isAdmin, agentFilter, activeAgent])

  const { listingGroups, listingTotals, totalListingValue } = useMemo(() => {
    const groups = Object.fromEntries(LISTING_STATUS_ORDER.map(s => [s, []]))
    const totals = Object.fromEntries(LISTING_STATUS_ORDER.map(s => [s, 0]))
    let total = 0
    visibleListings.forEach(p => {
      const key = p.status || 'active'
      if (groups[key]) {
        groups[key].push(p)
        totals[key] += p.list_price || 0
        total += p.list_price || 0
      }
    })
    return { listingGroups: groups, listingTotals: totals, totalListingValue: total }
  }, [visibleListings])

  const reload = useCallback(async () => {
    const { data } = await fetchVisibleDeals(supabase, {
      isAdmin, agentId: activeAgent?.id, dealAgentIds,
    })
    setDb(p => ({ ...p, deals: data || [] }))
  }, [setDb, isAdmin, dealAgentIds, activeAgent?.id])

  const del = useCallback(async (id) => {
    // Nullify deal_id on tasks before deletion to avoid FK constraint failures
    await supabase.from('tasks').update({ deal_id: null }).eq('deal_id', id)
    const { error } = await supabase.from('deals').delete().eq('id', id)
    if (error) { pushToast(error.message, 'error'); setConfirm(null); return }
    pushToast('Deal deleted', 'info')
    setConfirm(null); reload()
  }, [reload])

  // ── Listings: drag between statuses, delete, and open the linked deal ──────
  // Listings are `properties`; documents/signatures live on the deal that links
  // to a property (deal.property_id), so opening a listing routes to that deal.
  const moveListingStatus = useCallback(async (propertyId, newStatus) => {
    const { error } = await supabase.from('properties').update({ status: newStatus }).eq('id', propertyId)
    if (error) { pushToast(error.message, 'error'); return }
    setDb(p => ({ ...p, properties: (p.properties || []).map(pr => pr.id === propertyId ? { ...pr, status: newStatus } : pr) }))
    pushToast(`Listing moved to ${LISTING_STATUS_LABELS[newStatus]}`)
  }, [setDb])

  const delProperty = useCallback(async (id) => {
    // deals.property_id is ON DELETE SET NULL — linked deals are kept, just unlinked.
    const { error } = await supabase.from('properties').delete().eq('id', id)
    if (error) { pushToast(error.message, 'error'); setConfirmProp(null); return }
    setDb(p => ({ ...p, properties: (p.properties || []).filter(pr => pr.id !== id) }))
    pushToast('Listing removed', 'info'); setConfirmProp(null)
  }, [setDb])

  const openListing = useCallback((property) => {
    const linked = deals.filter(d => d.property_id === property.id)
    if (linked.length) {
      // Prefer an in-contract deal (either track's tokens); otherwise the most recent one.
      const target = linked.find(d => ['under-contract','psa','due-diligence','loi'].includes(d.stage)) || linked[0]
      go(`deal/${target.id}`)
      return
    } else {
      // No deal yet — open a new one prefilled from the property. Saving it
      // unlocks the Documents & Signatures tabs (those need an existing deal).
      setEditing({
        stage: 'lead',
        property_id: property.id,
        title: property.address || 'New Listing Deal',
        agent_id: property.assigned_agent_id || activeAgent?.id || '',
        prop_category: isResidentialPropertyType(property.type) ? 'residential' : 'commercial',
      })
    }
    setDrawer(true)
  }, [deals, activeAgent])

  // updated_at omitted — handled by DB trigger. We stamp comp_data.stage_since
  // so "days in stage" / rotting is precise going forward (no schema change).
  const moveStage = useCallback(async (dealId, newStage) => {
    const deal = deals.find(d => d.id === dealId)
    const comp_data = { ...(deal?.comp_data || {}), stage_since: new Date().toISOString() }
    await supabase.from('deals').update({ stage: newStage, comp_data }).eq('id', dealId)
    setDb(p => ({ ...p, deals: p.deals.map(d => d.id === dealId ? { ...d, stage: newStage, comp_data } : d) }))
    pushToast(`Moved to ${STAGE_LABELS[newStage]}`)

    const auto = AUTO_TASKS[newStage]
    if (!auto) return
    if (!deal) return
    const due = new Date()
    due.setDate(due.getDate() + auto.daysOut)
    due.setHours(9, 0, 0, 0)
    const { data: newTask } = await supabase.from('tasks').insert([{
      title: auto.title(deal),
      type: auto.type,
      priority: auto.priority,
      due_date: due.toISOString(),
      agent_id: deal.agent_id || null,
      contact_id: deal.contact_id || null,
      deal_id: dealId,
      completed: false,
    }]).select().single()
    if (newTask) {
      setDb(p => ({ ...p, tasks: [newTask, ...(p.tasks || [])] }))
      pushToast(`Task auto-created: ${newTask.title}`, 'info')
    }
  }, [setDb, deals])

  return (
    <div className="page-content" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header">
        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div className="page-title">Pipeline{isAdmin ? ' — Admin View' : ''}</div>
            {/* Tab toggle */}
            <div style={{ display:'flex', background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:3, gap:2 }}>
              {[['deals','Transactions'],['listings','Listings']].map(([id, label]) => (
                <button key={id} onClick={() => setPipelineTab(id)} style={{
                  padding:'5px 14px', border:'none', borderRadius:'var(--radius)', cursor:'pointer',
                  fontFamily:'var(--font-body)', fontSize:12, fontWeight:600,
                  background: pipelineTab === id ? 'var(--gw-slate)' : 'transparent',
                  color: pipelineTab === id ? '#fff' : 'var(--gw-mist)',
                  transition:'all 150ms ease',
                }}>{label}</button>
              ))}
            </div>
          </div>
          {pipelineTab === 'deals'
            ? (dealView === 'focus'
                ? <div className="page-sub">{focusCount === 0 ? 'Nothing needs attention right now — you’re clear.' : `${focusCount} item${focusCount !== 1 ? 's' : ''} need attention across all your open deals`}</div>
                : <div className="page-sub">
                    {track.label} · {intel.count} open · {formatCurrency(intel.value)} value
                    {' · '}<strong style={{ color: 'var(--gw-ink)' }}>{formatCurrency(intel.weighted)}</strong> weighted
                    {intel.closingThisMonth > 0 && <> · {formatCurrency(intel.closingThisMonth)} closing this month</>}
                  </div>)
            : <div className="page-sub">Your property inventory by status · {visibleListings.length} listing{visibleListings.length !== 1 ? 's' : ''} · {formatCurrency(totalListingValue)} listed</div>
          }
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
          {pipelineTab === 'deals' && (
            <div style={{ display:'flex', background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:3, gap:2 }}>
              {[['board','Board'],['list','List'],['focus','Focus']].map(([id, label]) => (
                <button key={id} onClick={() => pickView(id)} style={{
                  padding:'5px 12px', border:'none', borderRadius:'var(--radius)', cursor:'pointer',
                  fontFamily:'var(--font-body)', fontSize:12, fontWeight:600, display:'flex', alignItems:'center', gap:6,
                  background: dealView === id ? 'var(--gw-slate)' : 'transparent',
                  color: dealView === id ? '#fff' : 'var(--gw-mist)', transition:'all 150ms ease',
                }}>
                  {label}
                  {id === 'focus' && focusCount > 0 && (
                    <span style={{ fontSize:10, fontWeight:700, padding:'0 6px', borderRadius:8, lineHeight:'16px',
                      background: dealView === id ? 'rgba(255,255,255,0.22)' : '#fde2e2', color: dealView === id ? '#fff' : '#dc2626' }}>{focusCount}</span>
                  )}
                </button>
              ))}
            </div>
          )}
          {isAdmin && (
            <select
              value={agentFilter}
              onChange={e => setAgentFilter(e.target.value)}
              className="form-control"
              style={{ fontSize:13, minWidth:160 }}
            >
              <option value="all">All Agents</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          {!isAdmin && pipelineTab === 'deals' && (
            <button className="btn btn--primary" onClick={() => { setEditing(null); setDefaultStage(track.stages[0]); setDrawer(true) }}>
              <Icon name="plus" size={14} /> Add Deal
            </button>
          )}
        </div>
      </div>

      {pipelineTab === 'deals' && dealView === 'board' && (
        deals.length === 0 ? (
          <EmptyState icon="pipeline" title="No deals yet" message="Add your first deal to start tracking your pipeline." action={<button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Deal</button>} />
        ) : (
          <div className="kanban-board">
            {track.stages.map(stage => (
              <div key={stage} className="kanban-col">
                <div className="kanban-col__head">
                  <div>
                    <div className="kanban-col__label">{STAGE_LABELS[stage]}</div>
                    {stageTotals[stage] > 0 && <div style={{ fontSize:10, color:'var(--gw-mist)', marginTop:1 }}>{formatCurrency(stageTotals[stage])}</div>}
                  </div>
                  <span className="kanban-col__count">{stageGroups[stage].length}</span>
                </div>
                <div
                  className={`kanban-col__body${dragOver === stage ? ' drag-over' : ''}`}
                  onDragOver={e => { e.preventDefault(); setDragOver(stage) }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={e => { e.preventDefault(); if (dragging && dragging !== stage) moveStage(dragging, stage); setDragOver(null); setDragging(null) }}
                >
                  {stageGroups[stage].map(deal => {
                    const contact    = contactMap[deal.contact_id]
                    const agent      = agentMap[deal.agent_id]
                    const dealProp   = deal.property_id ? propertyMap[deal.property_id] : null
                    const coAgIds    = dealProp?.details?.co_agent_ids || []
                    const allAgents  = [deal.agent_id, ...coAgIds].filter(Boolean)
                      .map(id => agentMap[id]).filter(Boolean)
                      .filter((a, i, arr) => arr.findIndex(x => x.id === a.id) === i)
                    const overdue    = deal.expected_close_date && new Date(deal.expected_close_date) < new Date() && stage !== 'closed' && stage !== 'lost'
                    const urgency    = getKeyDateUrgency(deal)
                    const nearestKD  = urgency ? getNearestKeyDate(deal) : null
                    const act        = dealActivityState(deal, tasks)
                    const rotting    = isRotting(deal)
                    const dis        = daysInStage(deal)
                    const wtd        = weightedValue(deal)
                    const cardBorder = urgency === 'urgent' ? '2px solid #ef4444' : urgency === 'warning' ? '2px solid #f59e0b' : undefined
                    const cardBg     = urgency === 'urgent' ? '#fef2f2' : urgency === 'warning' ? '#fffbeb' : undefined
                    return (
                      <div key={deal.id} className={`deal-card${dragging === deal.id ? ' dragging' : ''}`}
                        style={{ border: cardBorder, background: cardBg }}
                        draggable
                        onDragStart={() => setDragging(deal.id)}
                        onDragEnd={() => { setDragging(null); setDragOver(null) }}
                        onClick={() => go(`deal/${deal.id}`)}
                      >
                        {urgency && nearestKD && (
                          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:5, fontSize:10, fontWeight:700, color: urgency === 'urgent' ? '#dc2626' : '#d97706' }}>
                            <span style={{ fontSize:11 }}>⚠</span>
                            <span>{nearestKD.type}: {nearestKD.daysUntil === 0 ? 'Today' : nearestKD.daysUntil === 1 ? 'Tomorrow' : `${nearestKD.daysUntil} days`}</span>
                          </div>
                        )}
                        <div style={{ display:'flex', alignItems:'flex-start', gap:6 }}>
                          <span title={act.state === 'overdue' ? `Task overdue ${act.overdueBy}d` : act.state === 'scheduled' ? 'Next step scheduled' : 'No next step planned'}
                            style={{ width:8, height:8, borderRadius:'50%', flexShrink:0, marginTop:4,
                              background: act.color, boxShadow: act.state === 'none' ? 'inset 0 0 0 1px var(--gw-border)' : undefined }} />
                          <div className="deal-card__title" style={{ flex:1 }}>{deal.title}</div>
                        </div>
                        {isAdmin && agent && (
                          <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
                            <Avatar agent={agent} size={14} />
                            <span style={{ fontSize:10, color:'var(--gw-mist)' }}>{agent.name}</span>
                          </div>
                        )}
                        {contact && <div className="deal-card__contact">{contact.first_name} {contact.last_name}</div>}
                        {deal.value > 0 && (
                          <div className="deal-card__value">
                            {formatCurrency(deal.value)}
                            {deal.probability > 0 && deal.probability < 100 && (
                              <span style={{ fontSize:10, fontWeight:500, color:'var(--gw-mist)', marginLeft:6 }}>wtd {formatCurrency(wtd)}</span>
                            )}
                          </div>
                        )}
                        {rotting && (
                          <div style={{ display:'inline-flex', alignItems:'center', gap:3, marginTop:3, fontSize:10, fontWeight:700, color:'#b45309', background:'#fef3c7', padding:'1px 6px', borderRadius:6 }}>
                            ⚠ Idle {dis}d
                          </div>
                        )}
                        <div className="deal-card__meta">
                          <div style={{ fontSize:11, color: overdue ? 'var(--gw-red)' : 'var(--gw-mist)' }}>
                            {deal.expected_close_date ? formatDate(deal.expected_close_date) : ''}
                          </div>
                          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                            {deal.probability > 0 && <span style={{ fontSize:10, color:'var(--gw-mist)' }}>{deal.probability}%</span>}
                            <div style={{ display:'flex', alignItems:'center' }}>
                              {allAgents.slice(0, 3).map((a, i) => (
                                <div key={a.id} style={{ marginLeft: i > 0 ? -5 : 0, zIndex: 10 - i, position: 'relative' }}>
                                  <Avatar agent={a} size={20} />
                                </div>
                              ))}
                            </div>
                            <button className="btn btn--ghost btn--icon" style={{ padding:2 }} title="Delete deal" onClick={e=>{e.stopPropagation(); setConfirm(deal.id)}}><Icon name="trash" size={11} /></button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {!isAdmin && (
                    <button className="btn btn--ghost" style={{ width:'100%', justifyContent:'center', fontSize:12, marginTop:'auto', borderStyle:'dashed', border:'1px dashed var(--gw-border)' }}
                      onClick={() => { setEditing(null); setDefaultStage(stage); setDrawer(true) }}>
                      <Icon name="plus" size={13} /> Add deal
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {/* ── LIST VIEW ── */}
      {pipelineTab === 'deals' && dealView === 'list' && (
        trackDeals.length === 0 ? (
          <EmptyState icon="pipeline" title={`No ${track.label.toLowerCase()} deals`} message="Switch tracks above, or add a deal to this one." />
        ) : (
          <div style={{ flex:1, minHeight:0, overflow:'auto', border:'1px solid var(--gw-border)', borderRadius:'var(--radius-lg)', background:'#fff' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ background:'var(--gw-bone)', textAlign:'left' }}>
                  {[['', ''],['title','Deal'],['stage','Stage'],['value','Value'],['weighted','Weighted'],['close','Close'],['keydate','Next Key Date'],['stale','In Stage'],['agents','Team']].map(([col, label]) => (
                    <th key={col || 'dot'} onClick={() => col && toggleSort(col)}
                      style={{ padding:'9px 12px', fontSize:11, fontWeight:700, color:'var(--gw-mist)', textTransform:'uppercase', letterSpacing:'0.05em',
                        cursor: col ? 'pointer' : 'default', whiteSpace:'nowrap', userSelect:'none', position:'sticky', top:0, background:'var(--gw-bone)' }}>
                      {label}{sortBy.col === col && col ? (sortBy.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {listRows.map(({ deal, contact, weighted, dis, rotting, activity, keyDate }) => {
                  const col = boardStageFor(deal, resolvedTrack)
                  const teamAgents = [deal.agent_id, ...((propertyMap[deal.property_id]?.details?.co_agent_ids) || [])]
                    .filter(Boolean).map(id => agentMap[id]).filter(Boolean)
                    .filter((a, i, arr) => arr.findIndex(x => x.id === a.id) === i)
                  const kdColor = keyDate == null ? 'var(--gw-mist)' : keyDate.daysUntil <= 2 ? '#dc2626' : keyDate.daysUntil <= 7 ? '#d97706' : 'var(--gw-ink)'
                  return (
                    <tr key={deal.id} onClick={() => go(`deal/${deal.id}`)}
                      style={{ borderTop:'1px solid var(--gw-border)', cursor:'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--gw-bone)'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <td style={{ padding:'9px 12px' }}>
                        <span title={activity.state === 'overdue' ? `Overdue ${activity.overdueBy}d` : activity.state === 'scheduled' ? 'Next step scheduled' : 'No next step'}
                          style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:activity.color, boxShadow: activity.state === 'none' ? 'inset 0 0 0 1px var(--gw-border)' : undefined }} />
                      </td>
                      <td style={{ padding:'9px 12px', maxWidth:260 }}>
                        <div style={{ fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{deal.title}</div>
                        {contact && <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{contact.first_name} {contact.last_name}</div>}
                      </td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap' }}><Badge variant={col === 'closed' ? 'closed' : col === 'lost' ? 'lost' : 'lead'}>{STAGE_LABELS[col]}</Badge></td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap', fontWeight:600 }}>{deal.value > 0 ? formatCurrency(deal.value) : '—'}</td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap', color:'var(--gw-mist)' }}>{deal.value > 0 ? formatCurrency(weighted) : '—'}</td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap' }}>{deal.expected_close_date ? formatDate(deal.expected_close_date) : '—'}</td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap', color:kdColor, fontWeight: keyDate && keyDate.daysUntil <= 7 ? 700 : 400 }}>
                        {keyDate ? `${keyDate.type} · ${keyDate.daysUntil === 0 ? 'today' : keyDate.daysUntil === 1 ? '1d' : `${keyDate.daysUntil}d`}` : '—'}
                      </td>
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap', color: rotting ? '#b45309' : 'var(--gw-mist)', fontWeight: rotting ? 700 : 400 }}>
                        {dis == null ? '—' : `${dis}d`}{rotting ? ' ⚠' : ''}
                      </td>
                      <td style={{ padding:'9px 12px' }}>
                        <div style={{ display:'flex' }}>
                          {teamAgents.slice(0, 3).map((a, i) => (
                            <div key={a.id} style={{ marginLeft: i > 0 ? -5 : 0, zIndex: 10 - i, position:'relative' }}><Avatar agent={a} size={20} /></div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* ── FOCUS VIEW ── */}
      {pipelineTab === 'deals' && dealView === 'focus' && (
        focus.length === 0 ? (
          <EmptyState icon="check" title="You're all clear" message="No overdue tasks, looming deadlines, or stalled deals across your pipeline. Nice." />
        ) : (
          <div style={{ flex:1, minHeight:0, overflow:'auto', display:'flex', flexDirection:'column', gap:8, maxWidth:760, paddingRight:4 }}>
            {focus.map((item, i) => {
              const dot = item.severity === 'critical' ? '#dc2626' : '#d97706'
              const icon = item.kind === 'task' ? '⏰' : item.kind === 'date' ? '📅' : '⚠'
              return (
                <div key={`${item.deal.id}-${item.kind}-${i}`} onClick={() => go(`deal/${item.deal.id}`)}
                  className="card" style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', cursor:'pointer', borderLeft:`3px solid ${dot}` }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--gw-bone)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}>
                  <span style={{ fontSize:18 }}>{icon}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontWeight:600, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{item.deal.title}</div>
                    <div style={{ fontSize:12, color: item.severity === 'critical' ? '#dc2626' : '#b45309', fontWeight:600 }}>
                      {item.label}{item.detail ? <span style={{ color:'var(--gw-mist)', fontWeight:400 }}> — {item.detail}</span> : ''}
                    </div>
                  </div>
                  <Badge variant={item.deal.prop_category === 'commercial' ? 'commercial' : 'residential'}>
                    {STAGE_LABELS[item.deal.stage] || item.deal.stage}
                  </Badge>
                </div>
              )
            })}
          </div>
        )
      )}

      {pipelineTab === 'listings' && (
        visibleListings.length === 0 ? (
          <EmptyState icon="properties" title="No listings yet" message="Add properties in the Properties page and they'll appear here grouped by status." />
        ) : (
          <div className="kanban-board">
            {LISTING_STATUS_ORDER.map(status => (
              <div key={status} className="kanban-col">
                <div className="kanban-col__head">
                  <div>
                    <div className="kanban-col__label" style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <span style={{ width:8, height:8, borderRadius:'50%', background: LISTING_STATUS_COLORS[status], flexShrink:0, display:'inline-block' }} />
                      {LISTING_STATUS_LABELS[status]}
                    </div>
                    {listingTotals[status] > 0 && (
                      <div style={{ fontSize:10, color:'var(--gw-mist)', marginTop:1 }}>{formatCurrency(listingTotals[status])}</div>
                    )}
                  </div>
                  <span className="kanban-col__count">{listingGroups[status].length}</span>
                </div>
                <div
                  className={`kanban-col__body${dragOverStatus === status ? ' drag-over' : ''}`}
                  onDragOver={e => { e.preventDefault(); setDragOverStatus(status) }}
                  onDragLeave={() => setDragOverStatus(null)}
                  onDrop={e => { e.preventDefault(); if (dragListing) moveListingStatus(dragListing, status); setDragOverStatus(null); setDragListing(null) }}
                >
                  {listingGroups[status].length === 0 ? (
                    <div style={{ fontSize:12, color:'var(--gw-border)', textAlign:'center', padding:'20px 0', fontStyle:'italic' }}>Drop a listing here</div>
                  ) : (
                    listingGroups[status].map(property => (
                      <ListingCard
                        key={property.id}
                        property={property}
                        agent={agentMap[property.assigned_agent_id]}
                        deals={deals}
                        onClick={() => openListing(property)}
                        onDelete={() => setConfirmProp(property.id)}
                        draggable
                        dragging={dragListing === property.id}
                        onDragStart={() => setDragListing(property.id)}
                        onDragEnd={() => { setDragListing(null); setDragOverStatus(null) }}
                      />
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      <DealDrawer open={drawer} onClose={() => setDrawer(false)}
        deal={editing ? editing : { stage: defaultStage }}
        agents={agents} contacts={contacts} properties={properties} activeAgent={activeAgent} onSave={reload} />
      {confirm && <ConfirmDialog message="This will permanently delete this deal." onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
      {confirmProp && <ConfirmDialog message="Remove this listing from the pipeline? Any linked deals are kept but will be unlinked from the property." onConfirm={() => delProperty(confirmProp)} onCancel={() => setConfirmProp(null)} />}
    </div>
  )
}
