import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Avatar, Drawer, EmptyState, ConfirmDialog, Modal, pushToast } from '../components/UI.jsx'

function TeamModal({ open, onClose, team, onSave }) {
  const [name, setName] = useState(team?.name || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => { setName(team?.name || '') }, [team, open])

  const save = async () => {
    if (!name.trim()) return
    setSaving(true)
    if (team?.id) {
      await supabase.from('teams').update({ name: name.trim() }).eq('id', team.id)
    } else {
      await supabase.from('teams').insert([{ name: name.trim() }])
    }
    setSaving(false)
    pushToast(team?.id ? 'Team updated' : 'Team created')
    onSave()
  }

  return (
    <Modal open={open} onClose={onClose} width={400}>
      <div className="modal__head">
        <div><div className="eyebrow-label">Teams</div><h3 style={{margin:0,fontFamily:'var(--font-display)',fontSize:20}}>{team?.id ? 'Edit Team' : 'New Team'}</h3></div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body">
        <div className="form-group"><label className="form-label required">Team Name</label>
          <input className="form-control" value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Alpha Team, East Side, Investor Group" autoFocus/>
        </div>
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving||!name.trim()}>{saving?'Saving…':'Save Team'}</button>
      </div>
    </Modal>
  )
}

function AgentDrawer({ open, onClose, agent, teams, onSave }) {
  const COLORS = ['#2d3561','#4a6fa5','#2e7d5e','#c9a84c','#6b4fa5','#c0392b','#d4820a','#1a1a2e']
  const blank = { name:'', initials:'', role:'', email:'', color:'#2d3561', team_id:'' }
  const [form, setForm] = useState(agent || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  useEffect(() => { setForm(agent ? {...agent, team_id: agent.team_id || ''} : blank); setErrors({}) }, [agent, open])
  const set = (k, v) => setForm(p => ({...p, [k]: v}))

  const autoInitials = (name) => name.split(' ').map(w=>w[0]||'').join('').toUpperCase().slice(0,2)

  const save = async () => {
    const e = {}
    if (!form.name.trim()) e.name = true
    if (!form.email.trim()) e.email = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    const payload = { ...form, initials: form.initials || autoInitials(form.name), team_id: form.team_id || null }
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
        <div className="form-group"><label className="form-label">Team</label>
          <select className="form-control" value={form.team_id} onChange={e=>set('team_id',e.target.value)}>
            <option value="">No Team</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {teams.length === 0 && <div className="form-hint">Create a team first in the Teams section below</div>}
        </div>
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
  const [drawer, setDrawer]         = useState(false)
  const [editing, setEditing]       = useState(null)
  const [confirm, setConfirm]       = useState(null)
  const [teams, setTeams]           = useState([])
  const [teamModal, setTeamModal]   = useState(false)
  const [editingTeam, setEditingTeam] = useState(null)
  const [confirmTeam, setConfirmTeam] = useState(null)

  const agents   = db.agents || []
  const contacts = db.contacts || []
  const deals    = db.deals || []
  const tasks    = db.tasks || []

  useEffect(() => { loadTeams() }, [])

  const loadTeams = async () => {
    const { data } = await supabase.from('teams').select('*').order('name', { ascending: true })
    setTeams(data || [])
  }

  const reload = async () => {
    const { data } = await supabase.from('agents').select('*').order('created_at', { ascending: true })
    setDb(p => ({ ...p, agents: data || [] }))
  }

  const del = async (id) => {
    await supabase.from('agents').delete().eq('id', id)
    pushToast('Agent removed', 'info')
    setConfirm(null); reload()
  }

  const deleteTeam = async (id) => {
    await supabase.from('teams').delete().eq('id', id)
    // Unset team_id on agents belonging to this team
    await supabase.from('agents').update({ team_id: null }).eq('team_id', id)
    pushToast('Team deleted', 'info')
    setConfirmTeam(null); loadTeams(); reload()
  }

  // Group agents by team
  const teamsWithMembers = teams.map(t => ({
    ...t,
    members: agents.filter(a => a.team_id === t.id),
  }))
  const unassigned = agents.filter(a => !a.team_id)

  return (
    <div className="page-content">
      <div className="page-header">
        <div><div className="page-title">Team</div><div className="page-sub">{agents.length} agents · {teams.length} teams</div></div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn btn--secondary" onClick={() => { setEditingTeam(null); setTeamModal(true) }}><Icon name="plus" size={14} /> New Team</button>
          <button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Agent</button>
        </div>
      </div>

      {agents.length === 0 ? (
        <EmptyState icon="team" title="No agents yet" message="Add your team members to assign contacts, deals, and tasks." action={<button className="btn btn--primary" onClick={() => setDrawer(true)}><Icon name="plus" size={14} /> Add Agent</button>} />
      ) : (
        <div>
          {/* Teams with members */}
          {teamsWithMembers.map(team => (
            <div key={team.id} style={{marginBottom:28}}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,paddingBottom:8,borderBottom:'2px solid var(--gw-border)'}}>
                <div style={{fontSize:13,fontWeight:700,color:'var(--gw-ink)',flex:1}}>{team.name}</div>
                <span style={{fontSize:11,color:'var(--gw-mist)',background:'var(--gw-bone)',padding:'2px 8px',borderRadius:8}}>{team.members.length} {team.members.length===1?'agent':'agents'}</span>
                <button className="btn btn--ghost btn--icon btn--sm" onClick={() => { setEditingTeam(team); setTeamModal(true) }}><Icon name="edit" size={13}/></button>
                <button className="btn btn--ghost btn--icon btn--sm" onClick={() => setConfirmTeam(team.id)}><Icon name="trash" size={13}/></button>
              </div>
              {team.members.length === 0
                ? <div style={{fontSize:12,color:'var(--gw-mist)',paddingLeft:4}}>No agents assigned to this team yet.</div>
                : <div className="team-grid">{team.members.map(agent => <AgentCard key={agent.id} agent={agent} contacts={contacts} deals={deals} tasks={tasks} activeAgent={activeAgent} onSwitchAgent={onSwitchAgent} onEdit={() => { setEditing(agent); setDrawer(true) }} onDelete={() => setConfirm(agent.id)} />)}</div>
              }
            </div>
          ))}

          {/* Unassigned agents */}
          {unassigned.length > 0 && (
            <div style={{marginBottom:28}}>
              <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,paddingBottom:8,borderBottom:'2px solid var(--gw-border)'}}>
                <div style={{fontSize:13,fontWeight:700,color:'var(--gw-mist)',flex:1}}>Unassigned</div>
                <span style={{fontSize:11,color:'var(--gw-mist)',background:'var(--gw-bone)',padding:'2px 8px',borderRadius:8}}>{unassigned.length} {unassigned.length===1?'agent':'agents'}</span>
              </div>
              <div className="team-grid">{unassigned.map(agent => <AgentCard key={agent.id} agent={agent} contacts={contacts} deals={deals} tasks={tasks} activeAgent={activeAgent} onSwitchAgent={onSwitchAgent} onEdit={() => { setEditing(agent); setDrawer(true) }} onDelete={() => setConfirm(agent.id)} />)}</div>
            </div>
          )}
        </div>
      )}

      <AgentDrawer open={drawer} onClose={() => setDrawer(false)} agent={editing} teams={teams} onSave={reload} />
      <TeamModal open={teamModal} onClose={() => setTeamModal(false)} team={editingTeam} onSave={() => { loadTeams(); reload() }} />
      {confirm && <ConfirmDialog message="Remove this agent from the team?" onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
      {confirmTeam && <ConfirmDialog message="Delete this team? Agents will become unassigned." onConfirm={() => deleteTeam(confirmTeam)} onCancel={() => setConfirmTeam(null)} />}
    </div>
  )
}

function AgentCard({ agent, contacts, deals, tasks, activeAgent, onSwitchAgent, onEdit, onDelete }) {
  const agentContacts = contacts.filter(c => c.assigned_agent_id === agent.id).length
  const agentDeals    = deals.filter(d => d.agent_id === agent.id && d.stage !== 'closed' && d.stage !== 'lost').length
  const agentTasks    = tasks.filter(t => t.agent_id === agent.id && !t.completed).length
  const isActive      = agent.id === activeAgent?.id
  return (
    <div className="agent-card" style={{ border: isActive ? '2px solid var(--gw-azure)' : undefined }}>
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
        <button className="btn btn--ghost btn--icon" onClick={onEdit}><Icon name="edit" size={14} /></button>
        <button className="btn btn--ghost btn--icon" onClick={onDelete}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  )
}
