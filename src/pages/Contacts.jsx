import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatDate, formatPhone, contactFullName } from '../lib/helpers.js'
import { Icon, Badge, Avatar, Drawer, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'

function ActivityTimeline({ contact, deals, tasks, agents }) {
  const contactDeals = (deals || []).filter(d => d.contact_id === contact?.id)
  const contactTasks = (tasks || []).filter(t => t.contact_id === contact?.id)

  const entries = [
    ...contactDeals.map(d => ({ kind: 'deal', date: d.created_at, data: d })),
    ...contactTasks.map(t => ({ kind: 'task', date: t.due_date || t.created_at, data: t })),
    ...(contact?.created_at ? [{ kind: 'created', date: contact.created_at, data: contact }] : []),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))

  if (entries.length === 0) return (
    <div style={{ padding: '40px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>No activity yet</div>
      <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>Deals and tasks linked to this contact will appear here.</div>
    </div>
  )

  const STAGE_COLORS = { lead:'var(--gw-mist)', qualified:'var(--gw-azure)', showing:'var(--gw-azure)', offer:'var(--gw-amber)', 'under-contract':'var(--gw-purple)', closed:'var(--gw-green)', lost:'var(--gw-red)' }

  return (
    <div style={{ padding: '8px 0' }}>
      {entries.map((entry, i) => {
        const isLast = i === entries.length - 1
        if (entry.kind === 'deal') {
          const d = entry.data
          return (
            <div key={`deal-${d.id}`} style={{ display: 'flex', gap: 12, padding: '12px 24px', position: 'relative' }}>
              {!isLast && <div style={{ position: 'absolute', left: 35, top: 36, bottom: 0, width: 2, background: 'var(--gw-border)' }} />}
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--gw-sky)', border: '2px solid var(--gw-azure)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                <Icon name="pipeline" size={10} style={{ color: 'var(--gw-azure)' }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{d.title}</div>
                <div style={{ fontSize: 11, marginTop: 2, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: STAGE_COLORS[d.stage] || 'var(--gw-mist)', fontWeight: 600, textTransform: 'capitalize' }}>{d.stage.replace('-', ' ')}</span>
                  {d.value > 0 && <span style={{ color: 'var(--gw-mist)' }}>{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(d.value)}</span>}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--gw-mist)', whiteSpace: 'nowrap', marginTop: 2 }}>{new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
            </div>
          )
        }
        if (entry.kind === 'task') {
          const t = entry.data
          const overdue = !t.completed && t.due_date && new Date(t.due_date) < new Date()
          const typeIcon = t.type === 'call' ? 'phone' : t.type === 'email' ? 'mail' : t.type === 'showing' ? 'building' : 'tasks'
          return (
            <div key={`task-${t.id}`} style={{ display: 'flex', gap: 12, padding: '12px 24px', position: 'relative' }}>
              {!isLast && <div style={{ position: 'absolute', left: 35, top: 36, bottom: 0, width: 2, background: 'var(--gw-border)' }} />}
              <div style={{ width: 22, height: 22, borderRadius: '50%', background: t.completed ? 'var(--gw-green-light)' : 'var(--gw-bone)', border: `2px solid ${t.completed ? 'var(--gw-green)' : 'var(--gw-border)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
                <Icon name={t.completed ? 'check' : typeIcon} size={10} style={{ color: t.completed ? 'var(--gw-green)' : 'var(--gw-mist)' }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13, textDecoration: t.completed ? 'line-through' : 'none', color: t.completed ? 'var(--gw-mist)' : 'inherit' }}>{t.title}</div>
                <div style={{ fontSize: 11, marginTop: 2, color: overdue ? 'var(--gw-red)' : 'var(--gw-mist)', fontWeight: overdue ? 600 : 400 }}>
                  {t.completed ? 'Completed' : overdue ? 'Overdue' : t.priority + ' priority'} · {t.type}
                </div>
              </div>
              <div style={{ fontSize: 11, color: overdue ? 'var(--gw-red)' : 'var(--gw-mist)', whiteSpace: 'nowrap', marginTop: 2 }}>
                {t.due_date ? new Date(t.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
              </div>
            </div>
          )
        }
        // created
        return (
          <div key="created" style={{ display: 'flex', gap: 12, padding: '12px 24px' }}>
            <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--gw-gold-light)', border: '2px solid var(--gw-gold)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
              <Icon name="contacts" size={10} style={{ color: 'var(--gw-gold)' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Added to CRM</div>
              <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2 }}>Contact record created</div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', whiteSpace: 'nowrap', marginTop: 2 }}>{new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
          </div>
        )
      })}
    </div>
  )
}

function ContactDrawer({ open, onClose, contact, agents, deals, tasks, onSave }) {
  const blank = { first_name:'', last_name:'', email:'', phone:'', type:'buyer', status:'active', source:'other', assigned_agent_id:'', notes:'', tags:[] }
  const [form, setForm] = useState(contact || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState('details')

  React.useEffect(() => { setForm(contact || blank); setErrors({}); setTab('details') }, [contact, open])

  const set = (k, v) => setForm(p => ({...p, [k]: v}))

  const validate = () => {
    const e = {}
    if (!form.first_name.trim()) e.first_name = true
    if (!form.last_name.trim()) e.last_name = true
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const save = async () => {
    if (!validate()) return
    setSaving(true)
    const payload = { ...form, tags: typeof form.tags === 'string' ? form.tags.split(',').map(t=>t.trim()).filter(Boolean) : form.tags }
    let error
    if (contact?.id) {
      ({ error } = await supabase.from('contacts').update(payload).eq('id', contact.id))
    } else {
      ({ error } = await supabase.from('contacts').insert([payload]))
    }
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(contact?.id ? 'Contact updated' : 'Contact added')
    onSave(); onClose()
  }

  const contactDeals = (deals || []).filter(d => d.contact_id === contact?.id)
  const contactTasks = (tasks || []).filter(t => t.contact_id === contact?.id)
  const activityCount = contactDeals.length + contactTasks.length

  const tabBtn = (id, label, count) => (
    <button onClick={() => setTab(id)} style={{
      padding: '8px 16px', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600,
      background: tab === id ? '#fff' : 'transparent',
      color: tab === id ? 'var(--gw-slate)' : 'var(--gw-mist)',
      borderBottom: tab === id ? '2px solid var(--gw-slate)' : '2px solid transparent',
      transition: 'all 150ms',
    }}>
      {label}{count > 0 && tab !== id ? <span style={{ marginLeft: 5, background: 'var(--gw-azure)', color: '#fff', borderRadius: 10, fontSize: 10, padding: '1px 6px', fontWeight: 700 }}>{count}</span> : ''}
    </button>
  )

  return (
    <Drawer open={open} onClose={onClose} title={contact?.id ? `${contact.first_name} ${contact.last_name}` : 'Add Contact'} width={500}>
      {contact?.id && (
        <div style={{ display: 'flex', borderBottom: '1px solid var(--gw-border)', background: 'var(--gw-bone)', paddingLeft: 8 }}>
          {tabBtn('details', 'Details')}
          {tabBtn('activity', 'Activity', activityCount)}
        </div>
      )}

      {tab === 'details' && (
        <>
          <div className="drawer__body">
            <div className="form-row">
              <div className="form-group">
                <label className="form-label required">First Name</label>
                <input className={`form-control${errors.first_name?' error':''}`} value={form.first_name} onChange={e=>set('first_name',e.target.value)} placeholder="Jane" />
              </div>
              <div className="form-group">
                <label className="form-label required">Last Name</label>
                <input className={`form-control${errors.last_name?' error':''}`} value={form.last_name} onChange={e=>set('last_name',e.target.value)} placeholder="Smith" />
              </div>
            </div>
            <div className="form-group"><label className="form-label">Email</label><input className="form-control" type="email" value={form.email||''} onChange={e=>set('email',e.target.value)} placeholder="jane@email.com" /></div>
            <div className="form-group"><label className="form-label">Phone</label><input className="form-control" value={form.phone||''} onChange={e=>set('phone',e.target.value)} placeholder="(555) 000-0000" /></div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Type</label>
                <select className="form-control" value={form.type} onChange={e=>set('type',e.target.value)}>
                  {['buyer','seller','landlord','tenant','investor'].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Status</label>
                <select className="form-control" value={form.status} onChange={e=>set('status',e.target.value)}>
                  {['active','cold','closed'].map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Source</label>
                <select className="form-control" value={form.source||'other'} onChange={e=>set('source',e.target.value)}>
                  {['referral','website','open house','social','other'].map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Assigned Agent</label>
                <select className="form-control" value={form.assigned_agent_id||''} onChange={e=>set('assigned_agent_id',e.target.value)}>
                  <option value="">Unassigned</option>
                  {agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
            </div>
            <div className="form-group"><label className="form-label">Tags</label><input className="form-control" value={Array.isArray(form.tags)?form.tags.join(', '):(form.tags||'')} onChange={e=>set('tags',e.target.value)} placeholder="vip, referral, hot-lead" /><div className="form-hint">Comma separated</div></div>
            <div className="form-group"><label className="form-label">Notes</label><textarea className="form-control form-control--textarea" value={form.notes||''} onChange={e=>set('notes',e.target.value)} placeholder="Add notes…" /></div>
          </div>
          <div className="drawer__foot">
            <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Contact'}</button>
          </div>
        </>
      )}

      {tab === 'activity' && (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <ActivityTimeline contact={contact} deals={deals} tasks={tasks} agents={agents} />
        </div>
      )}
    </Drawer>
  )
}

export default function ContactsPage({ db, setDb, activeAgent, go, openCompose }) {
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterAgent, setFilterAgent] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [sortKey, setSortKey] = useState('created_at')
  const [sortDir, setSortDir] = useState('desc')

  const contacts = db.contacts || []
  const agents = db.agents || []

  const filtered = contacts.filter(c => {
    const name = `${c.first_name} ${c.last_name}`.toLowerCase()
    const q = search.toLowerCase()
    if (q && !name.includes(q) && !(c.email||'').toLowerCase().includes(q) && !(c.phone||'').includes(q)) return false
    if (filterType && c.type !== filterType) return false
    if (filterStatus && c.status !== filterStatus) return false
    if (filterAgent && c.assigned_agent_id !== filterAgent) return false
    return true
  }).sort((a, b) => {
    let av = a[sortKey]||'', bv = b[sortKey]||''
    return sortDir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
  })

  const reload = async () => {
    const { data } = await supabase.from('contacts').select('*').order('created_at', { ascending: false })
    setDb(p => ({ ...p, contacts: data || [] }))
  }

  const deleteContact = async (id) => {
    await supabase.from('contacts').delete().eq('id', id)
    pushToast('Contact deleted', 'info')
    setConfirm(null)
    reload()
  }

  const sort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const SortIcon = ({ k }) => sortKey === k ? <Icon name={sortDir === 'asc' ? 'chevronRight' : 'chevronDown'} size={12} /> : null

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Contacts</div>
          <div className="page-sub">{contacts.length} total contacts</div>
        </div>
        <button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Contact</button>
      </div>

      <div className="filters-bar">
        <div style={{ display:'flex', alignItems:'center', gap:8, background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'0 10px', height:34, flex:1, maxWidth:300 }}>
          <Icon name="search" size={14} style={{ color:'var(--gw-mist)' }} />
          <input style={{ border:'none', outline:'none', fontSize:13, flex:1 }} placeholder="Search contacts…" value={search} onChange={e=>setSearch(e.target.value)} />
        </div>
        <select className="filter-select" value={filterType} onChange={e=>setFilterType(e.target.value)}>
          <option value="">All Types</option>
          {['buyer','seller','landlord','tenant','investor'].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
        </select>
        <select className="filter-select" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}>
          <option value="">All Statuses</option>
          {['active','cold','closed'].map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1)}</option>)}
        </select>
        <select className="filter-select" value={filterAgent} onChange={e=>setFilterAgent(e.target.value)}>
          <option value="">All Agents</option>
          {agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="contacts" title="No contacts yet" message="Add your first contact to get started with your CRM."
          action={<button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Contact</button>} />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => sort('first_name')}>Name <SortIcon k="first_name" /></th>
                <th>Type</th>
                <th>Status</th>
                <th className="sortable" onClick={() => sort('phone')}>Phone <SortIcon k="phone" /></th>
                <th className="sortable" onClick={() => sort('email')}>Email <SortIcon k="email" /></th>
                <th>Agent</th>
                <th className="sortable" onClick={() => sort('last_contacted_at')}>Last Contact <SortIcon k="last_contacted_at" /></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const agent = agents.find(a => a.id === c.assigned_agent_id)
                return (
                  <tr key={c.id} onClick={() => { setEditing(c); setDrawer(true) }}>
                    <td>
                      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                        <div style={{ width:30, height:30, borderRadius:'var(--radius)', background:'var(--gw-sky)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, color:'var(--gw-azure)', flexShrink:0 }}>
                          {(c.first_name||'')[0]}{(c.last_name||'')[0]}
                        </div>
                        <div>
                          <div style={{ fontWeight:600 }}>{c.first_name} {c.last_name}</div>
                          {c.tags?.length > 0 && <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{c.tags.slice(0,2).join(', ')}</div>}
                        </div>
                      </div>
                    </td>
                    <td><Badge variant={c.type}>{c.type}</Badge></td>
                    <td><Badge variant={c.status}>{c.status}</Badge></td>
                    <td style={{ fontFamily:'var(--font-mono)', fontSize:12 }}>{formatPhone(c.phone)}</td>
                    <td style={{ fontSize:12 }}>{c.email || '—'}</td>
                    <td>{agent ? <div style={{ display:'flex', alignItems:'center', gap:6 }}><Avatar agent={agent} size={24} /><span style={{ fontSize:12 }}>{agent.name}</span></div> : '—'}</td>
                    <td style={{ fontSize:12, color:'var(--gw-mist)' }}>{formatDate(c.last_contacted_at)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div style={{ display:'flex', gap:4 }}>
                        <button className="btn btn--ghost btn--icon" title="Email" onClick={() => openCompose({ to: c.email, contactName: `${c.first_name} ${c.last_name}` })}><Icon name="mail" size={13} /></button>
                        <button className="btn btn--ghost btn--icon" title="Edit" onClick={() => { setEditing(c); setDrawer(true) }}><Icon name="edit" size={13} /></button>
                        <button className="btn btn--ghost btn--icon" title="Delete" onClick={() => setConfirm(c.id)}><Icon name="trash" size={13} /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <ContactDrawer open={drawer} onClose={() => setDrawer(false)} contact={editing} agents={agents} deals={db.deals||[]} tasks={db.tasks||[]} onSave={reload} />
      {confirm && <ConfirmDialog message="This will permanently delete this contact." onConfirm={() => deleteContact(confirm)} onCancel={() => setConfirm(null)} />}
    </div>
  )
}
