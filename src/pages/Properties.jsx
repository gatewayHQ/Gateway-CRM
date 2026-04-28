import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatCurrency } from '../lib/helpers.js'
import { Icon, Badge, Avatar, Drawer, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'

// Types where commercial fields apply
const COMMERCIAL_TYPES = ['multifamily','office','land','retail','industrial','mixed-use']
const isCommercial = (t) => COMMERCIAL_TYPES.includes(t)

const TYPE_LABELS = {
  residential: 'Residential',
  multifamily: 'Multifamily',
  office: 'Office',
  land: 'Land',
  retail: 'Retail',
  industrial: 'Industrial',
  'mixed-use': 'Mixed-Use',
  rental: 'Rental (Residential)',
}

// Returns a badge-friendly category label
const typeCategory = (t) => isCommercial(t) ? 'commercial' : 'residential'

function ResidentialFields({ form, set }) {
  return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Beds</label>
          <input className="form-control" type="number" value={form.beds||''} onChange={e=>set('beds',e.target.value)} placeholder="3" />
        </div>
        <div className="form-group">
          <label className="form-label">Baths</label>
          <input className="form-control" type="number" step="0.5" value={form.baths||''} onChange={e=>set('baths',e.target.value)} placeholder="2" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Sq Ft</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} placeholder="1,800" />
        </div>
        <div className="form-group">
          <label className="form-label">Garage</label>
          <select className="form-control" value={form.garage??0} onChange={e=>set('garage',Number(e.target.value))}>
            <option value={0}>No Garage</option>
            <option value={1}>1 Car</option>
            <option value={2}>2 Car</option>
            <option value={3}>3 Car</option>
            <option value={4}>4+ Car</option>
          </select>
        </div>
      </div>
    </>
  )
}

function CommercialFields({ form, set }) {
  const d = form.details || {}
  const sd = (k, v) => set('details', { ...d, [k]: v })

  if (form.type === 'multifamily') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Total Units</label>
          <input className="form-control" type="number" value={d.total_units||''} onChange={e=>sd('total_units',e.target.value)} placeholder="24" />
        </div>
        <div className="form-group">
          <label className="form-label">Year Built</label>
          <input className="form-control" type="number" value={d.year_built||''} onChange={e=>sd('year_built',e.target.value)} placeholder="1998" />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Unit Mix</label>
        <input className="form-control" value={d.unit_mix||''} onChange={e=>sd('unit_mix',e.target.value)} placeholder="e.g. 10×Studio, 8×1BR, 6×2BR" />
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Sq Ft (total)</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} placeholder="18,000" />
        </div>
        <div className="form-group">
          <label className="form-label">Parking Spaces</label>
          <input className="form-control" type="number" value={d.parking||''} onChange={e=>sd('parking',e.target.value)} />
        </div>
      </div>
    </>
  )

  if (form.type === 'office') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Sq Ft</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} placeholder="10,000" />
        </div>
        <div className="form-group">
          <label className="form-label">Floors</label>
          <input className="form-control" type="number" value={d.floors||''} onChange={e=>sd('floors',e.target.value)} placeholder="4" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Parking Spaces</label>
          <input className="form-control" type="number" value={d.parking||''} onChange={e=>sd('parking',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Year Built</label>
          <input className="form-control" type="number" value={d.year_built||''} onChange={e=>sd('year_built',e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Class</label>
          <select className="form-control" value={d.class||''} onChange={e=>sd('class',e.target.value)}>
            <option value="">—</option>
            <option value="A">Class A</option>
            <option value="B">Class B</option>
            <option value="C">Class C</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Vacancy Rate %</label>
          <input className="form-control" type="number" min="0" max="100" value={d.vacancy||''} onChange={e=>sd('vacancy',e.target.value)} />
        </div>
      </div>
    </>
  )

  if (form.type === 'land') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Acres</label>
          <input className="form-control" type="number" step="0.01" value={d.acres||''} onChange={e=>sd('acres',e.target.value)} placeholder="2.5" />
        </div>
        <div className="form-group">
          <label className="form-label">Sq Ft</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Status</label>
          <select className="form-control" value={d.land_status||''} onChange={e=>sd('land_status',e.target.value)}>
            <option value="">—</option>
            <option value="raw">Raw Land</option>
            <option value="developed">Developed</option>
            <option value="ready">Ready to Build</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Zoning</label>
          <input className="form-control" value={d.zoning||''} onChange={e=>sd('zoning',e.target.value)} placeholder="R-1, C-2, etc." />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Utilities Available</label>
        <input className="form-control" value={d.utilities||''} onChange={e=>sd('utilities',e.target.value)} placeholder="Water, Sewer, Electric, Gas" />
      </div>
    </>
  )

  if (form.type === 'retail') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Sq Ft</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} placeholder="5,000" />
        </div>
        <div className="form-group">
          <label className="form-label">Frontage (ft)</label>
          <input className="form-control" type="number" value={d.frontage||''} onChange={e=>sd('frontage',e.target.value)} placeholder="40" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Parking Spaces</label>
          <input className="form-control" type="number" value={d.parking||''} onChange={e=>sd('parking',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Year Built</label>
          <input className="form-control" type="number" value={d.year_built||''} onChange={e=>sd('year_built',e.target.value)} />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Anchor Tenants</label>
        <input className="form-control" value={d.anchor_tenants||''} onChange={e=>sd('anchor_tenants',e.target.value)} placeholder="Starbucks, Chase Bank…" />
      </div>
    </>
  )

  if (form.type === 'industrial') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Sq Ft</label>
          <input className="form-control" type="number" value={form.sqft||''} onChange={e=>set('sqft',e.target.value)} placeholder="50,000" />
        </div>
        <div className="form-group">
          <label className="form-label">Clear Height (ft)</label>
          <input className="form-control" type="number" value={d.clear_height||''} onChange={e=>sd('clear_height',e.target.value)} placeholder="28" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Loading Docks</label>
          <input className="form-control" type="number" value={d.loading_docks||''} onChange={e=>sd('loading_docks',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Drive-In Doors</label>
          <input className="form-control" type="number" value={d.drive_in_doors||''} onChange={e=>sd('drive_in_doors',e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Office Sq Ft</label>
          <input className="form-control" type="number" value={d.office_sqft||''} onChange={e=>sd('office_sqft',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Year Built</label>
          <input className="form-control" type="number" value={d.year_built||''} onChange={e=>sd('year_built',e.target.value)} />
        </div>
      </div>
    </>
  )

  if (form.type === 'mixed-use') return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Total Units</label>
          <input className="form-control" type="number" value={d.total_units||''} onChange={e=>sd('total_units',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Floors</label>
          <input className="form-control" type="number" value={d.floors||''} onChange={e=>sd('floors',e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Residential Sq Ft</label>
          <input className="form-control" type="number" value={d.res_sqft||''} onChange={e=>sd('res_sqft',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Commercial Sq Ft</label>
          <input className="form-control" type="number" value={d.comm_sqft||''} onChange={e=>sd('comm_sqft',e.target.value)} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Year Built</label>
          <input className="form-control" type="number" value={d.year_built||''} onChange={e=>sd('year_built',e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Parking Spaces</label>
          <input className="form-control" type="number" value={d.parking||''} onChange={e=>sd('parking',e.target.value)} />
        </div>
      </div>
    </>
  )

  return null
}

function PropertyDrawer({ open, onClose, property, agents, contacts, onSave }) {
  const blank = { address:'', city:'', state:'', zip:'', type:'residential', status:'active', list_price:'', sqft:'', beds:'', baths:'', garage:0, mls_number:'', linked_contact_id:'', assigned_agent_id:'', notes:'', details:{} }
  const [form, setForm]     = useState(property || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  React.useEffect(() => {
    setForm(property ? { ...blank, ...property, details: property.details || {} } : blank)
    setErrors({})
  }, [property, open])

  const set = (k, v) => setForm(p => ({...p, [k]: v}))

  const save = async () => {
    const e = {}
    if (!form.address.trim()) e.address = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    const payload = {
      ...form,
      list_price: form.list_price ? Number(form.list_price) : null,
      sqft:       form.sqft  ? Number(form.sqft)  : null,
      beds:       form.beds  ? Number(form.beds)  : null,
      baths:      form.baths ? Number(form.baths) : null,
      garage:     form.garage != null ? Number(form.garage) : 0,
    }
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

  const commercial = isCommercial(form.type)

  return (
    <Drawer open={open} onClose={onClose} title={property?.id ? 'Edit Property' : 'Add Property'} width={520}>
      <div className="drawer__body">
        {/* Address */}
        <div className="form-group"><label className="form-label required">Address</label><input className={`form-control${errors.address?' error':''}`} value={form.address} onChange={e=>set('address',e.target.value)} placeholder="123 Main Street" /></div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">City</label><input className="form-control" value={form.city||''} onChange={e=>set('city',e.target.value)} /></div>
          <div className="form-group"><label className="form-label">State</label><input className="form-control" value={form.state||''} onChange={e=>set('state',e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">ZIP</label><input className="form-control" value={form.zip||''} onChange={e=>set('zip',e.target.value)} /></div>
          <div className="form-group"><label className="form-label">MLS #</label><input className="form-control" value={form.mls_number||''} onChange={e=>set('mls_number',e.target.value)} /></div>
        </div>

        {/* Type + Status */}
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Property Type</label>
            <select className="form-control" value={form.type} onChange={e=>set('type',e.target.value)}>
              <optgroup label="Residential">
                <option value="residential">Residential</option>
                <option value="rental">Rental (Residential)</option>
              </optgroup>
              <optgroup label="Commercial">
                <option value="multifamily">Multifamily</option>
                <option value="office">Office</option>
                <option value="land">Land</option>
                <option value="retail">Retail</option>
                <option value="industrial">Industrial</option>
                <option value="mixed-use">Mixed-Use</option>
              </optgroup>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Status</label>
            <select className="form-control" value={form.status} onChange={e=>set('status',e.target.value)}>
              {['active','pending','sold','off-market','leased'].map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1).replace('-',' ')}</option>)}
            </select>
          </div>
        </div>

        {/* Price */}
        <div className="form-group">
          <label className="form-label">{commercial ? 'Asking Price / Value' : 'List Price'}</label>
          <input className="form-control" type="number" value={form.list_price||''} onChange={e=>set('list_price',e.target.value)} placeholder="0" />
        </div>

        {/* Dynamic fields based on type */}
        {!commercial
          ? <ResidentialFields form={form} set={set} />
          : <CommercialFields form={form} set={set} />
        }

        {/* Always-present fields */}
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

function PropertySpecs({ p }) {
  const d = p.details || {}
  if (p.type === 'multifamily') return <>{d.total_units && <span>{d.total_units} units</span>}{d.unit_mix && <span> · {d.unit_mix}</span>}</>
  if (p.type === 'office')      return <>{p.sqft && <span>{p.sqft?.toLocaleString()} sqft</span>}{d.class && <span> · Class {d.class}</span>}{d.floors && <span> · {d.floors} fl</span>}</>
  if (p.type === 'land')        return <>{d.acres && <span>{d.acres} ac</span>}{d.land_status && <span> · {d.land_status}</span>}</>
  if (p.type === 'retail')      return <>{p.sqft && <span>{p.sqft?.toLocaleString()} sqft</span>}{d.frontage && <span> · {d.frontage}ft frontage</span>}</>
  if (p.type === 'industrial')  return <>{p.sqft && <span>{p.sqft?.toLocaleString()} sqft</span>}{d.clear_height && <span> · {d.clear_height}ft clear</span>}</>
  if (p.type === 'mixed-use')   return <>{d.total_units && <span>{d.total_units} units</span>}{d.floors && <span> · {d.floors} fl</span>}</>
  // residential / rental
  return <>{p.beds && <span>{p.beds} bd</span>}{p.baths && <span> · {p.baths} ba</span>}{p.sqft && <span> · {p.sqft?.toLocaleString()} sqft</span>}{p.garage > 0 && <span> · {p.garage}-car garage</span>}</>
}

export default function PropertiesPage({ db, setDb, activeAgent }) {
  const [view, setView]           = useState('grid')
  const [search, setSearch]       = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [drawer, setDrawer]       = useState(false)
  const [editing, setEditing]     = useState(null)
  const [confirm, setConfirm]     = useState(null)

  const properties = db.properties || []
  const agents     = db.agents     || []
  const contacts   = db.contacts   || []

  const filtered = properties.filter(p => {
    const q = search.toLowerCase()
    if (q && !(p.address||'').toLowerCase().includes(q) && !(p.city||'').toLowerCase().includes(q) && !(p.mls_number||'').toLowerCase().includes(q)) return false
    if (filterType   && p.type   !== filterType)   return false
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
        <select className="filter-select" value={filterType} onChange={e=>setFilterType(e.target.value)}>
          <option value="">All Types</option>
          <optgroup label="Residential"><option value="residential">Residential</option><option value="rental">Rental</option></optgroup>
          <optgroup label="Commercial">{COMMERCIAL_TYPES.map(t=><option key={t} value={t}>{TYPE_LABELS[t]}</option>)}</optgroup>
        </select>
        <select className="filter-select" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}>
          <option value="">All Statuses</option>
          {['active','pending','sold','off-market','leased'].map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1).replace('-',' ')}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="building" title="No properties yet" message="Add your first property listing to get started."
          action={<button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Property</button>} />
      ) : view === 'grid' ? (
        <div className="property-grid">
          {filtered.map(p => {
            const agent = agents.find(a => a.id === p.assigned_agent_id)
            return (
              <div key={p.id} className="property-card" onClick={() => { setEditing(p); setDrawer(true) }}>
                <div className="property-card__head">
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                    <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color: isCommercial(p.type) ? 'var(--gw-purple)' : 'var(--gw-azure)', background: isCommercial(p.type) ? '#f0ebff' : 'var(--gw-sky)', padding:'2px 7px', borderRadius:10 }}>
                      {TYPE_LABELS[p.type] || p.type}
                    </div>
                    <Badge variant={p.status}>{p.status}</Badge>
                  </div>
                  <div className="property-card__address">{p.address}</div>
                  <div className="property-card__city">{[p.city, p.state, p.zip].filter(Boolean).join(', ')}</div>
                </div>
                <div className="property-card__body">
                  <div className="property-card__price">{formatCurrency(p.list_price)}</div>
                  <div className="property-card__specs" style={{ fontSize:11, color:'var(--gw-mist)', display:'flex', gap:4, flexWrap:'wrap' }}>
                    <PropertySpecs p={p} />
                  </div>
                  <div className="property-card__foot">
                    {agent ? <Avatar agent={agent} size={24} /> : null}
                    <div onClick={e=>{e.stopPropagation(); setConfirm(p.id)}} style={{ cursor:'pointer', color:'var(--gw-mist)', marginLeft:'auto' }}><Icon name="trash" size={13} /></div>
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
              <thead><tr><th>Address</th><th>Type</th><th>Status</th><th>Price</th><th>Details</th><th>MLS #</th><th>Agent</th><th></th></tr></thead>
              <tbody>
                {filtered.map(p => {
                  const agent = agents.find(a => a.id === p.assigned_agent_id)
                  return (
                    <tr key={p.id} onClick={() => { setEditing(p); setDrawer(true) }}>
                      <td><div style={{ fontWeight:600 }}>{p.address}</div><div style={{ fontSize:11, color:'var(--gw-mist)' }}>{[p.city,p.state].filter(Boolean).join(', ')}</div></td>
                      <td><span style={{ fontSize:11, fontWeight:700, textTransform:'capitalize', padding:'2px 7px', borderRadius:10, background: isCommercial(p.type)?'#f0ebff':'var(--gw-sky)', color: isCommercial(p.type)?'var(--gw-purple)':'var(--gw-azure)' }}>{TYPE_LABELS[p.type]||p.type}</span></td>
                      <td><Badge variant={p.status}>{p.status}</Badge></td>
                      <td style={{ fontWeight:600 }}>{formatCurrency(p.list_price)}</td>
                      <td style={{ fontSize:12, color:'var(--gw-mist)' }}><PropertySpecs p={p} /></td>
                      <td style={{ fontFamily:'var(--font-mono)', fontSize:12 }}>{p.mls_number||'—'}</td>
                      <td>{agent ? <div style={{ display:'flex', alignItems:'center', gap:6 }}><Avatar agent={agent} size={24} /><span style={{ fontSize:12 }}>{agent.name}</span></div> : '—'}</td>
                      <td onClick={e=>e.stopPropagation()}><div style={{ display:'flex', gap:4 }}><button className="btn btn--ghost btn--icon" onClick={()=>{setEditing(p);setDrawer(true)}}><Icon name="edit" size={13}/></button><button className="btn btn--ghost btn--icon" onClick={()=>setConfirm(p.id)}><Icon name="trash" size={13}/></button></div></td>
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
