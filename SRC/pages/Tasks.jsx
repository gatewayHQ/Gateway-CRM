import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatDate, isOverdue, isToday, isThisWeek } from '../lib/helpers.js'
import { Icon, Badge, Avatar, Drawer, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'

function TaskDrawer({ open, onClose, task, agents, contacts, deals, onSave }) {
  const blank = { title:'', type:'follow-up', priority:'medium', due_date:'', contact_id:'', deal_id:'', agent_id:'', notes:'', completed:false }
  const [form, setForm] = useState(task || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  React.useEffect(() => {
    setForm(task ? { ...task, due_date: task.due_date ? task.due_date.slice(0,16) : '' } : blank)
    setErrors({})
  }, [task, open])
  const set = (k, v) => setForm(p => ({...p, [k]: v}))

  const save = async () => {
    const e = {}
    if (!form.title.trim()) e.title = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    let error
    if (task?.id) {
      ({ error } = await supabase.from('tasks').update(form).eq('id', task.id))
    } else {
      ({ error } = await supabase.from('tasks').insert([form]))
    }
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(task?.id ? 'Task updated' : 'Task added')
    onSave(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title={task?.id ? 'Edit Task' : 'Add Task'}>
      <div className="drawer__body">
        <div className="form-group"><label className="form-label required">Task Title</label><input className={`form-control${errors.title?' error':''}`} value={form.title} onChange={e=>set('title',e.target.value)} placeholder="e.g. Follow up with Jane Smith" /></div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Type</label><select className="form-control" value={form.type} onChange={e=>set('type',e.target.value)}>{['call','email','showing','follow-up','document','other'].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}</select></div>
          <div className="form-group"><label className="form-label">Priority</label><select className="form-control" value={form.priority} onChange={e=>set('priority',e.target.value)}>{['high','medium','low'].map(p=><option key={p} value={p}>{p.charAt(0).toUpperCase()+p.slice(1)}</option>)}</select></div>
        </div>
        <div className="form-group"><label className="form-label">Due Date</label><input className="form-control" type="datetime-local" value={form.due_date||''} onChange={e=>set('due_date',e.target.value)} /></div>
        <div className="form-group"><label className="form-label">Contact</label><SearchDropdown items={contacts} value={form.contact_id} onSelect={v=>set('contact_id',v)} placeholder="Search contacts…" labelKey={c=>`${c.first_name} ${c.last_name}`} /></div>
        <div className="form-group"><label className="form-label">Deal</label><SearchDropdown items={deals} value={form.deal_id} onSelect={v=>set('deal_id',v)} placeholder="Search deals…" labelKey="title" /></div>
        <div className="form-group"><label className="form-label">Assigned Agent</label><select className="form-control" value={form.agent_id||''} onChange={e=>set('agent_id',e.target.value)}><option value="">Unassigned</option>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
        <div className="form-group"><label className="form-label">Notes</label><textarea className="form-control form-control--textarea" value={form.notes||''} onChange={e=>set('notes',e.target.value)} /></div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Task'}</button>
      </div>
    </Drawer>
  )
}

export default function TasksPage({ db, setDb, activeAgent }) {
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [filterPriority, setFilterPriority] = useState('')
  const [filterType, setFilterType] = useState('')
  const [showCompleted, setShowCompleted] = useState(false)

  const tasks = db.tasks || []
  const agents = db.agents || []
  const contacts = db.contacts || []
  const deals = db.deals || []

  const reload = async () => {
    const { data } = await supabase.from('tasks').select('*').order('due_date', { ascending: true })
    setDb(p => ({ ...p, tasks: data || [] }))
  }

  const toggle = async (task) => {
    const updated = { ...task, completed: !task.completed }
    await supabase.from('tasks').update({ completed: updated.completed }).eq('id', task.id)
    setDb(p => ({ ...p, tasks: p.tasks.map(t => t.id === task.id ? updated : t) }))
    pushToast(updated.completed ? 'Task completed! ✓' : 'Task reopened')
  }

  const del = async (id) => {
    await supabase.from('tasks').delete().eq('id', id)
    pushToast('Task deleted', 'info')
    setConfirm(null); reload()
  }

  const filtered = tasks.filter(t => {
    if (!showCompleted && t.completed) return false
    if (filterPriority && t.priority !== filterPriority) return false
    if (filterType && t.type !== filterType) return false
    return true
  })

  const overdue = filtered.filter(t => !t.completed && t.due_date && new Date(t.due_date) < new Date())
  const todayTasks = filtered.filter(t => !t.completed && t.due_date && isToday(t.due_date) && !overdue.find(o=>o.id===t.id))
  const upcoming = filtered.filter(t => !t.completed && t.due_date && isThisWeek(t.due_date) && !todayTasks.find(x=>x.id===t.id) && !overdue.find(o=>o.id===t.id))
  const other = filtered.filter(t => !overdue.find(o=>o.id===t.id) && !todayTasks.find(x=>x.id===t.id) && !upcoming.find(x=>x.id===t.id))

  const TaskRow = ({ task }) => {
    const contact = contacts.find(c => c.id === task.contact_id)
    const agent = agents.find(a => a.id === task.agent_id)
    const od = !task.completed && task.due_date && new Date(task.due_date) < new Date()
    return (
      <div className={`task-row${task.completed?' completed':''}`}>
        <div className={`task-checkbox${task.completed?' checked':''}`} onClick={() => toggle(task)}>
          {task.completed && <Icon name="check" size={10} style={{ color:'#fff' }} />}
        </div>
        <Icon name={task.type==='call'?'phone':task.type==='email'?'mail':task.type==='showing'?'building':'tasks'} size={14} style={{ color:'var(--gw-mist)', flexShrink:0 }} />
        <div style={{ flex:1 }}>
          <div className="task-title">{task.title}</div>
          {contact && <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{contact.first_name} {contact.last_name}</div>}
        </div>
        <div className="task-meta">
          <Badge variant={task.priority}>{task.priority}</Badge>
          {task.due_date && <span style={{ fontSize:11, color: od?'var(--gw-red)':'var(--gw-mist)', fontWeight: od?600:400 }}>{formatDate(task.due_date)}</span>}
          {agent && <Avatar agent={agent} size={22} />}
          <button className="btn btn--ghost btn--icon" onClick={() => { setEditing(task); setDrawer(true) }}><Icon name="edit" size={12} /></button>
          <button className="btn btn--ghost btn--icon" onClick={() => setConfirm(task.id)}><Icon name="trash" size={12} /></button>
        </div>
      </div>
    )
  }

  const Group = ({ label, items, color }) => {
    if (items.length === 0) return null
    return (
      <div className="task-group">
        <div className="task-group__label" style={{ color: color || undefined }}>{label} ({items.length})</div>
        {items.map(t => <TaskRow key={t.id} task={t} />)}
      </div>
    )
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div><div className="page-title">Tasks</div><div className="page-sub">{tasks.filter(t=>!t.completed).length} open · {tasks.filter(t=>t.completed).length} completed</div></div>
        <button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Task</button>
      </div>

      <div className="filters-bar">
        <select className="filter-select" value={filterPriority} onChange={e=>setFilterPriority(e.target.value)}><option value="">All Priorities</option>{['high','medium','low'].map(p=><option key={p} value={p}>{p.charAt(0).toUpperCase()+p.slice(1)}</option>)}</select>
        <select className="filter-select" value={filterType} onChange={e=>setFilterType(e.target.value)}><option value="">All Types</option>{['call','email','showing','follow-up','document','other'].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}</select>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, cursor:'pointer', marginLeft:'auto' }}>
          <input type="checkbox" checked={showCompleted} onChange={e=>setShowCompleted(e.target.checked)} />
          Show completed
        </label>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="tasks" title="No tasks" message="Add tasks to track follow-ups, showings, and reminders." action={<button className="btn btn--primary" onClick={() => setDrawer(true)}><Icon name="plus" size={14} /> Add Task</button>} />
      ) : (
        <>
          <Group label="Overdue" items={overdue} color="var(--gw-red)" />
          <Group label="Today" items={todayTasks} color="var(--gw-azure)" />
          <Group label="This Week" items={upcoming} />
          <Group label="Upcoming & Other" items={other} />
          {showCompleted && <Group label="Completed" items={filtered.filter(t=>t.completed)} color="var(--gw-mist)" />}
        </>
      )}

      <TaskDrawer open={drawer} onClose={() => setDrawer(false)} task={editing} agents={agents} contacts={contacts} deals={deals} onSave={reload} />
      {confirm && <ConfirmDialog message="Delete this task?" onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
    </div>
  )
}
