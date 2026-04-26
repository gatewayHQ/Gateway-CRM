import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Drawer, pushToast } from '../components/UI.jsx'
import { STAGE_ORDER, STAGE_LABELS } from '../lib/helpers.js'

function QuickContactDrawer({ open, onClose, agents, activeAgent, onSaved }) {
  const blank = () => ({ first_name: '', last_name: '', phone: '', email: '', type: 'buyer', assigned_agent_id: activeAgent?.id || '' })
  const [form, setForm] = useState(blank())
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  React.useEffect(() => { setForm(blank()) }, [open, activeAgent?.id])

  const save = async () => {
    if (!form.first_name.trim() || !form.last_name.trim()) { pushToast('First and last name required', 'error'); return }
    setSaving(true)
    const { error } = await supabase.from('contacts').insert([{ ...form, status: 'active', source: 'other', tags: [] }])
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(`${form.first_name} ${form.last_name} added to Contacts`)
    onSaved(); onClose()
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
            <label className="form-label">Assign To</label>
            <select className="form-control" value={form.assigned_agent_id} onChange={e => set('assigned_agent_id', e.target.value)}>
              <option value="">Unassigned</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Add Contact'}</button>
      </div>
    </Drawer>
  )
}

function QuickDealDrawer({ open, onClose, agents, activeAgent, onSaved }) {
  const blank = () => ({ title: '', value: '', stage: 'lead', agent_id: activeAgent?.id || '' })
  const [form, setForm] = useState(blank())
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  React.useEffect(() => { setForm(blank()) }, [open, activeAgent?.id])

  const save = async () => {
    if (!form.title.trim()) { pushToast('Deal title required', 'error'); return }
    setSaving(true)
    const { error } = await supabase.from('deals').insert([{
      ...form,
      value: form.value ? Number(form.value) : null,
      probability: 25,
      updated_at: new Date().toISOString(),
    }])
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(`Deal "${form.title}" added`)
    onSaved(); onClose()
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
              {STAGE_ORDER.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
            </select>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label">Assign To</label>
          <select className="form-control" value={form.agent_id} onChange={e => set('agent_id', e.target.value)}>
            <option value="">Unassigned</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
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

function QuickTaskDrawer({ open, onClose, agents, activeAgent, onSaved }) {
  const defaultDue = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.toISOString().slice(0, 16) }
  const blank = () => ({ title: '', type: 'follow-up', priority: 'medium', due_date: defaultDue(), agent_id: activeAgent?.id || '' })
  const [form, setForm] = useState(blank())
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  React.useEffect(() => { setForm(blank()) }, [open, activeAgent?.id])

  const save = async () => {
    if (!form.title.trim()) { pushToast('Task title required', 'error'); return }
    setSaving(true)
    const { error } = await supabase.from('tasks').insert([{ ...form, completed: false }])
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast('Task added')
    onSaved(); onClose()
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
        <div className="form-group">
          <label className="form-label">Assign To</label>
          <select className="form-control" value={form.agent_id} onChange={e => set('agent_id', e.target.value)}>
            <option value="">Unassigned</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
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

export default function QuickAdd({ db, setDb, activeAgent }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState(null)

  const reload = (table, key, order = 'created_at') => async () => {
    const { data } = await supabase.from(table).select('*').order(order, { ascending: table === 'tasks' })
    setDb(p => ({ ...p, [key]: data || [] }))
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
        agents={db.agents || []} activeAgent={activeAgent}
        onSaved={reload('contacts', 'contacts')} />

      <QuickDealDrawer open={mode === 'deal'} onClose={() => setMode(null)}
        agents={db.agents || []} activeAgent={activeAgent}
        onSaved={reload('deals', 'deals')} />

      <QuickTaskDrawer open={mode === 'task'} onClose={() => setMode(null)}
        agents={db.agents || []} activeAgent={activeAgent}
        onSaved={reload('tasks', 'tasks', 'due_date')} />
    </>
  )
}
