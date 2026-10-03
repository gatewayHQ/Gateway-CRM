/**
 * Drip Sequences — each agent's own automated follow-up.
 *
 *   • PRIVATE. A sequence belongs to the agent who made it (sequences.agent_id,
 *     migration 0060). Row-level security shows it, its steps and its
 *     enrollments to that agent only.
 *   • SENT FROM YOUR OUTLOOK. Email steps go out through the owner's connected
 *     Microsoft 365 mailbox (api/_lib/dripRunner.js) — no shared sender.
 *   • EMAIL OR CALL. A call step puts a call task on the agent's list that day.
 *   • AUTO-START. Mark one sequence per lane and every website lead the round
 *     robin assigns you starts it, with the Day-0 email sent immediately.
 *   • PERSONAL. {{tokens}} fill in the lead's search (beds, baths, budget,
 *     area), the home they viewed, and listings that match — see
 *     src/lib/dripTokens.js, which renders the preview AND the real send.
 */
import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  fetchSequencesWithSteps, insertSequence, clearAutoEnrollLane, updateSequence, deleteSequenceById,
  claimSequence, insertSequenceSteps, deleteSequenceSteps, fetchSequenceEnrollments, insertEnrollments,
  updateEnrollment,
} from '../lib/services/sequences.js'
import { Icon, Modal, ConfirmDialog, pushToast } from '../components/UI.jsx'
import ContactMultiSelect from '../components/ContactMultiSelect.jsx'
import {
  DRIP_TOKENS, SAMPLE_TOKENS, dripTokens, renderDripEmail, renderDripText,
  matchListings, searchCriteria, wantsListings, STARTER_BUYER_SEQUENCE,
} from '../lib/dripTokens.js'
import { getAuthSession } from '../lib/services/auth.js'
import { fetchAgentOutlookConnection } from '../lib/services/outlook.js'

const LANE_LABELS = { residential: 'Residential website leads', commercial: 'Commercial website leads' }

const STATUS_STYLE = {
  active:    { bg: 'var(--gw-sky)',          fg: 'var(--gw-azure)' },
  paused:    { bg: '#fff3cd',                fg: '#856404' },
  completed: { bg: 'var(--gw-green-light)',  fg: 'var(--gw-green)' },
  replied:   { bg: '#e0e7ff',                fg: '#3730a3' },
  stopped:   { bg: '#f3f4f6',                fg: '#6b7280' },
}

async function authedPost(action, payload = {}) {
  const { data: { session } } = await getAuthSession()
  const res = await fetch(`/api/email-send?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`)
  return data
}

const DAY_MS = 86_400_000
function nextDueDate(enrollment, steps) {
  const idx = enrollment.current_step || 0
  const step = steps[idx]
  if (!step) return null
  const ref = idx === 0 || !enrollment.last_sent_at ? enrollment.started_at : enrollment.last_sent_at
  return new Date(new Date(ref).getTime() + (Number(step.delay_days) || 0) * DAY_MS)
}

// ─── One step ─────────────────────────────────────────────────────────────────
function StepEditor({ step, index, onChange, onDelete, onMove, isFirst, isLast, previewTokens, previewListings, agent }) {
  const bodyRef = useRef(null)
  const [preview, setPreview] = useState(false)
  const isCall = step.step_type === 'call'

  const insertToken = (key) => {
    const token = `{{${key}}}`
    const el = bodyRef.current
    if (!el) { onChange({ ...step, body: `${step.body || ''}${token}` }); return }
    const start = el.selectionStart ?? step.body.length
    const end   = el.selectionEnd ?? step.body.length
    const body  = `${step.body.slice(0, start)}${token}${step.body.slice(end)}`
    onChange({ ...step, body })
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length) })
  }

  const rendered = useMemo(() => {
    if (!preview) return null
    if (isCall) {
      return {
        subject: renderDripText(step.subject, previewTokens) || 'Call',
        text: renderDripText(step.body, previewTokens),
      }
    }
    return renderDripEmail({
      subject: step.subject, body: step.body, tokens: previewTokens,
      listings: wantsListings(step.body) ? previewListings : [], agent,
      baseUrl: window.location.origin, unsubscribeUrl: '#preview-unsubscribe',
    })
  }, [preview, step, previewTokens, previewListings, agent, isCall])

  return (
    <div className="seq-step">
      <div className="seq-step__head">
        <div style={{ width: 22, height: 22, borderRadius: '50%', background: isCall ? 'var(--gw-green)' : 'var(--gw-azure)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
          {index + 1}
        </div>
        <div style={{ display: 'flex', border: '1px solid var(--gw-border)', borderRadius: 4, overflow: 'hidden', flexShrink: 0 }}>
          {[['email', 'Email'], ['call', 'Call']].map(([v, label]) => (
            <button key={v} type="button" onClick={() => onChange({ ...step, step_type: v })}
              style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer',
                background: (step.step_type || 'email') === v ? 'var(--gw-slate)' : '#fff',
                color: (step.step_type || 'email') === v ? '#fff' : 'var(--gw-mist)' }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span className="seq-step__delay">{index === 0 ? 'Day' : 'Wait'}</span>
          <input
            type="number" min="0" value={step.delay_days}
            onChange={e => onChange({ ...step, delay_days: Math.max(0, Number(e.target.value) || 0) })}
            style={{ width: 52, padding: '3px 6px', border: '1px solid var(--gw-border)', borderRadius: 4, fontSize: 12, fontFamily: 'var(--font-body)' }}
          />
          <span style={{ fontSize: 11, color: 'var(--gw-mist)' }}>
            {index === 0
              ? (Number(step.delay_days) === 0 ? 'sends immediately on enrollment' : 'days after enrollment')
              : 'days after the previous step'}
          </span>
        </div>
        <button className="btn btn--ghost btn--icon btn--sm" onClick={() => onMove(-1)} disabled={isFirst} title="Move up"><span style={{ fontSize: 12, lineHeight: 1 }}>↑</span></button>
        <button className="btn btn--ghost btn--icon btn--sm" onClick={() => onMove(1)} disabled={isLast} title="Move down"><span style={{ fontSize: 12, lineHeight: 1 }}>↓</span></button>
        <button className="btn btn--ghost btn--icon btn--sm" onClick={onDelete} title="Delete step"><Icon name="trash" size={12} /></button>
      </div>
      <div className="seq-step__body">
        <div className="form-group" style={{ marginBottom: 8 }}>
          <input className="form-control"
            placeholder={isCall ? 'Task title… e.g. Intro call — {{firstName}}' : 'Email subject…'}
            value={step.subject}
            onChange={e => onChange({ ...step, subject: e.target.value })} />
        </div>
        <div className="form-group" style={{ marginBottom: 6 }}>
          <textarea ref={bodyRef} className="form-control form-control--textarea"
            placeholder={isCall ? 'Call notes / talking points…' : 'Write it like a personal note. Click a token below to drop it in.'}
            value={step.body}
            onChange={e => onChange({ ...step, body: e.target.value })} style={{ minHeight: isCall ? 70 : 140 }} />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
          {DRIP_TOKENS.filter(t => !(isCall && t.key === 'matchingListings')).map(t => (
            <button key={t.key} type="button" onClick={() => insertToken(t.key)} title={`{{${t.key}}}`}
              style={{ fontSize: 10.5, padding: '2px 7px', borderRadius: 10, border: '1px solid var(--gw-border)', background: 'var(--gw-bone, #faf9f6)', cursor: 'pointer', color: 'var(--gw-ink)' }}>
              + {t.label}
            </button>
          ))}
          <button type="button" className="btn btn--ghost btn--sm" style={{ marginLeft: 'auto' }} onClick={() => setPreview(p => !p)}>
            <Icon name="eye" size={12} /> {preview ? 'Hide preview' : 'Preview'}
          </button>
        </div>
        {preview && rendered && (
          <div style={{ marginTop: 10, border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', background: 'var(--gw-bone, #faf9f6)', fontSize: 12, borderBottom: '1px solid var(--gw-border)' }}>
              <strong>{isCall ? 'Task:' : 'Subject:'}</strong> {rendered.subject}
            </div>
            {isCall
              ? <div style={{ padding: 12, fontSize: 13, whiteSpace: 'pre-wrap' }}>{rendered.text || <em style={{ color: 'var(--gw-mist)' }}>No notes</em>}</div>
              : <iframe title="Email preview" srcDoc={rendered.html} sandbox="" style={{ width: '100%', height: 360, border: 'none', background: '#fff' }} />}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Enroll ───────────────────────────────────────────────────────────────────
function EnrollModal({ sequence, steps, contacts, enrolledIds, onClose, onEnrolled }) {
  const [ids, setIds]       = useState([])
  const [saving, setSaving] = useState(false)
  const available = contacts.filter(c => !enrolledIds.has(c.id))
  const noEmail   = ids.map(id => contacts.find(c => c.id === id)).filter(c => c && !c.email)
  const first     = steps[0]
  const sendsNow  = first && Number(first.delay_days) === 0

  const enroll = async () => {
    if (!ids.length) return
    setSaving(true)
    const started = new Date().toISOString()
    const { data, error } = await insertEnrollments(ids.map(contact_id => ({
      contact_id, sequence_id: sequence.id, agent_id: sequence.agent_id,
      started_at: started, current_step: 0, status: 'active',
    })))
    if (error) {
      setSaving(false)
      pushToast(error.code === '23505' ? 'One of those contacts is already in this sequence.' : error.message, 'error')
      return
    }
    let note = `Enrolled ${ids.length} contact${ids.length === 1 ? '' : 's'}`
    if (sendsNow && data?.length) {
      try {
        const r = await authedPost('drip-run', { enrollmentIds: data.map(d => d.id) })
        if (r.sent) note += ` — ${r.sent} email${r.sent === 1 ? '' : 's'} sent from your Outlook`
        if (r.calls) note += ` — ${r.calls} call task${r.calls === 1 ? '' : 's'} created`
        if (r.errors) note += ` — ${r.errors} could not send yet (see the enrollment for why)`
      } catch (err) {
        note += ` — first step will go out on the next daily run (${err.message})`
      }
    }
    setSaving(false)
    pushToast(note)
    onEnrolled()
    onClose()
  }

  return (
    <Modal open={true} onClose={onClose} width={520}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">Drip Sequence</div>
          <h3 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--font-display)' }}>Enroll Contacts</h3>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <div className="modal__body">
        <p style={{ fontSize: 13, color: 'var(--gw-mist)', margin: '0 0 12px', lineHeight: 1.5 }}>
          Enrolling in <strong>{sequence.name}</strong> ({steps.length} step{steps.length === 1 ? '' : 's'}).
          {' '}Emails send from your connected Outlook; call steps land on your task list.
          {sendsNow && <> The first step goes out <strong>as soon as you enroll</strong>.</>}
          {' '}A contact who replies is taken out of the drip automatically.
        </p>
        <ContactMultiSelect contacts={available} selectedIds={ids} onChange={setIds} placeholder="Search your contacts…" />
        {noEmail.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 12, color: '#856404', background: '#fff3cd', padding: '8px 10px', borderRadius: 4 }}>
            {noEmail.map(c => c.first_name).join(', ')} {noEmail.length === 1 ? 'has' : 'have'} no email address — email steps will be skipped and the drip will stop at the first one.
          </div>
        )}
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={enroll} disabled={!ids.length || saving}>
          {saving ? 'Enrolling…' : `Enroll ${ids.length || ''}`.trim()}
        </button>
      </div>
    </Modal>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────
export default function SequencesPage({ db, activeAgent, isAdmin, go }) {
  const [sequences, setSequences]     = useState([])
  const [orphans, setOrphans]         = useState([])
  const [selected, setSelected]       = useState(null)
  const [steps, setSteps]             = useState([])
  const [enrollments, setEnrollments] = useState([])
  const [ready, setReady]             = useState(null)
  const [saving, setSaving]           = useState(false)
  const [dirty, setDirty]             = useState(false)
  const [seqName, setSeqName]         = useState('')
  const [seqDesc, setSeqDesc]         = useState('')
  const [lane, setLane]               = useState('')
  const [creating, setCreating]       = useState(false)
  const [newName, setNewName]         = useState('')
  const [enrollModal, setEnrollModal] = useState(false)
  const [confirm, setConfirm]         = useState(null)
  const [outlook, setOutlook]         = useState(undefined)   // undefined = loading, null = not connected
  const [previewContactId, setPreviewContactId] = useState('')

  const me       = activeAgent?.id || null
  const contacts = db.contacts || []
  const properties = db.properties || []

  useEffect(() => { if (me) { loadSequences(); loadOutlook() } }, [me])

  const loadOutlook = async () => {
    const { data } = await fetchAgentOutlookConnection(me)
    setOutlook(data || null)
  }

  const loadSequences = async (keepId = selected?.id) => {
    const { data, error } = await fetchSequencesWithSteps()
    if (error) { setReady(false); return }
    // A missing agent_id column means migration 0060 has not been applied —
    // every sequence would look shared. Refuse to pretend otherwise.
    if ((data || []).length && !('agent_id' in data[0])) { setReady(false); return }
    setReady(true)
    const mine = (data || []).filter(s => s.agent_id === me)
    setSequences(mine)
    setOrphans(isAdmin ? (data || []).filter(s => !s.agent_id) : [])
    const pick = mine.find(s => s.id === keepId) || mine[0]
    if (pick) selectSeq(pick)
    else { setSelected(null); setSteps([]); setEnrollments([]) }
  }

  const selectSeq = async (seq) => {
    setSelected(seq)
    setSeqName(seq.name)
    setSeqDesc(seq.description || '')
    setLane(seq.auto_enroll_lane || '')
    setSteps([...(seq.sequence_steps || [])].sort((a, b) => a.sort_order - b.sort_order)
      .map(s => ({ ...s, step_type: s.step_type || 'email' })))
    setDirty(false)
    const { data } = await fetchSequenceEnrollments(seq.id)
    setEnrollments(data || [])
  }

  const createSequence = async (template = null) => {
    const name = (template?.name || newName).trim()
    if (!name || !me) return
    const { data, error } = await insertSequence({ name, description: template?.description || '', agent_id: me })
    if (error) { pushToast(error.message, 'error'); return }
    if (template) {
      const { error: stepErr } = await insertSequenceSteps(
        template.steps.map((s, i) => ({ ...s, sequence_id: data.id, sort_order: i })))
      if (stepErr) pushToast(`Sequence created, but its steps did not save: ${stepErr.message}`, 'error')
    }
    setCreating(false); setNewName('')
    pushToast(template ? 'Starter sequence created — edit it to sound like you' : 'Sequence created')
    loadSequences(data.id)
  }

  const saveSequence = async () => {
    if (!selected) return
    setSaving(true)
    try {
      // One auto-start sequence per lane per agent: free the lane first.
      if (lane && lane !== selected.auto_enroll_lane) {
        const { error } = await clearAutoEnrollLane(me, lane, selected.id)
        if (error) throw error
      }
      const { error: upErr } = await updateSequence(selected.id, {
        name: seqName.trim() || selected.name, description: seqDesc,
        auto_enroll_lane: lane || null, updated_at: new Date().toISOString(),
      })
      if (upErr) throw upErr

      const { error: delErr } = await deleteSequenceSteps(selected.id)
      if (delErr) throw delErr
      if (steps.length > 0) {
        const { error: insErr } = await insertSequenceSteps(
          steps.map((s, i) => ({
            sequence_id: selected.id, subject: s.subject, body: s.body,
            delay_days: Number(s.delay_days) || 0, sort_order: i, step_type: s.step_type || 'email',
          })))
        if (insErr) throw insErr
      }
      pushToast('Sequence saved')
      setDirty(false)
      loadSequences(selected.id)
    } catch (err) {
      pushToast(`Save failed: ${err.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const deleteSequence = async () => {
    const { error } = await deleteSequenceById(selected.id)
    setConfirm(null)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast('Sequence deleted', 'info')
    loadSequences(null)
  }

  const claim = async (seq) => {
    const { error } = await claimSequence(seq.id, me)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(`"${seq.name}" is now yours`)
    loadSequences(seq.id)
  }

  const edit = (fn) => { setSteps(fn); setDirty(true) }
  const addStep = (type = 'email') => edit(p => [...p, {
    id: `new-${Date.now()}`, subject: '', body: '', step_type: type,
    delay_days: p.length === 0 ? 0 : 2, sort_order: p.length,
  }])
  const updateStep = (i, val) => edit(p => p.map((s, idx) => idx === i ? val : s))
  const removeStep = (i) => edit(p => p.filter((_, idx) => idx !== i))
  const moveStep = (i, dir) => edit(p => {
    const j = i + dir
    if (j < 0 || j >= p.length) return p
    const next = [...p]; [next[i], next[j]] = [next[j], next[i]]
    return next
  })

  const changeEnrollStatus = async (enrollId, status) => {
    const patch = status === 'stopped'
      ? { status, stopped_reason: 'Stopped by agent' }
      : { status, ...(status === 'active' ? { last_error: null } : {}) }
    const { error } = await updateEnrollment(enrollId, patch)
    if (error) { pushToast(error.message, 'error'); return }
    setEnrollments(p => p.map(e => e.id === enrollId ? { ...e, ...patch } : e))
  }

  // Preview with a real contact when one is picked, sample values otherwise.
  const previewContact = contacts.find(c => c.id === previewContactId)
  const previewTokens = useMemo(() => previewContact
    ? dripTokens({ contact: previewContact, agent: activeAgent || {} })
    : { ...SAMPLE_TOKENS, agentName: activeAgent?.name || SAMPLE_TOKENS.agentName,
        agentFirstName: (activeAgent?.name || '').split(' ')[0] || SAMPLE_TOKENS.agentFirstName,
        agentPhone: activeAgent?.phone || SAMPLE_TOKENS.agentPhone,
        agentEmail: activeAgent?.email || SAMPLE_TOKENS.agentEmail },
  [previewContact, activeAgent])
  const previewListings = useMemo(() => {
    const crit = previewContact ? searchCriteria(previewContact) : { bedsMin: 3, bathsMin: 2, priceMax: 250000 }
    return matchListings(properties, crit)
  }, [previewContact, properties])

  const enrolledIds = useMemo(() => new Set(
    enrollments.filter(e => e.status === 'active' || e.status === 'paused').map(e => e.contact_id)), [enrollments])
  const counts = useMemo(() => enrollments.reduce((m, e) => ({ ...m, [e.status]: (m[e.status] || 0) + 1 }), {}), [enrollments])

  if (!me) return (
    <div className="page-content"><div className="card" style={{ padding: 24 }}>Sign in with your agent profile to manage drip sequences.</div></div>
  )

  if (ready === false) return (
    <div className="page-content">
      <div className="page-header"><div><div className="page-title">Drip Sequences</div></div></div>
      <div className="card" style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Icon name="alert" size={18} style={{ color: 'var(--gw-amber)' }} />
          <strong>Database update required</strong>
        </div>
        <p style={{ fontSize: 13, color: 'var(--gw-mist)', marginTop: 0, lineHeight: 1.6 }}>
          Drip sequences are private to each agent and send from their own Outlook. That needs
          migration <code>0060_drip_sequences_per_agent.sql</code> applied in the Supabase SQL Editor
          (see <code>migrations/README.md</code>). Ask your office admin to run it.
        </p>
        <button className="btn btn--primary" style={{ marginTop: 4 }} onClick={() => loadSequences()}>
          <Icon name="refresh" size={13} /> Check again
        </button>
      </div>
    </div>
  )

  const outlookOk = outlook?.status === 'connected'

  return (
    <div className="page-content" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header">
        <div>
          <div className="page-title">Drip Sequences</div>
          <div className="page-sub">
            {sequences.length} sequence{sequences.length === 1 ? '' : 's'} · private to you · emails send from your Outlook
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--secondary" onClick={() => createSequence(STARTER_BUYER_SEQUENCE)}>
            <Icon name="sequences" size={14} /> Starter: Buyer Lead
          </button>
          <button className="btn btn--primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New Sequence</button>
        </div>
      </div>

      {outlook !== undefined && !outlookOk && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fff3cd', border: '1px solid #f5d77a', borderRadius: 'var(--radius)', padding: '10px 14px', marginBottom: 14, fontSize: 13 }}>
          <Icon name="alert" size={16} style={{ color: '#856404' }} />
          <div style={{ flex: 1 }}>
            <strong>Connect Outlook to send your drips.</strong> Email steps wait (nothing is lost) until your
            Microsoft 365 mailbox is connected{outlook?.status === 'error' ? ' — your connection needs to be renewed' : ''}.
            Call steps still create tasks.
          </div>
          {go && <button className="btn btn--secondary btn--sm" onClick={() => go('integrations')}>Open Integrations</button>}
        </div>
      )}

      {creating && (
        <div style={{ background: 'var(--gw-sky)', border: '1px solid var(--gw-azure)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 16, display: 'flex', gap: 8 }}>
          <input className="form-control" placeholder="Sequence name (e.g. New Buyer Drip)" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createSequence()} autoFocus style={{ flex: 1 }} />
          <button className="btn btn--primary btn--sm" onClick={() => createSequence()}>Create</button>
          <button className="btn btn--secondary btn--sm" onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}

      {orphans.length > 0 && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 14, fontSize: 13 }}>
          <strong>Unowned sequences</strong>
          <span style={{ color: 'var(--gw-mist)' }}> — created before sequences were private. Only admins can see these; claim one to make it yours, or delete it.</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {orphans.map(o => (
              <span key={o.id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', border: '1px solid var(--gw-border)', borderRadius: 4, padding: '3px 8px' }}>
                {o.name}
                <button className="btn btn--ghost btn--sm" onClick={() => claim(o)}>Claim</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {sequences.length === 0 && !creating ? (
        <div className="card" style={{ textAlign: 'center', padding: 60 }}>
          <Icon name="sequences" size={36} style={{ color: 'var(--gw-border)', marginBottom: 12 }} />
          <div style={{ fontWeight: 600, marginBottom: 6 }}>No sequences yet</div>
          <div style={{ fontSize: 13, color: 'var(--gw-mist)', marginBottom: 20, maxWidth: 460, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 }}>
            A drip is a series of emails and call reminders that runs on its own. Set one to auto-start and every
            website lead the round robin sends you gets a personal email from your Outlook within seconds —
            built from what they searched for.
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button className="btn btn--primary" onClick={() => createSequence(STARTER_BUYER_SEQUENCE)}><Icon name="sequences" size={14} /> Use the Buyer Lead starter</button>
            <button className="btn btn--secondary" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> Start blank</button>
          </div>
        </div>
      ) : (
        <div className="seq-layout" style={{ flex: 1 }}>
          <div className="seq-list">
            {sequences.map(seq => (
              <div key={seq.id} className={`seq-list__item${selected?.id === seq.id ? ' active' : ''}`} onClick={() => selectSeq(seq)}>
                <div className="seq-list__name">{seq.name}</div>
                <div className="seq-list__meta">
                  {(seq.sequence_steps || []).length} steps
                  {seq.auto_enroll_lane && <> · <span style={{ color: 'var(--gw-green)', fontWeight: 600 }}>auto-starts ({seq.auto_enroll_lane})</span></>}
                </div>
              </div>
            ))}
          </div>

          {selected && (
            <div className="seq-editor">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <input className="form-control" value={seqName} onChange={e => { setSeqName(e.target.value); setDirty(true) }} style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }} />
                  <input className="form-control" value={seqDesc} onChange={e => { setSeqDesc(e.target.value); setDirty(true) }} placeholder="Description (optional)" style={{ fontSize: 13 }} />
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className="btn btn--secondary btn--sm" onClick={() => setEnrollModal(true)} disabled={dirty || steps.length === 0}
                    title={dirty ? 'Save your changes first' : ''}><Icon name="contacts" size={12} /> Enroll</button>
                  <button className="btn btn--primary btn--sm" onClick={saveSequence} disabled={saving}>{saving ? 'Saving…' : dirty ? 'Save*' : 'Save'}</button>
                  <button className="btn btn--ghost btn--icon btn--sm" onClick={() => setConfirm(true)} title="Delete sequence"><Icon name="trash" size={13} /></button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', background: 'var(--gw-bone, #faf9f6)', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', padding: '10px 12px', marginBottom: 18 }}>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Auto-start for</label>
                <select className="form-control" style={{ width: 'auto' }} value={lane} onChange={e => { setLane(e.target.value); setDirty(true) }}>
                  <option value="">Nobody — I enroll contacts by hand</option>
                  <option value="residential">{LANE_LABELS.residential} assigned to me</option>
                  <option value="commercial">{LANE_LABELS.commercial} assigned to me</option>
                </select>
                <span style={{ fontSize: 11.5, color: 'var(--gw-mist)', flex: '1 1 220px' }}>
                  When the round robin gives you a website lead, it starts this sequence right away. One per lane.
                </span>
              </div>

              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Steps ({steps.length})</div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <select className="form-control" style={{ width: 'auto', fontSize: 12, padding: '3px 6px' }} value={previewContactId} onChange={e => setPreviewContactId(e.target.value)} title="Preview as">
                      <option value="">Preview with sample lead</option>
                      {contacts.filter(c => c.assigned_agent_id === me).slice(0, 300).map(c => (
                        <option key={c.id} value={c.id}>Preview as {c.first_name} {c.last_name}</option>
                      ))}
                    </select>
                    <button className="btn btn--secondary btn--sm" onClick={() => addStep('email')}><Icon name="plus" size={12} /> Email</button>
                    <button className="btn btn--secondary btn--sm" onClick={() => addStep('call')}><Icon name="plus" size={12} /> Call</button>
                  </div>
                </div>
                {steps.length === 0 ? (
                  <div style={{ border: '2px dashed var(--gw-border)', borderRadius: 'var(--radius)', padding: '32px 24px', textAlign: 'center', color: 'var(--gw-mist)' }}>
                    No steps yet. Add an email or a call.
                  </div>
                ) : (
                  steps.map((step, i) => (
                    <StepEditor key={step.id || i} step={step} index={i}
                      isFirst={i === 0} isLast={i === steps.length - 1}
                      onChange={val => updateStep(i, val)}
                      onDelete={() => removeStep(i)}
                      onMove={dir => moveStep(i, dir)}
                      previewTokens={previewTokens} previewListings={previewListings}
                      agent={activeAgent || {}} />
                  ))
                )}
              </div>

              {enrollments.length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Enrolled ({enrollments.length})</div>
                  <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 10 }}>
                    {Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')}
                  </div>
                  {enrollments.map(e => {
                    const c = e.contacts
                    const next = e.status === 'active' ? nextDueDate(e, steps) : null
                    const st = STATUS_STYLE[e.status] || STATUS_STYLE.stopped
                    return (
                      <div key={e.id} className="seq-enrollment" style={{ flexWrap: 'wrap' }}>
                        <div style={{ width: 30, height: 30, borderRadius: 'var(--radius)', background: 'var(--gw-sky)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--gw-azure)', flexShrink: 0 }}>
                          {(c?.first_name || '')[0]}{(c?.last_name || '')[0]}
                        </div>
                        <div style={{ flex: 1, minWidth: 160 }}>
                          <div className="seq-enrollment__name">{c ? `${c.first_name} ${c.last_name}` : 'Contact'}</div>
                          <div className="seq-enrollment__meta">
                            Step {Math.min((e.current_step || 0) + 1, steps.length)}/{steps.length}
                            {next && <> · Next: {next <= new Date() ? 'due now' : next.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</>}
                            {e.stopped_reason && <> · {e.stopped_reason}</>}
                          </div>
                          {e.last_error && e.status === 'active' && (
                            <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}><Icon name="alert" size={10} /> {e.last_error}</div>
                          )}
                        </div>
                        <span className="seq-enrollment__status" style={{ background: st.bg, color: st.fg }}>{e.status}</span>
                        {(e.status === 'active' || e.status === 'paused') && (
                          <select className="form-control" style={{ width: 'auto', fontSize: 11, padding: '3px 6px' }}
                            value={e.status} onChange={ev => changeEnrollStatus(e.id, ev.target.value)}>
                            <option value="active">Active</option>
                            <option value="paused">Paused</option>
                            <option value="stopped">Stop</option>
                          </select>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {enrollModal && selected && (
        <EnrollModal sequence={selected} steps={steps} contacts={contacts} enrolledIds={enrolledIds}
          onClose={() => setEnrollModal(false)}
          onEnrolled={() => selectSeq(selected)} />
      )}
      {confirm && <ConfirmDialog message={`Delete "${selected?.name}"? This also removes everyone enrolled in it.`} onConfirm={deleteSequence} onCancel={() => setConfirm(null)} />}
    </div>
  )
}
