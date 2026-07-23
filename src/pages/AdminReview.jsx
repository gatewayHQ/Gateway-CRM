import React, { useState, useMemo, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Avatar, Badge, EmptyState, pushToast } from '../components/UI.jsx'
import { formatCurrency, formatDate, STAGE_LABELS } from '../lib/helpers.js'
import { getClosingGate, gateBadge } from '../lib/compliance.js'
import { daysBetween } from '../lib/pipeline.js'
import { TABLES, REVIEW_STATUS, BUCKETS } from '../lib/constants.js'
import { decideDealReview } from '../lib/services/review.js'
import { signDealDocumentUrl } from '../lib/services/documents.js'

// ─────────────────────────────────────────────────────────────────────────────
// AdminReview — the broker's review inbox.
//
// One queue: every deal an agent has submitted for closing review, plus deals
// the admin has paused with "changes requested" that are now resubmitted. The
// admin can read the compliance gate, the agent's notes, and approve / request
// changes / open the deal without leaving the queue. The admin's daily job
// goes from "scan every deal" to "work the queue top-to-bottom."
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_TABS = [
  { id: 'pending',            label: 'Awaiting Review', variant: 'pending' },
  { id: 'changes_requested',  label: 'Changes Requested', variant: 'lost' },
  { id: 'approved',           label: 'Approved',         variant: 'closed' },
]

export default function AdminReviewPage({ db, setDb, activeAgent, go, isAdmin }) {
  const deals       = db.deals       || []
  const agents      = db.agents      || []
  const commissions = db.commissions || []

  const [tab, setTab] = useState('pending')
  const [openId, setOpenId] = useState(null)        // expanded deal row
  const [stepsByDeal,    setStepsByDeal]    = useState({})
  const [envByDeal,      setEnvByDeal]      = useState({})
  const [filesByDeal,    setFilesByDeal]    = useState({})
  const [notes, setNotes] = useState('')
  const [busy,  setBusy]  = useState(null)

  // Pull steps + envelopes + uploaded files only for the deals expanded in the
  // queue, so we don't round-trip the world. Surfacing the actual paperwork here
  // means the admin can vet a deal without hunting for it in the pipeline.
  const loadDealDetails = useCallback(async (dealId) => {
    if (!dealId || stepsByDeal[dealId]) return
    const [s, e, f] = await Promise.all([
      supabase.from(TABLES.TRANSACTION_STEPS).select('id, title, completed, if_applicable, doc_action').eq('deal_id', dealId),
      supabase.from(TABLES.BOLDSIGN_DOCUMENTS).select('id, status, document_name').eq('deal_id', dealId),
      supabase.storage.from(BUCKETS.DEAL_DOCS).list(`deal-${dealId}`, { sortBy: { column: 'created_at', order: 'desc' } }),
    ])
    setStepsByDeal(p => ({ ...p, [dealId]: s.data || [] }))
    setEnvByDeal(p => ({ ...p, [dealId]: e.data || [] }))
    setFilesByDeal(p => ({ ...p, [dealId]: (f.data || []).filter(x => x.name !== '.emptyFolderPlaceholder') }))
  }, [stepsByDeal])

  // Open an uploaded document in a new tab via a short-lived signed URL.
  const openFile = async (dealId, name) => {
    const { url, error } = await signDealDocumentUrl(`deal-${dealId}/${name}`)
    if (!url) { pushToast(error || 'Could not open file', 'error'); return }
    window.open(url, '_blank', 'noopener')
  }

  useEffect(() => {
    if (openId) loadDealDetails(openId)
  }, [openId, loadDealDetails])

  const commByDeal = useMemo(() => new Map(commissions.map(c => [c.deal_id, c])), [commissions])

  // Pre-compute gates for the pending queue so the admin sees blockers at a glance
  const queue = useMemo(() => {
    const filtered = deals.filter(d => d.review_status === tab)
    return filtered
      .map(d => ({
        deal: d,
        agent: agents.find(a => a.id === d.review_requested_by) || agents.find(a => a.id === d.agent_id),
        waitingDays: d.review_requested_at ? daysBetween(new Date(), new Date(d.review_requested_at)) : null,
        commission: commByDeal.get(d.id) || null,
      }))
      .sort((a, b) => (b.waitingDays ?? 0) - (a.waitingDays ?? 0))
  }, [deals, agents, commByDeal, tab])

  const counts = useMemo(() => {
    const c = { pending: 0, changes_requested: 0, approved: 0 }
    for (const d of deals) if (c[d.review_status] != null) c[d.review_status]++
    return c
  }, [deals])

  const decide = async (deal, decision) => {
    if (!isAdmin) return
    setBusy(`${deal.id}-${decision}`)
    const r = await decideDealReview(deal, decision, { actorId: activeAgent?.id, notes })
    setBusy(null)
    if (!r.ok) { pushToast(r.error, 'error'); return }
    setDb(p => ({ ...p, deals: (p.deals || []).map(d => d.id === deal.id ? { ...d, ...r.patch } : d) }))
    setNotes('')
    setOpenId(null)
    pushToast(decision === REVIEW_STATUS.APPROVED ? 'Approved' : 'Changes requested')
  }

  if (!isAdmin) {
    return (
      <div className="page-content">
        <EmptyState icon="lock" title="Admin only"
          message="The review queue is visible to office admins only."
          action={<button className="btn btn--primary" onClick={() => go('dashboard')}>Back to Dashboard</button>} />
      </div>
    )
  }

  return (
    <div className="page-content">
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div>
          <div className="page-title">Review Queue</div>
          <div className="page-sub">Deals submitted for closing review — approve, request changes, or open the deal</div>
        </div>
      </div>

      {/* Status tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--gw-border)' }}>
        {STATUS_TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{
              padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: tab === t.id ? 700 : 500,
              color: tab === t.id ? 'var(--gw-ink)' : 'var(--gw-mist)',
              borderBottom: tab === t.id ? '2px solid var(--gw-slate)' : '2px solid transparent',
              marginBottom: -1,
            }}>
            {t.label}
            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--gw-mist)' }}>{counts[t.id]}</span>
          </button>
        ))}
      </div>

      {queue.length === 0 ? (
        <EmptyState icon="check"
          title={tab === 'pending' ? 'No deals waiting' : tab === 'changes_requested' ? 'No deals with pending changes' : 'No approved deals yet'}
          message={tab === 'pending'
            ? 'When agents submit deals for closing review, they show up here.'
            : tab === 'changes_requested'
            ? 'Agents will resubmit once they address the requested changes.'
            : 'Approved deals are ready to close.'} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {queue.map(({ deal, agent, waitingDays, commission }) => {
            const isOpen = openId === deal.id
            const steps     = stepsByDeal[deal.id] || []
            const envelopes = envByDeal[deal.id] || []
            const uploaded  = filesByDeal[deal.id] || []
            const reqSteps     = steps.filter(s => !s.if_applicable)
            const missingSteps = reqSteps.filter(s => !s.completed)
            const gate = isOpen ? getClosingGate(deal, { steps, envelopes, commission, hasCommissionVisibility: true }) : null
            const gb   = isOpen ? gateBadge(gate) : null
            return (
              <div key={deal.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div
                  onClick={() => setOpenId(isOpen ? null : deal.id)}
                  style={{
                    padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
                    background: isOpen ? 'var(--gw-bone)' : '#fff',
                  }}>
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14 }}>{deal.title}</strong>
                      <Badge variant={deal.prop_category === 'commercial' ? 'commercial' : 'residential'}>
                        {STAGE_LABELS[deal.stage]}
                      </Badge>
                      {deal.value > 0 && <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>{formatCurrency(deal.value)}</span>}
                      {deal.expected_close_date && <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>Closes {formatDate(deal.expected_close_date)}</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, fontSize: 12, color: 'var(--gw-mist)' }}>
                      {agent && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          <Avatar agent={agent} size={16} /> {agent.name}
                        </span>
                      )}
                      {tab === 'pending' && waitingDays != null && (
                        <span style={{ color: waitingDays > 2 ? '#d97706' : waitingDays > 5 ? '#dc2626' : 'var(--gw-mist)' }}>
                          Waiting {waitingDays}d
                        </span>
                      )}
                      {tab === 'changes_requested' && deal.review_decided_at && (
                        <span>Returned {formatDate(deal.review_decided_at)}</span>
                      )}
                    </div>
                  </div>
                  <button className="btn btn--ghost btn--sm" onClick={(e) => { e.stopPropagation(); go(`deal/${deal.id}/documents`) }}>
                    Go to property →
                  </button>
                </div>

                {isOpen && (
                  <div style={{ padding: '14px 16px', borderTop: '1px solid var(--gw-border)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {/* Compliance summary */}
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span style={{ width: 9, height: 9, borderRadius: '50%', background: gb.color }} />
                        <strong style={{ fontSize: 13 }}>Compliance: {gb.label}</strong>
                      </div>
                      {gate.issues.length === 0 ? (
                        <div style={{ fontSize: 12.5, color: 'var(--gw-green)' }}>All checks pass — safe to approve.</div>
                      ) : (
                        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {gate.issues.map(i => <li key={i.code}>{i.label}</li>)}
                        </ul>
                      )}
                    </div>

                    {/* Documents & Forms — the paperwork, right in the queue, so the
                        admin can vet a deal without hunting for the property. */}
                    <div style={{ borderTop: '1px solid var(--gw-border)', paddingTop: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <strong style={{ fontSize: 13 }}>Documents &amp; Forms</strong>
                        <button className="btn btn--ghost btn--sm" onClick={(e) => { e.stopPropagation(); go(`deal/${deal.id}/documents`) }}>
                          Go to property →
                        </button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
                        {/* Forms checklist */}
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>
                            Forms · {reqSteps.length - missingSteps.length}/{reqSteps.length}
                          </div>
                          {reqSteps.length === 0 ? (
                            <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>No checklist yet.</div>
                          ) : missingSteps.length === 0 ? (
                            <div style={{ fontSize: 12, color: 'var(--gw-green)' }}>All required forms complete.</div>
                          ) : (
                            <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {missingSteps.slice(0, 6).map(s => <li key={s.id} style={{ color: 'var(--gw-mist)' }}>{s.title}</li>)}
                              {missingSteps.length > 6 && <li style={{ color: 'var(--gw-mist)' }}>+{missingSteps.length - 6} more</li>}
                            </ul>
                          )}
                        </div>
                        {/* Uploaded documents */}
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>
                            Uploaded · {uploaded.length}
                          </div>
                          {uploaded.length === 0 ? (
                            <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>No documents uploaded yet.</div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {uploaded.slice(0, 6).map(f => (
                                <button key={f.name} onClick={(e) => { e.stopPropagation(); openFile(deal.id, f.name) }} title="Open"
                                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', fontSize: 12, color: 'var(--gw-ink)', fontFamily: 'var(--font-body)' }}>
                                  <Icon name="document" size={12} />
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                                </button>
                              ))}
                              {uploaded.length > 6 && <span style={{ fontSize: 11.5, color: 'var(--gw-mist)' }}>+{uploaded.length - 6} more</span>}
                            </div>
                          )}
                        </div>
                        {/* Signatures */}
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>
                            Signatures · {envelopes.length}
                          </div>
                          {envelopes.length === 0 ? (
                            <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>No e-sign envelopes.</div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                              {envelopes.slice(0, 6).map(env => (
                                <div key={env.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                                  <Badge variant={env.status === 'completed' ? 'closed' : env.status === 'voided' ? 'lost' : 'pending'}>{env.status}</Badge>
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{env.document_name || 'Envelope'}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Decision form (only on pending; resubmitted-changes deals show here too) */}
                    {(tab === 'pending' || tab === 'changes_requested') && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--gw-border)', paddingTop: 10 }}>
                        <textarea className="form-control" rows={2} style={{ fontSize: 12.5, resize: 'vertical' }}
                          placeholder="Notes — required if requesting changes, optional on approval"
                          value={openId === deal.id ? notes : ''} onChange={e => setNotes(e.target.value)} />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn--primary btn--sm" onClick={() => decide(deal, REVIEW_STATUS.APPROVED)}
                            disabled={busy === `${deal.id}-${REVIEW_STATUS.APPROVED}`}>
                            {busy === `${deal.id}-${REVIEW_STATUS.APPROVED}` ? 'Approving…' : 'Approve for closing'}
                          </button>
                          <button className="btn btn--secondary btn--sm" onClick={() => decide(deal, REVIEW_STATUS.CHANGES_REQUESTED)}
                            disabled={busy === `${deal.id}-${REVIEW_STATUS.CHANGES_REQUESTED}` || !notes.trim()}
                            title={!notes.trim() ? 'Notes required to request changes' : ''}>
                            {busy === `${deal.id}-${REVIEW_STATUS.CHANGES_REQUESTED}` ? 'Sending…' : 'Request changes'}
                          </button>
                        </div>
                      </div>
                    )}
                    {tab === 'approved' && deal.review_decided_at && (
                      <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>
                        Approved {formatDate(deal.review_decided_at)}
                        {deal.review_notes ? ` — "${deal.review_notes}"` : ''}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
