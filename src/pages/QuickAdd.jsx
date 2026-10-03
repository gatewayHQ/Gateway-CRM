import React, { useState } from 'react'
import { syncTaskCalendar, createTask } from '../lib/services/tasks.js'
import { Icon, Drawer, pushToast } from '../components/UI.jsx'
import { STAGE_ORDER, toDateTimeLocalInput, fromDateTimeLocalInput } from '../lib/helpers.js'
import { useStageLabels } from '../lib/stageLabelContext.js'
import { upsertContactRecord } from '../lib/services/contactRecords.js'
import { CONTACT_SOURCES } from '../lib/enums.js'
import { mutationErrorMessage } from '../lib/services/db.js'
import { createDeal } from '../lib/services/dealRecords.js'

function QuickContactDrawer({ open, onClose, agents, activeAgent, contacts = [], onSaved }) {
  const blank = () => ({ first_name: '', last_name: '', phone: '', email: '', type: 'buyer', source: 'referral', assigned_agent_id: activeAgent?.id || '' })
  const [form, setForm] = useState(blank())
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  React.useEffect(() => { setForm(blank()) }, [open, activeAgent?.id])

  const save = async () => {
    if (!form.first_name.trim() || !form.last_name.trim()) { pushToast('First and last name required', 'error'); return }
    setSaving(true)
    // `source` is captured, not hardcoded to 'other' — lead-source attribution
    // is the input every ROI report depends on, and it was being destroyed at
    // the point of capture.
    const owner = form.assigned_agent_id || activeAgent?.id || null
    const handingOff = Boolean(owner) && owner !== activeAgent?.id
    const { contact, created, error } = await upsertContactRecord(
      { ...form, status: 'active', tags: [], assigned_agent_id: owner },
      contacts,
      { readBack: !handingOff },
    )
    setSaving(false)
    if (error) { pushToast(mutationErrorMessage({ message: error }), 'error'); return }
    const name = `${form.first_name} ${form.last_name}`
    const toName = agents.find(a => a.id === owner)?.name
    pushToast(!created ? `${name} already existed — record updated`
      : handingOff ? `${name} handed to ${toName || 'another agent'} — it's in their book now`
      : `${name} added to Contacts`)
    // A handed-off contact is in someone else's book, not this one.
    if (!handingOff) onSaved(contact)
    onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title="Quick Add Contact" width={400}>
      <div className="drawer__body">
        <div className="form-row">
          <div className="form-group">
            <label className="form-label required">First Name</label>
            <input className="form-control" autoFocus value={form.first_name} onChange={e => set('first_name', e.target.value)} placeholder="Jane" />
          </div>
          <div className="form-group">
            <label className="form-label required">Last Name</label>
            <input className="form-control" value={form.last_name} onChange={e => set('last_name', e.target.value)} placeholder="Smith" />
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Phone</label>
          <input className="form-control" type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="(555) 000-0000" />
        </div>
        <div className="form-group">
          <label className="form-label">Email</label>
          <input className="form-control" type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="jane@email.com" />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Type</label>
            <select className="form-control" value={form.type} onChange={e => set('type', e.target.value)}>
              {['buyer', 'seller', 'investor', 'landlord', 'tenant'].map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Source</label>
            <select className="form-control" value={form.source} onChange={e => set('source', e.target.value)}>
              {CONTACT_SOURCES.map(sc => <option key={sc} value={sc}>{sc.charAt(0).toUpperCase() + sc.slice(1)}</option>)}
            </select>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Assign To</label>
          <select className="form-control" value={form.assigned_agent_id} onChange={e => set('assigned_agent_id', e.target.value)}>
            {agents.map(a => <option key={a.id} value={a.id}>{a.id === activeAgent?.id ? `${a.name} (you)` : a.name}</option>)}
          </select>
        </div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add Contact'}</button>
      </div>
    </Drawer>
  )
}

// Where a quick-added deal can start. Never Closed or Lost: closing runs the
// compliance checks on the deal page, and a quick add would skip them.
const QUICK_STAGES = STAGE_ORDER.filter(s => s !== 'closed' && s !== 'lost')

function QuickDealDrawer({ open, onClose, agents, activeAgent, onSaved, onOpen }) {
  const stageLabels = useStageLabels()
  const blank = () => ({ title: '', value: '', stage: 'lead', agent_id: activeAgent?.id || '' })
  const [form, setForm] = useState(blank())
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  React.useEffect(() => { setForm(blank()) }, [open, activeAgent?.id])

  const save = async () => {
    if (!form.title.trim()) { pushToast('Deal title required', 'error'); return }
    setSaving(true)
    const { data, error } = await createDeal({
      ...form,
      value: form.value ? Number(form.value) : null,
      probability: 25,
      updated_at: new Date().toISOString(),
      agent_id: form.agent_id || activeAgent?.id || null,
    })
    setSaving(false)
    if (error) { pushToast(mutationErrorMessage(error), 'error'); return }
    pushToast(`Deal "${form.title}" added`)
    onSaved(data); onClose()
    // Straight to the new deal: its property, contact and checklist are next.
    if (data?.id) onOpen?.(`deal/${data.id}`)
  }

  return (
    <Drawer open={open} onClose={onClose} title="Quick Add Deal" width={400}>
      <div className="drawer__body">
        <div className="form-group">
          <label className="form-label required">Deal Title</label>
          <input className="form-control" autoFocus value={form.title} onChange={e => set('title', e.target.value)} placeholder="123 Main St — Purchase" />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Sale Price</label>
            <input className="form-control" type="number" value={form.value} onChange={e => set('value', e.target.value)} placeholder="500000" />
          </div>
          <div className="form-group">
            <label className="form-label">Stage</label>
            <select className="form-control" value={form.stage} onChange={e => set('stage', e.target.value)}>
              {QUICK_STAGES.map(s => <option key={s} value={s}>{stageLabels[s]}</option>)}
            </select>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Assign To</label>
          <select className="form-control" value={form.agent_id} onChange={e => set('agent_id', e.target.value)}>
            {agents.map(a => <option key={a.id} value={a.id}>{a.id === activeAgent?.id ? `${a.name} (you)` : a.name}</option>)}
          </select>
        </div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add Deal'}</button>
      </div>
    </Drawer>
  )
}

function QuickTaskDrawer({ open, onClose, activeAgent, onSaved }) {
  // Tomorrow at 9am in the AGENT's own zone — `toDateTimeLocalInput` keeps the
  // input showing 09:00 instead of the UTC-shifted 14:00 the ISO slice showed.
  const defaultDue = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return toDateTimeLocalInput(d) }
  const blank = () => ({ title: '', type: 'follow-up', priority: 'medium', due_date: defaultDue() })
  const [form, setForm] = useState(blank())
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  React.useEffect(() => { setForm(blank()) }, [open, activeAgent?.id])

  const save = async () => {
    if (!form.title.trim()) { pushToast('Task title required', 'error'); return }
    setSaving(true)
    const { data, error } = await createTask({
      ...form,
      due_date: fromDateTimeLocalInput(form.due_date),
      completed: false,
      // Tasks are personal: always the agent adding it (tasks_agent_scope).
      agent_id: activeAgent?.id || null,
    })
    setSaving(false)
    if (error) { pushToast(mutationErrorMessage(error), 'error'); return }
    syncTaskCalendar(data?.id)
    pushToast('Task added')
    onSaved(data); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title="Quick Add Task" width={400}>
      <div className="drawer__body">
        <div className="form-group">
          <label className="form-label required">Task</label>
          <input className="form-control" autoFocus value={form.title} onChange={e => set('title', e.target.value)} placeholder="Follow up with Jane Smith" />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Type</label>
            <select className="form-control" value={form.type} onChange={e => set('type', e.target.value)}>
              {['call', 'email', 'showing', 'follow-up', 'document', 'other'].map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Priority</label>
            <select className="form-control" value={form.priority} onChange={e => set('priority', e.target.value)}>
              {['high', 'medium', 'low'].map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
            </select>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Due</label>
          <input className="form-control" type="datetime-local" value={form.due_date} onChange={e => set('due_date', e.target.value)} />
        </div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add Task'}</button>
      </div>
    </Drawer>
  )
}

const OPTIONS = [
  { id: 'task',    label: 'New Task',    icon: 'tasks',    bg: '#4a6fa5' },
  { id: 'deal',    label: 'New Deal',    icon: 'pipeline', bg: '#2e7d5e' },
  { id: 'contact', label: 'New Contact', icon: 'contacts', bg: '#c9a84c' },
]

export default function QuickAdd({ db, setDb, activeAgent, go }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState(null)

  // Put the saved row into the loaded list — the same row the database
  // returned. Reloading the whole table here used to skip the app's
  // visibility rules and could swap an agent's list for a different one.
  const keep = (key) => (row) => {
    if (!row?.id) return
    setDb(p => ({ ...p, [key]: [row, ...(p[key] || []).filter(r => r.id !== row.id)] }))
  }

  return (
    <>
      {open && <div style={{ position: 'fixed', inset: 0, zIndex: 498 }} onClick={() => setOpen(false)} />}

      <div className="fab-wrap">
        {open && (
          <div className="fab-menu">
            {OPTIONS.map(o => (
              <button key={o.id} className="fab-option" style={{ background: o.bg }}
                onClick={() => { setMode(o.id); setOpen(false) }}>
                <Icon name={o.icon} size={14} />
                {o.label}
              </button>
            ))}
          </div>
        )}
        <button className={`fab-btn${open ? ' fab-btn--open' : ''}`} onClick={() => setOpen(v => !v)} title="Quick add">
          <Icon name={open ? 'x' : 'plus'} size={22} />
        </button>
      </div>

      <QuickContactDrawer open={mode === 'contact'} onClose={() => setMode(null)}
        agents={db.agents || []} activeAgent={activeAgent} contacts={db.contacts || []}
        onSaved={keep('contacts')} />

      <QuickDealDrawer open={mode === 'deal'} onClose={() => setMode(null)}
        agents={db.agents || []} activeAgent={activeAgent}
        onSaved={keep('deals')} onOpen={go} />

      <QuickTaskDrawer open={mode === 'task'} onClose={() => setMode(null)}
        activeAgent={activeAgent}
        onSaved={keep('tasks')} />
    </>
  )
}
