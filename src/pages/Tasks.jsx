import React, { useState, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatDate } from '../lib/helpers.js'
import { Icon, Badge, Avatar, Drawer, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'

function TaskDrawer({ open, onClose, task, agents, contacts, deals, onSave }) {
  const blank = { title:'', type:'follow-up', priority:'medium', due_date:'', contact_id:'', deal_id:'', agent_id:'', notes:'', completed:false }
  const [form, setForm] = useState(blank)
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
    try {
      // Explicit whitelist — never spread full task object
      const payload = {
        title:      form.title.trim(),
        type:       form.type,
        priority:   form.priority,
        due_date:   form.due_date   || null,
        contact_id: form.contact_id || null,
        deal_id:    form.deal_id    || null,
        agent_id:   form.agent_id   || null,
        notes:      form.notes      || null,
        completed:  form.completed,
      }
      let error
      if (task?.id) {
        ;({ error } = await supabase.from('tasks').update(payload).eq('id', task.id))
      } else {
        ;({ error } = await supabase.from('tasks').insert([payload]))
      }
      if (error) { pushToast(error.message, 'error'); return }
      pushToast(task?.id ? 'Task updated' : 'Task added')
      await onSave()
      onClose()
    } catch(err) {
      console.error('[TaskDrawer] save error:', err)
      pushToast('Something went wrong.', 'error')
    } finally {
      setSaving(false)
    }
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

// ─── Defined OUTSIDE TasksPage ────────────────────────────────────────────────
// Defining components inside a parent causes React to treat them as new types
// every render → full unmount/remount of every row. Moving outside prevents this.

const TaskRow = React.memo(function TaskRow({ task, contact, agent, onToggle, onEdit, onDelete }) {
  const od = !task.completed && task.due_date && new Date(task.due_date) < new Date()
  return (
    <div className={`task-row${task.completed?' completed':''}`}>
      <div className={`task-checkbox${task.completed?' checked':''}`} onClick={() => onToggle(task)}>
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
        <button className="btn btn--ghost btn--icon" onClick={() => onEdit(task)}><Icon name="edit" size={12} /></button>
        <button className="btn btn--ghost btn--icon" onClick={() => onDelete(task.id)}><Icon name="trash" size={12} /></button>
      </div>
    </div>
  )
})

const TaskGroup = React.memo(function TaskGroup({ label, items, color, contactMap, agentMap, onToggle, onEdit, onDelete }) {
  if (items.length === 0) return null
  return (
    <div className="task-group">
      <div className="task-group__label" style={{ color: color || undefined }}>{label} ({items.length})</div>
      {items.map(t => (
        <TaskRow
          key={t.id}
          task={t}
          contact={contactMap[t.contact_id]}
          agent={agentMap[t.agent_id]}
          onToggle={onToggle}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
})

export default function TasksPage({ db, setDb, activeAgent }) {
  const [drawer, setDrawer]           = useState(false)
  const [editing, setEditing]         = useState(null)
  const [confirm, setConfirm]         = useState(null)
  const [filterPriority, setFilterPriority] = useState('')
  const [filterType, setFilterType]   = useState('')
  const [showCompleted, setShowCompleted] = useState(false)
  const [loadError, setLoadError]     = useState(null)

  const tasks    = db.tasks    || []
  const agents   = db.agents   || []
  const contacts = db.contacts || []
  const deals    = db.deals    || []

  // O(1) lookups — built once per contacts/agents change, not per-row
  const contactMap = useMemo(() => Object.fromEntries(contacts.map(c => [c.id, c])), [contacts])
  const agentMap   = useMemo(() => Object.fromEntries(agents.map(a => [a.id, a])),   [agents])

  // Memoized filter — only recomputes when tasks or active filters change
  const filtered = useMemo(() => tasks.filter(t => {
    if (!showCompleted && t.completed) return false
    if (filterPriority && t.priority !== filterPriority) return false
    if (filterType     && t.type     !== filterType)     return false
    return true
  }), [tasks, showCompleted, filterPriority, filterType])

  // Single-pass O(n) grouping — replaces the previous 4× O(n²) filter+find passes
  const { overdue, todayTasks, upcoming, other, completedTasks } = useMemo(() => {
    const now     = new Date()
    const todayStr = now.toDateString()
    const weekEnd  = new Date(now); weekEnd.setDate(now.getDate() + 7)
    const g = { overdue: [], todayTasks: [], upcoming: [], other: [], completedTasks: [] }
    filtered.forEach(t => {
      if (t.completed)  { g.completedTasks.push(t); return }
      if (!t.due_date)  { g.other.push(t);          return }
      const due = new Date(t.due_date)
      if (due < now)                       { g.overdue.push(t);    return }
      if (due.toDateString() === todayStr) { g.todayTasks.push(t); return }
      if (due <= weekEnd)                  { g.upcoming.push(t);   return }
      g.other.push(t)
    })
    return g
  }, [filtered])

  const openCount = useMemo(() => tasks.filter(t => !t.completed).length, [tasks])

  const reload = useCallback(async () => {
    if (!activeAgent?.id) return
    setLoadError(null)
    const { data, error } = await supabase.from('tasks').select('*')
      .eq('agent_id', activeAgent.id)
      .order('due_date', { ascending: true })
    if (error) { setLoadError(error.message); return }
    setDb(p => ({ ...p, tasks: data || [] }))
  }, [setDb, activeAgent?.id])

  const toggle = useCallback(async (task) => {
    const completed = !task.completed
    setDb(p => ({ ...p, tasks: p.tasks.map(t => t.id === task.id ? { ...t, completed } : t) }))
    const { error } = await supabase.from('tasks').update({ completed }).eq('id', task.id)
    if (error) {
      setDb(p => ({ ...p, tasks: p.tasks.map(t => t.id === task.id ? { ...t, completed: !completed } : t) }))
      pushToast(error.message, 'error'); return
    }
    pushToast(completed ? 'Task completed! ✓' : 'Task reopened')
  }, [setDb])

  const del = useCallback(async (id) => {
    const { error } = await supabase.from('tasks').delete().eq('id', id)
    if (error) { pushToast(error.message, 'error'); setConfirm(null); return }
    pushToast('Task deleted', 'info')
    setConfirm(null); reload()
  }, [reload])

  const hasFilters = !!(filterPriority || filterType)
  const clearFilters = () => { setFilterPriority(''); setFilterType('') }

  const handleEdit   = useCallback((task) => { setEditing(task); setDrawer(true) }, [])
  const handleDelete = useCallback((id)   => setConfirm(id), [])

  return (
    <div className="page-content">
      <div className="page-header">
        <div><div className="page-title">Tasks</div><div className="page-sub">{openCount} open · {tasks.length - openCount} completed</div></div>
        <button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Task</button>
      </div>

      {loadError && (
        <div style={{ margin:'0 0 12px', padding:'10px 16px', background:'var(--gw-red-light)', border:'1px solid var(--gw-red)', borderRadius:'var(--radius)', fontSize:13, color:'var(--gw-red)', display:'flex', alignItems:'center', gap:10 }}>
          <Icon name="alert" size={14} />
          <span>Failed to load tasks: {loadError}</span>
          <button className="btn btn--ghost btn--sm" style={{ marginLeft:'auto', color:'var(--gw-red)' }} onClick={reload}>Retry</button>
        </div>
      )}

      <div className="filters-bar">
        <select className="filter-select" value={filterPriority} onChange={e=>setFilterPriority(e.target.value)}><option value="">All Priorities</option>{['high','medium','low'].map(p=><option key={p} value={p}>{p.charAt(0).toUpperCase()+p.slice(1)}</option>)}</select>
        <select className="filter-select" value={filterType} onChange={e=>setFilterType(e.target.value)}><option value="">All Types</option>{['call','email','showing','follow-up','document','other'].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}</select>
        <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:13, cursor:'pointer', marginLeft:'auto' }}>
          <input type="checkbox" checked={showCompleted} onChange={e=>setShowCompleted(e.target.checked)} />
          Show completed
        </label>
        {hasFilters && (
          <button className="btn btn--ghost btn--sm" style={{ fontSize:12, color:'var(--gw-mist)' }} onClick={clearFilters}>Clear filters</button>
        )}
      </div>

      {tasks.length === 0 ? (
        <EmptyState icon="tasks" title="No tasks yet" message="Add tasks to track follow-ups, showings, and reminders." action={<button className="btn btn--primary" onClick={() => setDrawer(true)}><Icon name="plus" size={14} /> Add Task</button>} />
      ) : filtered.length === 0 ? (
        <EmptyState icon="tasks" title="No tasks match your filters" message="Try clearing your priority or type filter." action={<button className="btn btn--secondary" onClick={clearFilters}>Clear Filters</button>} />
      ) : (
        <>
          <TaskGroup label="Overdue"          items={overdue}        color="var(--gw-red)"   contactMap={contactMap} agentMap={agentMap} onToggle={toggle} onEdit={handleEdit} onDelete={handleDelete} />
          <TaskGroup label="Today"            items={todayTasks}     color="var(--gw-azure)" contactMap={contactMap} agentMap={agentMap} onToggle={toggle} onEdit={handleEdit} onDelete={handleDelete} />
          <TaskGroup label="This Week"        items={upcoming}                                contactMap={contactMap} agentMap={agentMap} onToggle={toggle} onEdit={handleEdit} onDelete={handleDelete} />
          <TaskGroup label="Upcoming & Other" items={other}                                   contactMap={contactMap} agentMap={agentMap} onToggle={toggle} onEdit={handleEdit} onDelete={handleDelete} />
          {showCompleted && <TaskGroup label="Completed" items={completedTasks} color="var(--gw-mist)" contactMap={contactMap} agentMap={agentMap} onToggle={toggle} onEdit={handleEdit} onDelete={handleDelete} />}
        </>
      )}

      <TaskDrawer open={drawer} onClose={() => setDrawer(false)} task={editing} agents={agents} contacts={contacts} deals={deals} onSave={reload} />
      {confirm && <ConfirmDialog message="Delete this task?" onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
    </div>
  )
}
