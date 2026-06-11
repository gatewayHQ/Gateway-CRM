import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { withRetry, mutationErrorMessage } from '../lib/services/db.js'
import { Icon, Avatar, Badge, EmptyState, pushToast } from '../components/UI.jsx'
import { formatCurrency, formatDate, formatPhone, STAGE_LABELS } from '../lib/helpers.js'
import { TRACKS, trackForDeal, boardStageFor, STAGE_AUTO_TASKS, isOpenStage } from '../lib/stages.js'
import { breakdownForDeal } from '../lib/commission.js'
import { DealDrawer } from './Pipeline.jsx'

const BUCKET = 'deal-documents'

// ─────────────────────────────────────────────────────────────────────────────
// Deal Page — the whole deal on one screen: stage rail, property, people,
// commission, key dates, next actions, timeline, documents & signatures.
// Deep edits (forms, signatures, portal sharing, checklist authoring) reuse
// the battle-tested DealDrawer, opened at the right tab from each card.
// ─────────────────────────────────────────────────────────────────────────────

const timeAgo = (iso) => {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`
  return formatDate(iso)
}

const ACTIVITY_ICONS = { note: 'edit', call: 'phone', email: 'mail', meeting: 'contacts', showing: 'eye' }

const dateUrgency = (dateStr) => {
  if (!dateStr) return null
  const days = Math.ceil((new Date(dateStr + 'T12:00:00') - new Date()) / 86400000)
  if (days < 0) return { color: 'var(--gw-mist)', label: 'passed' }
  if (days === 0) return { color: '#dc2626', label: 'today' }
  if (days <= 3) return { color: '#dc2626', label: `${days}d` }
  if (days <= 7) return { color: '#d97706', label: `${days}d` }
  return { color: 'var(--gw-mist)', label: `${days}d` }
}

function SectionCard({ title, action, children, style }) {
  return (
    <div className="card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 12, ...style }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gw-mist)' }}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  )
}

const drawerLink = (label, onClick) => (
  <button className="btn btn--ghost btn--sm" style={{ fontSize: 11, padding: '2px 8px' }} onClick={onClick}>{label}</button>
)

export default function DealPage({ db, setDb, activeAgent, go, isAdmin, dealId }) {
  const deals      = db.deals      || []
  const agents     = db.agents     || []
  const contacts   = db.contacts   || []
  const properties = db.properties || []

  const [fetched, setFetched]   = useState(null)   // fallback when not in state (deep link)
  const [missing, setMissing]   = useState(false)
  const deal = useMemo(
    () => deals.find(d => d.id === dealId) || fetched,
    [deals, dealId, fetched]
  )

  useEffect(() => {
    if (deals.find(d => d.id === dealId)) return
    supabase.from('deals').select('*').eq('id', dealId).single().then(({ data, error }) => {
      if (data) setFetched(data)
      else if (error) setMissing(true)
    })
  }, [dealId, deals])

  // ── Per-deal extras not in global state ────────────────────────────────────
  const [files, setFiles]         = useState([])
  const [envelopes, setEnvelopes] = useState([])
  const [steps, setSteps]         = useState([])
  const loadExtras = useCallback(async () => {
    if (!dealId) return
    const [f, e, s] = await Promise.all([
      supabase.storage.from(BUCKET).list(`deal-${dealId}`, { sortBy: { column: 'created_at', order: 'desc' } }),
      supabase.from('docusign_envelopes').select('*').eq('deal_id', dealId).order('created_at', { ascending: false }),
      supabase.from('transaction_steps').select('id, title, completed, sort_order').eq('deal_id', dealId).order('sort_order', { ascending: true }),
    ])
    setFiles((f.data || []).filter(x => x.name !== '.emptyFolderPlaceholder'))
    setEnvelopes(e.data || [])
    setSteps(s.data || [])
  }, [dealId])
  useEffect(() => { loadExtras() }, [loadExtras])

  // ── Drawer (deep edit) ─────────────────────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerTab, setDrawerTab]   = useState('details')
  const openDrawer = (tab) => { setDrawerTab(tab); setDrawerOpen(true) }
  const refreshDeal = useCallback(async () => {
    const { data } = await supabase.from('deals').select('*').eq('id', dealId).single()
    if (data) {
      setFetched(data)
      setDb(p => ({ ...p, deals: (p.deals || []).map(d => d.id === dealId ? data : d) }))
    }
    loadExtras()
  }, [dealId, setDb, loadExtras])

  // ── Derived records ────────────────────────────────────────────────────────
  const contact  = deal?.contact_id ? contacts.find(c => c.id === deal.contact_id) : null
  const property = deal?.property_id ? properties.find(p => p.id === deal.property_id) : null
  const agent    = deal?.agent_id ? agents.find(a => a.id === deal.agent_id) : null
  const track    = deal ? TRACKS[trackForDeal(deal)] : null
  const cd       = deal?.comp_data || {}

  const commission = (db.commissions || []).find(c => c.deal_id === dealId)
  const breakdown  = useMemo(
    () => deal ? breakdownForDeal(deal, commission, agents) : null,
    [deal, commission, agents]
  )
  // Everyone on the deal: owner + commission participants, deduped
  const team = useMemo(() => {
    if (!deal) return []
    const ids = [deal.agent_id, ...(breakdown?.participants || []).map(p => p.agent_id)].filter(Boolean)
    return [...new Set(ids)].map(id => agents.find(a => a.id === id)).filter(Boolean)
  }, [deal, breakdown, agents])
  const myTake = useMemo(() => {
    if (!breakdown || !activeAgent) return 0
    return breakdown.participants.filter(p => p.agent_id === activeAgent.id).reduce((s, p) => s + p.agent_take, 0)
  }, [breakdown, activeAgent])

  const dealActivities = useMemo(
    () => (db.activities || []).filter(a => a.deal_id === dealId),
    [db.activities, dealId]
  )
  const dealTasks = useMemo(
    () => (db.tasks || []).filter(t => t.deal_id === dealId && !t.completed)
      .sort((a, b) => new Date(a.due_date || '2999') - new Date(b.due_date || '2999')),
    [db.tasks, dealId]
  )

  // ── Actions ────────────────────────────────────────────────────────────────
  const setStage = async (newStage) => {
    if (!deal || newStage === deal.stage) return
    const { error, status } = await withRetry(() => supabase.from('deals').update({ stage: newStage }).eq('id', deal.id))
    if (error) { pushToast(mutationErrorMessage(error, status), 'error'); return }
    setDb(p => ({ ...p, deals: (p.deals || []).map(d => d.id === deal.id ? { ...d, stage: newStage } : d) }))
    setFetched(f => f && f.id === deal.id ? { ...f, stage: newStage } : f)
    pushToast(`Moved to ${STAGE_LABELS[newStage]}`)
    const auto = STAGE_AUTO_TASKS[newStage]
    if (!auto) return
    const due = new Date(); due.setDate(due.getDate() + auto.daysOut); due.setHours(9, 0, 0, 0)
    const { data: newTask } = await supabase.from('tasks').insert([{
      title: auto.title(deal), type: auto.type, priority: auto.priority,
      due_date: due.toISOString(), agent_id: activeAgent?.id || deal.agent_id || null,
      contact_id: deal.contact_id || null, deal_id: deal.id, completed: false,
    }]).select().single()
    if (newTask) {
      setDb(p => ({ ...p, tasks: [newTask, ...(p.tasks || [])] }))
      pushToast(`Task auto-created: ${newTask.title}`, 'info')
    }
  }

  const [logType, setLogType] = useState('note')
  const [logBody, setLogBody] = useState('')
  const [logging, setLogging] = useState(false)
  const logActivity = async () => {
    const body = logBody.trim()
    if (!body || !deal) return
    setLogging(true)
    const { data, error, status } = await withRetry(() => supabase.from('activities').insert([{
      deal_id: deal.id, contact_id: deal.contact_id || null,
      agent_id: activeAgent?.id || null, type: logType, body,
    }]).select().single())
    setLogging(false)
    if (error) { pushToast(mutationErrorMessage(error, status), 'error'); return }
    setDb(p => ({ ...p, activities: [data, ...(p.activities || [])] }))
    setLogBody('')
    pushToast('Logged')
  }

  const [newTask, setNewTask] = useState('')
  const addTask = async () => {
    const title = newTask.trim()
    if (!title || !deal) return
    const due = new Date(); due.setDate(due.getDate() + 3); due.setHours(9, 0, 0, 0)
    const { data, error, status } = await withRetry(() => supabase.from('tasks').insert([{
      title, type: 'follow-up', priority: 'medium', due_date: due.toISOString(),
      agent_id: activeAgent?.id || null, contact_id: deal.contact_id || null,
      deal_id: deal.id, completed: false,
    }]).select().single())
    if (error) { pushToast(mutationErrorMessage(error, status), 'error'); return }
    setDb(p => ({ ...p, tasks: [data, ...(p.tasks || [])] }))
    setNewTask('')
  }
  const completeTask = async (task) => {
    await supabase.from('tasks').update({ completed: true }).eq('id', task.id)
    setDb(p => ({ ...p, tasks: (p.tasks || []).map(t => t.id === task.id ? { ...t, completed: true } : t) }))
    pushToast('Task completed')
  }

  const toggleStep = async (step) => {
    const completed = !step.completed
    await supabase.from('transaction_steps').update({ completed, completed_at: completed ? new Date().toISOString() : null }).eq('id', step.id)
    setSteps(s => s.map(x => x.id === step.id ? { ...x, completed } : x))
  }

  const persistKeyDate = async (idx, date) => {
    const updated = (cd.key_dates || []).map((d, i) => i === idx ? { ...d, date } : d)
    const comp_data = { ...cd, key_dates: updated }
    const { error, status } = await withRetry(() => supabase.from('deals').update({ comp_data }).eq('id', deal.id))
    if (error) { pushToast(mutationErrorMessage(error, status), 'error'); return }
    setDb(p => ({ ...p, deals: (p.deals || []).map(d => d.id === deal.id ? { ...d, comp_data } : d) }))
    setFetched(f => f && f.id === deal.id ? { ...f, comp_data } : f)
  }

  const [uploading, setUploading] = useState(false)
  const uploadFile = async (file) => {
    if (!file || !deal) return
    setUploading(true)
    const { error } = await supabase.storage.from(BUCKET).upload(`deal-${deal.id}/${file.name}`, file, { upsert: false })
    setUploading(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast('Document uploaded')
    loadExtras()
  }
  const downloadFile = async (name) => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(`deal-${deal.id}/${name}`, 60)
    if (error || !data?.signedUrl) { pushToast('Could not open file', 'error'); return }
    window.open(data.signedUrl, '_blank', 'noopener')
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (missing) {
    return (
      <div className="page-content">
        <EmptyState icon="pipeline" title="Deal not found"
          message="It may have been deleted, or it belongs to another agent."
          action={<button className="btn btn--primary" onClick={() => go('pipeline')}>Back to Pipeline</button>} />
      </div>
    )
  }
  if (!deal) return <div className="page-content" />

  const railStages   = track.stages.filter(s => s !== 'lost')
  const currentCol   = boardStageFor(deal, track.id)
  const currentIdx   = railStages.indexOf(currentCol)
  const doneSteps    = steps.filter(s => s.completed).length
  const nextStep     = steps.find(s => !s.completed)
  const keyDates     = cd.key_dates || []
  const portalUrl    = deal.portal_enabled && deal.portal_token ? `${window.location.origin}/portal/${deal.portal_token}` : null

  return (
    <div className="page-content" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <button className="btn btn--ghost btn--sm" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => go('pipeline')}>
              ← Pipeline
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div className="page-title" style={{ margin: 0 }}>{deal.title}</div>
              <Badge variant={deal.prop_category === 'commercial' ? 'commercial' : 'residential'}>
                {deal.prop_category === 'commercial'
                  ? `Commercial${deal.prop_subtype ? ` · ${deal.prop_subtype}` : ''}`
                  : `Residential · ${cd.transaction_type === 'seller' ? 'Seller' : 'Buyer'} side`}
              </Badge>
              {!isOpenStage(deal.stage) && (
                <Badge variant={deal.stage === 'closed' ? 'closed' : 'lost'}>{STAGE_LABELS[deal.stage]}</Badge>
              )}
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 13, color: 'var(--gw-mist)', flexWrap: 'wrap' }}>
              {deal.value > 0 && <span><strong style={{ color: 'var(--gw-ink)' }}>{formatCurrency(deal.value)}</strong> deal value</span>}
              {deal.probability > 0 && isOpenStage(deal.stage) && <span>{deal.probability}% probability</span>}
              {deal.expected_close_date && <span>Closing {formatDate(deal.expected_close_date)}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {isOpenStage(deal.stage) && (
              <button className="btn btn--ghost btn--sm" style={{ color: 'var(--gw-red)' }} onClick={() => setStage('lost')}>Mark Lost</button>
            )}
            {!isOpenStage(deal.stage) && (
              <button className="btn btn--secondary btn--sm" onClick={() => setStage(railStages[0])}>Reopen</button>
            )}
            <button className="btn btn--primary btn--sm" onClick={() => openDrawer('details')}><Icon name="edit" size={13} /> Edit Deal</button>
          </div>
        </div>

        {/* ── Stage rail ── */}
        <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2 }}>
          {railStages.map((s, i) => {
            const isCurrent = i === currentIdx
            const isPast    = i < currentIdx
            return (
              <button key={s} onClick={() => setStage(s)} title={`Move to ${STAGE_LABELS[s]}`}
                style={{
                  flex: 1, minWidth: 86, padding: '8px 6px', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-body)', fontSize: 11.5, fontWeight: isCurrent ? 700 : 600,
                  borderRadius: i === 0 ? '8px 2px 2px 8px' : i === railStages.length - 1 ? '2px 8px 8px 2px' : 2,
                  background: isCurrent ? 'var(--gw-slate)' : isPast ? '#e7efe9' : 'var(--gw-bone)',
                  color: isCurrent ? '#fff' : isPast ? 'var(--gw-green)' : 'var(--gw-mist)',
                  transition: 'all 150ms ease', whiteSpace: 'nowrap',
                }}>
                {isPast ? '✓ ' : ''}{STAGE_LABELS[s]}
              </button>
            )
          })}
        </div>
      </div>

      {/* ── Cards grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: 14, alignItems: 'start' }}>

        {/* Property */}
        <SectionCard title="Property" action={drawerLink('Edit', () => openDrawer('details'))}>
          {property ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{property.address}</div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>
                {[property.city, property.state, property.zip].filter(Boolean).join(', ')}
              </div>
              <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--gw-mist)', marginTop: 6, flexWrap: 'wrap' }}>
                {property.type && <span style={{ textTransform: 'capitalize' }}>{property.type}</span>}
                {property.list_price > 0 && <span>Listed {formatCurrency(property.list_price)}</span>}
                {property.sqft > 0 && <span>{Number(property.sqft).toLocaleString()} sq ft</span>}
                {property.beds > 0 && <span>{property.beds} bd / {property.baths || '—'} ba</span>}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--gw-mist)' }}>
              No property linked yet.{' '}
              <button className="btn btn--ghost btn--sm" style={{ padding: '0 4px', fontSize: 12 }} onClick={() => openDrawer('details')}>Link one</button>
            </div>
          )}
        </SectionCard>

        {/* People */}
        <SectionCard title="People">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {contact ? (
              <div>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{contact.first_name} {contact.last_name}</div>
                <div style={{ fontSize: 12, color: 'var(--gw-mist)', display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 2 }}>
                  {contact.phone && <a href={`tel:${contact.phone}`} style={{ color: 'inherit' }}>{formatPhone(contact.phone)}</a>}
                  {contact.email && <a href={`mailto:${contact.email}`} style={{ color: 'inherit' }}>{contact.email}</a>}
                </div>
                {contact.spouse_name && <div style={{ fontSize: 11.5, color: 'var(--gw-mist)', marginTop: 2 }}>Spouse: {contact.spouse_name}</div>}
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--gw-mist)' }}>No contact linked.</div>
            )}
            <div style={{ borderTop: '1px solid var(--gw-border)', paddingTop: 8 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Agents on deal</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {(team.length ? team : agent ? [agent] : []).map(a => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <Avatar agent={a} size={20} />
                    <span style={{ fontSize: 12.5 }}>{a.name}</span>
                    {a.id === deal.agent_id && <span style={{ fontSize: 10, color: 'var(--gw-mist)' }}>primary</span>}
                  </div>
                ))}
                {!team.length && !agent && <div style={{ fontSize: 12.5, color: 'var(--gw-mist)' }}>Unassigned</div>}
              </div>
            </div>
            {breakdown && (deal.value > 0) && (
              <div style={{ borderTop: '1px solid var(--gw-border)', paddingTop: 8, display: 'flex', gap: 16, fontSize: 12 }}>
                <span>Gross comm: <strong>{formatCurrency(breakdown.gross_total)}</strong></span>
                {myTake > 0 && <span style={{ color: 'var(--gw-green)' }}>Your take: <strong>{formatCurrency(myTake)}</strong></span>}
              </div>
            )}
          </div>
        </SectionCard>

        {/* Key dates */}
        <SectionCard title="Key Dates" action={drawerLink('Manage', () => openDrawer('dates'))}>
          {keyDates.filter(d => d.type).length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--gw-mist)' }}>
              No key dates yet — add closing, inspection, or DD deadlines and the CRM reminds everyone automatically.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {keyDates.map((d, i) => {
                const u = dateUrgency(d.date)
                return (
                  <div key={`${d.type}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {u && d.date ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: u.color, flexShrink: 0 }} /> : <span style={{ width: 7 }} />}
                    <span style={{ fontSize: 12.5, flex: 1 }}>{d.type}</span>
                    {u && d.date && u.label !== 'passed' && <span style={{ fontSize: 10.5, fontWeight: 700, color: u.color }}>{u.label}</span>}
                    <input type="date" className="form-control" value={d.date || ''} onChange={e => persistKeyDate(i, e.target.value)}
                      style={{ width: 140, fontSize: 12, padding: '3px 7px' }} />
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>

        {/* Next actions */}
        <SectionCard title="Next Actions" action={drawerLink('Checklist', () => openDrawer('checklist'))}>
          {steps.length > 0 && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--gw-mist)', marginBottom: 4 }}>
                <span>Closing checklist</span><span>{doneSteps}/{steps.length}</span>
              </div>
              <div style={{ height: 5, background: 'var(--gw-border)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${steps.length ? Math.round(doneSteps / steps.length * 100) : 0}%`, height: '100%', background: 'var(--gw-green)', transition: 'width 300ms' }} />
              </div>
              {nextStep && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 7, fontSize: 12.5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={false} onChange={() => toggleStep(nextStep)} />
                  <span>Next: {nextStep.title}</span>
                </label>
              )}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {dealTasks.length === 0 && steps.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--gw-mist)' }}>Nothing pending — add a task below or generate the closing checklist.</div>
            )}
            {dealTasks.slice(0, 6).map(t => (
              <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={false} onChange={() => completeTask(t)} />
                <span style={{ flex: 1 }}>{t.title}</span>
                {t.due_date && <span style={{ fontSize: 10.5, color: new Date(t.due_date) < new Date() ? 'var(--gw-red)' : 'var(--gw-mist)' }}>{formatDate(t.due_date)}</span>}
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="form-control" style={{ fontSize: 12.5 }} placeholder="Add a task…" value={newTask}
              onChange={e => setNewTask(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addTask() }} />
            <button className="btn btn--secondary btn--sm" onClick={addTask} disabled={!newTask.trim()}><Icon name="plus" size={12} /></button>
          </div>
        </SectionCard>

        {/* Documents & signatures */}
        <SectionCard title="Documents & Signatures" action={drawerLink('Send for signature', () => openDrawer('signatures'))}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {files.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--gw-mist)' }}>No documents yet.</div>}
            {files.slice(0, 8).map(f => (
              <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="document" size={13} />
                <button onClick={() => downloadFile(f.name)} title="Open"
                  style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 12.5, color: 'var(--gw-ink)', fontFamily: 'var(--font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: 0 }}>
                  {f.name}
                </button>
              </div>
            ))}
            {files.length > 8 && drawerLink(`All ${files.length} documents`, () => openDrawer('documents'))}
          </div>
          {envelopes.length > 0 && (
            <div style={{ borderTop: '1px solid var(--gw-border)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {envelopes.slice(0, 4).map(env => (
                <div key={env.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <Badge variant={env.status === 'completed' ? 'closed' : env.status === 'voided' ? 'lost' : 'pending'}>{env.status}</Badge>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{env.document_name || env.subject || 'Envelope'}</span>
                  <span style={{ fontSize: 10.5, color: 'var(--gw-mist)' }}>{timeAgo(env.created_at)}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label className="btn btn--secondary btn--sm" style={{ cursor: 'pointer' }}>
              <Icon name="plus" size={12} /> {uploading ? 'Uploading…' : 'Upload'}
              <input type="file" style={{ display: 'none' }} onChange={e => { uploadFile(e.target.files?.[0]); e.target.value = '' }} disabled={uploading} />
            </label>
            {portalUrl
              ? <button className="btn btn--ghost btn--sm" onClick={() => { navigator.clipboard.writeText(portalUrl); pushToast('Portal link copied') }}>
                  <Icon name="copy" size={12} /> Client portal link
                </button>
              : drawerLink('Set up client portal', () => openDrawer('portal'))}
          </div>
        </SectionCard>

        {/* Timeline */}
        <SectionCard title="Timeline" style={{ gridColumn: '1 / -1' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <select className="form-control" style={{ width: 110, fontSize: 12.5 }} value={logType} onChange={e => setLogType(e.target.value)}>
              {['note', 'call', 'email', 'meeting', 'showing'].map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
            <input className="form-control" style={{ flex: 1, fontSize: 12.5 }} placeholder={`Log a ${logType} on this deal…`}
              value={logBody} onChange={e => setLogBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') logActivity() }} />
            <button className="btn btn--primary btn--sm" onClick={logActivity} disabled={logging || !logBody.trim()}>Log</button>
          </div>
          {dealActivities.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--gw-mist)' }}>
              No activity yet. Calls, notes, and emails logged here also appear on {contact ? `${contact.first_name}'s` : "the contact's"} history.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {dealActivities.slice(0, 25).map(a => {
                const author = agents.find(x => x.id === a.agent_id)
                return (
                  <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--gw-bone)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <Icon name={ACTIVITY_ICONS[a.type] || 'edit'} size={12} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, lineHeight: 1.45 }}>{a.body}</div>
                      <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2 }}>
                        {a.type}{author ? ` · ${author.name}` : ''} · {timeAgo(a.created_at)}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </SectionCard>
      </div>

      <DealDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} deal={deal} initialTab={drawerTab}
        agents={agents} contacts={contacts} properties={properties} activeAgent={activeAgent} onSave={refreshDeal} />
    </div>
  )
}
