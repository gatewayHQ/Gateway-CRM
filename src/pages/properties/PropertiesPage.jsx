// Properties — the listings database: filters, cards, and the property drawer.

import React, { useState } from 'react'
import { formatCurrency } from '../../lib/helpers.js'
import { Icon, Badge, Avatar, EmptyState, ConfirmDialog, pushToast } from '../../components/UI.jsx'
import { loadVisibleProperties, deleteProperty } from '../../lib/services/properties.js'
import { PROPERTY_STATUSES } from '../../lib/enums.js'
import { streetLine } from '../../lib/address.js'
import { COMMERCIAL_TYPES, TYPE_LABELS, isCommercial } from './propertyTypes.js'
import { PropertyDrawer } from './PropertyDrawer.jsx'
import { RadiusMailingModal } from './RadiusMailingModal.jsx'

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

// ─── Properties page ──────────────────────────────────────────────────────────

export default function PropertiesPage({ db, setDb, activeAgent, go, propertyAgentIds, isAdmin, focusRecord, onFocusHandled, announce }) {
  const [view, setView]               = useState('grid')
  const [search, setSearch]           = useState('')
  const [filterType, setFilterType]   = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterCounty, setFilterCounty] = useState('')
  const [drawer, setDrawer]           = useState(false)
  const [editing, setEditing]         = useState(null)

  // Same contract as ContactsPage — see the comment there.
  React.useEffect(() => {
    if (focusRecord?.type === 'new-property') { setEditing(null); setDrawer(true); onFocusHandled?.(); return }
    if (focusRecord?.type !== 'property') return
    const hit = (db.properties || []).find(x => x.id === focusRecord.id)
    if (hit) { setEditing(hit); setDrawer(true) }
    onFocusHandled?.()
  }, [focusRecord, db.properties])
  const [confirm, setConfirm]         = useState(null)
  const [radiusProp, setRadiusProp]   = useState(null)

  const properties     = db.properties     || []
  const agents         = db.agents         || []
  const contacts       = db.contacts       || []
  const propertyContacts = db.propertyContacts || []   // additional-contact links (migration 0021)

  const counties = [...new Set(properties.map(p => p.county).filter(Boolean))].sort()

  const filtered = properties.filter(p => {
    const q = search.toLowerCase()
    if (q && !streetLine(p).toLowerCase().includes(q) && !(p.city||'').toLowerCase().includes(q) && !(p.county||'').toLowerCase().includes(q) && !(p.mls_number||'').toLowerCase().includes(q)) return false
    if (filterType   && p.type   !== filterType)   return false
    if (filterStatus && p.status !== filterStatus) return false
    if (filterCounty && p.county !== filterCounty) return false
    return true
  })

  // Scoped by the PROPERTY sharing list, not the contacts one — `properties`
  // has no row-level scoping in the database (it is `allow_all_authenticated`),
  // so this filter is the whole of a non-admin's property visibility.
  // Same scoped read the initial load uses, so a save can't widen or narrow the
  // list relative to what sign-in produced. Before this it re-queried by
  // assigned_agent_id alone, which dropped an admin to their own properties and
  // dropped everyone else's co-listings after every save.
  const reload = async () => {
    if (!isAdmin && !propertyAgentIds?.length) return
    const { data, error } = await loadVisibleProperties({
      isAdmin, agentId: activeAgent?.id, propertyAgentIds,
    })
    if (!error && data) setDb(p => ({ ...p, properties: data }))
  }

  const handleSave = (savedProp) => {
    if (savedProp) {
      setDb(p => {
        const exists = p.properties.some(x => x.id === savedProp.id)
        return {
          ...p,
          properties: exists
            ? p.properties.map(x => x.id === savedProp.id ? { ...x, ...savedProp } : x)
            : [savedProp, ...p.properties],
        }
      })
    }
    reload()
  }

  const del = async (id) => {
    await deleteProperty(id)
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
          {PROPERTY_STATUSES.map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1).replace('-',' ')}</option>)}
        </select>
        {counties.length > 0 && (
          <select className="filter-select" value={filterCounty} onChange={e=>setFilterCounty(e.target.value)}>
            <option value="">All Counties</option>
            {counties.map(c=><option key={c} value={c}>{c}</option>)}
          </select>
        )}
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
                  <div className="property-card__address">{streetLine(p)}</div>
                  <div className="property-card__city">{[p.city, p.state, p.zip].filter(Boolean).join(', ')}</div>
                </div>
                <div className="property-card__body">
                  <div className="property-card__price">{formatCurrency(p.list_price)}</div>
                  <div className="property-card__specs" style={{ fontSize:11, color:'var(--gw-mist)', display:'flex', gap:4, flexWrap:'wrap' }}>
                    <PropertySpecs p={p} />
                  </div>
                  <div className="property-card__foot">
                    {(() => {
                      const coIds = p.details?.co_agent_ids || []
                      const allA = [agent, ...coIds.map(id => agents.find(a => a.id === id)).filter(Boolean)].filter(Boolean)
                      if (!allA.length) return null
                      return (
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                          {allA.slice(0, 3).map((a, i) => (
                            <div key={a.id} style={{ marginLeft: i > 0 ? -6 : 0, zIndex: 10 - i, position: 'relative' }}>
                              <Avatar agent={a} size={22} />
                            </div>
                          ))}
                          {allA.length > 3 && <span style={{ fontSize: 10, color: 'var(--gw-mist)', marginLeft: 4 }}>+{allA.length - 3}</span>}
                        </div>
                      )
                    })()}
                    <button
                      className="btn btn--ghost btn--icon"
                      title="Radius Mailing — list the owners near this property"
                      onClick={e => { e.stopPropagation(); setRadiusProp(p) }}
                      style={{ marginLeft:'auto', color:'var(--gw-azure)' }}
                    >
                      <Icon name="mail" size={13} />
                    </button>
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
              <thead><tr><th>Address</th><th>County</th><th>Type</th><th>Status</th><th>Price</th><th>Details</th><th>MLS #</th><th>Agent</th><th></th></tr></thead>
              <tbody>
                {filtered.map(p => {
                  const agent = agents.find(a => a.id === p.assigned_agent_id)
                  return (
                    <tr key={p.id} onClick={() => { setEditing(p); setDrawer(true) }}>
                      <td><div style={{ fontWeight:600 }}>{streetLine(p)}</div><div style={{ fontSize:11, color:'var(--gw-mist)' }}>{[p.city,p.state].filter(Boolean).join(', ')}</div></td>
                      <td style={{ fontSize:12, color:'var(--gw-mist)' }}>{p.county||'—'}</td>
                      <td><span style={{ fontSize:11, fontWeight:700, textTransform:'capitalize', padding:'2px 7px', borderRadius:10, background: isCommercial(p.type)?'#f0ebff':'var(--gw-sky)', color: isCommercial(p.type)?'var(--gw-purple)':'var(--gw-azure)' }}>{TYPE_LABELS[p.type]||p.type}</span></td>
                      <td><Badge variant={p.status}>{p.status}</Badge></td>
                      <td style={{ fontWeight:600 }}>{formatCurrency(p.list_price)}</td>
                      <td style={{ fontSize:12, color:'var(--gw-mist)' }}><PropertySpecs p={p} /></td>
                      <td style={{ fontFamily:'var(--font-mono)', fontSize:12 }}>{p.mls_number||'—'}</td>
                      <td>{agent ? <div style={{ display:'flex', alignItems:'center', gap:6 }}><Avatar agent={agent} size={24} /><span style={{ fontSize:12 }}>{agent.name}</span></div> : '—'}</td>
                      <td onClick={e=>e.stopPropagation()}><div style={{ display:'flex', gap:4 }}><button className="btn btn--ghost btn--icon" title="Radius Mailing" onClick={()=>setRadiusProp(p)} style={{ color:'var(--gw-azure)' }}><Icon name="mail" size={13}/></button><button className="btn btn--ghost btn--icon" onClick={()=>{setEditing(p);setDrawer(true)}}><Icon name="edit" size={13}/></button><button className="btn btn--ghost btn--icon" onClick={()=>setConfirm(p.id)}><Icon name="trash" size={13}/></button></div></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <PropertyDrawer open={drawer} onClose={() => setDrawer(false)} property={editing} agents={agents} contacts={contacts} propertyContacts={propertyContacts} deals={db.deals || []} activeAgent={activeAgent} isAdmin={isAdmin} onSave={handleSave} go={go} setDb={setDb} announce={announce} />
      {confirm && <ConfirmDialog message="This will permanently delete this property." onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
      {radiusProp && (
        <RadiusMailingModal
          property={radiusProp}
          contacts={contacts}
          allProperties={properties}
          onClose={() => setRadiusProp(null)}
        />
      )}
    </div>
  )
}
