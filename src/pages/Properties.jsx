import React, { useState, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatCurrency } from '../lib/helpers.js'
import { Icon, Badge, Avatar, Drawer, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'
import { fireWebhooks } from '../lib/webhooks.js'
import { findMatchingBuyers } from '../lib/matching.js'
import { friendlyDbError } from '../lib/dbErrors.js'
import { RESIDENTIAL_PROPERTY_TYPES, COMMERCIAL_PROPERTY_TYPES, PROPERTY_TYPE_LABELS, PROPERTY_STATUSES } from '../lib/enums.js'
import OptionSelect from '../components/OptionSelect.jsx'

// Types where commercial fields apply
const COMMERCIAL_TYPES = COMMERCIAL_PROPERTY_TYPES
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

function PossibleBuyers({ form, contacts }) {
  const buyers = useMemo(() => findMatchingBuyers(form, contacts), [form, contacts])
  const hasSubmarket = Boolean(form.submarket)

  if (!hasSubmarket) return null

  return (
    <div style={{ borderTop: '1px solid var(--gw-border)', marginTop: 4, paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gw-mist)' }}>
          Possible Buyers
        </div>
        {buyers.length > 0 && (
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--gw-azure)', background: 'var(--gw-sky)', padding: '2px 8px', borderRadius: 99 }}>
            {buyers.length} match{buyers.length !== 1 ? 'es' : ''}
          </span>
        )}
      </div>
      {buyers.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--gw-mist)', padding: '8px 0' }}>
          No buyers have this submarket + asset type in their criteria yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {buyers.map(c => (
            <div key={c.id} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px',
              background: 'var(--gw-sky)',
              border: '1px solid var(--gw-azure)',
              borderRadius: 'var(--radius)',
            }}>
              <Avatar agent={{ name: `${c.first_name} ${c.last_name}` }} size={28} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gw-ink)' }}>
                  {c.first_name} {c.last_name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--gw-azure)', marginTop: 1 }}>
                  {(c.submarkets || []).join(', ')}
                  {c.asset_types?.length > 0 ? ` · ${c.asset_types.join(', ')}` : ''}
                </div>
              </div>
              {(c.size_min || c.size_max) && (
                <div style={{ fontSize: 11, color: 'var(--gw-mist)', whiteSpace: 'nowrap' }}>
                  {c.size_min ? Number(c.size_min).toLocaleString() : '0'}
                  {'–'}
                  {c.size_max ? Number(c.size_max).toLocaleString() : '∞'} {c.size_unit || 'sqft'}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Listing drawer tab components ───────────────────────────────────────────

function PriceHistoryTab({ property }) {
  const history = Array.isArray(property?.price_history) ? property.price_history : []
  if (history.length === 0) return (
    <div style={{ padding:24, textAlign:'center', color:'var(--gw-mist)', fontSize:13 }}>
      No price changes recorded yet.<br/>
      <span style={{ fontSize:11 }}>Changes are tracked automatically when you update the list price and save.</span>
    </div>
  )
  return (
    <div style={{ padding:16, overflowY:'auto', flex:1 }}>
      <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:12 }}>Price History</div>
      {[...history].reverse().map((entry, i) => {
        const reduction = Number(entry.previous_price) - Number(entry.price)
        const pct = entry.previous_price > 0 ? Math.abs(reduction / entry.previous_price * 100).toFixed(1) : 0
        return (
          <div key={i} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', marginBottom:6, background:'#fff' }}>
            <div style={{ width:32, height:32, borderRadius:6, background: reduction > 0 ? '#fee2e2' : '#dcfce7', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, flexShrink:0 }}>
              {reduction > 0 ? '↓' : '↑'}
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, fontWeight:700, color: reduction > 0 ? '#dc2626' : '#16a34a' }}>
                {formatCurrency(entry.price)}
                <span style={{ fontSize:11, fontWeight:400, color:'var(--gw-mist)', marginLeft:8 }}>from {formatCurrency(entry.previous_price)}</span>
              </div>
              <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
                {reduction > 0 ? `↓ ${formatCurrency(Math.abs(reduction))} (${pct}% reduction)` : `↑ ${formatCurrency(Math.abs(reduction))} increase`}
              </div>
            </div>
            <div style={{ fontSize:11, color:'var(--gw-mist)', whiteSpace:'nowrap' }}>
              {entry.date ? new Date(entry.date).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : ''}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ShowingsTab({ property }) {
  const [showings, setShowings]   = useState([])
  const [loading, setLoading]     = useState(true)
  const [tableReady, setTableReady] = useState(true)
  const [showForm, setShowForm]   = useState(false)
  const [adding, setAdding]       = useState(false)
  const [form, setForm]           = useState({ showing_date:'', buyer_agent_name:'', feedback:'', rating:'' })

  React.useEffect(() => { if (property?.id) loadShowings() }, [property?.id])

  const loadShowings = async () => {
    setLoading(true)
    const { data, error } = await supabase.from('property_showings').select('*').eq('property_id', property.id).order('showing_date', { ascending:false })
    if (error?.code === '42P01') { setTableReady(false); setLoading(false); return }
    setShowings(data || [])
    setLoading(false)
  }

  const add = async () => {
    if (!form.showing_date) { pushToast('Date is required', 'error'); return }
    setAdding(true)
    const { data, error } = await supabase.from('property_showings').insert([{
      property_id: property.id,
      showing_date: form.showing_date,
      buyer_agent_name: form.buyer_agent_name || null,
      feedback: form.feedback || null,
      rating: form.rating ? Number(form.rating) : null,
    }]).select().single()
    setAdding(false)
    if (error) { pushToast(error.message, 'error'); return }
    setShowings(p => [data, ...p])
    setForm({ showing_date:'', buyer_agent_name:'', feedback:'', rating:'' })
    setShowForm(false)
    pushToast('Showing logged')
  }

  const remove = async (id) => {
    await supabase.from('property_showings').delete().eq('id', id)
    setShowings(p => p.filter(s => s.id !== id))
  }

  if (!tableReady) return (
    <div style={{ padding:20 }}>
      <div style={{ background:'#fff8ec', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:16, fontSize:13, lineHeight:1.7 }}>
        <strong>Run this SQL in Supabase Dashboard → SQL Editor:</strong>
        <pre style={{ background:'var(--gw-slate)', color:'#e2e8f0', padding:10, borderRadius:6, fontSize:11, marginTop:8, overflowX:'auto' }}>
{`create table if not exists property_showings (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid references properties(id) on delete cascade,
  agent_id          uuid references agents(id) on delete set null,
  showing_date      timestamptz not null,
  buyer_agent_name  text,
  feedback          text,
  rating            int check (rating between 1 and 5),
  created_at        timestamptz default now()
);
alter table property_showings enable row level security;
create policy "agents_showings" on property_showings
  for all to authenticated using (true) with check (true);`}
        </pre>
        <button className="btn btn--secondary btn--sm" style={{ marginTop:8 }} onClick={() => { setTableReady(true); loadShowings() }}>
          <Icon name="refresh" size={12} /> Retry
        </button>
      </div>
    </div>
  )

  return (
    <div style={{ padding:16, overflowY:'auto', flex:1 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <div style={{ fontSize:12, color:'var(--gw-mist)' }}>{showings.length} showing{showings.length !== 1 ? 's' : ''}</div>
        <button className="btn btn--primary btn--sm" onClick={() => setShowForm(p => !p)}>
          <Icon name="plus" size={13} /> Log Showing
        </button>
      </div>
      {showForm && (
        <div style={{ background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:14, marginBottom:14 }}>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Date &amp; Time</label><input className="form-control" type="datetime-local" value={form.showing_date} onChange={e=>setForm(p=>({...p,showing_date:e.target.value}))} /></div>
            <div className="form-group"><label className="form-label">Buyer's Agent</label><input className="form-control" value={form.buyer_agent_name} onChange={e=>setForm(p=>({...p,buyer_agent_name:e.target.value}))} placeholder="Agent name" /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Feedback</label><input className="form-control" value={form.feedback} onChange={e=>setForm(p=>({...p,feedback:e.target.value}))} placeholder="Buyer's reaction…" /></div>
            <div className="form-group"><label className="form-label">Rating (1–5)</label>
              <select className="form-control" value={form.rating} onChange={e=>setForm(p=>({...p,rating:e.target.value}))}>
                <option value="">—</option>{[1,2,3,4,5].map(r=><option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
            <button className="btn btn--secondary btn--sm" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn--primary btn--sm" onClick={add} disabled={adding}>{adding ? 'Saving…' : 'Log Showing'}</button>
          </div>
        </div>
      )}
      {loading ? <div style={{ fontSize:13, color:'var(--gw-mist)' }}>Loading…</div>
        : showings.length === 0 ? <div style={{ textAlign:'center', color:'var(--gw-mist)', fontSize:13, padding:'24px 0' }}>No showings logged yet.</div>
        : showings.map(s => (
          <div key={s.id} style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:8, background:'#fff' }}>
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:600 }}>
                  {new Date(s.showing_date).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' })}
                  {s.rating && <span style={{ marginLeft:8, fontSize:12 }}>{'★'.repeat(s.rating)}{'☆'.repeat(5-s.rating)}</span>}
                </div>
                {s.buyer_agent_name && <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:2 }}>{s.buyer_agent_name}</div>}
                {s.feedback && <div style={{ fontSize:12, color:'var(--gw-ink)', marginTop:4, fontStyle:'italic' }}>"{s.feedback}"</div>}
              </div>
              <button className="btn btn--ghost btn--icon btn--sm" onClick={() => remove(s.id)}><Icon name="trash" size={12} /></button>
            </div>
          </div>
        ))
      }
    </div>
  )
}

const DEFAULT_MARKETING_STEPS = [
  'Professional photos uploaded','Virtual tour created','Listed on MLS',
  'Syndicated to Zillow/Realtor.com','Social media posts scheduled',
  'Open house scheduled','Lockbox installed','Yard sign placed',
]

function MarketingChecklistTab({ property }) {
  const [steps, setSteps]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [tableReady, setTableReady] = useState(true)
  const [newTitle, setNewTitle]   = useState('')
  const [adding, setAdding]       = useState(false)

  React.useEffect(() => { if (property?.id) loadSteps() }, [property?.id])

  const loadSteps = async () => {
    setLoading(true)
    const { data, error } = await supabase.from('listing_checklist_steps').select('*').eq('property_id', property.id).order('sort_order', { ascending:true })
    if (error?.code === '42P01') { setTableReady(false); setLoading(false); return }
    if ((data||[]).length === 0 && property.status === 'active') {
      const rows = DEFAULT_MARKETING_STEPS.map((title, i) => ({ property_id:property.id, title, completed:false, sort_order:i }))
      const { data: created } = await supabase.from('listing_checklist_steps').insert(rows).select()
      setSteps(created || [])
      pushToast('Marketing checklist created', 'info')
    } else {
      setSteps(data || [])
    }
    setLoading(false)
  }

  const toggle = async (step) => {
    const now = new Date().toISOString()
    const patch = { completed:!step.completed, completed_at:!step.completed ? now : null }
    await supabase.from('listing_checklist_steps').update(patch).eq('id', step.id)
    setSteps(p => p.map(s => s.id === step.id ? { ...s, ...patch } : s))
  }

  const addStep = async () => {
    if (!newTitle.trim()) return
    setAdding(true)
    const { data, error } = await supabase.from('listing_checklist_steps').insert([{
      property_id:property.id, title:newTitle.trim(), completed:false, sort_order:steps.length,
    }]).select().single()
    setAdding(false)
    if (error) { pushToast(error.message, 'error'); return }
    setSteps(p => [...p, data]); setNewTitle('')
  }

  const removeStep = async (id) => {
    await supabase.from('listing_checklist_steps').delete().eq('id', id)
    setSteps(p => p.filter(s => s.id !== id))
  }

  if (!tableReady) return (
    <div style={{ padding:20 }}>
      <div style={{ background:'#fff8ec', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:16, fontSize:13, lineHeight:1.7 }}>
        <strong>Run this SQL in Supabase Dashboard → SQL Editor:</strong>
        <pre style={{ background:'var(--gw-slate)', color:'#e2e8f0', padding:10, borderRadius:6, fontSize:11, marginTop:8, overflowX:'auto' }}>
{`create table if not exists listing_checklist_steps (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid references properties(id) on delete cascade,
  title        text not null,
  completed    boolean default false,
  completed_at timestamptz,
  sort_order   int default 0,
  created_at   timestamptz default now()
);
alter table listing_checklist_steps enable row level security;
create policy "agents_listing_checklist" on listing_checklist_steps
  for all to authenticated using (true) with check (true);`}
        </pre>
        <button className="btn btn--secondary btn--sm" style={{ marginTop:8 }} onClick={() => { setTableReady(true); loadSteps() }}>
          <Icon name="refresh" size={12} /> Retry
        </button>
      </div>
    </div>
  )

  if (loading) return <div style={{ padding:24, fontSize:13, color:'var(--gw-mist)' }}>Loading checklist…</div>

  const doneCount = steps.filter(s => s.completed).length
  const pct = steps.length > 0 ? Math.round(doneCount / steps.length * 100) : 0

  return (
    <div style={{ padding:16, overflowY:'auto', flex:1 }}>
      {steps.length > 0 && (
        <div style={{ marginBottom:16 }}>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, fontWeight:600, marginBottom:6 }}>
            <span>{doneCount}/{steps.length} complete</span>
            <span style={{ color: pct === 100 ? 'var(--gw-green)' : 'var(--gw-mist)' }}>{pct}%</span>
          </div>
          <div style={{ height:6, background:'var(--gw-border)', borderRadius:3, overflow:'hidden' }}>
            <div style={{ width:`${pct}%`, height:'100%', background: pct === 100 ? 'var(--gw-green)' : 'var(--gw-azure)', borderRadius:3, transition:'width 300ms ease' }} />
          </div>
        </div>
      )}
      {steps.length === 0 && property.status !== 'active' && (
        <div style={{ textAlign:'center', padding:'20px 0', color:'var(--gw-mist)', fontSize:13 }}>
          Checklist auto-creates when status is <strong>Active</strong>.<br/>Or add steps manually below.
        </div>
      )}
      {steps.map(step => (
        <div key={step.id} onClick={() => toggle(step)}
          style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 10px', borderRadius:'var(--radius)', cursor:'pointer', marginBottom:3, transition:'background 120ms' }}
          onMouseEnter={e=>e.currentTarget.style.background='var(--gw-bone)'}
          onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
          <div style={{ width:20, height:20, borderRadius:4, border:`2px solid ${step.completed?'var(--gw-green)':'var(--gw-border)'}`, background:step.completed?'var(--gw-green)':'#fff', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, transition:'all 150ms' }}>
            {step.completed && <Icon name="check" size={11} style={{ color:'#fff' }} />}
          </div>
          <span style={{ flex:1, fontSize:13, textDecoration:step.completed?'line-through':'none', color:step.completed?'var(--gw-mist)':'var(--gw-ink)' }}>{step.title}</span>
          {step.completed && step.completed_at && (
            <span style={{ fontSize:10, color:'var(--gw-mist)', whiteSpace:'nowrap' }}>
              {new Date(step.completed_at).toLocaleDateString('en-US', { month:'short', day:'numeric' })}
            </span>
          )}
          <button className="btn btn--ghost btn--icon" style={{ padding:2, opacity:0.4 }}
            onClick={e=>{e.stopPropagation();removeStep(step.id)}}><Icon name="x" size={11} /></button>
        </div>
      ))}
      <div style={{ display:'flex', gap:8, marginTop:12 }}>
        <input className="form-control" style={{ flex:1, fontSize:13 }} placeholder="Add a step…"
          value={newTitle} onChange={e=>setNewTitle(e.target.value)}
          onKeyDown={e=>e.key==='Enter'&&addStep()} disabled={adding} />
        <button className="btn btn--secondary btn--sm" onClick={addStep} disabled={adding||!newTitle.trim()}>Add</button>
      </div>
    </div>
  )
}

function CompsTab({ property, onUpdateComps }) {
  const comps = Array.isArray(property?.comps) ? property.comps : []
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving]     = useState(false)
  const [form, setForm]         = useState({ address:'', sold_price:'', sold_date:'', sqft:'', beds:'', baths:'', distance:'' })

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const add = async () => {
    if (!form.address.trim() || !form.sold_price) { pushToast('Address and sale price are required', 'error'); return }
    setSaving(true)
    const newComp = {
      id: Date.now(),
      address: form.address.trim(),
      sold_price: Number(form.sold_price),
      sold_date: form.sold_date || null,
      sqft: form.sqft ? Number(form.sqft) : null,
      beds: form.beds ? Number(form.beds) : null,
      baths: form.baths ? Number(form.baths) : null,
      distance: form.distance ? Number(form.distance) : null,
    }
    const newComps = [...comps, newComp]
    const { error } = await supabase.from('properties').update({ comps: newComps }).eq('id', property.id)
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    onUpdateComps(newComps)
    setForm({ address:'', sold_price:'', sold_date:'', sqft:'', beds:'', baths:'', distance:'' })
    setShowForm(false)
    pushToast('Comp added')
  }

  const remove = async (id) => {
    const newComps = comps.filter(c => c.id !== id)
    await supabase.from('properties').update({ comps: newComps }).eq('id', property.id)
    onUpdateComps(newComps)
  }

  const avgSoldPrice   = comps.length > 0 ? comps.reduce((s, c) => s + (c.sold_price || 0), 0) / comps.length : 0
  const compsWithSqft  = comps.filter(c => c.sqft > 0)
  const avgPricePerSqft = compsWithSqft.length > 0
    ? compsWithSqft.reduce((s, c) => s + c.sold_price / c.sqft, 0) / compsWithSqft.length : 0

  return (
    <div style={{ padding:16, overflowY:'auto', flex:1 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
        <div style={{ fontSize:12, color:'var(--gw-mist)' }}>{comps.length} comp{comps.length!==1?'s':''}</div>
        <button className="btn btn--primary btn--sm" onClick={() => setShowForm(p => !p)}>
          <Icon name="plus" size={13} /> Add Comp
        </button>
      </div>
      {comps.length > 0 && (
        <div style={{ display:'flex', gap:12, marginBottom:16, padding:'12px 14px', background:'var(--gw-sky)', borderRadius:'var(--radius)', border:'1px solid var(--gw-azure)' }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--gw-azure)', marginBottom:2 }}>Avg Comp Value</div>
            <div style={{ fontSize:18, fontWeight:700 }}>{formatCurrency(avgSoldPrice)}</div>
          </div>
          {avgPricePerSqft > 0 && (
            <div style={{ flex:1 }}>
              <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--gw-azure)', marginBottom:2 }}>Avg $/sqft</div>
              <div style={{ fontSize:18, fontWeight:700 }}>${Math.round(avgPricePerSqft)}</div>
            </div>
          )}
          {property.list_price > 0 && avgSoldPrice > 0 && (
            <div style={{ flex:1 }}>
              <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--gw-azure)', marginBottom:2 }}>vs List Price</div>
              <div style={{ fontSize:18, fontWeight:700, color: avgSoldPrice >= property.list_price ? 'var(--gw-green)' : '#dc2626' }}>
                {avgSoldPrice >= property.list_price ? '+' : ''}{formatCurrency(avgSoldPrice - property.list_price)}
              </div>
            </div>
          )}
        </div>
      )}
      {showForm && (
        <div style={{ background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:14, marginBottom:14 }}>
          <div className="form-group"><label className="form-label required">Address</label><input className="form-control" value={form.address} onChange={e=>set('address',e.target.value)} placeholder="123 Oak Street" /></div>
          <div className="form-row">
            <div className="form-group"><label className="form-label required">Sale Price</label><input className="form-control" type="number" value={form.sold_price} onChange={e=>set('sold_price',e.target.value)} placeholder="450000" /></div>
            <div className="form-group"><label className="form-label">Sale Date</label><input className="form-control" type="date" value={form.sold_date} onChange={e=>set('sold_date',e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Beds</label><input className="form-control" type="number" value={form.beds} onChange={e=>set('beds',e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Baths</label><input className="form-control" type="number" step="0.5" value={form.baths} onChange={e=>set('baths',e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={form.sqft} onChange={e=>set('sqft',e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Distance (mi)</label><input className="form-control" type="number" step="0.1" value={form.distance} onChange={e=>set('distance',e.target.value)} placeholder="0.5" /></div>
          </div>
          <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
            <button className="btn btn--secondary btn--sm" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn--primary btn--sm" onClick={add} disabled={saving}>{saving?'Saving…':'Add Comp'}</button>
          </div>
        </div>
      )}
      {comps.length === 0 && !showForm
        ? <div style={{ textAlign:'center', color:'var(--gw-mist)', fontSize:13, padding:'24px 0' }}>No comps yet. Add comparable sales to analyze market position.</div>
        : comps.map(c => (
          <div key={c.id} style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'10px 12px', marginBottom:8, background:'#fff' }}>
            <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:8 }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:600 }}>{c.address}</div>
                <div style={{ fontSize:13, fontWeight:700, marginTop:2 }}>
                  {formatCurrency(c.sold_price)}
                  {c.sqft > 0 && <span style={{ fontSize:11, fontWeight:400, color:'var(--gw-mist)', marginLeft:8 }}>${Math.round(c.sold_price/c.sqft)}/sqft</span>}
                </div>
                <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2, display:'flex', gap:8, flexWrap:'wrap' }}>
                  {c.beds && <span>{c.beds} bd</span>}
                  {c.baths && <span>{c.baths} ba</span>}
                  {c.sqft && <span>{Number(c.sqft).toLocaleString()} sqft</span>}
                  {c.sold_date && <span>{new Date(c.sold_date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>}
                  {c.distance && <span>{c.distance} mi away</span>}
                </div>
              </div>
              <button className="btn btn--ghost btn--icon btn--sm" onClick={() => remove(c.id)}><Icon name="trash" size={12} /></button>
            </div>
          </div>
        ))
      }
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function PropertyDrawer({ open, onClose, property, agents, contacts, activeAgent, onSave, go, setDb }) {
  const blank = { address:'', city:'', state:'', zip:'', county:'', submarket:'', type:'residential', status:'active', list_price:'', sqft:'', beds:'', baths:'', garage:0, mls_number:'', linked_contact_id:'', assigned_agent_id:'', notes:'', details:{}, listing_expiry_date:'', price_history:[], comps:[] }
  const [form, setForm]             = useState(property || blank)
  const [errors, setErrors]         = useState({})
  const [saving, setSaving]         = useState(false)
  const [startingDeal, setStartingDeal] = useState(false)
  const [tab, setTab]               = useState('details')
  const [tempId] = useState(() => property?.id || crypto.randomUUID())

  React.useEffect(() => {
    setForm(property
      ? { ...blank, ...property, details: property.details || {}, price_history: property.price_history || [], comps: property.comps || [], listing_expiry_date: property.listing_expiry_date ? property.listing_expiry_date.slice(0,10) : '' }
      : { ...blank, assigned_agent_id: activeAgent?.id || '' })
    setErrors({})
    setTab('details')
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

    // Track price reductions automatically
    const oldPrice = property?.list_price ? Number(property.list_price) : null
    const newPrice = form.list_price ? Number(form.list_price) : null
    let updatedHistory = Array.isArray(form.price_history) ? form.price_history : []
    if (property?.id && oldPrice && newPrice && oldPrice !== newPrice) {
      updatedHistory = [...updatedHistory, {
        price: newPrice,
        previous_price: oldPrice,
        date: new Date().toISOString().slice(0, 10),
      }]
    }

    const payload = {
      ...form,
      id:                   resolvedId,
      list_price:           form.list_price ? Number(form.list_price) : null,
      sqft:                 form.sqft       ? Number(form.sqft)       : null,
      beds:                 form.beds       ? Number(form.beds)       : null,
      baths:                form.baths      ? Number(form.baths)      : null,
      garage:               form.garage != null ? Number(form.garage) : 0,
      linked_contact_id:    form.linked_contact_id || null,
      assigned_agent_id:    form.assigned_agent_id || activeAgent?.id || null,
      listing_expiry_date:  form.listing_expiry_date || null,
      price_history:        updatedHistory,
      comps:                form.comps || [],
    }
    let error, data
    if (property?.id) {
      ({ error, data } = await supabase.from('properties').update(payload).eq('id', property.id).select().single())
    } else {
      ({ error, data } = await supabase.from('properties').insert([payload]).select().single())
    }
    setSaving(false)
    if (error) { pushToast(friendlyDbError(error) || error.message, 'error'); return }

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

  const isExisting = !!property?.id

  return (
    <Drawer open={open} onClose={onClose} title={property?.id ? 'Edit Property' : 'Add Property'} width={520}>
      {/* Tab bar — only for existing properties */}
      {isExisting && (
        <div className="drawer-tabs">
          {[['details','Details'],['history','Price History'],['showings','Showings'],['marketing','Marketing'],['comps','Comps']].map(([id, label]) => (
            <button key={id} className={`drawer-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Non-details tabs */}
      {tab === 'history'   && isExisting && <PriceHistoryTab property={{ ...property, price_history: form.price_history }} />}
      {tab === 'showings'  && isExisting && <ShowingsTab property={property} />}
      {tab === 'marketing' && isExisting && <MarketingChecklistTab property={property} />}
      {tab === 'comps'     && isExisting && (
        <CompsTab
          property={{ ...property, comps: form.comps, list_price: form.list_price ? Number(form.list_price) : property.list_price }}
          onUpdateComps={(newComps) => {
            set('comps', newComps)
            if (onSave) onSave({ ...property, comps: newComps })
          }}
        />
      )}

      {/* Details tab (also shown for new properties) */}
      {(tab === 'details' || !isExisting) && (<>
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
          <div className="form-group">
            <label className="form-label">Submarket</label>
            <OptionSelect
              fieldKey="submarket"
              value={form.submarket || ''}
              onChange={v => set('submarket', v)}
              placeholder="Select submarket…"
              allowAdd
            />
          </div>
          <div className="form-group"><label className="form-label">MLS #</label><input className="form-control" value={form.mls_number||''} onChange={e=>set('mls_number',e.target.value)} /></div>
        </div>

        {/* Google Maps embed — shown when address exists */}
        {form.address && (
          <div className="form-group">
            <iframe
              title="Property Map"
              src={`https://maps.google.com/maps?q=${encodeURIComponent([form.address, form.city, form.state, form.zip].filter(Boolean).join(', '))}&output=embed`}
              width="100%" height="200"
              style={{ border:0, borderRadius:'var(--radius)', display:'block' }}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          </div>
        )}

        {/* Type + Status */}
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Property Type</label>
            <select className="form-control" value={form.type} onChange={e=>set('type',e.target.value)}>
              <optgroup label="Residential">
                {RESIDENTIAL_PROPERTY_TYPES.map(t=><option key={t} value={t}>{PROPERTY_TYPE_LABELS[t]}</option>)}
              </optgroup>
              <optgroup label="Commercial">
                {COMMERCIAL_PROPERTY_TYPES.map(t=><option key={t} value={t}>{PROPERTY_TYPE_LABELS[t]}</option>)}
              </optgroup>
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Status</label>
            <select className="form-control" value={form.status} onChange={e=>set('status',e.target.value)}>
              {PROPERTY_STATUSES.map(s=><option key={s} value={s}>{s.charAt(0).toUpperCase()+s.slice(1).replace('-',' ')}</option>)}
            </select>
          </div>
        </div>

        {/* Price + Expiry */}
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">{commercial ? 'Asking Price / Value' : 'List Price'}</label>
            <input className="form-control" type="number" value={form.list_price||''} onChange={e=>set('list_price',e.target.value)} placeholder="0" />
          </div>
          <div className="form-group">
            <label className="form-label">Listing Expiry Date</label>
            <input className="form-control" type="date" value={form.listing_expiry_date||''} onChange={e=>set('listing_expiry_date',e.target.value)} />
          </div>
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

        {/* ── Possible Buyers — powered by the matching engine ── */}
        <PossibleBuyers form={form} contacts={contacts} />
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
              title="Copy share link — works on social media, email, and text"
              onClick={() => {
                const url = `${window.location.origin}/share/${property.id}`
                navigator.clipboard.writeText(url).then(() => pushToast('Share link copied! Works on social, email & text.'))
              }}
            >
              <Icon name="link" size={13} />
              Share Link
            </button>
          </div>
        )}
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Property'}</button>
      </div>
      </>)}
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

export default function PropertiesPage({ db, setDb, activeAgent, go, visibleAgentIds }) {
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
    if (!visibleAgentIds?.length) return
    const { data, error } = await supabase.from('properties').select('*')
      .in('assigned_agent_id', visibleAgentIds)
      .order('created_at', { ascending: false })
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
