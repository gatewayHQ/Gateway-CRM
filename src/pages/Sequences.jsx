import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Badge, Modal, ConfirmDialog, pushToast } from '../components/UI.jsx'

const SETUP_SQL = `-- Run in Supabase SQL Editor

create table if not exists sequences (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text default '',
  created_at timestamptz default now()
);
alter table sequences enable row level security;
create policy "auth_all_sequences" on sequences for all to authenticated using (true) with check (true);

create table if not exists sequence_steps (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid references sequences(id) on delete cascade not null,
  subject text not null default '',
  body text not null default '',
  delay_days int default 0,
  sort_order int default 0
);
alter table sequence_steps enable row level security;
create policy "auth_all_seq_steps" on sequence_steps for all to authenticated using (true) with check (true);

create table if not exists contact_sequences (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references contacts(id) on delete cascade not null,
  sequence_id uuid references sequences(id) on delete cascade not null,
  agent_id uuid references agents(id) on delete set null,
  started_at timestamptz default now(),
  current_step int default 0,
  status text default 'active',
  created_at timestamptz default now()
);
alter table contact_sequences enable row level security;
create policy "auth_all_cs" on contact_sequences for all to authenticated using (true) with check (true);`

function StepEditor({ step, index, onChange, onDelete }) {
  return (
    <div className="seq-step">
      <div className="seq-step__head">
        <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--gw-azure)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
          {index + 1}
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="seq-step__delay">Day</span>
          <input
            type="number" min="0" value={step.delay_days}
            onChange={e => onChange({ ...step, delay_days: Number(e.target.value) })}
            style={{ width: 56, padding: '3px 6px', border: '1px solid var(--gw-border)', borderRadius: 4, fontSize: 12, fontFamily: 'var(--font-body)' }}
          />
          {index === 0 && <span style={{ fontSize: 11, color: 'var(--gw-mist)' }}>from enrollment</span>}
          {index > 0 && <span style={{ fontSize: 11, color: 'var(--gw-mist)' }}>after previous step</span>}
        </div>
        <button className="btn btn--ghost btn--icon btn--sm" onClick={onDelete}><Icon name="trash" size={12} /></button>
      </div>
      <div className="seq-step__body">
        <div className="form-group" style={{ marginBottom: 8 }}>
          <input className="form-control" placeholder="Email subject…" value={step.subject}
            onChange={e => onChange({ ...step, subject: e.target.value })} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <textarea className="form-control form-control--textarea" placeholder="Email body… (use {{firstName}}, {{agentName}})" value={step.body}
            onChange={e => onChange({ ...step, body: e.target.value })} style={{ minHeight: 100 }} />
        </div>
      </div>
    </div>
  )
}

function EnrollModal({ sequence, contacts, agents, activeAgent, onClose, onEnrolled }) {
  const [contactId, setContactId]   = useState('')
  const [search, setSearch]         = useState('')
  const [saving, setSaving]         = useState(false)

  const filtered = contacts.filter(c => {
    const name = `${c.first_name} ${c.last_name}`.toLowerCase()
    return !search || name.includes(search.toLowerCase()) || (c.email || '').toLowerCase().includes(search.toLowerCase())
  })

  const enroll = async () => {
    if (!contactId) return
    setSaving(true)
    const { error } = await supabase.from('contact_sequences').insert([{
      contact_id: contactId,
      sequence_id: sequence.id,
      agent_id: activeAgent?.id || null,
      started_at: new Date().toISOString(),
      current_step: 0,
      status: 'active',
    }])
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast('Contact enrolled in sequence')
    onEnrolled()
    onClose()
  }

  return (
    <Modal open={true} onClose={onClose} width={480}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">Drip Sequence</div>
          <h3 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--font-display)' }}>Enroll a Contact</h3>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <div className="modal__body">
        <p style={{ fontSize: 13, color: 'var(--gw-mist)', margin: '0 0 12px' }}>
          Enrolling in <strong>{sequence.name}</strong> ({(sequence.sequence_steps || []).length} steps).
          Emails are shown as scheduled — send them manually or connect an ESP.
        </p>
        <input className="form-control" placeholder="Search contacts…" value={search} onChange={e => { setSearch(e.target.value); setContactId('') }} style={{ marginBottom: 10 }} />
        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)' }}>
          {filtered.slice(0, 20).map(c => (
            <div key={c.id}
              onClick={() => setContactId(c.id)}
              style={{ padding: '10px 14px', cursor: 'pointer', background: contactId === c.id ? 'var(--gw-sky)' : '#fff', borderBottom: '1px solid var(--gw-border)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: 'var(--radius)', background: 'var(--gw-sky)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--gw-azure)', flexShrink: 0 }}>
                {(c.first_name || '')[0]}{(c.last_name || '')[0]}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{c.first_name} {c.last_name}</div>
                <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{c.email || c.phone || '—'}</div>
              </div>
              {contactId === c.id && <Icon name="check" size={14} style={{ color: 'var(--gw-azure)', marginLeft: 'auto' }} />}
            </div>
          ))}
          {filtered.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: 'var(--gw-mist)' }}>No contacts found</div>}
        </div>
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={enroll} disabled={!contactId || saving}>{saving ? 'Enrolling…' : 'Enroll Contact'}</button>
      </div>
    </Modal>
  )
}

export default function SequencesPage({ db, setDb, activeAgent }) {
  const [sequences, setSequences]         = useState([])
  const [selected, setSelected]           = useState(null)
  const [steps, setSteps]                 = useState([])
  const [enrollments, setEnrollments]     = useState([])
  const [ready, setReady]                 = useState(null)
  const [saving, setSaving]               = useState(false)
  const [seqName, setSeqName]             = useState('')
  const [seqDesc, setSeqDesc]             = useState('')
  const [creating, setCreating]           = useState(false)
  const [newName, setNewName]             = useState('')
  const [enrollModal, setEnrollModal]     = useState(false)
  const [confirm, setConfirm]             = useState(null)
  const [copiedSQL, setCopiedSQL]         = useState(false)

  const contacts = db.contacts || []
  const agents   = db.agents   || []

  useEffect(() => { loadSequences() }, [])

  const loadSequences = async () => {
    const { data, error } = await supabase.from('sequences').select('*, sequence_steps(*)').order('created_at', { ascending: false })
    if (error) { setReady(false); return }
    setReady(true)
    setSequences(data || [])
    if (data?.length > 0 && !selected) selectSeq(data[0], data[0].sequence_steps || [])
  }

  const selectSeq = async (seq, preloadedSteps) => {
    setSelected(seq)
    setSeqName(seq.name)
    setSeqDesc(seq.description || '')
    const s = (preloadedSteps || seq.sequence_steps || []).sort((a, b) => a.sort_order - b.sort_order)
    setSteps(s)
    const { data } = await supabase.from('contact_sequences')
      .select('*, contacts(first_name,last_name,email)')
      .eq('sequence_id', seq.id)
      .order('started_at', { ascending: false })
    setEnrollments(data || [])
  }

  const createSequence = async () => {
    if (!newName.trim()) return
    const { data, error } = await supabase.from('sequences').insert([{ name: newName.trim(), description: '' }]).select().single()
    if (error) { pushToast(error.message, 'error'); return }
    setCreating(false); setNewName('')
    const fresh = { ...data, sequence_steps: [] }
    setSequences(p => [fresh, ...p])
    selectSeq(fresh, [])
  }

  const saveSequence = async () => {
    if (!selected) return
    setSaving(true)
    const { error: updErr } = await supabase.from('sequences').update({ name: seqName.trim(), description: seqDesc }).eq('id', selected.id)
    if (updErr) { setSaving(false); pushToast(updErr.message, 'error'); return }
    await supabase.from('sequence_steps').delete().eq('sequence_id', selected.id)
    if (steps.length > 0) {
      const { error: stepsErr } = await supabase.from('sequence_steps').insert(
        steps.map((s, i) => ({ sequence_id: selected.id, subject: s.subject, body: s.body, delay_days: s.delay_days || 0, sort_order: i }))
      )
      if (stepsErr) { setSaving(false); pushToast(stepsErr.message, 'error'); return }
    }
    setSaving(false)
    pushToast('Sequence saved')
    loadSequences()
  }

  const deleteSequence = async () => {
    const { error } = await supabase.from('sequences').delete().eq('id', selected.id)
    if (error) { pushToast(error.message, 'error'); setConfirm(null); return }
    pushToast('Sequence deleted', 'info')
    setConfirm(null)
    setSelected(null)
    setSteps([])
    loadSequences()
  }

  const addStep = () => setSteps(p => [...p, { id: `new-${Date.now()}`, subject: '', body: '', delay_days: p.length === 0 ? 0 : 3, sort_order: p.length }])
  const updateStep = (i, val) => setSteps(p => p.map((s, idx) => idx === i ? val : s))
  const removeStep = (i) => setSteps(p => p.filter((_, idx) => idx !== i))

  const changeEnrollStatus = async (enrollId, status) => {
    const { error } = await supabase.from('contact_sequences').update({ status }).eq('id', enrollId)
    if (error) { pushToast(error.message, 'error'); return }
    setEnrollments(p => p.map(e => e.id === enrollId ? { ...e, status } : e))
    pushToast(`Status updated to ${status}`)
  }

  if (ready === false) return (
    <div className="page-content">
      <div className="page-header"><div><div className="page-title">Drip Sequences</div></div></div>
      <div className="card" style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Icon name="alert" size={18} style={{ color: 'var(--gw-amber)' }} />
          <strong>Database setup required</strong>
        </div>
        <p style={{ fontSize: 13, color: 'var(--gw-mist)', marginTop: 0, lineHeight: 1.6 }}>
          Run the SQL below in your <strong>Supabase SQL Editor</strong> to enable drip sequences.
        </p>
        <div style={{ position: 'relative' }}>
          <pre style={{ background: 'var(--gw-slate)', color: '#e2e8f0', padding: 16, borderRadius: 'var(--radius)', fontSize: 11, overflow: 'auto', maxHeight: 260, lineHeight: 1.6 }}>{SETUP_SQL}</pre>
          <button className="btn btn--secondary btn--sm" onClick={() => { navigator.clipboard.writeText(SETUP_SQL); setCopiedSQL(true); setTimeout(() => setCopiedSQL(false), 2000) }}
            style={{ position: 'absolute', top: 8, right: 8 }}>
            {copiedSQL ? '✓ Copied' : 'Copy SQL'}
          </button>
        </div>
        <button className="btn btn--primary" style={{ marginTop: 12 }} onClick={loadSequences}>
          <Icon name="refresh" size={13} /> Retry Connection
        </button>
      </div>
    </div>
  )

  return (
    <div className="page-content" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header">
        <div>
          <div className="page-title">Drip Sequences</div>
          <div className="page-sub">{sequences.length} sequences · Auto-scheduled email campaigns</div>
        </div>
        <button className="btn btn--primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New Sequence</button>
      </div>

      {creating && (
        <div style={{ background: 'var(--gw-sky)', border: '1px solid var(--gw-azure)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 16, display: 'flex', gap: 8 }}>
          <input className="form-control" placeholder="Sequence name (e.g. New Buyer Drip)" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createSequence()} autoFocus style={{ flex: 1 }} />
          <button className="btn btn--primary btn--sm" onClick={createSequence}>Create</button>
          <button className="btn btn--secondary btn--sm" onClick={() => setCreating(false)}>Cancel</button>
        </div>
      )}

      {sequences.length === 0 && !creating ? (
        <div className="card" style={{ textAlign: 'center', padding: 60 }}>
          <Icon name="sequences" size={36} style={{ color: 'var(--gw-border)', marginBottom: 12 }} />
          <div style={{ fontWeight: 600, marginBottom: 6 }}>No sequences yet</div>
          <div style={{ fontSize: 13, color: 'var(--gw-mist)', marginBottom: 20 }}>Create reusable email sequences to nurture leads automatically.</div>
          <button className="btn btn--primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> Create First Sequence</button>
        </div>
      ) : (
        <div className="seq-layout" style={{ flex: 1 }}>
          {/* Sequence list */}
          <div className="seq-list">
            {sequences.map(seq => (
              <div key={seq.id} className={`seq-list__item${selected?.id === seq.id ? ' active' : ''}`} onClick={() => selectSeq(seq, null)}>
                <div className="seq-list__name">{seq.name}</div>
                <div className="seq-list__meta">{(seq.sequence_steps || []).length} steps</div>
              </div>
            ))}
          </div>

          {/* Sequence editor */}
          {selected && (
            <div className="seq-editor">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <input className="form-control" value={seqName} onChange={e => setSeqName(e.target.value)} style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }} />
                  <input className="form-control" value={seqDesc} onChange={e => setSeqDesc(e.target.value)} placeholder="Description (optional)" style={{ fontSize: 13 }} />
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className="btn btn--secondary btn--sm" onClick={() => setEnrollModal(true)}><Icon name="contacts" size={12} /> Enroll Contact</button>
                  <button className="btn btn--primary btn--sm" onClick={saveSequence} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                  <button className="btn btn--ghost btn--icon btn--sm" onClick={() => setConfirm(true)} title="Delete sequence"><Icon name="trash" size={13} /></button>
                </div>
              </div>

              {/* Steps */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Email Steps ({steps.length})</div>
                  <button className="btn btn--secondary btn--sm" onClick={addStep}><Icon name="plus" size={12} /> Add Step</button>
                </div>
                {steps.length === 0 ? (
                  <div style={{ border: '2px dashed var(--gw-border)', borderRadius: 'var(--radius)', padding: '32px 24px', textAlign: 'center', color: 'var(--gw-mist)' }}>
                    No steps yet. Add your first email step.
                  </div>
                ) : (
                  steps.map((step, i) => (
                    <StepEditor key={step.id || i} step={step} index={i}
                      onChange={val => updateStep(i, val)}
                      onDelete={() => removeStep(i)} />
                  ))
                )}
              </div>

              {/* Enrollments */}
              {enrollments.length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12 }}>Enrolled Contacts ({enrollments.length})</div>
                  {enrollments.map(e => {
                    const c = e.contacts
                    const nextDate = new Date(e.started_at)
                    const currentStep = steps[e.current_step]
                    if (currentStep) nextDate.setDate(nextDate.getDate() + (currentStep.delay_days || 0))
                    return (
                      <div key={e.id} className="seq-enrollment">
                        <div style={{ width: 30, height: 30, borderRadius: 'var(--radius)', background: 'var(--gw-sky)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--gw-azure)', flexShrink: 0 }}>
                          {(c?.first_name || '')[0]}{(c?.last_name || '')[0]}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div className="seq-enrollment__name">{c?.first_name} {c?.last_name}</div>
                          <div className="seq-enrollment__meta">
                            Step {e.current_step + 1}/{steps.length}
                            {currentStep && <> · Next: {nextDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</>}
                          </div>
                        </div>
                        <span className={`seq-enrollment__status ${e.status}`}>{e.status}</span>
                        <select
                          className="form-control" style={{ width: 'auto', fontSize: 11, padding: '3px 6px' }}
                          value={e.status}
                          onChange={ev => changeEnrollStatus(e.id, ev.target.value)}
                          onClick={ev => ev.stopPropagation()}>
                          <option value="active">Active</option>
                          <option value="paused">Paused</option>
                          <option value="completed">Completed</option>
                        </select>
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
        <EnrollModal sequence={selected} contacts={contacts} agents={agents} activeAgent={activeAgent}
          onClose={() => setEnrollModal(false)}
          onEnrolled={() => selectSeq(selected, null)} />
      )}
      {confirm && <ConfirmDialog message={`Delete "${selected?.name}"? This will also remove all enrollments.`} onConfirm={deleteSequence} onCancel={() => setConfirm(null)} />}
    </div>
  )
}
