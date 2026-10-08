import React, { useState } from 'react'
import { Icon, pushToast } from '../../../components/UI.jsx'
import { streetLine } from '../../../lib/address.js'
import { deleteOm, normalizeOm } from '../../../lib/om.js'
import { fieldLabel, normImg, uploadImageToStorage } from './imageUpload.js'
import { ImageRow } from './ImageRow.jsx'
import { OmUploadField } from './OmUploadField.jsx'
import { DocumentsField } from './DealRoomBuilder.jsx'

// ─── Portfolio builder ────────────────────────────────────────────────────────
/**
 * One QR code for several properties. Stored on landing_config.portfolio:
 *
 *   [{ id, crm_property_id, name, asset_line, location_line, description,
 *      price, units, price_per_unit, cap_rate, noi, gross_income,
 *      building_sqft, occupancy, year_built, images[], om, documents[] }]
 *
 * The page's headline, story, NDA, teaser rules and updates still describe the
 * whole offering; each property here gets its own card on the landing page,
 * with its own photos, numbers, OM and documents. What a visitor may see is
 * decided on the server (api/_lib/dealRoom.js), same as a single property.
 */

export const MAX_PORTFOLIO = 12
const MAX_PHOTOS = 10

const FACT_FIELDS = [
  { key:'price',          label:'Asking Price',   ph:'$1,200,000' },
  { key:'units',          label:'Units',          ph:'12' },
  { key:'price_per_unit', label:'Price / Unit',   ph:'$100,000' },
  { key:'cap_rate',       label:'Cap Rate',       ph:'6.4%' },
  { key:'noi',            label:'NOI',            ph:'$76,800' },
  { key:'gross_income',   label:'Gross Income',   ph:'$132,000' },
  { key:'building_sqft',  label:'Building Sq Ft', ph:'9,600' },
  { key:'occupancy',      label:'Occupancy',      ph:'96%' },
  { key:'year_built',     label:'Year Built',     ph:'1978' },
]

const TYPE_LABEL = {
  multifamily:'Multifamily', office:'Office', land:'Land', retail:'Retail', industrial:'Industrial',
  'mixed-use':'Mixed-Use', commercial:'Commercial',
}

const newId = () => `p-${Math.random().toString(36).slice(2, 10)}`
const propertyPhotos = (p) => Array.isArray(p?.details?.photos) ? p.details.photos.filter(Boolean) : []

/** Fields to pre-fill from a CRM property — only where the entry is still empty. */
export function prefillFromProperty(entry, p) {
  const d = p.details || {}
  const units = d.total_units
  const fill = {
    crm_property_id: p.id,
    name:           streetLine(p) || '',
    location_line:  [p.city, p.state].filter(Boolean).join(', '),
    asset_line:     [TYPE_LABEL[p.type], units ? `${units} Units` : null].filter(Boolean).join(' · '),
    price:          p.list_price ? String(p.list_price) : '',
    units:          units ? String(units) : '',
    building_sqft:  p.sqft ? String(p.sqft) : '',
    year_built:     d.year_built || p.year_built ? String(d.year_built || p.year_built) : '',
    price_per_unit: p.list_price && units ? String(Math.round(Number(p.list_price) / Number(units))) : '',
  }
  const next = { ...entry, crm_property_id: p.id }
  Object.entries(fill).forEach(([k, v]) => { if (v && !entry[k]) next[k] = v })
  const hasPhotos = (entry.images || []).some(im => (typeof im === 'string' ? im : im?.url)?.trim())
  if (!hasPhotos && propertyPhotos(p).length) {
    next.images = propertyPhotos(p).slice(0, MAX_PHOTOS).map(url => ({ url, units:'', price:'', caption:'' }))
  }
  return next
}

export function PortfolioBuilder({ cfg, setCfg, properties = [] }) {
  const list = Array.isArray(cfg.portfolio) ? cfg.portfolio : []
  const on = list.length > 0
  const [openId, setOpenId] = useState(list[0]?.id || null)

  const save = (next) => setCfg('portfolio', next)
  const update = (i, patch) => save(list.map((p, idx) => idx === i ? { ...p, ...patch } : p))
  const add = () => {
    const entry = { id: newId(), name: '', images: [], documents: [] }
    save([...list, entry].slice(0, MAX_PORTFOLIO))
    setOpenId(entry.id)
  }
  const remove = (i) => {
    const p = list[i]
    if (!window.confirm(`Remove ${p.name || `property ${i + 1}`} from the portfolio? Its OM and documents are deleted.`)) return
    const om = normalizeOm(p.om)
    if (om?.path) deleteOm(om.path)
    ;(p.documents || []).forEach(d => d?.path && deleteOm(d.path))
    save(list.filter((_, idx) => idx !== i))
  }
  const move = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= list.length) return
    const next = [...list]; [next[i], next[j]] = [next[j], next[i]]
    save(next)
  }

  const small = { fontSize:11, color:'var(--gw-mist)', lineHeight:1.45 }

  return (
    <div style={{ border:'1px solid #d8e0f0', borderRadius:10, padding:12, background:'#f8faff', display:'grid', gap:10 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
        <Icon name="building" size={14} />
        <div style={{ fontSize:13, fontWeight:700 }}>Portfolio</div>
        <div style={small}>· one QR code, several properties</div>
        {!on && (
          <button type="button" className="btn btn--ghost" onClick={add} style={{ fontSize:12, marginLeft:'auto' }}>
            <Icon name="plus" size={12} /> Make this a portfolio
          </button>
        )}
      </div>

      {!on ? (
        <div style={small}>
          Selling several properties together? Add each one here and the landing page breaks them out — every property
          gets its own photos, numbers, OM and documents inside the one Deal Room. The headline, story and photos above
          then describe the portfolio as a whole.
        </div>
      ) : (
        <>
          <div style={small}>
            The headline, opening copy and photos above describe the whole portfolio. Each property below gets its own card
            on the page. Teaser mode, the NDA and the price setting in the Deal Room panel apply to every property.
          </div>
          {list.map((p, i) => (
            <PropertyEntry key={p.id || i} entry={p} index={i} count={list.length}
                           open={openId === p.id} onToggle={() => setOpenId(openId === p.id ? null : p.id)}
                           properties={properties}
                           onChange={(patch) => update(i, patch)} onReplace={(next) => save(list.map((x, idx) => idx === i ? next : x))}
                           onRemove={() => remove(i)} onMove={(dir) => move(i, dir)} />
          ))}
          {list.length < MAX_PORTFOLIO && (
            <button type="button" className="btn btn--ghost" onClick={add} style={{ fontSize:12, justifySelf:'start' }}>
              <Icon name="plus" size={12} /> Add a property
            </button>
          )}
        </>
      )}
    </div>
  )
}

function PropertyEntry({ entry, index, count, open, onToggle, properties, onChange, onReplace, onRemove, onMove }) {
  const [uploading, setUploading] = useState({})
  const images = Array.isArray(entry.images) ? entry.images.map(normImg) : []
  const om = normalizeOm(entry.om)
  const docCount = (om ? 1 : 0) + (entry.documents?.length || 0)
  const crm = properties.find(x => x.id === entry.crm_property_id)

  const setImage = (i, field, val) => onChange({ images: images.map((im, idx) => idx === i ? { ...im, [field]: val } : im) })
  const uploadImage = async (i, file) => {
    if (!file) return
    try {
      const url = await uploadImageToStorage(file, setUploading, i)
      setImage(i, 'url', url)
    } catch (err) { pushToast('Upload failed: ' + err.message, 'error') }
  }

  const pickCrm = (pid) => {
    const p = properties.find(x => x.id === pid)
    if (!p) { onChange({ crm_property_id: null }); return }
    const next = prefillFromProperty(entry, p)
    onReplace(next)
    if (next.images !== entry.images) pushToast(`${next.images.length} photo(s) imported from the property`, 'success')
  }

  const iconBtn = { padding:'4px 7px' }

  return (
    <div style={{ border:'1px solid var(--gw-border)', borderRadius:8, background:'#fff' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px' }}>
        <button type="button" onClick={onToggle} aria-expanded={open}
                style={{ flex:1, minWidth:0, display:'flex', alignItems:'center', gap:8, background:'none', border:0,
                         padding:0, cursor:'pointer', textAlign:'left' }}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          <span style={{ fontSize:12.5, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {String(index + 1).padStart(2, '0')} · {entry.name || 'Untitled property'}
          </span>
          <span style={{ fontSize:11, color:'var(--gw-mist)', whiteSpace:'nowrap' }}>
            {images.length} photo{images.length === 1 ? '' : 's'} · {docCount} file{docCount === 1 ? '' : 's'}
          </span>
        </button>
        <button type="button" className="btn btn--ghost" style={iconBtn} disabled={index === 0} onClick={() => onMove(-1)} title="Move up">
          <Icon name="chevronUp" size={12} />
        </button>
        <button type="button" className="btn btn--ghost" style={iconBtn} disabled={index === count - 1} onClick={() => onMove(1)} title="Move down">
          <Icon name="chevronDown" size={12} />
        </button>
        <button type="button" className="btn btn--ghost" style={iconBtn} onClick={onRemove} title="Remove property">
          <Icon name="x" size={12} />
        </button>
      </div>

      {open && (
        <div style={{ display:'grid', gap:10, padding:'0 10px 12px' }}>
          {properties.length > 0 && (
            <div>
              <label style={fieldLabel}>Link to CRM Property (auto-fills empty fields)</label>
              <select className="input" value={entry.crm_property_id || ''} onChange={e => pickCrm(e.target.value)}>
                <option value="">— select to auto-fill, or fill manually —</option>
                {properties.map(p => (
                  <option key={p.id} value={p.id}>
                    {streetLine(p)}{p.city ? `, ${p.city}` : ''}{p.state ? `, ${p.state}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
            <div>
              <label style={fieldLabel}>Property name *</label>
              <input className="input" maxLength={100} value={entry.name || ''} placeholder="Oak Street Apartments"
                     onChange={e => onChange({ name: e.target.value })} />
            </div>
            <div>
              <label style={fieldLabel}>Asset line</label>
              <input className="input" maxLength={60} value={entry.asset_line || ''} placeholder="Multifamily · 12 Units"
                     onChange={e => onChange({ asset_line: e.target.value })} />
            </div>
            <div>
              <label style={fieldLabel}>Location</label>
              <input className="input" maxLength={100} value={entry.location_line || ''} placeholder="Marshalltown, IA"
                     onChange={e => onChange({ location_line: e.target.value })} />
            </div>
          </div>

          <div>
            <label style={fieldLabel}>Key details</label>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, marginTop:4 }}>
              {FACT_FIELDS.map(f => (
                <div key={f.key}>
                  <label style={{ fontSize:10, fontWeight:700, color:'var(--gw-mist)', textTransform:'uppercase', letterSpacing:0.4, display:'block', marginBottom:3 }}>
                    {f.label}
                  </label>
                  <input className="input" placeholder={f.ph} value={entry[f.key] || ''}
                         onChange={e => onChange({ [f.key]: e.target.value })} />
                </div>
              ))}
            </div>
            <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6, lineHeight:1.4 }}>
              Leave a field blank to hide it. In teaser mode, cap rate, NOI, gross income, price/unit and occupancy show
              only to registered visitors.
            </div>
          </div>

          <div>
            <label style={fieldLabel}>Description</label>
            <textarea className="input" rows={3} value={entry.description || ''}
                      placeholder="What makes this property worth a look — location, condition, upside."
                      onChange={e => onChange({ description: e.target.value })} />
          </div>

          <div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8 }}>
              <label style={fieldLabel}>Photos (up to {MAX_PHOTOS})</label>
              {crm && propertyPhotos(crm).length > 0 && (
                <button type="button" className="btn btn--ghost" style={{ fontSize:11.5 }}
                        onClick={() => onChange({ images: propertyPhotos(crm).slice(0, MAX_PHOTOS).map(url => ({ url, units:'', price:'', caption:'' })) })}>
                  <Icon name="download" size={12} /> Use property's {propertyPhotos(crm).length} photo(s)
                </button>
              )}
            </div>
            <div style={{ display:'grid', gap:8, marginTop:4 }}>
              {images.map((img, i) => (
                <ImageRow key={i} img={img} index={i} uploading={uploading}
                          onField={(f, v) => setImage(i, f, v)}
                          onUpload={file => uploadImage(i, file)}
                          onRemove={() => onChange({ images: images.filter((_, idx) => idx !== i) })}
                          unitsLabel="Caption / label" priceLabel="Note (optional)" />
              ))}
              {images.length < MAX_PHOTOS && (
                <button type="button" className="btn btn--ghost" style={{ fontSize:12, alignSelf:'flex-start' }}
                        onClick={() => onChange({ images: [...images, { url:'', units:'', price:'', caption:'' }] })}>
                  <Icon name="plus" size={12} /> Add photo
                </button>
              )}
            </div>
            <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6 }}>The first photo is this property's cover.</div>
          </div>

          <OmUploadField cfg={entry} setCfg={(k, v) => onChange({ [k]: v })}
                         label="This property's OM (PDF)"
                         hint="Listed under this property in the Deal Room. Visitors download it there after registering." />

          <DocumentsField docs={Array.isArray(entry.documents) ? entry.documents : []}
                          onChange={(documents) => onChange({ documents })}
                          label="This property's documents (rent roll, T-12…)" />
        </div>
      )}
    </div>
  )
}
