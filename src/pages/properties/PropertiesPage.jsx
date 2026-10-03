// Properties — the listings database: filters, cards, and the property drawer.

import React, { useMemo, useState } from 'react'
import { formatCurrency } from '../../lib/helpers.js'
import { Icon, Badge, Avatar, ConfirmDialog, pushToast } from '../../components/UI.jsx'
import { Button, IconButton, DataTable, DataState, EmptyState, Skeleton } from '../../components/ui/index.js'
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

function TypePill({ type }) {
  const commercial = isCommercial(type)
  return (
    <span style={{ fontSize:11, fontWeight:700, textTransform:'capitalize', padding:'2px 7px', borderRadius:10, background: commercial ? '#f0ebff' : 'var(--gw-sky)', color: commercial ? 'var(--gw-purple)' : 'var(--gw-azure)' }}>
      {TYPE_LABELS[type] || type}
    </span>
  )
}

const NOUN = { one: 'property', other: 'properties' }

// What to call a property on screen and in accessible names — never blank,
// so "Delete " can't happen for a listing saved without a street line.
const addressOf = (p) => streetLine(p) || 'Untitled property'

// Grid placeholder while a reload has nothing to show yet — same footprint as
// the real cards so the page doesn't jump when they arrive.
function PropertyGridSkeleton() {
  return (
    <div className="property-grid">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="property-card" style={{ cursor: 'default' }}>
          <div style={{ padding: 20 }}><Skeleton width="40%" height={10} /><Skeleton width="80%" height={16} style={{ marginTop: 12 }} /></div>
          <div style={{ padding: '0 20px 20px' }}><Skeleton width="50%" height={20} /><Skeleton width="70%" height={10} style={{ marginTop: 10 }} /></div>
        </div>
      ))}
    </div>
  )
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
  const [sort, setSort]               = useState(null)
  // A reload after a save — the list stays on screen while it runs, and a
  // failure leaves the last good list up with a banner instead of blanking it.
  const [refreshing, setRefreshing]   = useState(false)
  const [reloadError, setReloadError] = useState(null)

  // Same contract as ContactsPage — see the comment there.
  React.useEffect(() => {
    if (focusRecord?.type === 'new-property') { setEditing(null); setDrawer(true); onFocusHandled?.(); return }
    if (focusRecord?.type !== 'property') return
    const hit = (db.properties || []).find(x => x.id === focusRecord.id)
    if (hit) { setEditing(hit); setDrawer(true) }
    onFocusHandled?.()
  }, [focusRecord, db.properties])
  const [confirm, setConfirm]         = useState(null)
  const [deleting, setDeleting]       = useState(false)
  const [radiusProp, setRadiusProp]   = useState(null)

  const properties     = db.properties     || []
  const agents         = db.agents         || []
  const contacts       = db.contacts       || []
  const propertyContacts = db.propertyContacts || []   // additional-contact links (migration 0021)

  const agentById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents])
  const counties = [...new Set(properties.map(p => p.county).filter(Boolean))].sort()

  const hasFilters = !!(search.trim() || filterType || filterStatus || filterCounty)
  const clearFilters = () => { setSearch(''); setFilterType(''); setFilterStatus(''); setFilterCounty('') }

  const filtered = properties.filter(p => {
    const q = search.trim().toLowerCase()
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
    setRefreshing(true)
    const { data, error } = await loadVisibleProperties({
      isAdmin, agentId: activeAgent?.id, propertyAgentIds,
    })
    setRefreshing(false)
    if (error) { setReloadError(error); return }
    setReloadError(null)
    if (data) setDb(p => ({ ...p, properties: data }))
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

  const openProperty = (p) => { setEditing(p); setDrawer(true) }
  const openNew = () => { setEditing(null); setDrawer(true) }

  // The delete used to report success whatever happened — a refused delete
  // (permissions, a deal still pointing at the listing) toasted "Property
  // deleted" and the row came back on the next load.
  const del = async (id) => {
    setDeleting(true)
    const { error } = await deleteProperty(id)
    setDeleting(false)
    if (error) {
      pushToast(`Couldn't delete this property: ${error.message || 'please try again.'}`, 'error')
      return
    }
    setDb(p => ({ ...p, properties: (p.properties || []).filter(x => x.id !== id) }))
    pushToast('Property deleted', 'info')
    setConfirm(null)
    reload()
  }

  const addButton = <Button variant="primary" icon="plus" onClick={openNew}>Add Property</Button>
  const emptyState = (
    <EmptyState icon="building" title="No properties yet" description="Add your first property listing to get started." action={addButton} />
  )

  const rowActions = (p) => (
    <>
      <IconButton icon="mail" tone="accent" label={`Radius mailing around ${addressOf(p)}`} title="Radius Mailing — list the owners near this property" onClick={() => setRadiusProp(p)} />
      <IconButton icon="edit" label={`Edit ${addressOf(p)}`} onClick={() => openProperty(p)} />
      <IconButton icon="trash" tone="danger" label={`Delete ${addressOf(p)}`} onClick={() => setConfirm(p.id)} />
    </>
  )

  const columns = [
    {
      id: 'address', header: 'Address', rowHeader: true, sortable: true, accessor: streetLine,
      cell: p => (
        <>
          <div>{addressOf(p)}</div>
          <div style={{ fontSize:11, color:'var(--gw-mist)', fontWeight:400 }}>{[p.city,p.state].filter(Boolean).join(', ')}</div>
        </>
      ),
    },
    { id: 'county', header: 'County', accessor: 'county', sortable: true, mobile: 'hidden' },
    { id: 'type', header: 'Type', accessor: p => TYPE_LABELS[p.type] || p.type, sortable: true, cell: p => <TypePill type={p.type} />, mobile: 'secondary' },
    { id: 'status', header: 'Status', accessor: 'status', sortable: true, cell: p => <Badge variant={p.status}>{p.status}</Badge>, mobile: 'secondary' },
    { id: 'price', header: 'Price', accessor: 'list_price', sortable: true, firstSortDir: 'desc', align: 'right', cell: p => <strong>{formatCurrency(p.list_price)}</strong> },
    { id: 'details', header: 'Details', cell: p => <span style={{ fontSize:12, color:'var(--gw-mist)' }}><PropertySpecs p={p} /></span> },
    { id: 'mls', header: 'MLS #', accessor: 'mls_number', sortable: true, cell: p => p.mls_number ? <span style={{ fontFamily:'var(--font-mono)', fontSize:12 }}>{p.mls_number}</span> : '—' },
    {
      id: 'agent', header: 'Agent', sortable: true, accessor: p => agentById.get(p.assigned_agent_id)?.name,
      cell: p => {
        const agent = agentById.get(p.assigned_agent_id)
        return agent ? <div style={{ display:'flex', alignItems:'center', gap:6 }}><Avatar agent={agent} size={24} /><span style={{ fontSize:12 }}>{agent.name}</span></div> : '—'
      },
    },
  ]

  return (
    <div className="page-content">
      <div className="page-header">
        <div><h1 className="page-title">Properties</h1><div className="page-sub">{properties.length} listings</div></div>
        <div style={{ display:'flex', gap:8 }}>
          <div role="group" aria-label="Layout" style={{ display:'flex', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
            {['grid','list'].map(v => (
              <button
                key={v} type="button" aria-pressed={view===v} aria-label={v==='grid' ? 'Grid view' : 'List view'} title={v==='grid' ? 'Grid view' : 'List view'}
                className={`btn btn--${view===v?'primary':'secondary'}`} style={{ borderRadius:0, border:'none' }} onClick={() => setView(v)}
              >
                <Icon name={v==='grid'?'dashboard':'pipeline'} size={14} />
              </button>
            ))}
          </div>
          {addButton}
        </div>
      </div>

      <div className="filters-bar" role="search">
        <div style={{ display:'flex', alignItems:'center', gap:8, background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'0 10px', height:34, flex:1, maxWidth:300 }}>
          <Icon name="search" size={14} style={{ color:'var(--gw-mist)' }} />
          <input type="search" aria-label="Search properties by address, city, county or MLS #" style={{ border:'none', outline:'none', fontSize:13, flex:1, minWidth:0 }} placeholder="Search properties…" value={search} onChange={e=>setSearch(e.target.value)} />
        </div>
        <select className="filter-select" aria-label="Filter by type" value={filterType} onChange={e=>setFilterType(e.target.value)}>
          <option value="">All Types</option>
          <optgroup label="Residential"><option value="residential">Residential</option><option value="rental">Rental</option></optgroup>
          <optgroup label="Commercial">{COMMERCIAL_TYPES.map(t=><option key={t} value={t}>{TYPE_LABELS[t]}</option>)}</optgroup>
        </select>
        <select className="filter-select" aria-label="Filter by status" value={filterStatus} onChange={e=>setFilterStatus(e.target.value)}>
          <option value="">All Statuses</option>
          {PROPERTY_STATUSES.map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1).replace('-',' ')}</option>)}
        </select>
        {counties.length > 0 && (
          <select className="filter-select" aria-label="Filter by county" value={filterCounty} onChange={e=>setFilterCounty(e.target.value)}>
            <option value="">All Counties</option>
            {counties.map(c=><option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {hasFilters && <Button size="sm" variant="ghost" icon="x" onClick={clearFilters}>Clear filters</Button>}
      </div>

      {view === 'grid' ? (
        <DataState
          noun={NOUN} count={filtered.length} loading={refreshing} error={reloadError} onRetry={reload}
          filtered={hasFilters} onClearFilters={clearFilters}
          skeleton={<PropertyGridSkeleton />} empty={emptyState}
        >
          <div className="property-grid">
            {filtered.map(p => {
              const agent = agentById.get(p.assigned_agent_id)
              return (
                <div
                  key={p.id} className="property-card"
                  // Mouse convenience; the address button below is the keyboard target.
                  onClick={e => { if (!e.target.closest('button, a')) openProperty(p) }}
                >
                  <div className="property-card__head">
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
                      <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color: isCommercial(p.type) ? 'var(--gw-purple)' : 'var(--gw-azure)', background: isCommercial(p.type) ? '#f0ebff' : 'var(--gw-sky)', padding:'2px 7px', borderRadius:10 }}>
                        {TYPE_LABELS[p.type] || p.type}
                      </div>
                      <Badge variant={p.status}>{p.status}</Badge>
                    </div>
                    <div className="property-card__address">
                      <button type="button" className="ui-table__row-link" onClick={() => openProperty(p)}>{addressOf(p)}</button>
                    </div>
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
                        const allA = [agent, ...coIds.map(id => agentById.get(id)).filter(Boolean)].filter(Boolean)
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
                      <div style={{ marginLeft:'auto', display:'flex', gap:2 }}>
                        <IconButton icon="mail" size="sm" tone="accent" label={`Radius mailing around ${addressOf(p)}`} title="Radius Mailing — list the owners near this property" onClick={() => setRadiusProp(p)} />
                        <IconButton icon="trash" size="sm" tone="danger" label={`Delete ${addressOf(p)}`} onClick={() => setConfirm(p.id)} />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </DataState>
      ) : (
        <div className="card" style={{ padding:0, overflow:'hidden' }}>
          <DataTable
            caption="Properties" noun={NOUN}
            columns={columns} rows={filtered}
            loading={refreshing} error={reloadError} onRetry={reload}
            filtered={hasFilters} onClearFilters={clearFilters} emptyState={emptyState}
            sort={sort} onSortChange={setSort}
            pageResetKey={`${search}|${filterType}|${filterStatus}|${filterCounty}`}
            onRowClick={openProperty}
            getRowLabel={p => `Open ${addressOf(p)}`}
            rowActions={rowActions}
          />
        </div>
      )}

      <PropertyDrawer open={drawer} onClose={() => setDrawer(false)} property={editing} agents={agents} contacts={contacts} propertyContacts={propertyContacts} deals={db.deals || []} activeAgent={activeAgent} isAdmin={isAdmin} onSave={handleSave} go={go} setDb={setDb} announce={announce} />
      {confirm && (
        <ConfirmDialog
          message="This will permanently delete this property."
          busy={deleting} busyLabel="Deleting…"
          onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)}
        />
      )}
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
