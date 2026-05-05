import React, { useState, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatCurrency } from '../lib/helpers.js'
import { Icon, Badge, Avatar, Drawer, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'
import { fireWebhooks } from '../lib/webhooks.js'

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

function PhotoUploader({ photos = [], propertyId, onAdd, onRemove }) {
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver]   = useState(false)
  const inputRef = useRef(null)

  const upload = async (files) => {
    const valid = [...files].filter(f => f.type.startsWith('image/') && f.size <= 10 * 1024 * 1024)
    if (valid.length < files.length) pushToast('Images only, max 10 MB each', 'error')
    if (!valid.length) return
    setUploading(true)
    for (const file of valid) {
      const ext  = file.name.split('.').pop().toLowerCase() || 'jpg'
      const path = `${propertyId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { data, error } = await supabase.storage
        .from('property-photos')
        .upload(path, file, { contentType: file.type, upsert: false })
      if (error) { pushToast(`Upload failed: ${error.message}`, 'error'); continue }
      const { data: { publicUrl } } = supabase.storage.from('property-photos').getPublicUrl(path)
      onAdd(publicUrl)
    }
    setUploading(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  const remove = async (url) => {
    const match = url.match(/property-photos\/(.+?)(\?|$)/)
    if (match) await supabase.storage.from('property-photos').remove([decodeURIComponent(match[1])])
    onRemove(url)
  }

  return (
    <div className="photo-uploader">
      <label className="form-label">
        Photos
        <span style={{ fontWeight: 400, color: 'var(--gw-mist)', marginLeft: 6, fontSize: 11 }}>
          shown on public listing page
        </span>
      </label>
      {photos.length > 0 && (
        <div className="photo-uploader__grid">
          {photos.map((url, i) => (
            <div key={url} className="photo-uploader__thumb">
              <img src={url} alt={`Property photo ${i + 1}`} loading="lazy" />
              <button type="button" className="photo-uploader__del" onClick={() => remove(url)} title="Remove">✕</button>
            </div>
          ))}
        </div>
      )}
      <div
        className={`photo-uploader__drop${dragOver ? ' drag-over' : ''}`}
        onClick={() => !uploading && inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files) }}
      >
        <input ref={inputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
          onChange={e => upload(e.target.files)} />
        <Icon name="upload" size={16} style={{ marginBottom: 4 }} />
        <span style={{ fontSize: 12 }}>{uploading ? 'Uploading…' : 'Drop photos or click to browse'}</span>
        {!uploading && <span style={{ fontSize: 11, color: 'var(--gw-mist)' }}>JPEG, PNG, WEBP — up to 10 MB</span>}
      </div>
    </div>
  )
}

function PropertyDrawer({ open, onClose, property, agents, contacts, activeAgent, onSave, go, setDb }) {
  const blank = { address:'', city:'', state:'', zip:'', county:'', type:'residential', status:'active', list_price:'', sqft:'', beds:'', baths:'', garage:0, mls_number:'', linked_contact_id:'', assigned_agent_id:'', notes:'', details:{} }
  const [form, setForm]             = useState(property || blank)
  const [errors, setErrors]         = useState({})
  const [saving, setSaving]         = useState(false)
  const [startingDeal, setStartingDeal] = useState(false)
  const [tempId] = useState(() => property?.id || crypto.randomUUID())

  React.useEffect(() => {
    setForm(property
      ? { ...blank, ...property, details: property.details || {} }
      : { ...blank, assigned_agent_id: activeAgent?.id || '' })
    setErrors({})
  }, [property, open, activeAgent?.id])

  const set = (k, v) => setForm(p => ({...p, [k]: v}))

  const photos     = form.details?.photos      || []
  const coAgentIds = form.details?.co_agent_ids || []

  const addPhoto    = (url) => set('details', { ...(form.details || {}), photos: [...photos, url] })
  const removePhoto = (url) => set('details', { ...(form.details || {}), photos: photos.filter(u => u !== url) })
  const toggleCoAgent = (agentId) => {
    const next = coAgentIds.includes(agentId)
      ? coAgentIds.filter(id => id !== agentId)
      : [...coAgentIds, agentId]
    set('details', { ...(form.details || {}), co_agent_ids: next })
  }

  const startDeal = async () => {
    setStartingDeal(true)
    const dealPayload = {
      title:       form.address,
      property_id: property.id,
      contact_id:  form.linked_contact_id || null,
      agent_id:    activeAgent?.id || form.assigned_agent_id || null,
      stage:       'lead',
      value:       form.list_price ? Number(form.list_price) : null,
    }
    const { data, error } = await supabase.from('deals').insert([dealPayload]).select().single()
    setStartingDeal(false)
    if (error) { pushToast(error.message, 'error'); return }
    if (setDb) setDb(p => ({ ...p, deals: [data, ...(p.deals || [])] }))
    pushToast('Deal created — opening Pipeline')
    onClose()
    if (go) go('pipeline')
  }

  const save = async () => {
    const e = {}
    if (!form.address.trim()) e.address = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    const resolvedId = property?.id || tempId
    const payload = {
      ...form,
      id:                resolvedId,
      list_price:        form.list_price ? Number(form.list_price) : null,
      sqft:              form.sqft       ? Number(form.sqft)       : null,
      beds:              form.beds       ? Number(form.beds)       : null,
      baths:             form.baths      ? Number(form.baths)      : null,
      garage:            form.garage != null ? Number(form.garage) : 0,
      linked_contact_id: form.linked_contact_id || null,
      assigned_agent_id: form.assigned_agent_id || activeAgent?.id || null,
    }
    let error, data
    if (property?.id) {
      ({ error, data } = await supabase.from('properties').update(payload).eq('id', property.id).select().single())
    } else {
      ({ error, data } = await supabase.from('properties').insert([payload]).select().single())
    }
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }

    // Geocode on save if address changed or not yet geocoded
    const savedId = data?.id || resolvedId
    const addressChanged = !property?.id || form.address !== property?.address || form.city !== property?.city
    if (savedId && addressChanged && (!form.lat || !form.lng)) {
      const fullAddr = [form.address, form.city, form.state, form.zip].filter(Boolean).join(', ')
      try {
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(fullAddr)}`,
          { headers: { 'User-Agent': 'GatewayCRM/1.0' } }
        )
        const geoData = await geoRes.json()
        if (geoData[0]) {
          await supabase.from('properties').update({ lat: parseFloat(geoData[0].lat), lng: parseFloat(geoData[0].lon) }).eq('id', savedId)
        }
      } catch { /* geocoding failure is non-fatal */ }
    }

    if (!property?.id) fireWebhooks('property.added', { id: savedId, address: form.address, city: form.city, type: form.type, status: form.status })

    pushToast(property?.id ? 'Property updated' : 'Property added')
    onSave(data || payload)
    onClose()
  }

  const commercial = isCommercial(form.type)

  return (
    <Drawer open={open} onClose={onClose} title={property?.id ? 'Edit Property' : 'Add Property'} width={520}>
      <div className="drawer__body">
        {/* Photos */}
        <div className="form-group">
          <PhotoUploader
            photos={photos}
            propertyId={tempId}
            onAdd={addPhoto}
            onRemove={removePhoto}
          />
        </div>
        {/* Address */}
        <div className="form-group"><label className="form-label required">Address</label><input className={`form-control${errors.address?' error':''}`} value={form.address} onChange={e=>set('address',e.target.value)} placeholder="123 Main Street" /></div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">City</label><input className="form-control" value={form.city||''} onChange={e=>set('city',e.target.value)} /></div>
          <div className="form-group"><label className="form-label">State</label><input className="form-control" value={form.state||''} onChange={e=>set('state',e.target.value)} /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">ZIP</label><input className="form-control" value={form.zip||''} onChange={e=>set('zip',e.target.value)} /></div>
          <div className="form-group"><label className="form-label">County</label><input className="form-control" value={form.county||''} onChange={e=>set('county',e.target.value)} placeholder="e.g. Travis County" /></div>
        </div>
        <div className="form-row">
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
        {/* Co-Agents */}
        {agents.filter(a => a.id !== form.assigned_agent_id).length > 0 && (
          <div className="form-group">
            <label className="form-label">
              Co-Agents
              <span style={{ fontWeight: 400, color: 'var(--gw-mist)', marginLeft: 6, fontSize: 11 }}>
                share commission on this property
              </span>
            </label>
            <div className="coagent-list">
              {agents.filter(a => a.id !== form.assigned_agent_id).map(a => (
                <label key={a.id} className={`coagent-item${coAgentIds.includes(a.id) ? ' checked' : ''}`}>
                  <input type="checkbox" checked={coAgentIds.includes(a.id)} onChange={() => toggleCoAgent(a.id)} />
                  <Avatar agent={a} size={22} />
                  <span>{a.name}</span>
                  {a.role && <span style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{a.role}</span>}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="form-group"><label className="form-label">Notes</label><textarea className="form-control form-control--textarea" value={form.notes||''} onChange={e=>set('notes',e.target.value)} /></div>
      </div>
      <div className="drawer__foot">
        {property?.id && (
          <div style={{ display:'flex', gap:6, marginRight:'auto' }}>
            <button
              className="btn btn--secondary"
              onClick={startDeal}
              disabled={startingDeal}
              title="Create a deal in the Pipeline linked to this property"
            >
              <Icon name="pipeline" size={13} />
              {startingDeal ? 'Creating…' : 'Start Deal'}
            </button>
            <button
              className="btn btn--ghost"
              title="Copy public listing link"
              onClick={() => {
                const url = `${window.location.origin}/listing/${property.id}`
                navigator.clipboard.writeText(url).then(() => pushToast('Listing link copied!'))
              }}
            >
              <Icon name="link" size={13} />
              Copy Link
            </button>
          </div>
        )}
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

// ─── Radius Mailing helpers ───────────────────────────────────────────────────

const CAMPAIGN_TYPES = ['Just Sold','Just Listed','Exclusively Offered','Price Reduced','Open House','Investment Opportunity','Custom']

async function geocodeAddress(address) {
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`,
      { headers: { 'User-Agent': 'GatewayCRM/1.0' } }
    )
    const d = await r.json()
    return d[0] ? { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) } : null
  } catch { return null }
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

// ─── Radius Mailing Modal ─────────────────────────────────────────────────────

function RadiusMailingModal({ property, contacts, allProperties, onClose }) {
  const [campaignType, setCampaignType]         = useState('Just Sold')
  const [customName, setCustomName]             = useState('')
  const [radius, setRadius]                     = useState(1)
  const [searching, setSearching]               = useState(false)
  const [geoProgress, setGeoProgress]           = useState(null) // { done, total }
  const [results, setResults]                   = useState(null) // null = not run yet
  const [selected, setSelected]                 = useState(new Set())
  const [syncing, setSyncing]                   = useState(false)
  const [syncDone, setSyncDone]                 = useState(false)
  const [mcConfig, setMcConfig]                 = useState(null)

  const contactMap = useMemo(() => Object.fromEntries(contacts.map(c => [c.id, c])), [contacts])

  // Load saved Mailchimp config
  React.useEffect(() => {
    supabase.from('integrations').select('config').eq('type', 'mailchimp').single()
      .then(({ data }) => { if (data?.config?.api_key) setMcConfig(data.config) })
  }, [])

  const search = async () => {
    setSearching(true); setResults(null); setSyncDone(false)

    // 1. Geocode source property (use stored coords if available)
    let src = property.lat && property.lng ? { lat: property.lat, lng: property.lng } : null
    if (!src) {
      const addr = [property.address, property.city, property.state, property.zip].filter(Boolean).join(', ')
      src = await geocodeAddress(addr)
      if (src) await supabase.from('properties').update({ lat: src.lat, lng: src.lng }).eq('id', property.id)
    }
    if (!src) {
      pushToast('Could not geocode this property — ensure address, city, state are filled in', 'error')
      setSearching(false); return
    }

    // 2. Geocode any nearby properties that don't have coords yet
    const others = allProperties.filter(p => p.id !== property.id)
    const needsGeo = others.filter(p => !p.lat || !p.lng)
    if (needsGeo.length) {
      setGeoProgress({ done: 0, total: needsGeo.length })
      for (let i = 0; i < needsGeo.length; i++) {
        const p = needsGeo[i]
        const addr = [p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')
        const coords = await geocodeAddress(addr)
        if (coords) {
          await supabase.from('properties').update({ lat: coords.lat, lng: coords.lng }).eq('id', p.id)
          p.lat = coords.lat; p.lng = coords.lng
        }
        setGeoProgress({ done: i + 1, total: needsGeo.length })
        if (i < needsGeo.length - 1) await new Promise(r => setTimeout(r, 1100)) // Nominatim rate limit
      }
      setGeoProgress(null)
    }

    // 3. Find properties within radius and collect their linked contacts
    const found = []
    const seen = new Set()
    for (const p of others) {
      if (!p.lat || !p.lng) continue
      const dist = haversineMiles(src.lat, src.lng, p.lat, p.lng)
      if (dist > radius) continue
      if (p.linked_contact_id && !seen.has(p.linked_contact_id)) {
        const contact = contactMap[p.linked_contact_id]
        if (contact?.email) {
          seen.add(p.linked_contact_id)
          found.push({ contact, property: p, distance: dist })
        }
      }
    }
    found.sort((a, b) => a.distance - b.distance)

    setResults(found)
    setSelected(new Set(found.map(r => r.contact.id)))
    setSearching(false)
  }

  const toggleContact = id => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const syncToMailchimp = async () => {
    if (!mcConfig?.api_key)  { pushToast('Mailchimp not connected — go to Integrations', 'error'); return }
    if (!mcConfig?.list_id)  { pushToast('No default audience set — go to Integrations → Mailchimp', 'error'); return }
    if (!selected.size)      { pushToast('Select at least one contact', 'error'); return }
    setSyncing(true)
    try {
      const toSync = results.filter(r => selected.has(r.contact.id))
      const label  = campaignType === 'Custom' ? customName : campaignType
      const tag    = `${label} — ${property.address}`

      const res = await fetch('/api/mailchimp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'syncMembers',
          apiKey: mcConfig.api_key,
          listId: mcConfig.list_id,
          tag,
          members: toSync.map(r => ({ email: r.contact.email, first_name: r.contact.first_name, last_name: r.contact.last_name })),
        }),
      })
      const data = await res.json()
      if (!res.ok) { pushToast(data.error || 'Mailchimp sync failed', 'error'); return }

      await fireWebhooks('radius_sync', {
        property: property.address, campaign: label,
        radius_miles: radius, contacts_synced: toSync.length, tag,
      })

      setSyncDone(true)
      pushToast(`${toSync.length} contact${toSync.length !== 1 ? 's' : ''} synced → Mailchimp tag "${tag}"`)
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setSyncing(false)
    }
  }

  const campaignLabel = campaignType === 'Custom' ? (customName || 'Custom') : campaignType
  const tag = `${campaignLabel} — ${property.address}`

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.48)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 'var(--radius-lg,10px)', width: '100%', maxWidth: 560, maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.2)' }}>

        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid var(--gw-border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18 }}>Radius Mailing</div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 3 }}>
                {property.address}{property.city ? `, ${property.city}` : ''}
              </div>
            </div>
            <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Campaign Type</label>
              <select className="form-control" value={campaignType} onChange={e => { setCampaignType(e.target.value); setResults(null) }}>
                {CAMPAIGN_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Search Radius</label>
              <select className="form-control" value={radius} onChange={e => { setRadius(Number(e.target.value)); setResults(null) }}>
                {[0.25, 0.5, 1, 2, 5].map(r => <option key={r} value={r}>{r} mi</option>)}
              </select>
            </div>
          </div>

          {campaignType === 'Custom' && (
            <div className="form-group">
              <label className="form-label">Custom Campaign Name</label>
              <input className="form-control" value={customName} onChange={e => setCustomName(e.target.value)} placeholder="e.g. New Office Listing Available" />
            </div>
          )}

          {/* Geocoding progress */}
          {geoProgress && (
            <div style={{ marginBottom: 16, padding: 14, background: 'var(--gw-sky)', borderRadius: 'var(--radius)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                <span>Geocoding properties for first-time search…</span>
                <span>{geoProgress.done} / {geoProgress.total}</span>
              </div>
              <div style={{ height: 5, background: 'rgba(0,0,0,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', background: 'var(--gw-azure)', borderRadius: 3, width: `${Math.round(geoProgress.done / geoProgress.total * 100)}%`, transition: 'width 400ms' }} />
              </div>
            </div>
          )}

          <button className="btn btn--primary" onClick={search} disabled={searching} style={{ marginBottom: 20 }}>
            {searching ? (geoProgress ? 'Geocoding…' : 'Searching…') : 'Find Contacts Within Radius'}
          </button>

          {/* Results */}
          {results !== null && (
            results.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--gw-mist)', fontSize: 13 }}>
                No contacts with email addresses found within {radius} mi of this property.<br />
                <span style={{ fontSize: 11, marginTop: 6, display: 'block' }}>
                  Tip: Link contacts to nearby properties in the Properties page to appear here.
                </span>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {results.length} contact{results.length !== 1 ? 's' : ''} found &nbsp;·&nbsp; {selected.size} selected
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={() => setSelected(new Set(results.map(r => r.contact.id)))}>All</button>
                    <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={() => setSelected(new Set())}>None</button>
                  </div>
                </div>
                <div style={{ border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 12 }}>
                  {results.map(({ contact, property: p, distance }) => (
                    <label key={contact.id}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid var(--gw-border)', cursor: 'pointer', background: selected.has(contact.id) ? 'var(--gw-sky)' : '#fff', transition: 'background 100ms' }}
                      onClick={() => toggleContact(contact.id)}>
                      <input type="checkbox" checked={selected.has(contact.id)} readOnly style={{ flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{contact.first_name} {contact.last_name}</div>
                        <div style={{ fontSize: 11, color: 'var(--gw-mist)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.email} · {p.address}</div>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--gw-mist)', flexShrink: 0 }}>{distance.toFixed(2)} mi</div>
                    </label>
                  ))}
                </div>
              </>
            )
          )}
        </div>

        {/* Footer */}
        {results !== null && results.length > 0 && (
          <div style={{ padding: '14px 24px', borderTop: '1px solid var(--gw-border)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {mcConfig ? (
              <div style={{ flex: 1, fontSize: 11, color: 'var(--gw-mist)', minWidth: 0 }}>
                Mailchimp tag: <strong style={{ color: 'var(--gw-ink)' }}>"{tag}"</strong>
              </div>
            ) : (
              <div style={{ flex: 1, fontSize: 12, color: 'var(--gw-red)' }}>⚠ Mailchimp not connected — go to Integrations</div>
            )}
            <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
            {!syncDone ? (
              <button className="btn btn--primary" onClick={syncToMailchimp} disabled={syncing || !selected.size || !mcConfig}>
                {syncing ? 'Syncing…' : `Sync ${selected.size} to Mailchimp`}
              </button>
            ) : (
              <button className="btn btn--primary" style={{ background: 'var(--gw-green, #16a34a)' }} onClick={onClose}>✓ Done</button>
            )}
          </div>
        )}
        {results !== null && results.length === 0 && (
          <div style={{ padding: '14px 24px', borderTop: '1px solid var(--gw-border)', display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn--secondary" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Properties page ──────────────────────────────────────────────────────────

export default function PropertiesPage({ db, setDb, activeAgent, go }) {
  const [view, setView]               = useState('grid')
  const [search, setSearch]           = useState('')
  const [filterType, setFilterType]   = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [filterCounty, setFilterCounty] = useState('')
  const [drawer, setDrawer]           = useState(false)
  const [editing, setEditing]         = useState(null)
  const [confirm, setConfirm]         = useState(null)
  const [radiusProp, setRadiusProp]   = useState(null)

  const properties = db.properties || []
  const agents     = db.agents     || []
  const contacts   = db.contacts   || []

  const counties = [...new Set(properties.map(p => p.county).filter(Boolean))].sort()

  const filtered = properties.filter(p => {
    const q = search.toLowerCase()
    if (q && !(p.address||'').toLowerCase().includes(q) && !(p.city||'').toLowerCase().includes(q) && !(p.county||'').toLowerCase().includes(q) && !(p.mls_number||'').toLowerCase().includes(q)) return false
    if (filterType   && p.type   !== filterType)   return false
    if (filterStatus && p.status !== filterStatus) return false
    if (filterCounty && p.county !== filterCounty) return false
    return true
  })

  const reload = async () => {
    const { data, error } = await supabase.from('properties').select('*').order('created_at', { ascending: false })
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
                  <div className="property-card__address">{p.address}</div>
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
                      title="Radius Mailing — sync nearby contacts to Mailchimp"
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
                      <td><div style={{ fontWeight:600 }}>{p.address}</div><div style={{ fontSize:11, color:'var(--gw-mist)' }}>{[p.city,p.state].filter(Boolean).join(', ')}</div></td>
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

      <PropertyDrawer open={drawer} onClose={() => setDrawer(false)} property={editing} agents={agents} contacts={contacts} activeAgent={activeAgent} onSave={handleSave} go={go} setDb={setDb} />
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
