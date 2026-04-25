import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatCurrency, formatDate } from '../lib/helpers.js'
import { Icon, Badge, Avatar, Drawer, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'

function PropertyDrawer({ open, onClose, property, agents, contacts, onSave }) {
  const blank = { address:'', city:'', state:'', zip:'', type:'residential', status:'active', list_price:'', sqft:'', beds:'', baths:'', mls_number:'', linked_contact_id:'', assigned_agent_id:'', notes:'' }
  const [form, setForm] = useState(property || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  React.useEffect(() => { setForm(property || blank); setErrors({}) }, [property, open])
  const set = (k, v) => setForm(p => ({...p, [k]: v}))

  const save = async () => {
    const e = {}
    if (!form.address.trim()) e.address = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    const payload = { ...form, list_price: form.list_price ? Number(form.list_price) : null, sqft: form.sqft ? Number(form.sqft) : null, beds: form.beds ? Number(form.beds) : null, baths: form.baths ? Number(form.baths) : null }
    let error
    if (property?.id) {
      ({ error } = await supabase.from('properties').update(payload).eq('id', property.id))
    } else {
      ({ error } = await supabase.from('properties').insert([payload]))
    }
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(property?.id ? 'Property updated' : 'Property added')
    onSave(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title={property?.id ? 'Edit Property' : 'Add Property'}>
      <div className="drawer__body">
        <div className="form-group"><label className="form-label required">Address</label><input className={`form-control${errors.address?' error':''}`} value={form.address} onChange={e=>set('address',e.target.value)} placeholder="123 Main Street" /></div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">City</label><input className="form-control" value={form.city||''} onChange={e=>set('city',e.target.value)} /></div>
          <div className="form-group"><label className="form-label">State</label><input className="form-control" value={form.state||''} onChange={e=>set('state',e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">ZIP</label><input className="form-control" value={form.zip||''} onChange={e=>set('zip',e.target.value)} /></div>
          <div className="form-group"><label className="form-label">MLS #</label><input className="form-control" value={form.mls_number||''} onChange={e=>set('mls_number',e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Type</label><select className="form-control" value={form.type} onChange={e=>set('type',e.target.value)}>{['residential','commercial','rental','land'].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}</select></div>
          <div className="form-group"><label className="form-label">Status</label><select className="form-control" value={form.status} onChange={e=>set('status',e.target.value)}>{['active','pending','sold','off-market'].map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1).replace('-',' ')}</option>)}</select></div>
        </div>
        <div className="form-group"><label className="form-label">List Price</label><input className="form-control" type="number" value={form.list_price||''} onChange={e=>set('list_price',e.target.value)} placeholder="0" /></div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Beds</label><input className="form-control" type="number" value={form.beds||''} onChange={e=>set('beds',e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Baths</label><input className="form-control" type="number" step="0.5" value={form.baths||''} onChange={e=>set('baths',e.target.value)} /></div>
        </div>
        <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} /></div>
        <div className="form-group"><label className="form-label">Linked Contact</label><SearchDropdown items={contacts} value={form.linked_contact_id} onSelect={v=>set('linked_contact_id',v)} placeholder="Search contacts…" labelKey={c=>`${c.first_name} ${c.last_name}`} /></div>
        <div className="form-group"><label className="form-label">Assigned Agent</label><select className="form-control" value={form.assigned_agent_id||''} onChange={e=>set('assigned_agent_id',e.target.value)}><option value="">Unassigned</option>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
        <div className="form-group"><label className="form-label">Notes</label><textarea className="form-control form-control--textarea" value={form.notes||''} onChange={e=>set('notes',e.target.value)} /></div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Property'}</button>
      </div>
    </Drawer>
  )
}

export default function PropertiesPage({ db, setDb, activeAgent }) {
  const [view, setView] = useState('grid')
  const [search, setSearch] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirm, setConfirm] = useState(null)

  const properties = db.properties || []
  const agents = db.agents || []
  const contacts = db.contacts || []

  const filtered = properties.filter(p => {
    const q = search.toLowerCase()
    if (q && !(p.address||'').toLowerCase().includes(q) && !(p.city||'').toLowerCase().includes(q) && !(p.mls_number||'').toLowerCase().includes(q)) return false
    if (filterType && p.type !== filterType) return false
    if (filterStatus && p.status !== filterStatus) return false
    return true
  })

  const reload = async () => {
    const { data } = await supabase.from('properties').select('*').order('created_at', { ascending: false })
    setDb(p => ({ ...p, properties: data || [] }))
  }

  const del = async (id) => {
    await supabase.from('properties').delete().eq('id', id)
    pushToast('Property deleted', 'info')
    setConfirm(null); reload()
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div><div className="page-title">Properties</div><div className="page-sub">{properties.length} listings</div></div>
        <div style={{ display:'flex', gap:8 }}>
          <div style={{ display:'flex', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
            {['grid','list'].map(v => <button key={v} className={`btn btn--${view===v?'primary':'secondary'}`} style={{ borderRadius:0, border:'none' }} onClick={() => setView(v)}><Icon name={v==='grid'?'dashboard':'pipeline'} size={14} /></button>)}
          </div>
          <button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Property</button>
        </div>
      </div>

      <div className="filters-bar">
        <div style={{ display:'flex', alignItems:'center', gap:8, background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'0 10px', height:34, flex:1, maxWidth:300 }}>
          <Icon name="search" size={14} style={{ color:'var(--gw-mist)' }} />
          <input style={{ border:'none', outline:'none', fontSize:13, flex:1 }} placeholder="Search properties…" value={search} onChange={e=>setSearch(e.target.value)} />
        </div>
        <select className="filter-select" value={filterType} onChange={e=>setFilterType(e.target.value)}><option value="">All Types</option>{['residential','commercial','rental','land'].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}</select>
        <select className="filter-select" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}><option value="">All Statuses</option>{['active','pending','sold','off-market'].map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1).replace('-',' ')}</option>)}</select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="building" title="No properties yet" message="Add your first property listing to get started." action={<button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Property</button>} />
      ) : view === 'grid' ? (
        <div className="property-grid">
          {filtered.map(p => {
            const agent = agents.find(a => a.id === p.assigned_agent_id)
            return (
              <div key={p.id} className="property-card" onClick={() => { setEditing(p); setDrawer(true) }}>
                <div className="property-card__head">
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                    <div className="property-card__type-icon"><Icon name="building" size={18} /></div>
                    <Badge variant={p.status}>{p.status}</Badge>
                  </div>
                  <div className="property-card__address">{p.address}</div>
                  <div className="property-card__city">{[p.city, p.state, p.zip].filter(Boolean).join(', ')}</div>
                </div>
                <div className="property-card__body">
                  <div className="property-card__price">{formatCurrency(p.list_price)}</div>
                  <div className="property-card__specs">
                    {p.beds && <span className="property-card__spec"><Icon name="home" size={12} />{p.beds} bd</span>}
                    {p.baths && <span className="property-card__spec">·{p.baths} ba</span>}
                    {p.sqft && <span className="property-card__spec">·{p.sqft?.toLocaleString()} sqft</span>}
                  </div>
                  <div className="property-card__foot">
                    <Badge variant={p.type}>{p.type}</Badge>
                    {agent ? <Avatar agent={agent} size={24} /> : null}
                    <div onClick={e=>{e.stopPropagation(); setConfirm(p.id)}} style={{ cursor:'pointer', color:'var(--gw-mist)' }}><Icon name="trash" size={13} /></div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="card" style={{ padding:0, overflow:'hidden' }}>
          <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Address</th><th>Type</th><th>Status</th><th>Price</th><th>Beds/Baths</th><th>Sq Ft</th><th>MLS #</th><th>Agent</th><th></th></tr></thead>
            <tbody>
              {filtered.map(p => {
                const agent = agents.find(a => a.id === p.assigned_agent_id)
                return (
                  <tr key={p.id} onClick={() => { setEditing(p); setDrawer(true) }}>
                    <td><div style={{ fontWeight:600 }}>{p.address}</div><div style={{ fontSize:11, color:'var(--gw-mist)' }}>{[p.city,p.state].filter(Boolean).join(', ')}</div></td>
                    <td><Badge variant={p.type}>{p.type}</Badge></td>
                    <td><Badge variant={p.status}>{p.status}</Badge></td>
                    <td style={{ fontWeight:600 }}>{formatCurrency(p.list_price)}</td>
                    <td style={{ fontSize:12 }}>{p.beds||'—'} / {p.baths||'—'}</td>
                    <td style={{ fontSize:12 }}>{p.sqft ? p.sqft.toLocaleString() : '—'}</td>
                    <td style={{ fontFamily:'var(--font-mono)', fontSize:12 }}>{p.mls_number||'—'}</td>
                    <td>{agent ? <div style={{ display:'flex', alignItems:'center', gap:6 }}><Avatar agent={agent} size={24} /><span style={{ fontSize:12 }}>{agent.name}</span></div> : '—'}</td>
                    <td onClick={e=>e.stopPropagation()}><div style={{ display:'flex', gap:4 }}><button className="btn btn--ghost btn--icon" onClick={() => { setEditing(p); setDrawer(true) }}><Icon name="edit" size={13} /></button><button className="btn btn--ghost btn--icon" onClick={() => setConfirm(p.id)}><Icon name="trash" size={13} /></button></div></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <PropertyDrawer open={drawer} onClose={() => setDrawer(false)} property={editing} agents={agents} contacts={contacts} onSave={reload} />
      {confirm && <ConfirmDialog message="This will permanently delete this property." onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
    </div>
  )
}
