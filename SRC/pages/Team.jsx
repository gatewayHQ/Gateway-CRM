import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Avatar, Drawer, EmptyState, ConfirmDialog, pushToast } from '../components/UI.jsx'

function AgentDrawer({ open, onClose, agent, onSave }) {
  const COLORS = ['#2d3561','#4a6fa5','#2e7d5e','#c9a84c','#6b4fa5','#c0392b','#d4820a','#1a1a2e']
  const blank = { name:'', initials:'', role:'', email:'', color:'#2d3561' }
  const [form, setForm] = useState(agent || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  React.useEffect(() => { setForm(agent || blank); setErrors({}) }, [agent, open])
  const set = (k, v) => setForm(p => ({...p, [k]: v}))

  const autoInitials = (name) => name.split(' ').map(w=>w[0]||'').join('').toUpperCase().slice(0,2)

  const save = async () => {
    const e = {}
    if (!form.name.trim()) e.name = true
    if (!form.email.trim()) e.email = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    const payload = { ...form, initials: form.initials || autoInitials(form.name) }
    let error
    if (agent?.id) {
      ({ error } = await supabase.from('agents').update(payload).eq('id', agent.id))
    } else {
      ({ error } = await supabase.from('agents').insert([payload]))
    }
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(agent?.id ? 'Agent updated' : 'Agent added')
    onSave(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title={agent?.id ? 'Edit Agent' : 'Add Agent'} width={400}>
      <div className="drawer__body">
        <div style={{ display:'flex', justifyContent:'center', marginBottom:20 }}>
          <div style={{ width:64, height:64, borderRadius:12, background:form.color, display:'flex', alignItems:'center', justifyContent:'center', fontSize:24, fontWeight:700, color:'#fff' }}>{form.initials || autoInitials(form.name) || '?'}</div>
        </div>
        <div className="form-group"><label className="form-label required">Full Name</label><input className={`form-control${errors.name?' error':''}`} value={form.name} onChange={e=>set('name',e.target.value)} placeholder="Jane Smith" /></div>
        <div className="form-group"><label className="form-label">Initials</label><input className="form-control" value={form.initials} onChange={e=>set('initials',e.target.value.toUpperCase().slice(0,2))} placeholder="Auto-generated" maxLength={2} /><div className="form-hint">Leave blank to auto-generate from name</div></div>
        <div className="form-group"><label className="form-label">Role</label><input className="form-control" value={form.role} onChange={e=>set('role',e.target.value)} placeholder="Lead Agent, Agent, Admin…" /></div>
        <div className="form-group"><label className="form-label required">Email</label><input className={`form-control${errors.email?' error':''}`} type="email" value={form.email} onChange={e=>set('email',e.target.value)} /></div>
        <div className="form-group">
          <label className="form-label">Avatar Color</label>
          <div style={{ display:'flex', gap:8, marginTop:4 }}>
            {COLORS.map(c => (
              <div key={c} onClick={() => set('color', c)} style={{ width:28, height:28, borderRadius:6, background:c, cursor:'pointer', border: form.color===c ? '3px solid var(--gw-ink)' : '3px solid transparent', transition:'border 150ms' }} />
            ))}
          </div>
        </div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Agent'}</button>
      </div>
    </Drawer>
  )
}

export default function TeamPage({ db, setDb, activeAgent, onSwitchAgent }) {
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirm, setConfirm] = useState(null)

  const agents = db.agents || []
  const contacts = db.contacts || []
  const deals = db.deals || []
  const tasks = db.tasks || []

  const reload = async () => {
    const { data } = await supabase.from('agents').select('*').order('created_at', { ascending: true })
    setDb(p => ({ ...p, agents: data || [] }))
  }

  const del = async (id) => {
    await supabase.from('agents').delete().eq('id', id)
    pushToast('Agent removed', 'info')
    setConfirm(null); reload()
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div><div className="page-title">Team</div><div className="page-sub">{agents.length} agents</div></div>
        <button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Agent</button>
      </div>

      {agents.length === 0 ? (
        <EmptyState icon="team" title="No agents yet" message="Add your team members to assign contacts, deals, and tasks." action={<button className="btn btn--primary" onClick={() => setDrawer(true)}><Icon name="plus" size={14} /> Add Agent</button>} />
      ) : (
        <div className="team-grid">
          {agents.map(agent => {
            const agentContacts = contacts.filter(c => c.assigned_agent_id === agent.id).length
            const agentDeals = deals.filter(d => d.agent_id === agent.id && d.stage !== 'closed' && d.stage !== 'lost').length
            const agentTasks = tasks.filter(t => t.agent_id === agent.id && !t.completed).length
            const isActive = agent.id === activeAgent?.id
            return (
              <div key={agent.id} className="agent-card" style={{ border: isActive ? '2px solid var(--gw-azure)' : undefined }}>
                {isActive && <div style={{ fontSize:10, fontWeight:600, color:'var(--gw-azure)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:8 }}>● Active</div>}
                <div className="agent-card__avatar" style={{ background: agent.color }}>{agent.initials}</div>
                <div className="agent-card__name">{agent.name}</div>
                <div className="agent-card__role">{agent.role}</div>
                <div className="agent-card__email">{agent.email}</div>
                <div className="agent-card__stats">
                  {[{val:agentContacts,label:'Contacts'},{val:agentDeals,label:'Deals'},{val:agentTasks,label:'Tasks'}].map(s => (
                    <div key={s.label} className="agent-card__stat">
                      <div className="agent-card__stat-val">{s.val}</div>
                      <div className="agent-card__stat-label">{s.label}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display:'flex', gap:6 }}>
                  {!isActive && <button className="btn btn--secondary" style={{ flex:1, justifyContent:'center', fontSize:12 }} onClick={() => { onSwitchAgent(agent.id); pushToast(`Now active as ${agent.name}`) }}>Switch to Agent</button>}
                  <button className="btn btn--ghost btn--icon" onClick={() => { setEditing(agent); setDrawer(true) }}><Icon name="edit" size={14} /></button>
                  <button className="btn btn--ghost btn--icon" onClick={() => setConfirm(agent.id)}><Icon name="trash" size={14} /></button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <AgentDrawer open={drawer} onClose={() => setDrawer(false)} agent={editing} onSave={reload} />
      {confirm && <ConfirmDialog message="Remove this agent from the team?" onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
    </div>
  )
}
