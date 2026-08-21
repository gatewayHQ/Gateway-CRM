import React, { useState, useRef, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { fetchVisibleDeals } from '../lib/services/deals.js'
import { formatCurrency, formatDate, STAGE_LABELS, getKeyDateUrgency, getNearestKeyDate } from '../lib/helpers.js'
import { TRACKS, UNIFIED, boardStageFor, STAGE_AUTO_TASKS, isOpenStage } from '../lib/stages.js'
import { normalizeStageLabel, hasStageLabelOverrides, STAGE_LABEL_MAX } from '../lib/stageLabels.js'
import { useStageLabels } from '../lib/stageLabelContext.js'
import { saveStageLabels } from '../lib/services/agentProfile.js'
import {
  weightedValue, daysInStage, isRotting, dealActivityState, nextKeyDate,
  focusItems, pipelineTotals,
} from '../lib/pipeline.js'
import { isResidentialPropertyType } from '../lib/enums.js'
import { OPERATING_STATES } from '../lib/constants.js'
import { describeDealCommission } from '../lib/commission.js'
import { agentIdsOnDeal, coAgentIdsForNewDeal, isMissingCoAgentColumn } from '../lib/coAgents.js'
import {
  propertyContactIds, propertyExtrasNotOnDeal, seedPickerFromProperty,
  REPRESENTING_OPTIONS, SIDE_LABELS, representingFor, sidesFor,
  primaryContactIdFor, dealContactIdsForSide, propertyContactSide, isMissingSideColumn,
} from '../lib/dealPeople.js'
import { priceChanged } from '../lib/pricing.js'
import { syncPriceChange } from '../lib/services/pricing.js'
import { DealPricingHistoryTab } from '../components/PricingHistoryPanel.jsx'
import { friendlyDbError } from '../lib/dbErrors.js'
import { documentEmbedUrl, documentEditUrl, captureLayout, documentPdfUrl, getDocStatus, downloadSigned as apiDownloadSigned, downloadAudit as apiDownloadAudit, deleteDocument as apiDeleteDocument, remindDocument as apiRemindDocument, sendDraft as apiSendDraft, templateEmbedUrl, saveTemplateDraft, templateDetails, crmTokenValues, isFillableField, isTickableField, isPrefillableField, prefillFieldEntry, isSharedField, isSignerBoundField, isUnconfiguredField, isDateField, usDateToIso, isoDateToUs, signerBoundPrefillFields, buildPrefillFields, sharedDataOnSignerFields, conditionalFieldsToRemove, fieldTokenValue, fieldTokenKey, normalizeTokenKey, appointedAgent, orderAgentSigners, normalizeState, seedSignersFromDeal, dealAgentList, buildTemplateRoles, uploadSendablePdf, signSendableUrl, formatBytes as fmtBytes, MAX_SEND_BYTES } from '../lib/services/boldsign.js'
import BoldSignFrame from '../components/BoldSignFrame.jsx'
import { savePdfFromUrl } from '../lib/savePdf.js'
import { Icon, Badge, Avatar, Drawer, Modal, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'
import ContactMultiSelect from '../components/ContactMultiSelect.jsx'
import AgentMultiSelect from '../components/AgentMultiSelect.jsx'

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

// Where BoldSign should redirect an embedded iframe on exit — a same-origin
// STATIC page (public/boldsign-return.html), never the CRM's own live URL.
// BoldSign can redirect the IFRAME ITSELF to RedirectUrl (see BoldSignFrame's
// handleLoad), and `window.location.href` names the very page the iframe sits
// inside — so on that path the whole running CRM (header, sidebar, board and
// all) loaded a second time, recursively, inside its own small BoldSign
// iframe. The static return page just posts a marker back and stops; see
// FormLibrary.jsx's template editor for the same pattern already in place.
const boldSignReturnUrl = () => `${window.location.origin}/boldsign-return.html`

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

const DEFAULT_KEY_DATE_TYPES = ['Closing','Expiration','Financing Contingency','Inspection','HUD Approval','Appraisal','Lease Start Date','Possession Date']

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
    syncOutlookCalendar(deal.id)
  }

  // Best-effort, fire-and-forget: push the updated key dates onto the
  // assigned agent's Outlook calendar (api/email-send.js?action=outlook-calendar-sync).
  // Silently a no-op if Outlook isn't connected, or if the viewer isn't the
  // deal's assigned agent (only they may write to their own calendar) — either
  // way this must never block or interrupt the key-dates save itself, which
  // already has its own "Saving…"/"Changes auto-saved" feedback above.
  const syncOutlookCalendar = async (dealId) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return
      await fetch('/api/email-send?action=outlook-calendar-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ dealId }),
      })
    } catch {
      // best-effort — nightly api/cron.js?task=calendar-sync is the safety net
    }
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
    // Storage lists sub-folders as entries with no id. Filter those out: the
    // `print/` prefix holds throwaway review copies, and showing it here would put
    // a fake "print" document in the deal's filing list.
    setFiles((data || []).filter(f => f.name !== '.emptyFolderPlaceholder' && f.id))
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

// ── Embedded BoldSign step (prepare a new send, or edit an existing draft) ───
// One shell for every in-app BoldSign screen, because they all share the same
// failure mode: the iframe holds field placement the agent is part-way through,
// and Modal closes on a backdrop click or Escape with no warning. A click a few
// pixels outside the frame threw that work away, and the resulting draft had no
// way back into it. So closing always asks first, and always says where the work
// went — and the frame stays mounted through a draft save, since saving a draft
// mid-prep means the agent is still working.
//
// It is also where a deal's FIELD LAYOUT gets saved. Placement happens inside
// BoldSign's iframe, on another origin, so the app cannot watch the agent drag a
// field — it can only ask BoldSign afterwards what the document ended up holding.
// Every way an editing session can end (saved, sent, closed) therefore triggers a
// capture, which stores the arrangement against the deal so the NEXT packet built
// from the same template opens already arranged. See captureFieldLayout() in
// api/boldsign.js.
// Save the document as it stands to a PDF file. Shared by the editor header and the
// Signatures tab rows so both behave identically — the same copy, the same messages.
//
// This REPLACED a Print button that opened the browser's print dialog on the same
// copy. Chrome renders a PDF in an iframe through a plugin the page cannot drive, so
// print() succeeded and produced BLANK paper — silently, with nothing to catch. The
// file is downloaded instead: the agent gets a complete document they can read, keep
// and print from their own PDF viewer, which is the workflow anyway (fill it in the
// preview, take it to the client in person).
//
// The PDF itself is composed server-side (api/boldsign.js → buildPrintablePdf): every
// value the fields carry is drawn onto the pages, the source form is flattened, and a
// signing summary is appended. The browser never re-renders it — the document lives in
// BoldSign's cross-origin iframe, where the CRM has no access to its pixels.
async function saveBoldSignDocumentPdf(documentId) {
  const { url, filename, fieldCount } = await documentPdfUrl(documentId)
  if (!url) throw new Error('No PDF copy was returned')
  const res = await savePdfFromUrl(url, filename || 'document (filled).pdf')
  return { ...res, fieldCount }
}

function BoldSignStepModal({ url, documentId, eyebrow, heading, onClose, onDone, onDraft, onLayoutSaved, returnUrlMarker = 'boldsign-return' }) {
  const [savingLayout, setSavingLayout] = React.useState(false)
  const [savingPdf,    setSavingPdf]    = React.useState(false)
  const [leaveAsk,     setLeaveAsk]     = React.useState(false)
  // Work may exist that BoldSign hasn't been told to save. Set when focus enters the
  // editor (see BoldSignFrame's onInteract — the only honest cross-origin signal),
  // cleared when BoldSign reports a save, because at that instant nothing is
  // outstanding. This is what keeps the leave prompt meaningful: an agent who opened
  // the editor and immediately closed it is not warned about losing nothing.
  const [unsaved,      setUnsaved]      = React.useState(false)
  const [lastSavedAt,  setLastSavedAt]  = React.useState(null)
  // Set before an async close so a late unmount can't push state into a dead
  // component (React logs that as a leak, and it hides real errors).
  const alive = React.useRef(true)
  React.useEffect(() => () => { alive.current = false }, [])

  // Closing the TAB, reloading, or navigating away entirely bypasses every in-app
  // guard — the modal's confirm never runs and the work is simply gone. Only
  // beforeunload reaches that path. The browser shows its own generic wording (all
  // of them ignore a custom message now), which is fine: the point is the pause.
  // Registered only while work is plausibly outstanding, so an agent who has saved
  // isn't nagged for closing their browser.
  React.useEffect(() => {
    if (!unsaved) return
    const warn = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])

  // Ask BoldSign what this document now holds and store it on the deal.
  // `silent` suppresses the "nothing to save" chatter for automatic captures —
  // an agent who placed no fields doesn't need to be told about a subsystem.
  const saveLayout = async ({ silent = false } = {}) => {
    if (!documentId) return
    if (alive.current) setSavingLayout(true)
    try {
      const res = await captureLayout(documentId)
      if (res?.saved) { setLastSavedAt(new Date()) }
      if (res?.saved && res.fieldCount) {
        pushToast(`Field layout saved for this deal — ${res.fieldCount} field${res.fieldCount === 1 ? '' : 's'} will come back next time.`, 'success')
        onLayoutSaved?.(res)
      } else if (res?.unavailable) {
        // Provisioning, not a failure — but the agent should know why this deal
        // will not remember anything, and who can fix it.
        pushToast(`Field layouts are not stored yet — ${res.reason}`, 'info')
      } else if (!silent) {
        pushToast(res?.reason
          ? `Field layout not saved: ${res.reason}`
          : 'No fields to save yet — place fields in BoldSign and they will be remembered for this deal.', 'info')
      }
    } catch (err) {
      // Never fatal: the document itself is fine, only the convenience of
      // remembering its layout is lost, and the agent should know that.
      pushToast(`Could not save this deal's field layout: ${err.message}`, 'error')
    } finally {
      if (alive.current) setSavingLayout(false)
    }
  }

  // Deliberately available the whole time the editor is open — including while
  // BoldSign's own Preview is showing — because "let me take this to the client on
  // paper" is a step BEFORE deciding to send, not after.
  //
  // The copy is built from what BOLDSIGN holds, which is what its Save button has
  // written — values typed in the frame and not yet saved there cannot reach the
  // server. So an agent with outstanding work is told, rather than handed a PDF
  // that quietly misses the last thing they typed.
  const savePdf = async () => {
    if (!documentId) { pushToast('This document has to exist in BoldSign before it can be saved as a PDF.', 'info'); return }
    // The print copy is built from whatever BoldSign has actually SAVED
    // (/document/properties) — never from what's sitting typed but uncommitted
    // in the iframe. This used to just warn and build the PDF anyway, so filling
    // a field and immediately clicking Save PDF (without saving inside BoldSign
    // first) raced BoldSign's own save and came back with those fields blank —
    // the exact gap "More Actions → Save & Close" doesn't have, because closing
    // that way forces the save to complete first. Blocking here instead of just
    // warning is what makes Save PDF match Save & Close: neither can produce an
    // incomplete copy once this stands.
    if (unsaved) {
      pushToast('Click Save inside BoldSign first — the PDF is built from BoldSign’s saved copy, and it would come back missing whatever you just typed.', 'error')
      return
    }
    setSavingPdf(true)
    try {
      const res = await saveBoldSignDocumentPdf(documentId)
      pushToast(res.fieldCount
        ? `PDF saved — ${res.fieldCount} field${res.fieldCount === 1 ? '' : 's'} included.`
        : 'PDF saved.', 'success')
    } catch (err) {
      pushToast(`Could not save the PDF: ${err.message}`, 'error')
    } finally {
      setSavingPdf(false)
    }
  }

  // Escape, the backdrop and the X all land here. With nothing outstanding this just
  // closes — the draft is safe in BoldSign either way, and a confirm on every close
  // is a confirm nobody reads. With work outstanding it asks, in the words the
  // situation deserves.
  const requestClose = () => {
    if (leaveAsk) return          // already asking; a second Escape must not re-ask
    if (!unsaved) { leaveNow({ silent: true }); return }
    setLeaveAsk(true)
  }

  // Capture BEFORE unmounting the frame: once the modal is gone the agent has no way
  // to trigger this, and the arrangement they just built is the thing worth keeping.
  // This is the "persist what can be persisted" half of leaving — whatever BoldSign
  // reports as placed is stored against the deal on the way out.
  const leaveNow = async ({ silent = false } = {}) => {
    setSavingLayout(true)
    await saveLayout({ silent })
    setLeaveAsk(false)
    onClose()
  }

  return (
    // Workspace-sized (see .modal--workspace): ~95% of the viewport, because this is
    // a document being read and arranged, not a form being filled in. The old 900 ×
    // 640 box rendered a US Letter page small enough that agents were zooming
    // BoldSign in and then scrolling a page they could only see a third of at a
    // time. `width={null}` hands sizing to CSS — an inline width would override the
    // class and its phone fallback.
    <Modal open={true} onClose={requestClose} width={null} className="modal--workspace">
      <div className="modal__head">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow-label">{eyebrow}</div>
          <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{heading}</h3>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
          <button
            className="btn btn--secondary btn--sm"
            onClick={savePdf}
            disabled={savingPdf || !documentId}
            title="Download this document as a PDF — every filled value, plus a summary of who signs what"
          >
            <Icon name="document" size={13}/> {savingPdf ? 'Preparing…' : 'Save PDF'}
          </button>
          <button
            className="drawer__close"
            onClick={requestClose}
            disabled={savingLayout}
            title={savingLayout ? 'Saving this deal’s field layout…' : 'Close BoldSign'}
          >
            <Icon name="x" size={18}/>
          </button>
        </div>
      </div>
      <div className="modal__body">
        <BoldSignFrame
          fill
          url={url}
          onInteract={() => setUnsaved(true)}
          onDone={(e) => { setUnsaved(false); saveLayout({ silent: true }); onDone?.(e) }}
          // Saved-as-draft is NOT sent. Reporting it as sent (which is what
          // happened when both events shared one handler) left the agent
          // believing the client had the document. It IS the natural moment to
          // record the layout, though — the agent explicitly saved their work.
          // A BoldSign save means nothing is outstanding as of this instant. Any
          // further work in the frame sets the flag again via onInteract.
          onDraft={(e) => { setUnsaved(false); setLastSavedAt(new Date()); saveLayout(); onDraft?.(e) }}
          onError={() => pushToast('BoldSign reported the send was cancelled — the draft is still on this deal.', 'info')}
          returnUrlMarker={returnUrlMarker}
        />
      </div>
      {/* flexShrink:0 — the body is flex:1 and would otherwise squeeze this hint
          (and its saving state) down to nothing on a short viewport. */}
      {/* NOTE: rendered inside the workspace Modal so it stacks above it. Modal's
          own Escape handling means Escape here cancels the leave — the safe
          direction — and requestClose() ignores a repeat while this is open. */}
      <div style={{ padding:'8px 12px', borderTop:'1px solid var(--gw-border)', fontSize:11, color:'var(--gw-mist)', lineHeight:1.5, flexShrink:0 }}>
        {savingLayout
          ? <span aria-live="polite">Saving this deal’s field layout…</span>
          : <>Not ready to send? Use <strong>Preview</strong> inside BoldSign, or <strong>Save PDF</strong> above to download the document as it stands — filled values included, with a summary of who signs what — to print or take to the client. Nothing goes out until you click Send. Fields you place are remembered for this deal.</>}
      </div>

      {leaveAsk && (
        <ConfirmDialog
          eyebrow="BoldSign"
          title="Leave the editor?"
          confirmLabel="Leave"
          confirmVariant="btn--danger"
          busy={savingLayout}
          onCancel={() => setLeaveAsk(false)}
          onConfirm={() => leaveNow()}
          message={
            <>
              <p style={{ margin:'0 0 10px' }}>Are you sure you want to leave? Unsaved changes will be lost.</p>
              {/* Precision is the point. "Unsaved changes" alone leaves an agent
                  guessing whether the whole packet is about to disappear; naming
                  what survives is what makes Leave a safe button to press. */}
              <p style={{ margin:'0 0 6px', color:'var(--gw-ink)' }}><strong>What is kept:</strong> the document stays on this deal as a draft, and the field layout is saved for next time as you leave.</p>
              <p style={{ margin:0 }}>
                <strong style={{ color:'var(--gw-ink)' }}>What may be lost:</strong> anything placed in BoldSign since
                {lastSavedAt
                  ? ` your last save at ${lastSavedAt.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}`
                  : ' you opened the editor'}
                {' '}that BoldSign hasn’t saved. To keep it, choose Cancel and click <strong>Save</strong> inside BoldSign first.
              </p>
            </>
          }
        />
      )}
    </Modal>
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
  const [embedDocId, setEmbedDocId]= React.useState(null)   // its document id — needed to capture the field layout
  const [useTextTags, setUseTextTags] = React.useState(false)   // PDF already has {{...}} text tags baked in
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

  // Validate at PICK time, not at send time. Drag-and-drop bypasses the input's
  // own accept=".pdf", so a dropped .docx used to be shipped to BoldSign
  // labelled as a PDF and failed there with an opaque message; an oversized file
  // failed even later, as a bare HTTP 413.
  const chooseFile = (picked) => {
    if (!picked) return
    if (!/\.pdf$/i.test(picked.name) && picked.type !== 'application/pdf') {
      pushToast(`"${picked.name}" is not a PDF. Convert it first — BoldSign only signs PDFs.`, 'error'); return
    }
    if (picked.size > MAX_SEND_BYTES) {
      pushToast(`"${picked.name}" is ${fmtBytes(picked.size)} — the limit is ${fmtBytes(MAX_SEND_BYTES)}. Split it into two packets.`, 'error'); return
    }
    setFile(picked); setPickedFile('')
  }

  const allSigners = React.useMemo(() => {
    const clients = signers.map(s => ({ ...s, routingOrder: 1 }))
    if (agentSigns && activeAgent) {
      clients.push({ id:'agent', name: activeAgent.name, email: activeAgent.email, routingOrder: 2 })
    }
    return clients
  }, [signers, agentSigns, activeAgent])

  const sendForSignature = async () => {
    const invalid = signers.find(s => !s.name.trim() || !s.email.trim())
    if (invalid) { pushToast('All signers need a name and email', 'error'); return }
    if (!file && !pickedFile) { pushToast('Select or upload a document', 'error'); return }
    setSending(true)

    // The PDF stays in storage and travels as a short-lived SIGNED URL, not as
    // base64 in the request body: a serverless request is capped at 4.5 MB and
    // base64 adds ~33%, so inline bytes silently limited every send to ~3.3 MB of
    // PDF — under the size of a normal scanned disclosure packet. A file already
    // on the deal is signed where it sits; a newly chosen one is uploaded to the
    // deal's folder first, so the exact document that went out for signature is
    // on the deal too. The API can only fetch a URL on our own bucket.
    let documentUrl, finalDocName
    try {
      let path
      if (file) {
        const up = await uploadSendablePdf(supabase, { file, dealId: deal.id })
        path = up.path
        finalDocName = up.name
      } else {
        path = `deal-${deal.id}/${pickedFile}`
        finalDocName = pickedFile.replace(/^\d+-/, '')
      }
      documentUrl = await signSendableUrl(supabase, path)
    } catch (err) {
      setSending(false)
      pushToast(err.message, 'error')
      return
    }

    const signerPayload = allSigners.map(s => ({
      name: s.name, email: s.email, routingOrder: s.routingOrder,
    }))

    let data
    try {
      // Open BoldSign's embedded prepare/send UI. If the PDF has text tags
      // baked in, BoldSign auto-places fields from them; otherwise the agent
      // places fields visually in the PreparePage before sending — we no
      // longer guess coordinates here.
      //
      // The API writes the tracking row itself, before returning this URL, so a
      // document can never reach a client without the CRM knowing about it (the
      // insert used to happen here in the browser, unchecked, and racing the
      // Sent webhook).
      data = await documentEmbedUrl({
        emailSubject: subject,
        documentUrl,
        documentName: finalDocName,
        deal_id:      deal.id,
        signers:      signerPayload,
        // A same-origin STATIC page, never the CRM's own live URL: BoldSign can
        // redirect the IFRAME itself to RedirectUrl (see BoldSignFrame's
        // handleLoad), and pointing that at window.location.href loaded the
        // whole running CRM — header, sidebar, dashboard and all — inside that
        // small iframe. public/boldsign-return.html exists exactly to be this
        // target instead; see FormLibrary.jsx's template editor for the same
        // pattern.
        redirectUrl:  boldSignReturnUrl(),
        useTextTags,
      })
    } catch (err) {
      setSending(false); pushToast(err.message, 'error'); return
    }
    setSending(false)
    if (!data.url) { pushToast('BoldSign did not return a send URL', 'error'); return }
    setEmbedDocId(data.documentId || null)
    setEmbedUrl(data.url)
  }

  // Step 2 — BoldSign's embedded prepare/send UI in-frame. A draft save leaves the
  // frame open (the agent is mid-prep); it's reopenable from the Signatures tab
  // either way, so closing this no longer loses the work.
  if (embedUrl) {
    return (
      <BoldSignStepModal
        url={embedUrl}
        documentId={embedDocId}
        eyebrow="BoldSign · Review & Send"
        heading="Place fields & send"
        onClose={onClose}
        onDone={() => { pushToast('Sent for signature', 'success'); onSent() }}
        onDraft={() => pushToast('Saved as a draft — nothing has been sent yet. You can keep working, or reopen it from the Signatures tab with "Edit & Send".', 'info')}
      />
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
            onDrop={e=>{e.preventDefault();setDragOver(false);chooseFile(e.dataTransfer.files[0])}}>
            <input ref={fileRef} type="file" accept=".pdf" style={{display:'none'}} onChange={e=>{chooseFile(e.target.files[0]); e.target.value=''}}/>
            {file
              ? <div style={{fontSize:12,fontWeight:600,color:'var(--gw-green)'}}>{file.name} <span style={{fontWeight:400,color:'var(--gw-mist)'}}>· {fmtBytes(file.size)}</span></div>
              : <><Icon name="upload" size={18} style={{color:'var(--gw-border)',marginBottom:4}}/><div style={{fontSize:12}}>Drop PDF or click to browse</div><div style={{fontSize:10,color:'var(--gw-mist)',marginTop:2}}>PDF up to {fmtBytes(MAX_SEND_BYTES)}</div></>}
          </div>
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', marginBottom:16, background:'var(--gw-bone)' }}>
          <input type="checkbox" id="useTextTags" checked={useTextTags} onChange={e=>setUseTextTags(e.target.checked)} style={{width:15,height:15,cursor:'pointer'}}/>
          <label htmlFor="useTextTags" style={{ fontSize:13, cursor:'pointer', flex:1 }}>
            <strong>This PDF has BoldSign text tags</strong> — fields will be placed automatically from <code>{'{{...}}'}</code> tags in the document.
          </label>
        </div>

        {/* What happens next */}
        <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:12, color:'var(--gw-mist)', lineHeight:1.5 }}>
          <strong style={{ color:'var(--gw-ink)' }}>Next:</strong> BoldSign opens here in the app.
          {useTextTags
            ? ' Fields are placed from the document’s text tags — review, then click Send inside BoldSign.'
            : ' Place signature and date fields for each signer, then click Send inside BoldSign.'} The status here updates automatically as they sign.
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

function SignaturesTab({ deal, contacts, properties, extraContacts = [], agents = [], activeAgent }) {
  const [envelopes,   setEnvelopes]   = React.useState([])
  const [loading,     setLoading]     = React.useState(true)
  const [tableReady,  setTableReady]  = React.useState(true)
  const [sendOpen,    setSendOpen]    = React.useState(false)
  const [tplOpen,     setTplOpen]     = React.useState(false)
  const [templates,   setTemplates]   = React.useState([])
  const [dealFiles,   setDealFiles]   = React.useState([])
  const [downloading, setDownloading] = React.useState({})
  const [deleting,    setDeleting]    = React.useState({})
  const [reminding,   setReminding]   = React.useState({})
  const [templateErr, setTemplateErr] = React.useState('')   // set when the catalog can't be read (e.g. migration not applied)
  const [participantIds, setParticipantIds] = React.useState([])   // co-agents paid on the deal (admin-visible only)
  const [statusFilter, setStatusFilter] = React.useState('active')   // active | drafts | completed | all
  const [opening,     setOpening]     = React.useState({})    // env.id → fetching its edit URL
  const [editDraft,   setEditDraft]   = React.useState(null)  // { url, env } — draft reopened in BoldSign
  const [layouts,     setLayouts]     = React.useState([])    // saved per-deal field arrangements
  const [savingPdf,   setSavingPdf]   = React.useState({})    // env.id → building its PDF copy
  const [sendingDraft, setSendingDraft] = React.useState({})  // env.id → draftSend in flight
  const [sendAsk,     setSendAsk]     = React.useState(null)  // env awaiting "yes, send it" confirmation

  React.useEffect(() => {
    if (!deal?.id) return
    loadEnvelopes()
    loadDealFiles()
    loadTemplates()
    loadParticipants()
    loadLayouts()

    // Realtime subscription — auto-update status when webhook fires
    const channel = supabase.channel(`sig-documents-${deal.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'boldsign_documents',
        filter: `deal_id=eq.${deal.id}`,
      }, payload => {
        if (payload.eventType === 'DELETE') {
          setEnvelopes(prev => prev.filter(e => e.id !== payload.old?.id))
          return
        }
        // INSERT as well as UPDATE: every send path writes its row server-side
        // before handing back a send URL, so a document that went out from
        // another tab (or from BoldSign itself) used to be invisible here until
        // the agent reloaded the deal.
        setEnvelopes(prev => (prev.some(e => e.id === payload.new.id)
          ? prev.map(e => e.id === payload.new.id ? { ...e, ...payload.new } : e)
          : [payload.new, ...prev]))
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
    // Form Library is the e-sign template catalog — an entry is sendable once
    // it carries a boldsign_template_id. Alias to `template_id` so the rest of
    // this component (written against the old boldsign_templates shape) needs
    // no other changes.
    //
    // The error is BOUND and SURFACED. It used to be discarded, which meant that
    // on a database where the e-sign columns hadn't been added yet the query
    // failed, `templates` stayed empty, and the "Send from Template" button
    // simply never rendered — the entire feature looked unbuilt rather than
    // unprovisioned, with nothing anywhere saying why.
    const { data, error } = await supabase
      .from('form_packets')
      .select('template_id:boldsign_template_id, name, state, doc_type, field_tokens, active')
      .not('boldsign_template_id', 'is', null)
      .eq('active', true)
      .order('name')
    if (error) {
      const missingColumn = error.code === '42703' || error.code === 'PGRST204' || /boldsign_template_id|form_packets/.test(error.message || '')
      setTemplateErr(missingColumn
        ? 'Template sending is not set up on this database yet — the Form Library e-signature columns are missing. Ask your admin to run migrations/production/2026-07-31_boldsign_hardening.sql in Supabase.'
        : `Could not load templates: ${error.message}`)
      setTemplates([])
      return
    }
    setTemplateErr('')
    setTemplates(data || [])
  }

  // The field arrangements remembered for this deal, one per template. Read
  // directly (RLS-scoped) rather than through the API — it's a plain per-deal read
  // and the agent already has permission to see their own deal's rows.
  //
  // Errors are swallowed on purpose: on a database where migration 0026 hasn't been
  // applied this table doesn't exist, and the whole feature should degrade to "no
  // saved layouts" rather than break the Signatures tab.
  const loadLayouts = async () => {
    const { data, error } = await supabase
      .from('deal_field_layouts')
      .select('template_id, field_count, document_name, updated_at')
      .eq('deal_id', deal.id)
    if (error) { setLayouts([]); return }
    setLayouts((data || []).filter(l => l.field_count > 0))
  }

  const loadDealFiles = async () => {
    const { data } = await supabase.storage.from(BUCKET).list(`deal-${deal.id}`, { sortBy: { column: 'created_at', order: 'desc' } })
    // Same folder filter as the Documents tab — a `print/` entry is not a sendable
    // document and must not appear in the "pick from deal documents" list.
    setDealFiles((data || []).filter(f => f.name !== '.emptyFolderPlaceholder' && f.id))
  }

  // Co-agents who are paid participants on the deal. Commissions are admin-only
  // under RLS, so this quietly yields nothing for a regular agent — who then
  // sees owner + co_agent_ids, exactly what the deal page shows them.
  const loadParticipants = async () => {
    const { data } = await supabase.from('commissions').select('participants').eq('deal_id', deal.id).maybeSingle()
    const ids = (Array.isArray(data?.participants) ? data.participants : [])
      .map(p => p?.agent_id).filter(Boolean)
    setParticipantIds(ids)
  }

  // The agents on this deal, ordered exactly like the "Agents on deal" card:
  // primary first, then co-agents. Used to seed agent signer roles so a
  // co-listing agent doesn't have to be typed in on every send.
  const dealAgents = React.useMemo(
    () => dealAgentList({ deal, agents, participantAgentIds: participantIds }),
    [deal, agents, participantIds]
  )

  const refreshStatus = async (env) => {
    let data
    try { data = await getDocStatus(env.document_id) }
    catch (err) { pushToast(err.message, 'error'); return }
    // A status BoldSign reports but this app does not store comes back as null.
    // Show it, never write it: an unknown string in this column takes the
    // document out of the portal, the reminder sweep and the closing gate, all
    // of which filter on the known set.
    if (!data.status) {
      pushToast(`BoldSign reports "${data.rawStatus || 'an unrecognized status'}" — left unchanged here.`, 'info')
      return
    }
    // Only write completed_at when there IS one — assigning `|| null`
    // unconditionally wiped a known signing date whenever a status read came
    // back without it, losing the "Signed on …" record permanently.
    const patch = { status: data.status }
    if (data.completedDateTime) patch.completed_at = data.completedDateTime
    await supabase.from('boldsign_documents').update(patch).eq('id', env.id)
    setEnvelopes(prev => prev.map(e => e.id === env.id ? { ...e, ...patch } : e))
    pushToast(`Status: ${data.status}`, 'info')
  }

  // Fetch the signed PDF (or audit trail) for THIS document.
  //
  // Two bugs lived in the old version of this. It matched files by scanning the
  // deal's whole storage folder for a name containing "signed-", and since the
  // archived filename never contained the document id, the id-specific predicate
  // could never match — so on a deal with several signed documents every row
  // handed back the SAME (first) PDF. And the fallback returned the file as
  // base64 through the API, which a 4.5 MB response cap made impossible for a
  // large packet.
  //
  // Now the API resolves the row's own recorded archive path and returns a
  // short-lived signed storage URL, archiving from BoldSign first if needed.
  const fetchDocumentPdf = async (env, kind) => {
    const key = kind === 'audit' ? `audit-${env.id}` : env.id
    setDownloading(p => ({ ...p, [key]: true }))
    try {
      const data = kind === 'audit'
        ? await apiDownloadAudit(env.document_id)
        : await apiDownloadSigned(env.document_id)
      if (!data?.url) { pushToast('That file is not available yet — try again shortly.', 'error'); return }
      const a = document.createElement('a')
      a.href = data.url
      a.download = data.filename || `${kind}-${(env.document_name || 'document').replace(/\.pdf$/i, '')}.pdf`
      a.target = '_blank'
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setDownloading(p => ({ ...p, [key]: false }))
    }
  }
  const downloadSigned     = (env) => fetchDocumentPdf(env, 'signed')
  const downloadAuditTrail = (env) => fetchDocumentPdf(env, 'audit')

  // Nudge whoever still owes a signature. The API refuses when there's nobody
  // left to remind and records the nudge, so the nightly auto-reminder sweep
  // doesn't immediately chase the same signer again.
  const remind = async (env) => {
    setReminding(p => ({ ...p, [env.id]: true }))
    try {
      await apiRemindDocument(env.document_id)
      const patch = { last_reminded_at: new Date().toISOString(), reminder_count: (env.reminder_count || 0) + 1 }
      setEnvelopes(prev => prev.map(e => e.id === env.id ? { ...e, ...patch } : e))
      pushToast(`Reminder sent to ${env.signer_name || 'the signers'}`, 'success')
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setReminding(p => ({ ...p, [env.id]: false }))
    }
  }

  // Reopen an unsent draft in BoldSign, at the point the agent left it — same
  // signers, same field placement. This is the way out of the trap where an agent
  // switched screens mid-prep: the document became a draft they could see and
  // could not touch, so finishing a started send meant deleting it and redoing the
  // whole thing.
  //
  // A failure here usually means the document is no longer a draft (a missed Sent
  // webhook left the row stale). The API corrects the row when it detects that, so
  // reload afterwards — the agent sees the real status instead of an Edit button
  // that keeps failing.
  const openDraft = async (env) => {
    setOpening(p => ({ ...p, [env.id]: true }))
    try {
      const data = await documentEditUrl({ documentId: env.document_id, redirectUrl: boldSignReturnUrl() })
      if (!data?.url) { pushToast('BoldSign did not return an edit link for this draft', 'error'); return }
      setEditDraft({ url: data.url, env })
    } catch (err) {
      pushToast(err.message, 'error')
      loadEnvelopes()
    } finally {
      setOpening(p => ({ ...p, [env.id]: false }))
    }
  }

  // Save a filled copy from the row — reachable without opening the editor, which
  // matters for the common case: an agent who wants the packet as a file before
  // deciding whether it is ready to go out at all.
  const savePdf = async (env) => {
    setSavingPdf(p => ({ ...p, [env.id]: true }))
    try {
      const res = await saveBoldSignDocumentPdf(env.document_id)
      pushToast(res.fieldCount
        ? `PDF saved — ${res.fieldCount} field${res.fieldCount === 1 ? '' : 's'} included.`
        : 'PDF saved.', 'success')
    } catch (err) {
      pushToast(`Could not save the PDF: ${err.message}`, 'error')
    } finally {
      setSavingPdf(p => ({ ...p, [env.id]: false }))
    }
  }

  // Release a prepared draft to its signers — BoldSign's draftSend. The last step
  // of prepare-and-print, and the ONLY button on this page that puts a document in
  // front of a client.
  //
  // Behind a confirm on purpose. Every other draft action is reversible; this one
  // emails a binding agreement, and the whole point of the draft workflow is that
  // an agent can prepare, print and review without that ever happening by
  // accident. `sendAsk` holds the row being confirmed.
  // The dialog stays up, busy, until BoldSign answers — closing it first would
  // leave the agent looking at a row that hasn't changed yet, with no way to tell
  // whether the send is in flight or silently failed.
  const sendDraftNow = async (env) => {
    setSendingDraft(p => ({ ...p, [env.id]: true }))
    try {
      await apiSendDraft(env.document_id)
      pushToast('Sent for signature — the signers have been notified.', 'success')
    } catch (err) {
      // The API refuses (409) when BoldSign says the document already went out,
      // and corrects the row when it does — so reload either way rather than
      // leaving a Send button that keeps failing.
      pushToast(err.message, 'error')
    } finally {
      setSendingDraft(p => ({ ...p, [env.id]: false }))
      setSendAsk(null)
      loadEnvelopes()
      loadLayouts()
    }
  }

  // Remove a draft/unsigned/expired document to keep this tab tidy. The API
  // refuses to delete a completed record (that's the signed legal record), so
  // this action is only ever offered for non-completed statuses (see render).
  const deleteEnvelope = async (env) => {
    if (!window.confirm(`Remove "${env.document_name || 'this document'}"? This cannot be undone.`)) return
    setDeleting(p => ({ ...p, [env.id]: true }))
    try {
      await apiDeleteDocument(env.document_id)
      setEnvelopes(prev => prev.filter(e => e.id !== env.id))
      pushToast('Document removed', 'info')
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setDeleting(p => ({ ...p, [env.id]: false }))
    }
  }

  const visibleEnvelopes = envelopes.filter(env => {
    if (statusFilter === 'all')       return true
    if (statusFilter === 'completed') return env.status === 'completed'
    if (statusFilter === 'drafts')    return env.status === 'draft'
    return !['completed'].includes(env.status)   // 'active' = everything still in flight
  })

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
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexWrap:'wrap', gap:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ fontSize:13, color:'var(--gw-mist)' }}>{visibleEnvelopes.length} of {envelopes.length} document{envelopes.length !== 1 ? 's' : ''}</div>
          <select className="form-control" style={{ fontSize:12, padding:'3px 8px', width:'auto' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="active">Active (hide completed)</option>
            <option value="drafts">Drafts only</option>
            <option value="completed">Completed only</option>
            <option value="all">All</option>
          </select>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {templates.length > 0 && (
            <button
              className="btn btn--secondary btn--sm"
              onClick={() => setTplOpen(true)}
              title="Fill a template from this deal's data and save it as a draft — print it for the client, then send when they're ready"
            >
              <Icon name="file" size={13}/> Prepare from Template
            </button>
          )}
          <button className="btn btn--primary btn--sm" onClick={() => setSendOpen(true)}>
            <Icon name="send" size={13}/> Send for Signature
          </button>
        </div>
      </div>

      {/* What this deal remembers. Field placement is invisible work — the agent
          who arranged a packet last month has no way to know it was kept unless
          the tab says so, and a silent restore would read as the template being
          wrong. `templates` is the sendable-form catalog, so a layout whose
          template has since been retired still names itself honestly. */}
      {layouts.length > 0 && (
        <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'8px 12px', fontSize:12, lineHeight:1.6, marginBottom:12, display:'flex', alignItems:'flex-start', gap:8 }}>
          <Icon name="check" size={13} style={{ color:'var(--gw-green)', flexShrink:0, marginTop:2 }}/>
          <div>
            <strong>Field layout remembered for this deal.</strong>{' '}
            {layouts.map((l, i) => {
              const tpl = templates.find(t => t.template_id === l.template_id)
              const name = tpl?.name || l.document_name || (l.template_id ? 'a template' : 'an uploaded PDF')
              return (
                <span key={l.template_id || 'adhoc'}>
                  {i > 0 && ' · '}
                  {name} <span style={{ color:'var(--gw-mist)' }}>({l.field_count} field{l.field_count === 1 ? '' : 's'})</span>
                </span>
              )
            })}
            <div style={{ color:'var(--gw-mist)' }}>
              Signature, initial and label placements are restored automatically the next time you send this form for this deal.
            </div>
          </div>
        </div>
      )}

      {/* Why "Send from Template" isn't here — never fail silently. */}
      {templateErr && (
        <div style={{ background:'#fff8ec', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:12, lineHeight:1.6, marginBottom:12 }}>
          <strong>Template sending unavailable.</strong> {templateErr}
        </div>
      )}

      {loading
        ? <div style={{ fontSize:13, color:'var(--gw-mist)' }}>Loading…</div>
        : visibleEnvelopes.length === 0
          ? <div style={{ textAlign:'center', color:'var(--gw-mist)', fontSize:13, padding:'32px 0' }}>
              {envelopes.length === 0 ? <>No documents sent yet.<br/>Click "Send for Signature" to get started.</> : 'No documents match this filter.'}
            </div>
          : visibleEnvelopes.map(env => {
              const sc        = DS_STATUS[env.status] || DS_STATUS.sent
              const completed = env.status === 'completed'
              const isDraft   = env.status === 'draft'
              // Chasing signatures is the job — surface how long this has been
              // outstanding, and offer a nudge, right on the row.
              const awaiting  = ['sent', 'delivered'].includes(env.status)
              const daysOut   = awaiting && (env.sent_at || env.created_at)
                ? Math.floor((Date.now() - new Date(env.sent_at || env.created_at)) / 86400000)
                : null
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
                        {daysOut !== null && daysOut >= 2 && (
                          <span style={{ color: daysOut >= 7 ? 'var(--gw-red)' : 'var(--gw-amber)', fontWeight:600 }}>
                            {' '}· waiting {daysOut}d
                            {env.reminder_count > 0 && ` · ${env.reminder_count} reminder${env.reminder_count > 1 ? 's' : ''} sent`}
                          </span>
                        )}
                      </div>
                    </div>
                    <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700, background:sc.bg, color:sc.color, flexShrink:0, textTransform:'capitalize' }}>{env.status}</span>
                    {awaiting && (
                      <button
                        className="btn btn--secondary btn--sm"
                        style={{ fontSize:11, flexShrink:0 }}
                        onClick={() => remind(env)}
                        disabled={reminding[env.id]}
                        title={env.last_reminded_at
                          ? `Last reminded ${new Date(env.last_reminded_at).toLocaleDateString('en-US', { month:'short', day:'numeric' })}`
                          : 'Email the outstanding signers a reminder'}
                      >
                        {reminding[env.id] ? 'Sending…' : 'Remind'}
                      </button>
                    )}
                    <button
                      className="btn btn--ghost btn--icon btn--sm"
                      title="Save a PDF copy (pages with their filled values, plus a summary of who signs what)"
                      onClick={() => savePdf(env)}
                      disabled={savingPdf[env.id]}
                    >
                      <Icon name="document" size={12}/>
                    </button>
                    <button className="btn btn--ghost btn--icon btn--sm" title="Refresh status" onClick={() => refreshStatus(env)}>
                      <Icon name="refresh" size={12}/>
                    </button>
                    {!completed && (
                      <button className="btn btn--ghost btn--icon btn--sm" title="Remove document" onClick={() => deleteEnvelope(env)} disabled={deleting[env.id]}>
                        <Icon name="trash" size={12}/>
                      </button>
                    )}
                  </div>
                  {/* A draft is unfinished work, not a sent document — say so, and
                      give the agent the doors back into it. Before this the row
                      showed a "Draft" chip and nothing else, so a send interrupted
                      by a screen change could only be restarted from scratch.

                      The three things an agent can do with a draft are genuinely
                      different acts: read it on paper,
                      change it, or put it in front of the client. They get three
                      separate buttons for that reason — the printed review copy is
                      the whole point of preparing a draft rather than sending one,
                      and it must never be one mis-click away from a real send. */}
                  {isDraft && (
                    <div style={{ borderTop:'1px solid var(--gw-border)', padding:'8px 12px', background:'#fff8ec', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                      <Icon name="alert" size={13} style={{ color:'var(--gw-amber)', flexShrink:0 }}/>
                      <span style={{ fontSize:12, flex:1, minWidth:180, color:'var(--gw-ink)' }}>
                        <strong>Draft — nothing sent.</strong> Print a filled copy for the client, keep editing, or send it when they’re happy.
                      </span>
                      <button
                        className="btn btn--secondary btn--sm"
                        style={{ fontSize:11, flexShrink:0 }}
                        onClick={() => savePdf(env)}
                        disabled={savingPdf[env.id]}
                        title="Download this draft as a PDF with every value you filled in — for printing and taking to the client. Not a signed document."
                      >
                        <Icon name="document" size={12}/> {savingPdf[env.id] ? 'Preparing…' : 'Download Filled PDF'}
                      </button>
                      <button
                        className="btn btn--secondary btn--sm"
                        style={{ fontSize:11, flexShrink:0 }}
                        onClick={() => openDraft(env)}
                        disabled={opening[env.id]}
                        title="Reopen this draft in BoldSign to change values, signers or field placement"
                      >
                        <Icon name="edit" size={12}/> {opening[env.id] ? 'Opening…' : 'Edit Fields'}
                      </button>
                      <button
                        className="btn btn--primary btn--sm"
                        style={{ fontSize:11, flexShrink:0 }}
                        onClick={() => setSendAsk(env)}
                        disabled={sendingDraft[env.id]}
                        title="Email this document to its signers for e-signature"
                      >
                        <Icon name="send" size={12}/> {sendingDraft[env.id] ? 'Sending…' : 'Send for Signature'}
                      </button>
                    </div>
                  )}
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
                      <button
                        className="btn btn--sm btn--secondary"
                        style={{ fontSize:11 }}
                        onClick={() => downloadAuditTrail(env)}
                        disabled={downloading[`audit-${env.id}`]}
                        title="Compliance audit trail — who signed, when, IP, and a tamper hash"
                      >
                        {downloading[`audit-${env.id}`] ? 'Fetching…' : 'Audit Trail'}
                      </button>
                    </div>
                  )}
                </div>
              )
            })
      }

      {/* Both send modals reload on CLOSE as well as on send: the draft row is
          written server-side the moment BoldSign hands back a prepare URL, so an
          agent who backs out mid-prep has to see that draft here to reopen it. */}
      {sendOpen && (
        <SendSignatureModal
          deal={deal} contacts={contacts} properties={properties} dealFiles={dealFiles} activeAgent={activeAgent}
          onClose={() => { setSendOpen(false); loadEnvelopes(); loadLayouts() }}
          onSent={() => { setSendOpen(false); loadEnvelopes(); loadLayouts() }}
        />
      )}

      {/* A reopened draft — the same BoldSign prepare screen the send started in. */}
      {editDraft && (
        <BoldSignStepModal
          url={editDraft.url}
          documentId={editDraft.env.document_id}
          eyebrow="BoldSign · Edit Draft"
          heading={editDraft.env.document_name || 'Edit draft'}
          onLayoutSaved={loadLayouts}
          onClose={() => { setEditDraft(null); loadEnvelopes(); loadLayouts() }}
          onDone={() => { pushToast('Sent for signature', 'success'); setEditDraft(null); loadEnvelopes(); loadLayouts() }}
          onDraft={() => pushToast('Draft saved — nothing sent. Reopen it here any time to finish.', 'info')}
        />
      )}

      {tplOpen && (
        <SendFromTemplateModal
          deal={deal} contacts={contacts} properties={properties} extraContacts={extraContacts} dealAgents={dealAgents} templates={templates} activeAgent={activeAgent}
          onClose={() => { setTplOpen(false); loadEnvelopes(); loadLayouts() }}
          onSent={() => { setTplOpen(false); loadEnvelopes(); loadLayouts() }}
          onSaved={() => { setTplOpen(false); loadEnvelopes(); loadLayouts() }}
        />
      )}

      {/* The one irreversible step in the draft workflow. It names the actual
          recipients rather than asking "are you sure?", because the mistake this
          catches is sending the RIGHT document to the WRONG people — a confirm
          that doesn't show who is about to be emailed cannot catch that. */}
      {sendAsk && (
        <ConfirmDialog
          eyebrow="BoldSign · Send for Signature"
          title="Send this document to its signers?"
          confirmLabel="Send for Signature"
          busyLabel="Sending…"
          confirmVariant="btn--primary"
          busy={Boolean(sendingDraft[sendAsk.id])}
          onCancel={() => setSendAsk(null)}
          onConfirm={() => sendDraftNow(sendAsk)}
          message={
            <>
              <p style={{ margin:'0 0 10px', color:'var(--gw-ink)' }}>
                <strong>{sendAsk.document_name || 'This document'}</strong> will be emailed for e-signature to:
              </p>
              <p style={{ margin:'0 0 10px', color:'var(--gw-ink)' }}>{sendAsk.signer_email || sendAsk.signer_name || 'its signers'}</p>
              <p style={{ margin:0 }}>
                It stops being a draft, so it can no longer be edited here. If the client still has changes,
                cancel and use <strong>Edit Fields</strong> instead.
              </p>
            </>
          }
        />
      )}
    </div>
  )
}

// ── Prepare from Template modal — dynamic. Reads the template's actual roles +
//    fillable fields from BoldSign, renders a signer input per role and an
//    editable (CRM-prefilled) input per field, then creates the document as a
//    DRAFT on the deal.
//
//    It has no send button, deliberately. Both of its actions end at a draft —
//    "Save as Draft" straight away, "Place Fields in BoldSign" via the embedded
//    editor — and sending is a separate, confirmed act on the draft row (see
//    sendDraftNow / the draft-send action). That separation is the workflow: an
//    agent prints the filled draft, walks a client through it on paper, edits it
//    as many times as the client asks, and sends only at the end.
const prettyLabel = (id) => String(id || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

// Presentation only — the field ids and CRM tokens underneath are unchanged.
// A template author names a field `Buyer1NameLabel` because that's the
// account-wide convention (see CANONICAL_LABEL_TOKENS in boldsignFields.js),
// not because it's a caption an agent should have to read and decode on the
// send screen. This maps the same tokens to a short, human description of
// where the value actually lands on the document, which group of fields it
// belongs with, and — for the ones that only apply to some deals — a note
// saying so, so "why is this blank" isn't a mystery.
const FIELD_TOKEN_INFO = {
  party_buyer_1:        { group: 'Buyer names',  text: 'Primary buyer’s name' },
  party_buyer_2:        { group: 'Buyer names',  text: 'Co-buyer’s name', optional: 'only appears when this deal has a co-buyer' },
  party_seller_1:       { group: 'Seller names', text: 'Primary seller’s name' },
  party_seller_2:       { group: 'Seller names', text: 'Co-seller’s name', optional: 'only appears when this deal has a co-seller' },
  seller_name:          { group: 'Buyer/Seller names', text: 'Your client’s name' },
  client_name:          { group: 'Buyer/Seller names', text: 'Your client’s name' },
  client_names:         { group: 'Buyer/Seller names', text: 'Every client, as the "entered into by and between" line reads' },
  seller_names:         { group: 'Buyer/Seller names', text: 'Every client, as the "entered into by and between" line reads' },
  client_2_name:        { group: 'Buyer/Seller names', text: 'Co-buyer / co-seller / spouse', optional: 'only appears when there’s a second client on this deal' },
  seller_2_name:        { group: 'Buyer/Seller names', text: 'Co-buyer / co-seller / spouse', optional: 'only appears when there’s a second client on this deal' },
  agent_name:           { group: 'Agent names', text: 'This deal’s appointed agent' },
  agent_2_name:         { group: 'Agent names', text: 'A co-listing agent', optional: 'only appears when a second agent is on this deal' },
  broker_name:          { group: 'Agent names', text: 'The brokerage name' },
  property_address:     { group: 'Property', text: 'Street address' },
  property_full:        { group: 'Property', text: 'Full one-line address' },
  property_city_state_zip: { group: 'Property', text: 'City, state and ZIP line' },
  property_county:      { group: 'Property', text: 'County' },
  property_type:        { group: 'Property', text: 'Property type' },
  property_mls:         { group: 'Property', text: 'MLS number' },
  list_price:           { group: 'Money', text: 'Price' },
  commission_pct:       { group: 'Money', text: 'Commission percentage' },
  commission_amount:    { group: 'Money', text: 'Commission dollar amount' },
  broker_compensation_flat: { group: 'Money', text: 'Flat-fee commission amount' },
  agreement_date:       { group: 'Dates', text: 'Agreement date, written out whole' },
  agreement_day:        { group: 'Dates', text: '"this ___ day of ______" — the day' },
  agreement_month:      { group: 'Dates', text: '"day of ______, 20__" — the month' },
  agreement_year:       { group: 'Dates', text: '"20__" — last two digits of the year' },
  agreement_year_full:  { group: 'Dates', text: 'Full four-digit year' },
  agreement_term_months:{ group: 'Dates', text: 'Term of representation, in months' },
  retainer_start_date:  { group: 'Dates', text: 'Representation start date' },
  retainer_end_date:    { group: 'Dates', text: 'Representation end date' },
  closing_date_us:      { group: 'Dates', text: 'Closing date' },
  listing_start_us:     { group: 'Dates', text: 'Listing start date' },
  listing_end_us:       { group: 'Dates', text: 'Listing end date' },
  offer_expiration:     { group: 'Dates', text: 'Offer expiration date' },
  additional_agent_name:{ group: 'Additional Agent', text: 'Additional appointed agent’s name', optional: 'only appears when this deal has an additional agent' },
  additional_agent_date:{ group: 'Additional Agent', text: '"this ___ day of ______, 20__" for the additional agent’s appointment', optional: 'only appears when this deal has an additional agent' },
}
const fieldInfo        = (f) => FIELD_TOKEN_INFO[fieldTokenKey(f)] || null
const FIELD_GROUP_ORDER = ['Buyer names', 'Seller names', 'Buyer/Seller names', 'Agent names', 'Additional Agent', 'Property', 'Money', 'Dates', 'Other']
// Fields in template order, bucketed into the groups above (falling back to
// "Other" for anything the table doesn't name) and returned in a fixed,
// sensible reading order rather than however the template happens to list them.
const groupFields = (list) => {
  const byGroup = new Map()
  for (const f of list) {
    const g = fieldInfo(f)?.group || 'Other'
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push(f)
  }
  return FIELD_GROUP_ORDER
    .map(g => ({ group: g, fields: byGroup.get(g) || [] }))
    .filter(g => g.fields.length)
}

function SendFromTemplateModal({ deal, contacts, properties, extraContacts = [], dealAgents = [], templates, activeAgent, onClose, onSent, onSaved }) {
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
  const [embedDocId, setEmbedDocId] = React.useState(null)   // its document id — needed to capture the field layout
  const [sending,    setSending]    = React.useState(false)
  const [savingDraft, setSavingDraft] = React.useState(false)
  const [details,    setDetails]    = React.useState(null)   // { roles, fields }
  const [loadingDet, setLoadingDet] = React.useState(false)
  const [detailsErr, setDetailsErr] = React.useState('')     // why the roles/fields could not be read
  const [reloadKey,  setReloadKey]  = React.useState(0)      // bumped by Retry
  const [signers,    setSigners]    = React.useState({})     // roleIndex → { name, email }
  // Signing order. SEQUENTIAL is the default, and that is a deliberate
  // reversal — it was parallel, so that two co-buyers sitting at the same table
  // could sign together instead of the second one waiting on the first.
  //
  // What changed is that BoldSign scopes FIELD VISIBILITY by role: a field
  // assigned to a signer is invisible to every other recipient until that signer
  // completes. Our packets carry the deal's own details — the agency type, the
  // appointed agent, the property, the price — on fields assigned to a signer,
  // and on a parallel send the other parties open the document and find those
  // lines blank. On an Appointed Agency form that means a client being asked to
  // sign an agreement without seeing which agent is being appointed.
  //
  // In order, with the client first, every later signer sees everything the
  // earlier ones did. The cost is real and accepted: co-buyers can no longer
  // sign simultaneously, they go one after the other. The box below still turns
  // it off for a packet that genuinely has nothing prefilled to share.
  const [inOrder,    setInOrder]    = React.useState(true)
  const [values,     setValues]     = React.useState({})     // fieldId → value

  const tpl = templates.find(t => t.template_id === templateId)

  // Load the template's roles + fields whenever the selection changes, and seed
  // signer/field inputs from the deal.
  React.useEffect(() => {
    if (!templateId) { setDetails(null); setDetailsErr(''); return }
    let cancelled = false
    setLoadingDet(true)
    setDetailsErr('')
    templateDetails(templateId)
      .then(det => {
        if (cancelled) return
        const roles  = det.roles?.length ? det.roles : [{ index: 1, name: 'Signer' }]
        const fields = (det.fields || []).filter(f => isPrefillableField(f.type))
        setDetails({ roles, fields })

        // Seed signer name/email from the deal's linked contact (+ spouse for a
        // second client role) and the acting agent. See seedSignersFromDeal.
        //
        // The token values follow the SAME people: every client on the deal (so
        // `client_names` prints "Jane Doe and John Doe" on a two-buyer packet),
        // and the deal's own agent rather than whoever happens to be sending —
        // an admin sending on an agent's behalf must not have their own name
        // printed as the appointed agent. See appointedAgent().
        // `agents` is the same ordered list seedSignersFromDeal() fills the
        // agent signature rows from, so a template's second agent LINE and its
        // second agent ROW name the same person.
        const tokenVals = crmTokenValues({
          deal, property, contact,
          additionalContacts: extraContacts,
          agent:  appointedAgent({ activeAgent, dealAgents }),
          agents: orderAgentSigners({ activeAgent, dealAgents }),
          today:  new Date().toISOString().slice(0, 10),
        })
        setSigners(seedSignersFromDeal({ roles, contact, additionalContacts: extraContacts, activeAgent, dealAgents }))

        const seededValues = {}
        for (const f of fields) {
          // A Name field is left empty on purpose. BoldSign prints the assigned
          // signer's own name in it and discards whatever we send, so seeding
          // `agent_name` here would show the agent a value the document will
          // never carry — the field is reported below instead of filled.
          if (isSignerBoundField(f.type)) { seededValues[f.id] = ''; continue }
          // Tick boxes start as null — "leave it to the signer" — rather than
          // false, so an untouched box isn't sent out locked as a deliberate no.
          // fieldTokenValue matches on the field's id, name OR label, normalized
          // for case and separators — BoldSign auto-assigns the id (`Label1`), so
          // a hand-typed token usually lives in the name or the label.
          seededValues[f.id] = isTickableField(f.type) ? null : fieldTokenValue(tokenVals, f)
        }
        setValues(seededValues)
      })
      // A FAILED LOAD MUST NOT LOOK LIKE A LOADED TEMPLATE. This used to fall back to
      // a single generic "Signer" row — which, next to "Roles left blank are removed
      // from this send", reads as a one-signer packet and sends as one. A listing
      // agreement that reaches only the seller because a network call failed is far
      // worse than a modal that refuses to continue and says why.
      .catch(err => {
        if (cancelled) return
        setDetails(null)
        setDetailsErr(err.message || 'The template’s roles and fields could not be read.')
        pushToast(`Couldn't load template fields: ${err.message}`, 'error')
      })
      .finally(() => { if (!cancelled) setLoadingDet(false) })
    return () => { cancelled = true }
  }, [templateId, reloadKey])

  const [showAllFields, setShowAllFields] = React.useState(false)
  const [showShared, setShowShared] = React.useState(false)
  const setSigner = (idx, k, v) => setSigners(p => ({ ...p, [idx]: { ...(p[idx] || {}), [k]: v } }))
  const setValue  = (id, v)     => setValues(p => ({ ...p, [id]: v }))

  // The payload both actions below send. Returns null (having said why) when the
  // modal isn't ready — the two buttons must agree exactly on what is valid, so
  // this is built once rather than duplicated per action.
  const buildArgs = () => {
    if (!templateId) { pushToast('Pick a template', 'error'); return null }
    const roleList = details?.roles || []
    const filled   = roleList.filter(r => (signers[r.index]?.name || '').trim() && (signers[r.index]?.email || '').trim())
    if (!filled.length) { pushToast('At least one signer needs a name and email', 'error'); return null }

    // Split the prefilled values in two — this is the whole point of Label
    // fields. `sharedFormFields` (the template's Labels) go out as ONE common,
    // read-only set that every signer sees the instant the document lands, no
    // matter who signs first; `byRole` holds the role-scoped fields, which
    // BoldSign keeps private to their own signer until that signer is done.
    // Keyed by ORIGINAL role index — buildTemplateRoles handles the index shift.
    const { sharedFormFields, byRole } = buildPrefillFields({
      fields: details.fields || [],
      values,
      filledRoleIndices: filled.map(r => r.index),
    })
    // Roles + removals, with BoldSign's post-removal index shift applied — see
    // buildTemplateRoles. Leaving a middle role blank (e.g. Co-seller, with a
    // co-listing agent filled below it) used to send an index past the end of
    // the remaining list, which BoldSign rejected as a role with no signer.
    const { roles, roleRemovalIndices } = buildTemplateRoles({
      roleList, signers, fieldsByRole: byRole, inOrder,
    })

    const docName = [tpl?.name || deal?.title, property?.address].filter(Boolean).join(' — ')
    const labels  = [tpl?.state, tpl?.doc_type, `deal:${deal.id}`].filter(Boolean)
    // Fields that only mean something for a co-buyer or an additional agent this
    // deal doesn't have — left blank above, and removed from the draft outright
    // so the template doesn't show them as unfilled "Label" placeholders. See
    // conditionalFieldsToRemove in boldsignFields.js.
    const fieldRemovalIds = conditionalFieldsToRemove({ fields: details.fields || [], values })
    return {
      templateId, deal_id: deal.id, roles, roleRemovalIndices, sharedFormFields, fieldRemovalIds,
      emailSubject: subject, documentName: docName, labels,
    }
  }

  // This deal's remembered arrangement was restored over the template's defaults —
  // say so, because the document will not match the blank template and that should
  // read as intentional. A partial restore reports BOTH what came back and what
  // didn't; only a total failure is an error, since a form that is mostly right is
  // worth saying out loud but is not a broken document.
  const reportLayout = (data) => {
    // BoldSign refused the locks and the send went through unlocked. Worth a
    // toast: every value is still filled in, but the guarantee the agent was
    // told about on this screen ("none can change them") no longer holds.
    if (data.readOnlyWarning) pushToast(data.readOnlyWarning, 'info')
    if (data.layoutApplied) {
      pushToast(`Restored this deal's saved field layout — ${data.layoutFieldCount} field${data.layoutFieldCount === 1 ? '' : 's'}.`, 'success')
    }
    // Never an error toast. The draft exists, is filled, and is sendable; all a
    // failed restore means is that it opened with the template's own field
    // placement, which is what every send did before layouts existed. Shown red,
    // it read as a failed send and sent the agent looking for a problem that was
    // not there.
    if (data.layoutWarning) pushToast(data.layoutWarning, 'info')
  }

  // SAVE AS DRAFT — the prepare-and-print path. Creates the document in BoldSign
  // with every value entered above already written into it, and stops. Nothing is
  // sent, no editor opens; the agent lands back on the Signatures tab where the
  // draft can be downloaded as a filled PDF, printed, re-edited, and sent later.
  //
  // This is the default action because it is the safe one: the packet exists, the
  // client can read it on paper, and no email has gone anywhere.
  const saveDraft = async () => {
    const args = buildArgs()
    if (!args) return
    setSavingDraft(true)
    try {
      const data = await saveTemplateDraft(args)
      reportLayout(data)
      pushToast('Saved as a draft — nothing sent. Use "Download Filled PDF" on the draft to print a copy for the client.', 'success')
      onSaved()
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setSavingDraft(false)
    }
  }

  // PLACE FIELDS — the same draft, opened in BoldSign's embedded editor. Needed
  // when the template's own field placement has to be adjusted for this deal
  // (an extra initial box, a label only this county wants). Still a draft on the
  // other side: BoldSign sends only if the agent clicks Send in there.
  const placeFields = async () => {
    const args = buildArgs()
    if (!args) return
    setSending(true)
    try {
      const data = await templateEmbedUrl({ ...args, redirectUrl: boldSignReturnUrl() })
      if (!data?.url) { pushToast('BoldSign did not return a send URL', 'error'); return }
      reportLayout(data)
      setEmbedDocId(data.documentId || null)
      setEmbedUrl(data.url)
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setSending(false)
    }
  }

  const fields     = details?.fields || []
  const tickFields = fields.filter(f => isTickableField(f.type))
  const textFields = fields.filter(f => isFillableField(f.type))

  // Shared (Label) fields vs signer-specific ones. The difference is not
  // cosmetic: a Label is common to the document and every signer reads it the
  // moment it arrives, while a role-scoped field stays invisible to everyone but
  // its own signer until that signer has finished. The two groups are shown
  // apart, and labelled, so nobody has to guess which one a value lands in.
  // Fields the admin never named, whose ids are BoldSign's own auto-counters
  // (`Label1`, `Checkbox2`), are folded away by default. One live agency packet
  // renders 27 such Labels and 14 such tick boxes, which buries the three fields
  // that actually matter and turns a review step into something to scroll past.
  // They are hidden, never dropped: the toggle brings every one of them back,
  // because an unnamed checkbox is still a term somebody may need to tick.
  const shown = (list) => (showAllFields ? list : list.filter(f => !isUnconfiguredField(f)))

  const sharedTextFields = shown(textFields.filter(f => isSharedField(f.type)))
  const signerTextFields = shown(textFields.filter(f => !isSharedField(f.type)))
  const shownTickFields  = shown(tickFields)
  // Only the shared fields that actually carry a value. An empty one has nothing
  // to show in a summary, and listing it as blank would invite the agent to go
  // hunting for something to type where the template simply has a spare box.
  const sharedFilled = sharedTextFields.filter(f => String(values[f.id] ?? '').trim())
  const hiddenCount = showAllFields
    ? 0
    : [...textFields, ...tickFields].filter(isUnconfiguredField).length
  // A role-scoped field can name no role at all, in which case it rides on the
  // first signer — either way it is one signer's, which is what the warning below
  // needs to say.
  const roleNameFor = (idx) => details?.roles?.find(r => r.index === Number(idx))?.name || (idx ? `Signer ${idx}` : 'one signer only')

  // Deal data sitting on a role-scoped field — the template needs fixing, and no
  // send-time payload can work around it. Named here because the agent about to
  // send is the person who will hear about the blank from the client.
  // Who signs first decides what everyone else can see: BoldSign reveals a
  // signer's fields to the rest once that signer completes, so prefilled details
  // carried by the first signer reach every later one. Filled rows in template
  // order — the same order buildTemplateRoles emits.
  const firstSignerIndex = (details?.roles || [])
    .filter(r => (signers[r.index]?.name || '').trim() && (signers[r.index]?.email || '').trim())[0]?.index ?? null
  const sharedGaps = sharedDataOnSignerFields({ fields, values, firstSignerIndex, inOrder })

  // Name fields the template is using for somebody other than their own signer.
  // Worse than the gap above and not fixable from here at all: BoldSign prints
  // the assigned signer's name and silently drops whatever we send, so the
  // document goes out with the WRONG name rather than a blank one.
  const nameMisuse = signerBoundPrefillFields({ fields, values })

  // Recomputed for the warning above, which names the value each misused Name
  // field was SUPPOSED to print — that is what tells an admin which Label to
  // put in its place. Same inputs as the seeding effect, and pure.
  const tokenVals = React.useMemo(() => crmTokenValues({
    deal, property, contact,
    additionalContacts: extraContacts,
    agent:  appointedAgent({ activeAgent, dealAgents }),
    agents: orderAgentSigners({ activeAgent, dealAgents }),
    today:  new Date().toISOString().slice(0, 10),
  }), [deal, property, contact, extraContacts, activeAgent, dealAgents])

  // What BoldSign actually calls this field, and whether it matched a CRM token.
  // A blank box used to be unreadable — "did the deal have no value, or is the
  // field named something the CRM doesn't recognise?" — and the answer lived in
  // an API response nobody could see. It is on screen now: the field's real id,
  // and the token it resolved to when it resolved to one.
  const fieldOrigin = (f) => {
    const token = fieldTokenKey(f)
    return token && normalizeTokenKey(f.id) !== token ? `${f.id} → ${token}` : String(f.id || '')
  }

  // The field's BoldSign TYPE, shown next to its id. Without this the screen
  // names fields `Label1` and `Name3` and there is no way to tell a TextBox from
  // a Company or a Name — which is exactly the distinction that decides whether
  // a value can be prefilled, whether it can be locked, and whether every signer
  // can read it. Two send-breaking bugs were diagnosed blind for want of it.
  const fieldType = (f) => String(f?.type || 'unknown')

  const renderTextField = (f) => {
    // The heading an agent actually reads: the canonical token's human name
    // first (Buyer1NameLabel → "Primary buyer's name"), since that's true for
    // every template using the account-wide convention regardless of what the
    // admin happened to type as the field's own name; then whatever the
    // template author actually captioned it; then, only for a field neither of
    // those resolves, the raw PascalCase id — which is what every one of these
    // used to show, unreadable id and all.
    const info = fieldInfo(f)
    const heading = info?.text || f.label || f.name || prettyLabel(f.id)
    return (
    <div key={f.id} style={{ marginBottom:8 }}>
      <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:2, display:'flex', gap:8, alignItems:'baseline' }}>
        <span style={{ flex:1 }}>
          {heading}
          {info?.optional && (
            <span style={{ marginLeft:6, fontSize:10, fontWeight:600, color:'#d4a017', border:'1px solid #d4a017', borderRadius:10, padding:'1px 6px' }}>
              optional
            </span>
          )}
        </span>
        <span style={{ fontFamily:'var(--font-mono, monospace)', fontSize:10, opacity:0.7 }} title="The field id BoldSign uses, its type, and the CRM token it matched">
          {fieldOrigin(f)} · {fieldType(f)}
        </span>
      </div>
      {info?.optional && (
        <div style={{ fontSize:10, color:'var(--gw-mist)', marginBottom:3 }}>
          {info.optional.replace(/^./, c => c.toUpperCase())}
        </div>
      )}
      {isDateField(f)
        ? (
          <input
            className="form-control"
            type="date"
            value={usDateToIso(values[f.id] || '')}
            onChange={e => setValue(f.id, isoDateToUs(e.target.value))}
          />
        )
        : f.options?.length
        ? (
          <select className="form-control" value={values[f.id] || ''} onChange={e => setValue(f.id, e.target.value)}>
            <option value="">— signer chooses —</option>
            {f.options.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        )
        : <input className="form-control" value={values[f.id] || ''} onChange={e => setValue(f.id, e.target.value)}/>}
    </div>
    )
  }

  // A flat list of 15+ fields is what agents said was hard to read here — this
  // renders the same fields as small labelled sections instead (Buyer names,
  // Agent names, Dates, Additional Agent, …), in a fixed reading order, so
  // "which value goes where" is a sub-heading away rather than a scroll.
  const renderGroupedFields = (list) => groupFields(list).map(({ group, fields: groupedFields }) => (
    <div key={group} style={{ marginBottom:10 }}>
      <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.03em', color:'var(--gw-mist)', marginBottom:4 }}>
        {group}
      </div>
      {groupedFields.map(renderTextField)}
    </div>
  ))

  // Step 2 — BoldSign's embedded prepare/send UI (replaces our own send popup).
  if (embedUrl) {
    return (
      <BoldSignStepModal
        url={embedUrl}
        documentId={embedDocId}
        eyebrow="BoldSign · Review & Send"
        heading="Place fields & send"
        onClose={onClose}
        onDone={() => { pushToast('Sent for signature', 'success'); onSent() }}
        onDraft={() => pushToast('Saved as a draft — nothing has been sent yet. You can keep working, or reopen it from the Signatures tab with "Edit & Send".', 'info')}
      />
    )
  }

  return (
    <Modal open={true} onClose={onClose} width={520}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">BoldSign · Prepare from Template</div>
          <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>Prepare Draft Agreement</h3>
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

        {!loadingDet && detailsErr && (
          <div style={{ background:'#fff5f5', border:'1px solid var(--gw-red)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:12, fontSize:12, lineHeight:1.6 }} role="alert">
            <strong>This template’s signers and fields could not be read, so it can’t be sent yet.</strong>
            <div style={{ color:'var(--gw-mist)', marginTop:4 }}>{detailsErr}</div>
            <button className="btn btn--secondary btn--sm" style={{ marginTop:8 }} onClick={() => setReloadKey(k => k + 1)}>
              <Icon name="refresh" size={12}/> Try again
            </button>
          </div>
        )}

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

              <label style={{ display:'flex', alignItems:'center', gap:8, marginTop:10, padding:'8px 10px', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', background:'var(--gw-bone)', cursor:'pointer' }}>
                <input type="checkbox" checked={inOrder} onChange={e => setInOrder(e.target.checked)} style={{ width:14, height:14, cursor:'pointer' }}/>
                <span style={{ fontSize:12, flex:1 }}>
                  <strong>Sign in this order</strong> — each signer waits for the one above.
                  <span style={{ color:'var(--gw-mist)' }}> Keep this on unless nothing above is prefilled: BoldSign
                    only shows a signer&rsquo;s fields to the others once that signer has finished, so sending to
                    everyone at once means the client opens the packet with the prefilled lines blank.</span>
                </span>
              </label>
            </div>

            {/* SHARED — the template's Label fields. One common copy, visible to
                every signer as soon as the document is sent (no waiting for the
                first signature) and editable by none of them. */}
            {sharedTextFields.length > 0 && (
              <div className="form-group">
                {/* COLLAPSED BY DEFAULT. These are filled from the deal and are
                    not the agent's job: presented as 30-odd open inputs they
                    read as 30 things to fill in, which is the opposite of the
                    truth and the single biggest source of confusion on this
                    screen. The summary says what will be carried, the count says
                    how much, and the detail is one click away for whoever wants
                    to check it before sending. */}
                <label className="form-label">
                  From this deal <span style={{ fontSize:11, fontWeight:400, color:'var(--gw-mist)' }}>— filled in automatically, every signer sees them straight away</span>
                </label>
                <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', background:'var(--gw-bone)', padding:'10px 12px' }}>
                  {sharedFilled.length === 0 && (
                    <div style={{ fontSize:12, color:'var(--gw-mist)' }}>
                      Nothing on this template matches the deal yet. Open it below to fill anything in by hand.
                    </div>
                  )}
                  {sharedFilled.length > 0 && !showShared && (
                    <div style={{ fontSize:12, lineHeight:1.7 }}>
                      {sharedFilled.slice(0, 5).map(f => (
                        <div key={f.id} style={{ display:'flex', gap:8 }}>
                          <span style={{ color:'var(--gw-mist)', minWidth:130 }}>{fieldInfo(f)?.text || prettyLabel(fieldTokenKey(f) || f.id)}</span>
                          <strong style={{ flex:1 }}>{values[f.id]}</strong>
                        </div>
                      ))}
                      {sharedFilled.length > 5 && (
                        <div style={{ color:'var(--gw-mist)', marginTop:4 }}>
                          and {sharedFilled.length - 5} more
                        </div>
                      )}
                    </div>
                  )}
                  {showShared && renderGroupedFields(sharedTextFields)}
                  <button
                    type="button"
                    className="btn btn--link btn--sm"
                    style={{ marginTop:6, padding:0 }}
                    onClick={() => setShowShared(v => !v)}
                  >
                    {showShared
                      ? 'Done — hide these'
                      : `Review or edit ${sharedTextFields.length} shared field${sharedTextFields.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              </div>
            )}

            {/* SIGNER-SPECIFIC — role-scoped fields. BoldSign shows each of these
                only to its own signer until that signer has finished, so anything
                the other parties need to read up front belongs above, as a Label
                in the template. */}
            {signerTextFields.length > 0 && (
              <div className="form-group">
                <label className="form-label">
                  Signer details <span style={{ fontSize:11, fontWeight:400, color:'var(--gw-mist)' }}>— each of these is visible only to the signer it belongs to until they sign</span>
                </label>
                {renderGroupedFields(signerTextFields)}
              </div>
            )}

            {/* A Name field being used for someone other than its own signer.
                This is the silent one — BoldSign accepts the value, ignores it,
                and prints the assigned signer's name instead — so it is stated
                as an outright defect in the template, with the fix. */}
            {nameMisuse.length > 0 && (
              <div style={{ background:'#fff5f5', border:'1px solid var(--gw-red)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:12, fontSize:12, lineHeight:1.6 }} role="alert">
                <strong>This template prints the wrong name in {nameMisuse.length === 1 ? 'one place' : `${nameMisuse.length} places`}.</strong>
                <div style={{ color:'var(--gw-mist)', marginTop:4 }}>
                  A BoldSign <strong>Name</strong> field always shows the name of the signer it is assigned to, and ignores
                  any value sent for it — so these cannot be filled from the CRM, and each one will show its own
                  signer&rsquo;s name instead of what it is captioned for:
                </div>
                <ul style={{ margin:'6px 0 0', paddingLeft:18, color:'var(--gw-mist)' }}>
                  {nameMisuse.map(f => {
                    const token = fieldTokenKey(f)
                    const want  = token ? tokenVals[token] : ''
                    return (
                      <li key={f.id}>
                        “{f.label || f.name || prettyLabel(f.id)}” — assigned to {roleNameFor(f.roleIndex)}
                        {token ? <>, meant to show <code>{token}</code>{want ? ` (“${want}”)` : ''}</> : ''}
                      </li>
                    )
                  })}
                </ul>
                <div style={{ color:'var(--gw-mist)', marginTop:6 }}>
                  Ask an admin to fix the template: delete each of these and place a <strong>Label</strong> in the same
                  spot (BoldSign cannot change a placed field&rsquo;s type), naming the Label after the token above so it
                  fills automatically. A Label is also read by every signer immediately, whatever the signing order.
                </div>
              </div>
            )}

            {/* The one problem this modal cannot fix from here: shared deal data
                the template put on a role's own field. Say which fields, and say
                what it means, rather than letting a client find the blank. */}
            {sharedGaps.length > 0 && (
              <div style={{ background:'#fffbe6', border:'1px solid #d4a017', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:12, fontSize:12, lineHeight:1.6 }}>
                <strong>Some deal details will not be visible to everyone right away.</strong>
                <div style={{ color:'var(--gw-mist)', marginTop:4 }}>
                  {sharedGaps.map(f => `“${f.label || f.name || prettyLabel(f.id)}” (${roleNameFor(f.roleIndex)})`).join(', ')} —
                  {' '}these are filled in, but each is assigned to one signer, and BoldSign only shows a
                  signer&rsquo;s fields to the others once that signer has finished.
                  {inOrder
                    ? <> They belong to someone who signs <strong>after</strong> {roleNameFor(firstSignerIndex)}, so the
                        earlier signers open the document with those lines blank. Fix it in the BoldSign template by
                        assigning them to the first signer (read-only), or by making them <strong>Label</strong> fields.</>
                    : <> This send goes to everyone at once, so nobody sees anybody else&rsquo;s fields. Tick
                        <strong> Sign in this order</strong> above and put the client first, or ask an admin to make
                        them <strong>Label</strong> fields, which every signer sees whatever the order.</>}
                </div>
              </div>
            )}

            {/* Boxes the AGENT decides — exclusive agency, who pays what. Ticked
                here they go out as real, locked values every signer sees; left
                alone they stay the signer's to fill. Setting one inside
                BoldSign's editor instead does NOT carry to the signers. */}
            {shownTickFields.length > 0 && (
              <div className="form-group">
                <label className="form-label">Selections <span style={{ fontSize:11, fontWeight:400, color:'var(--gw-mist)' }}>— set these here and they travel with the send, locked. Each is still visible only to its own signer until they sign</span></label>
                {shownTickFields.map(f => (
                  <div key={f.id} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                    <div style={{ flex:1, fontSize:12 }}>
                      {f.label || prettyLabel(f.id)}
                      <span style={{ fontFamily:'var(--font-mono, monospace)', fontSize:10, opacity:0.7, marginLeft:8 }}>{f.id} · {fieldType(f)}</span>
                    </div>
                    <select
                      className="form-control"
                      style={{ width:150, flex:'none' }}
                      value={values[f.id] === true ? 'yes' : values[f.id] === false ? 'no' : ''}
                      onChange={e => setValue(f.id, e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null)}
                    >
                      <option value="">Signer decides</option>
                      <option value="yes">Checked</option>
                      <option value="no">Unchecked</option>
                    </select>
                  </div>
                ))}
              </div>
            )}

            {hiddenCount > 0 && (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                style={{ width:'100%', marginBottom:12 }}
                onClick={() => setShowAllFields(true)}
              >
                Show {hiddenCount} unnamed template field{hiddenCount === 1 ? '' : 's'}
              </button>
            )}
            {showAllFields && (
              <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:12 }}>
                Showing every field on the template, including the ones with no name of their own.
                Give a field a name in BoldSign&rsquo;s template editor (a CRM token, or just a caption)
                and it will show here by default.{' '}
                <button type="button" className="btn btn--link btn--sm" onClick={() => setShowAllFields(false)}>Hide them again</button>
              </div>
            )}
          </>
        )}

        <div style={{ fontSize:12, color:'var(--gw-mist)', padding:'2px 2px' }}>
          <strong>Neither button sends anything.</strong> Both save this as a draft on the deal, filled in with the values
          above — from there you can download a filled PDF to print for the client, keep editing, and send only
          when they&rsquo;re happy. <strong>From this deal</strong> is filled in for you and every signer can read it
          the moment the document arrives, without waiting for anyone else to sign. <strong>Signer details</strong> and{' '}
          <strong>Selections</strong> stay hidden from the other parties until their own signer has signed, which is why
          the order box above matters. Values typed or ticked inside BoldSign&rsquo;s own editor are placement previews
          and do <strong>not</strong> reach the signers — set them here.
        </div>
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        {/* Secondary, because most packets need no placement work: the template
            already has its fields and this is the detour, not the route. */}
        <button
          className="btn btn--secondary"
          onClick={placeFields}
          disabled={sending || savingDraft || loadingDet || Boolean(detailsErr) || !details}
          title="Save the draft and open it in BoldSign to move, add or remove fields"
        >
          {sending ? 'Opening…' : 'Place Fields in BoldSign'}
        </button>
        <button
          className="btn btn--primary"
          onClick={saveDraft}
          disabled={sending || savingDraft || loadingDet || Boolean(detailsErr) || !details}
          title="Create the filled document on this deal as a draft — nothing is sent"
        >
          {savingDraft ? 'Saving…' : 'Save as Draft'}
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

// Reconcile a deal's additional-contact link rows (deal_contacts) to match the
// chosen ids PER SIDE — inserts new links, deletes removed ones, and moves
// anyone whose side changed. Best-effort.
//
// `bySide` is { buyer: [id], seller: [id] }. The side matters as much as the
// membership: on a deal representing both parties, the same list without sides
// cannot say which names belong to the buyer, so a form captioned "Seller"
// would print whoever happened to be first.
//
// Returns true when rows actually changed, so the caller only refreshes state
// (which re-runs the drawer's seeding effect) when there is something new.
async function syncDealContacts(dealId, bySide) {
  const wanted = new Map()
  for (const side of ['buyer', 'seller']) {
    for (const id of (bySide?.[side] || [])) if (id && !wanted.has(id)) wanted.set(id, side)
  }
  try {
    const { data: existing } = await supabase.from('deal_contacts').select('contact_id, side').eq('deal_id', dealId)
    const have = new Map((existing || []).map(r => [r.contact_id, r.side || null]))
    const toAdd    = [...wanted.keys()].filter(id => !have.has(id))
    const toRemove = [...have.keys()].filter(id => !wanted.has(id))
    // A row whose side is wrong (or was never set, on a legacy link) is updated
    // in place rather than deleted and re-inserted, so its created_at — the row
    // order the picker and the signer list read — survives.
    const toMove   = [...wanted.entries()].filter(([id, side]) => have.has(id) && have.get(id) !== side)

    if (toAdd.length) {
      const rows = toAdd.map(contact_id => ({ deal_id: dealId, contact_id, side: wanted.get(contact_id) }))
      const { error } = await supabase.from('deal_contacts').insert(rows)
      // deal_contacts.side arrives with migration 0040. Until it is applied the
      // links are written without a side and read back as the deal's
      // represented side — the pre-0040 behavior, not a lost contact.
      if (error && isMissingSideColumn(error)) {
        await supabase.from('deal_contacts').insert(rows.map(({ side, ...rest }) => rest))
      }
    }
    if (toRemove.length) await supabase.from('deal_contacts').delete().eq('deal_id', dealId).in('contact_id', toRemove)
    for (const [contact_id, side] of toMove) {
      const { error } = await supabase.from('deal_contacts').update({ side }).eq('deal_id', dealId).eq('contact_id', contact_id)
      if (error && isMissingSideColumn(error)) break
    }
    return toAdd.length + toRemove.length + toMove.length > 0
  } catch (e) { console.error('[syncDealContacts]', e); return false }
}

// Pull a deal's link rows back into global state after writing them. The drawer
// re-seeds its picker from `db.dealContacts` — with a stale (pre-save) copy it
// would reopen empty, and the reconcile above would then delete the very links
// that were just inserted. App's loader only refetches these on a full reload.
export async function reloadDealContacts(setDb, dealId) {
  if (!setDb || !dealId) return
  const { data, error } = await supabase.from('deal_contacts').select('*').eq('deal_id', dealId)
  if (error) return   // table missing (pre-0021) — leave state as it was
  setDb(p => ({
    ...p,
    dealContacts: [...(p.dealContacts || []).filter(r => r?.deal_id !== dealId), ...(data || [])],
  }))
}

// ── Commission entry (deal Details tab) ──────────────────────────────────────
// The one commission number the ASSIGNED AGENT owns: what the client is being
// charged, priced either as a percentage of the deal value or as a flat fee.
// How that gross gets SPLIT (per-agent take-home, referrals, the brokerage's
// share) is back-office data in the admin-only `commissions` table and never
// appears here — this field is its input. `src/lib/commission.js` documents the
// precedence: an admin's explicit entry wins, then this, then the legacy scalar.
function CommissionFields({ form, set }) {
  const type    = form.commission_type === 'flat' ? 'flat' : 'percent'
  const value   = Number(form.value) || 0
  const preview = describeDealCommission({ ...form, commission_type: type })

  return (
    <div style={{ borderTop:'1px solid var(--gw-border)', paddingTop:14, marginTop:4 }}>
      <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:12 }}>Commission</div>

      {/* Percentage / Flat fee — same toggle pattern as Property Category */}
      <div className="form-group">
        <label className="form-label">How is it charged?</label>
        <div style={{ display:'flex', gap:0, border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
          {[['percent','Percentage'],['flat','Flat Fee']].map(([key, label]) => (
            <button key={key} type="button" onClick={() => set('commission_type', key)}
              style={{ flex:1, padding:'7px 0', border:'none', cursor:'pointer', fontFamily:'var(--font-body)', fontSize:12, fontWeight:600, transition:'all 150ms',
                background: type === key ? 'var(--gw-slate)' : '#fff',
                color:      type === key ? '#fff'            : 'var(--gw-mist)' }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {type === 'percent' ? (
        <div className="form-group">
          <label className="form-label">Commission Rate (%)</label>
          <input className="form-control" type="number" min="0" max="100" step="0.05"
            value={form.commission_pct ?? ''} onChange={e=>set('commission_pct', e.target.value)} placeholder="e.g. 3" />
        </div>
      ) : (
        <div className="form-group">
          <label className="form-label">Flat Fee ($)</label>
          <input className="form-control" type="number" min="0" step="100"
            value={form.commission_flat ?? ''} onChange={e=>set('commission_flat', e.target.value)} placeholder="e.g. 12500" />
        </div>
      )}

      {/* Live gross — the agent never has to do the math in their head. */}
      <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', fontSize:12 }}>
        {!preview ? (
          <span style={{ color:'var(--gw-mist)' }}>
            Enter {type === 'flat' ? 'a flat fee' : 'a rate'} to see the gross commission on this deal.
          </span>
        ) : preview.gross <= 0 ? (
          <span style={{ color:'var(--gw-mist)' }}>
            {preview.pct}% — add a Sale / Deal Value above to see the dollar amount.
          </span>
        ) : (
          <>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
              <span style={{ color:'var(--gw-mist)' }}>Gross commission</span>
              <strong style={{ fontSize:14 }}>{formatCurrency(preview.gross)}</strong>
            </div>
            <div style={{ color:'var(--gw-mist)', marginTop:4, fontSize:11 }}>
              {type === 'flat'
                ? (value > 0
                    ? <>Flat fee — {(preview.gross / value * 100).toFixed(2)}% of {formatCurrency(value)}.</>
                    : <>Flat fee, independent of the deal value.</>)
                : <>{preview.pct}% of {formatCurrency(value)}.</>}
            </div>
          </>
        )}
      </div>
      <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6 }}>
        This is the total commission charged on the deal — the back office splits it from here.
      </div>
    </div>
  )
}

// The contacts linked to a deal, as a SORTED id list — a stable content key, so a
// refetch that returns the same people in a different order (or simply a new array)
// doesn't read as a change. Pure and exported for testing: the whole tab-switch bug
// lived in treating array identity as meaning.
export function dealContactIdsFor(dealContacts, dealId) {
  if (!dealId) return []
  return (dealContacts || [])
    .filter(dc => dc?.deal_id === dealId)
    .map(dc => dc?.contact_id)
    .filter(Boolean)
    .sort()
}

// The same stable key, but including each link's SIDE — so moving someone from
// the buyer side to the seller side re-seeds the drawer, which a plain id list
// would read as "nothing changed".
export function dealContactKeyFor(dealContacts, dealId) {
  if (!dealId) return ''
  return (dealContacts || [])
    .filter(dc => dc?.deal_id === dealId && dc?.contact_id)
    .map(dc => `${dc.contact_id}:${dc.side || ''}`)
    .sort()
    .join(',')
}

export function DealDrawer({ open, onClose, deal, agents, contacts, properties, deals = [], dealContacts = [], propertyContacts = [], activeAgent, onSave, setDb, initialTab = 'details' }) {
  const blank = { title:'', contact_id:'', buyer_contact_id:'', seller_contact_id:'', property_id:'', agent_id:'', stage:'lead', value:'', probability:0, expected_close_date:'', notes:'', prop_category:'residential', prop_subtype:'', comp_data:{}, commission_type:'percent', commission_pct:'', commission_flat:'' }
  const [form, setForm]     = useState(deal || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [tab, setTab]       = useState(initialTab)
  // Stage picker reads the agent's own column names, so the drawer and the
  // board they dragged the card from agree.
  const stageLabels         = useStageLabels()
  // Additional contacts (husband & wife, co-buyers, co-owners), kept PER SIDE —
  // the primaries are form.buyer_contact_id / form.seller_contact_id. Both sides
  // are held in state even when only one is shown, so flipping Representing to
  // 'both' and back never discards the other side's people.
  const [additionalBySide, setAdditionalBySide] = useState({ buyer: [], seller: [] })

  // WHY THE DEPS ARE CONTENT, NOT OBJECTS — this is the "the modal closed when I
  // switched tabs" bug.
  //
  // This effect re-seeds the form AND resets the visible tab. It used to depend on
  // the `deal` OBJECT and the `dealContacts` ARRAY, both of which arrive from App's
  // `db` state. Switching browser tabs makes Supabase refresh the auth token, which
  // hands App a new session object, which re-runs its loader, which calls setDb with
  // freshly-built arrays. Same data, new identities — so this effect fired and
  // `setTab()` threw the agent back to Details, unmounting the Signatures tab and
  // destroying the open BoldSign editor with it. The draft survived in BoldSign; the
  // agent's place in it did not.
  //
  // Seeding belongs to "the drawer opened on this deal", so that is what it depends
  // on: the deal's ID, not its object identity, and a content KEY for the linked
  // contacts rather than the array they came in. A refetch that changes nothing now
  // changes nothing. It also means an agent's half-typed edits are no longer wiped
  // by a background refetch — the same bug wearing different clothes.
  const dealContactKey = dealContactKeyFor(dealContacts, deal?.id)

  React.useEffect(() => {
    setForm(deal ? {
      ...blank, ...deal,
      expected_close_date: deal.expected_close_date ? deal.expected_close_date.slice(0,10) : '',
      comp_data: deal.comp_data || {},
      // Null columns must become '' so the inputs stay controlled, and a legacy
      // row with no type flag reads as a percentage deal (matching migration 0024).
      commission_type:  deal.commission_type === 'flat' ? 'flat' : 'percent',
      commission_pct:   deal.commission_pct  ?? '',
      commission_flat:  deal.commission_flat ?? '',
      // A deal saved before the per-side columns existed has its single contact
      // read onto the side it represents (src/lib/dealPeople.js), so opening the
      // drawer shows that person where they belong instead of an empty field.
      buyer_contact_id:  primaryContactIdFor(deal, 'buyer')  || '',
      seller_contact_id: primaryContactIdFor(deal, 'seller') || '',
    } : blank)
    setErrors({})
    setTab(deal?.id ? initialTab : 'details')
    setAdditionalBySide(deal?.id ? {
      buyer:  dealContactIdsForSide(dealContacts, deal, 'buyer'),
      seller: dealContactIdsForSide(dealContacts, deal, 'seller'),
    } : { buyer: [], seller: [] })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on
    // the deal's IDENTITY and its contacts' CONTENT; see the comment above.
  }, [deal?.id, open, initialTab, dealContactKey])

  // ── Carry the linked property's extra contacts into the picker ─────────────
  // "Start Deal" copies the property's Additional Contacts onto the new deal, so
  // a co-owner normally arrives here as a real deal_contacts row and seeds a
  // signer row of their own. Deals that never got that copy — converted before
  // the carry-over shipped, or built from scratch and linked to a property later
  // — had nothing, and the co-owner silently missed the signature packet.
  //
  // So an EMPTY picker seeds from the property. A picker that already has
  // someone in it is left alone: re-adding a person the agent deliberately
  // removed from this deal would put them back on the next send, which is
  // exactly the silent behavior worth avoiding. Those show up as a one-click
  // "also on the property" suggestion under the field instead.
  const propertyContactKey = propertyContactIds(propertyContacts, form.property_id).slice().sort().join(',')
  const propertySeedRef = useRef('')

  // ── Which side(s) this deal represents ────────────────────────────────────
  // Buyer, Seller, or Both, read from comp_data.transaction_type — the same
  // field the old two-way toggle wrote, so no deal changes meaning here. 'Both'
  // is what makes the two contact sections appear.
  const representing  = representingFor(form)
  const visibleSides  = sidesFor(representing)
  const primaryFor    = (side) => (side === 'seller' ? form.seller_contact_id : form.buyer_contact_id) || ''

  // People the agent has taken off this deal. Removing the LAST extra empties
  // the picker, which reads exactly like "this deal never had one" — without
  // this, the property would seed them back on the next open and the removal
  // would never stick. Kept for the session; they remain one click away below.
  // Kept PER SIDE, because a removal only sticks on the side it was made on.
  const removedRef = useRef({ dealKey: '', ids: { buyer: [], seller: [] } })
  const changeAdditionalContacts = (side, next) => {
    const dealKey = deal?.id || 'new'
    const known = removedRef.current.dealKey === dealKey ? removedRef.current.ids : { buyer: [], seller: [] }
    // Anyone previously removed or currently picked, who isn't in the new list.
    // Re-adding someone drops them from the memory by the same rule.
    removedRef.current = {
      dealKey,
      ids: {
        ...known,
        [side]: [...new Set([...(known[side] || []), ...(additionalBySide[side] || [])])].filter(id => !next.includes(id)),
      },
    }
    setAdditionalBySide(prev => ({ ...prev, [side]: next }))
  }

  // Which side the property's co-owners belong to: the seller side when the deal
  // has one, otherwise the single client set they have always sat in.
  const ownerSide = propertyContactSide(form)

  React.useEffect(() => {
    if (!open) { propertySeedRef.current = ''; return }
    // The key includes the property's link CONTENT, so rows that arrive after
    // the drawer opened can still seed an empty picker. Nothing is ever
    // overwritten — `prev.length` inside seedPickerFromProperty is what
    // protects a curated list.
    const seedKey = `${deal?.id || 'new'}:${form.property_id || ''}:${ownerSide}:${propertyContactKey}`
    if (propertySeedRef.current === seedKey) return
    propertySeedRef.current = seedKey
    const excludeIds = removedRef.current.dealKey === (deal?.id || 'new') ? (removedRef.current.ids[ownerSide] || []) : []
    setAdditionalBySide(prev => ({
      ...prev,
      [ownerSide]: seedPickerFromProperty({
        selectedIds: prev[ownerSide] || [], propertyId: form.property_id, propertyContacts,
        primaryContactId: primaryFor(ownerSide), excludeIds,
      }),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the deal's
    // IDENTITY and the property links' CONTENT, like the seeding effect above.
  }, [open, deal?.id, form.property_id, form.buyer_contact_id, form.seller_contact_id, ownerSide, propertyContactKey])

  // Anyone left on the property who isn't on the deal — offered, never forced.
  const propertyOnlyIds = propertyExtrasNotOnDeal({
    propertyId: form.property_id, propertyContacts,
    selectedIds: [...(additionalBySide.buyer || []), ...(additionalBySide.seller || [])],
    primaryContactId: primaryFor(ownerSide),
    excludeIds: [primaryFor(ownerSide === 'buyer' ? 'seller' : 'buyer')].filter(Boolean),
  })
  const propertyOnlyContacts = propertyOnlyIds.map(id => contacts.find(c => c.id === id)).filter(Boolean)

  // Resolved additional-contact objects — used for the "Send from Template"
  // signer prefill on the Signatures tab (co-signers get their own rows). Both
  // sides go in: on a deal representing both parties, everyone signs something.
  const extraContacts = [...(additionalBySide.buyer || []), ...(additionalBySide.seller || [])]
    .map(id => contacts.find(c => c.id === id)).filter(Boolean)

  const set  = (k, v) => setForm(p => ({...p, [k]: v}))
  const setCD = (k, v) => setForm(p => ({...p, comp_data: {...(p.comp_data||{}), [k]: v}}))
  const cd = form.comp_data || {}
  const setPrimaryFor = (side, id) => set(side === 'seller' ? 'seller_contact_id' : 'buyer_contact_id', id || '')

  const linkedProperty = form.property_id ? (properties || []).find(p => p.id === form.property_id) || null : null

  // Linking a property fills in what the listing already knows, but only where
  // the deal is BLANK — an agent who typed a negotiated number or a deal title
  // of their own keeps it. This is what stops a fresh deal from sitting at "no
  // value" next to a priced listing, which is the state the two-way sync then
  // has to reconcile forever.
  const linkProperty = (propertyId) => {
    const picked = propertyId ? (properties || []).find(p => p.id === propertyId) : null
    setForm(prev => ({
      ...prev,
      property_id: propertyId,
      value: (prev.value === '' || prev.value === null || prev.value === undefined) && picked?.list_price != null
        ? picked.list_price
        : prev.value,
      title: !prev.title.trim() && picked?.address ? picked.address : prev.title,
    }))
  }

  // Additional agents — mirrors deals.co_agent_ids, the same column the deal
  // page's "Agents on deal" card reads via agentIdsOnDeal(), so adding/removing
  // one here shows up there once saved.
  const additionalAgentIds = form.co_agent_ids || []

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
      // Linking a NEW deal to a property is a conversion too, so its co-agents
      // come along exactly as they do from the property's "Start Deal" button.
      // An existing deal only seeds from the property once, at conversion time.
      const seededCoAgents = deal?.id ? [] : coAgentIdsForNewDeal(linkedProperty, form.agent_id || null)
      // Manual picks from the Additional Agents field, merged with anything seeded
      // from the property above — never the primary agent, never duplicated.
      const finalCoAgentIds = [...new Set([...additionalAgentIds, ...seededCoAgents])].filter(id => id && id !== form.agent_id)

      // Only the sides this deal actually represents are saved: flipping Both →
      // Buyer must not leave a seller contact on the row for a form to print.
      // The picked people stay in drawer state, so flipping back restores them.
      const savedSides = { buyer: null, seller: null }
      for (const side of visibleSides) savedSides[side] = primaryFor(side) || null
      const savedExtras = {
        buyer:  visibleSides.includes('buyer')  ? (additionalBySide.buyer  || []) : [],
        seller: visibleSides.includes('seller') ? (additionalBySide.seller || []) : [],
      }
      // On a both-sided deal either primary is a defensible mirror, so the rule
      // is "don't change it": a deal already pointing at one of the two keeps
      // pointing there, and only a deal with no usable mirror picks one — the
      // seller, the party this deal's property, title and price belong to.
      // Without this, switching an existing buyer-side deal to Both would
      // silently repoint the portal, the mass-email token and the BoldSign
      // prefill at a different person.
      const mirrorPrimaryId = representing === 'both'
        ? ([savedSides.buyer, savedSides.seller].includes(form.contact_id) ? form.contact_id : (savedSides.seller || savedSides.buyer))
        : savedSides[visibleSides[0]]

      // Explicit whitelist — never spread full form object (prevents unknown-column schema errors)
      let payload = {
        co_agent_ids:        finalCoAgentIds,
        title:               form.title.trim(),
        stage:               form.stage,
        value:               form.value !== '' && form.value !== null ? Number(form.value) : null,
        probability:         Number(form.probability) || 0,
        expected_close_date: form.expected_close_date || null,
        // `contact_id` stays the single primary contact of the side we represent —
        // the BoldSign prefill, the client portal, mass email and every deal card
        // read it, and none of them know about sides. See mirrorPrimaryId above
        // for what a both-sided deal points it at.
        contact_id:          mirrorPrimaryId       || null,
        buyer_contact_id:    savedSides.buyer,
        seller_contact_id:   savedSides.seller,
        property_id:         form.property_id  || null,
        agent_id:            form.agent_id     || null,
        notes:               form.notes        || null,
        prop_category:       form.prop_category || null,
        prop_subtype:        form.prop_subtype  || null,
        comp_data:           form.comp_data     || null,
        // Commission entry — only the field the chosen type uses is persisted, so
        // switching percent ⇄ flat can't leave a stale amount behind for the
        // engine (or a listing agreement) to pick up.
        commission_type:     form.commission_type === 'flat' ? 'flat' : 'percent',
        commission_pct:      form.commission_type !== 'flat' && form.commission_pct  !== '' && form.commission_pct  !== null ? Number(form.commission_pct)  : null,
        commission_flat:     form.commission_type === 'flat' && form.commission_flat !== '' && form.commission_flat !== null ? Number(form.commission_flat) : null,
      }
      const write = async (body) => {
        if (deal?.id) {
          const { error } = await supabase.from('deals').update(body).eq('id', deal.id)
          return { error, savedId: deal.id }
        }
        const { data, error } = await supabase.from('deals').insert([body]).select('id').single()
        return { error, savedId: data?.id }
      }

      let { error, savedId } = await write(payload)
      let degraded = false
      let coAgentsDropped = false

      // deals.co_agent_ids arrives with migration 0025. Until it's applied the
      // deal saves without it and the team still resolves from the linked
      // property, so this degrades quietly rather than failing the save.
      if (error && isMissingCoAgentColumn(error)) {
        const { co_agent_ids, ...rest } = payload
        payload = rest
        coAgentsDropped = true
        ;({ error, savedId } = await write(payload))
      }

      // deals.buyer_contact_id / seller_contact_id arrive with migration 0040.
      // Until it's applied the deal saves with `contact_id` alone — the
      // pre-0040 single-contact behavior — rather than failing the save.
      let sidesDropped = false
      if (error && isMissingSideColumn(error)) {
        const { buyer_contact_id, seller_contact_id, ...rest } = payload
        payload = rest
        sidesDropped = true
        ;({ error, savedId } = await write(payload))
      }

      // The commission columns arrive with migration 0024. Until it's applied,
      // drop them and save the rest rather than blocking the whole deal — the
      // agent gets an actionable pointer instead of an opaque schema error.
      if (error && /commission_(type|pct|flat)/.test(error.message || '')) {
        const { commission_type, commission_pct, commission_flat, ...rest } = payload
        const retry = await write(rest)
        if (retry.error) { pushToast(friendlyDbError(retry.error) || retry.error.message, 'error'); return }
        savedId  = retry.savedId
        degraded = true
      } else if (error) {
        pushToast(friendlyDbError(error) || error.message, 'error'); return
      }

      // Sync additional contacts (best-effort — the deal itself is already saved),
      // then mirror the result into global state so the picker and the deal page's
      // People card read the rows that now exist.
      if (savedId && await syncDealContacts(savedId, savedExtras)) {
        await reloadDealContacts(setDb, savedId)
      }

      // ── Price round-trip ───────────────────────────────────────────────────
      // The deal's value and the listing's price are one number
      // (src/lib/pricing.js): a change here reaches the property, its other open
      // deals, and the shared Pricing History both tabs read. Best-effort — the
      // deal is already saved, so a failure warns rather than losing the edit.
      let priceWarning = null
      if (savedId && priceChanged(deal?.value, form.value)) {
        const sync = await syncPriceChange({
          price: form.value, previousPrice: deal?.value, origin: 'deal',
          property: linkedProperty, dealId: savedId, deals, actor: activeAgent,
        })
        priceWarning = sync.warning
        if ((sync.propertyPatch || sync.repricedDealIds.length) && setDb) {
          const nextValue = payload.value
          setDb(prev => ({
            ...prev,
            properties: sync.propertyPatch
              ? (prev.properties || []).map(p => p.id === form.property_id ? { ...p, ...sync.propertyPatch } : p)
              : prev.properties,
            deals: (prev.deals || []).map(d => sync.repricedDealIds.includes(d.id) ? { ...d, value: nextValue } : d),
          }))
        }
      }

      const coAgentWarning = coAgentsDropped && seededCoAgents.length
        ? 'Deal saved, but its co-agents were not — ask an admin to apply database migration 0025.'
        : null
      const sidesWarning = sidesDropped
        ? 'Deal saved, but the buyer/seller split was not — ask an admin to apply database migration 0040.'
        : null
      const warning = degraded
        ? 'Deal saved, but the commission was not — ask an admin to apply database migration 0024.'
        : sidesWarning || coAgentWarning || priceWarning
      pushToast(warning || (deal?.id ? 'Deal updated' : 'Deal added'), warning ? 'error' : undefined)
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
          {[['details','Details'],['dates','Key Dates'],['pricing','Pricing History'],['checklist','Checklist'],['documents','Documents'],['signatures','Signatures'],['portal','Client Portal']].map(([id, label]) => (
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

            {/* Which side(s) of the table we represent. Decides which contact
                sections appear below, and which Form Library packets the deal's
                forms come from. Shares the Forms tab's
                comp_data.transaction_type field.

                Commercial deals get it too: an agent representing both parties
                on a multifamily sale has the same two client sets to keep
                apart, and nothing on the board depends on this value. */}
            <div className="form-group">
              <label className="form-label">Representing</label>
              <div style={{ display:'flex', gap:0, border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                {REPRESENTING_OPTIONS.map(([side, label]) => {
                  const selected = representing === side
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
              {representing === 'both' && (
                <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>
                  Representing both parties — each side keeps its own contacts below.
                </div>
              )}
            </div>

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

            <div className="form-group"><label className="form-label">Stage</label><select className="form-control" value={formStages.includes(form.stage) ? form.stage : boardStageFor(form, formTrack)} onChange={e=>set('stage',e.target.value)}>{formStages.map(s=><option key={s} value={s}>{stageLabels[s]}</option>)}</select></div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Sale / Deal Value</label>
                <input className="form-control" type="number" value={form.value||''} onChange={e=>set('value',e.target.value)} placeholder="0" />
                {/* The deal's value and the listing's price are one number
                    (src/lib/pricing.js) — this says so out loud before the
                    agent saves, rather than letting the two drift silently. */}
                {linkedProperty && priceChanged(linkedProperty.list_price, form.value) && (
                  <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>
                    Listing price is {linkedProperty.list_price ? formatCurrency(linkedProperty.list_price) : 'not set'} — saving updates the property and logs the change to Pricing History.
                  </div>
                )}
              </div>
              <div className="form-group"><label className="form-label">Probability %</label><input className="form-control" type="number" min="0" max="100" value={form.probability||0} onChange={e=>set('probability',e.target.value)} /></div>
            </div>
            <div className="form-group"><label className="form-label">Expected Close Date</label><input className="form-control" type="date" value={form.expected_close_date||''} onChange={e=>set('expected_close_date',e.target.value)} /></div>
            {/* One contact section per side we represent. On a 'both' deal that
                is two, each with its own primary and its own extras, because a
                buyer and a seller are not interchangeable people and editing one
                must never touch the other. On a one-sided deal it reads exactly
                like the single Contact field it replaces, just labelled with the
                side it belongs to. */}
            {visibleSides.map(side => {
              const otherSide   = side === 'buyer' ? 'seller' : 'buyer'
              const extras      = additionalBySide[side] || []
              const showOwners  = side === ownerSide && propertyOnlyContacts.length > 0
              // Anyone on the other side can't also be picked here.
              const takenOnOtherSide = new Set([
                primaryFor(otherSide),
                ...(visibleSides.includes(otherSide) ? (additionalBySide[otherSide] || []) : []),
              ].filter(Boolean))
              const pickable = contacts.filter(c => !takenOnOtherSide.has(c.id))
              return (
                <div key={side} style={representing === 'both' ? {
                  border:'1px solid var(--gw-border)', borderRadius:'var(--radius)',
                  padding:'12px 12px 4px', marginBottom:12, background:'var(--gw-bone)',
                } : undefined}>
                  {representing === 'both' && (
                    <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:10 }}>
                      {SIDE_LABELS[side]} side
                    </div>
                  )}
                  <div className="form-group">
                    <label className="form-label">{SIDE_LABELS[side]} Contact</label>
                    <SearchDropdown items={pickable} value={primaryFor(side)} onSelect={v=>setPrimaryFor(side, v)}
                      placeholder={`Search ${side === 'buyer' ? 'buyers' : 'sellers'}…`} labelKey={c=>`${c.first_name} ${c.last_name}`} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Additional {SIDE_LABELS[side]} Contacts</label>
                    <ContactMultiSelect contacts={pickable} selectedIds={extras} onChange={next=>changeAdditionalContacts(side, next)}
                      excludeId={primaryFor(side)}
                      placeholder={side === 'buyer' ? 'Add co-buyer, spouse…' : 'Add co-owner, spouse…'} />
                    <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>Husband &amp; wife, co-buyers, co-owners — these also pre-fill as signers when you Send from Template.</div>
                    {showOwners && (
                      <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>Also on this property:</span>
                        {propertyOnlyContacts.map(c => (
                          <button key={c.id} type="button" className="btn btn--ghost btn--sm" style={{ fontSize: 11, padding: '1px 7px' }}
                            onClick={() => changeAdditionalContacts(side, [...extras, c.id])}>
                            + {c.first_name} {c.last_name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            <div className="form-group"><label className="form-label">Property</label><SearchDropdown items={properties} value={form.property_id} onSelect={linkProperty} placeholder="Search properties…" labelKey="address" /></div>
            <div className="form-group"><label className="form-label">Assigned Agent</label><select className="form-control" value={form.agent_id||''} onChange={e=>set('agent_id',e.target.value)}><option value="">Unassigned</option>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
            <div className="form-group">
              <label className="form-label">Additional Agents</label>
              <AgentMultiSelect agents={agents} selectedIds={additionalAgentIds} onChange={v=>set('co_agent_ids',v)} excludeId={form.agent_id} placeholder="Search agents to add…" />
            </div>

            {/* ── Commission ────────────────────────────────────── */}
            <CommissionFields form={form} set={set} />

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

      {/* Pricing History tab — the LINKED PROPERTY's price log, which is the
          same log the property drawer's own tab shows. The price belongs to the
          building, so a reduction made on either surface appears on both. */}
      {tab === 'pricing' && isExisting && (
        <DealPricingHistoryTab
          deal={deal}
          property={form.property_id ? (properties || []).find(p => p.id === form.property_id) : null}
        />
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
        <SignaturesTab deal={deal} contacts={contacts} properties={properties} extraContacts={extraContacts} agents={agents} activeAgent={activeAgent} />
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

// ─────────────────────────────────────────────────────────────────────────────
// Editable board column header.
//
// Renaming a column is a personal display preference — "Qualified" becomes
// "Vetted", "Offer" becomes "LOI Out". The deal's stored stage token never
// changes, so reports, automations, the stage CHECK constraint, and the client
// portal keep working off the canonical value; only what this agent reads
// changes, and only for this agent.
//
// Enter or blur commits, Escape reverts, and an empty box restores the built-in
// label — which is the whole undo story, so there's no way to get stuck with a
// header you can't read.
// ─────────────────────────────────────────────────────────────────────────────
function StageHeader({ stage, label, canRename, onRename }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(label)

  const begin = () => { if (!canRename) return; setDraft(label); setEditing(true) }
  const commit = () => {
    setEditing(false)
    if (draft.trim() === label) return          // nothing typed, nothing to save
    onRename(stage, draft)
  }

  if (editing) {
    return (
      <input
        className="kanban-col__rename"
        value={draft}
        maxLength={STAGE_LABEL_MAX}
        autoFocus
        onFocus={e => e.target.select()}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter')  { e.preventDefault(); commit() }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
        }}
        aria-label={`Rename the ${label} column`}
        placeholder={STAGE_LABELS[stage]}
      />
    )
  }

  return (
    <div className="kanban-col__label" onDoubleClick={begin}
         title={canRename ? `${label} — double-click to rename` : label}>
      <span>{label}</span>
      {canRename && (
        <button type="button" className="kanban-col__rename-btn" onClick={begin}
                aria-label={`Rename the ${label} column`}>
          <Icon name="edit" size={11} />
        </button>
      )}
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

  // ── Personal column headers ──────────────────────────────────────────────
  // Provided by App (defaults + this agent's overrides). Renaming writes to the
  // agent row through the authenticated profile API and mirrors the SAVED row
  // back into db.agents, which is what re-renders the provider — so a rename
  // the server rejected never sticks on screen.
  const stageLabels   = useStageLabels()
  const canRename     = !!activeAgent?.id
  const [renaming, setRenaming] = useState(false)

  // Renaming two columns in quick succession must not lose the first. Each save
  // sends the WHOLE map, so the second request has to be built from the first
  // one's intent — not from `activeAgent`, which won't have caught up yet. This
  // ref carries that intent, tagged with the agent it belongs to so switching
  // agents (admin "view as") can never inherit someone else's pending edit.
  const pendingLabels = useRef({ agentId: null, labels: null })
  const myStageLabels =
    (pendingLabels.current.agentId === activeAgent?.id ? pendingLabels.current.labels : null)
    || activeAgent?.stage_labels || {}

  const persistStageLabels = async (next) => {
    if (!activeAgent?.id) return
    pendingLabels.current = { agentId: activeAgent.id, labels: next }
    setRenaming(true)
    try {
      const saved = await saveStageLabels(activeAgent.id, next)
      setDb(p => ({ ...p, agents: (p.agents || []).map(a => a.id === saved.id ? { ...a, ...saved } : a) }))
    } catch (e) {
      // Fall back to whatever the server actually holds, so a retry doesn't
      // build on an edit that never landed.
      pendingLabels.current = { agentId: null, labels: null }
      pushToast(e.message || 'Could not save the column name', 'error')
    } finally {
      setRenaming(false)
    }
  }

  const renameStage = (stage, value) => {
    const label = normalizeStageLabel(stage, value)
    const next  = { ...myStageLabels }
    // A blank entry (or one that matches the built-in name) removes the
    // override rather than storing it — that's how a column resets.
    if (label) next[stage] = label
    else       delete next[stage]
    if (next[stage] === myStageLabels[stage]) return   // nothing actually changed
    persistStageLabels(next)
  }

  const resetStageLabels = () => persistStageLabels({})

  const deals        = db.deals        || []
  const agents       = db.agents       || []
  const contacts     = db.contacts     || []
  const properties   = db.properties   || []
  const tasks        = db.tasks        || []
  const dealContacts = db.dealContacts || []   // additional-contact link rows (migration 0021)

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
    // Best-effort: clear this deal off any tasks pointing at it. RLS makes tasks
    // strictly personal, so this only ever reaches the CALLER'S OWN tasks — a
    // co-agent's task on the same deal is invisible here and silently unaffected,
    // which is exactly how a shared deal used to fail the delete below with a raw
    // "violates foreign key constraint tasks_deal_id_fkey". The database now
    // clears those itself (migration 0029); this stays because it costs nothing
    // and keeps deletes working on a database that hasn't had 0029 applied yet.
    await supabase.from('tasks').update({ deal_id: null }).eq('deal_id', id)
    const { error } = await supabase.from('deals').delete().eq('id', id)
    if (error) { pushToast(friendlyDbError(error) || error.message, 'error'); setConfirm(null); return }
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
    pushToast(`Moved to ${stageLabels[newStage]}`)

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
          {pipelineTab === 'deals' && dealView === 'board' && canRename && hasStageLabelOverrides(myStageLabels) && (
            <button className="btn btn--ghost btn--sm" style={{ fontSize:11 }}
              onClick={resetStageLabels} disabled={renaming}
              title="Put every column back to its standard name">
              Reset headers
            </button>
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
                  <div style={{ minWidth:0 }}>
                    <StageHeader stage={stage} label={stageLabels[stage]}
                      canRename={canRename} onRename={renameStage} />
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
                    // The deal's own co-agents (copied over at conversion), with
                    // the linked property as the fallback for deals converted
                    // before migration 0025.
                    const allAgents  = agentIdsOnDeal(deal, dealProp)
                      .map(id => agentMap[id]).filter(Boolean)
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
                  const teamAgents = agentIdsOnDeal(deal, propertyMap[deal.property_id])
                    .map(id => agentMap[id]).filter(Boolean)
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
                      <td style={{ padding:'9px 12px', whiteSpace:'nowrap' }}><Badge variant={col === 'closed' ? 'closed' : col === 'lost' ? 'lost' : 'lead'}>{stageLabels[col]}</Badge></td>
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
                    {stageLabels[item.deal.stage] || item.deal.stage}
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
        agents={agents} contacts={contacts} properties={properties} deals={deals} dealContacts={dealContacts} propertyContacts={db.propertyContacts || []} activeAgent={activeAgent} onSave={reload} setDb={setDb} />
      {confirm && <ConfirmDialog message="This will permanently delete this deal." onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
      {confirmProp && <ConfirmDialog message="Remove this listing from the pipeline? Any linked deals are kept but will be unlinked from the property." onConfirm={() => delProperty(confirmProp)} onCancel={() => setConfirmProp(null)} />}
    </div>
  )
}
