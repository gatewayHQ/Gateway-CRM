import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, Drawer, pushToast } from '../../components/UI.jsx'

const COLORS = ['#2d3561','#4a6fa5','#2e7d5e','#c9a84c','#6b4fa5','#c0392b','#d4820a','#1a1a2e']
const BLANK  = { name: '', initials: '', role: '', email: '', color: '#2d3561' }

const autoInitials = (name) =>
  name.trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2)

export default function AgentDrawer({ open, onClose, agent, onSave }) {
  const [form,   setForm]   = useState(BLANK)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setForm(agent ? { ...agent } : BLANK)
    setErrors({})
  }, [agent, open])

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const save = async () => {
    const e = {}
    if (!form.name.trim())  e.name  = true
    if (!form.email.trim()) e.email = true
    setErrors(e)
    if (Object.keys(e).length) return

    setSaving(true)
    const payload = { ...form, initials: form.initials || autoInitials(form.name) }
    const { error } = agent?.id
      ? await supabase.from('agents').update(payload).eq('id', agent.id)
      : await supabase.from('agents').insert([payload])
    setSaving(false)

    if (error) { pushToast(error.message, 'error'); return }
    pushToast(agent?.id ? 'Agent updated' : 'Agent added')
    onSave()
    onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title={agent?.id ? 'Edit Agent' : 'Add Agent'} width={400}>
      <div className="drawer__body">
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
          <div style={{ width: 64, height: 64, borderRadius: 12, background: form.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700, color: '#fff' }}>
            {form.initials || autoInitials(form.name) || '?'}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label required">Full Name</label>
          <input className={`form-control${errors.name ? ' error' : ''}`} value={form.name}
            onChange={e => set('name', e.target.value)} placeholder="Jane Smith" />
        </div>
        <div className="form-group">
          <label className="form-label">Initials</label>
          <input className="form-control" value={form.initials}
            onChange={e => set('initials', e.target.value.toUpperCase().slice(0, 2))}
            placeholder="Auto-generated" maxLength={2} />
          <div className="form-hint">Leave blank to auto-generate from name</div>
        </div>
        <div className="form-group">
          <label className="form-label">Role</label>
          <input className="form-control" value={form.role}
            onChange={e => set('role', e.target.value)} placeholder="Lead Agent, Agent, Admin…" />
        </div>
        <div className="form-group">
          <label className="form-label required">Email</label>
          <input className={`form-control${errors.email ? ' error' : ''}`} type="email" value={form.email}
            onChange={e => set('email', e.target.value)} />
        </div>

        <div className="form-group">
          <label className="form-label">Avatar Color</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {COLORS.map(c => (
              <div key={c} onClick={() => set('color', c)} style={{
                width: 28, height: 28, borderRadius: 6, background: c, cursor: 'pointer',
                border: form.color === c ? '3px solid var(--gw-ink)' : '3px solid transparent',
                transition: 'border 150ms',
              }} />
            ))}
          </div>
        </div>
      </div>

      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Agent'}
        </button>
      </div>
    </Drawer>
  )
}
