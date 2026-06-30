import React, { useState, useMemo, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { withRetry, mutationErrorMessage } from '../lib/services/db.js'
import { Icon, Avatar, Badge, EmptyState, pushToast } from '../components/UI.jsx'
import { formatCurrency, formatDate, STAGE_LABELS } from '../lib/helpers.js'
import { getClosingGate, gateBadge } from '../lib/compliance.js'
import { audit } from '../lib/audit.js'
import { daysBetween } from '../lib/pipeline.js'

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
  const [notes, setNotes] = useState('')
  const [busy,  setBusy]  = useState(null)

  // Pull steps + envelopes only for the dealsexpanded in the queue, so we don't
  // round-trip the world.
  const loadDealDetails = useCallback(async (dealId) => {
    if (!dealId || stepsByDeal[dealId]) return
    const [s, e] = await Promise.all([
      supabase.from('transaction_steps').select('id, title, completed, if_applicable, doc_action').eq('deal_id', dealId),
      supabase.from('signwell_documents').select('id, status, document_name').eq('deal_id', dealId),
    ])
    setStepsByDeal(p => ({ ...p, [dealId]: s.data || [] }))
    setEnvByDeal(p => ({ ...p, [dealId]: e.data || [] }))
  }, [stepsByDeal])

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
    if (decision === 'changes_requested' && !notes.trim()) return
    setBusy(`${deal.id}-${decision}`)
    const patch = {
      review_status: decision,
      review_decided_at: new Date().toISOString(),
      review_decided_by: activeAgent?.id || null,
      review_notes: notes.trim() || null,
    }
    const { error, status } = await withRetry(() => supabase.from('deals').update(patch).eq('id', deal.id))
    setBusy(null)
    if (error) { pushToast(mutationErrorMessage(error, status), 'error'); return }
    setDb(p => ({ ...p, deals: (p.deals || []).map(d => d.id === deal.id ? { ...d, ...patch } : d) }))
    if (decision === 'approved') audit.reviewApproved(deal, activeAgent?.id, notes.trim() || null)
    else                          audit.reviewChanges(deal, activeAgent?.id, notes.trim() || null)
    setNotes('')
    setOpenId(null)
    pushToast(decision === 'approved' ? 'Approved' : 'Changes requested')
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
                  <button className="btn btn--ghost btn--sm" onClick={(e) => { e.stopPropagation(); go(`deal/${deal.id}`) }}>
                    Open deal →
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

                    {/* Decision form (only on pending; resubmitted-changes deals show here too) */}
                    {(tab === 'pending' || tab === 'changes_requested') && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--gw-border)', paddingTop: 10 }}>
                        <textarea className="form-control" rows={2} style={{ fontSize: 12.5, resize: 'vertical' }}
                          placeholder="Notes — required if requesting changes, optional on approval"
                          value={openId === deal.id ? notes : ''} onChange={e => setNotes(e.target.value)} />
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn--primary btn--sm" onClick={() => decide(deal, 'approved')}
                            disabled={busy === `${deal.id}-approved`}>
                            {busy === `${deal.id}-approved` ? 'Approving…' : 'Approve for closing'}
                          </button>
                          <button className="btn btn--secondary btn--sm" onClick={() => decide(deal, 'changes_requested')}
                            disabled={busy === `${deal.id}-changes_requested` || !notes.trim()}
                            title={!notes.trim() ? 'Notes required to request changes' : ''}>
                            {busy === `${deal.id}-changes_requested` ? 'Sending…' : 'Request changes'}
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
