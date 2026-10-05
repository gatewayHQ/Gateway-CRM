import React, { useState } from 'react'
import { Icon, pushToast } from '../../../components/UI.jsx'
import { streetLine } from '../../../lib/address.js'
import { fieldLabel, normImg, uploadImageToStorage } from './imageUpload.js'
import { ImageRow } from './ImageRow.jsx'
import { DealRoomBuilder } from './DealRoomBuilder.jsx'

// ─── Property Showcase landing config builder ─────────────────────────────────

export function PropertyLandingBuilder({ cfg, setCfg, properties, form, set }) {
  const [uploading, setUploading] = useState({})

  const images   = Array.isArray(cfg.images)   ? cfg.images.map(normImg) : []
  const features = Array.isArray(cfg.features) ? cfg.features             : []

  // 'residential' shows beds/baths/sqft; 'commercial' shows units/cap rate/NOI etc.
  const detailMode = cfg.detail_mode || 'residential'
  const COMMERCIAL_TYPES = ['multifamily','office','land','retail','industrial','mixed-use','commercial']

  // Pull photo URLs off a CRM property record (stored on details.photos)
  const propertyPhotos = (p) => Array.isArray(p?.details?.photos) ? p.details.photos.filter(Boolean) : []

  const importPhotosFrom = (p) => {
    const photos = propertyPhotos(p)
    if (!photos.length) return false
    setCfg('images', photos.map(url => ({ url, units:'', price:'', caption:'' })))
    return true
  }

  const handlePropertySelect = (pid) => {
    set('property_id', pid)
    if (!pid) return
    const p = properties.find(x => x.id === pid)
    if (!p) return

    const commercial = COMMERCIAL_TYPES.includes(p.type)
    const d = p.details || {}

    if (!cfg.headline)                   setCfg('headline',    [streetLine(p), p.city, p.state].filter(Boolean).join(', '))
    if (!cfg.price      && p.list_price) setCfg('price',       String(p.list_price))
    if (!cfg.location_line && (p.city || p.state)) setCfg('location_line', [p.city, p.state].filter(Boolean).join(', '))

    if (commercial) {
      setCfg('detail_mode', 'commercial')
      if (!cfg.units        && d.total_units) setCfg('units',        String(d.total_units))
      if (!cfg.asset_line) {
        const typeLabel = { multifamily:'Multifamily', office:'Office', land:'Land', retail:'Retail', industrial:'Industrial',
                            'mixed-use':'Mixed-Use', commercial:'Commercial' }[p.type] || 'Investment'
        setCfg('asset_line', [typeLabel, d.total_units ? `${d.total_units} Units` : null].filter(Boolean).join(' · '))
      }
      if (!cfg.building_sqft && p.sqft)       setCfg('building_sqft', String(p.sqft))
      if (!cfg.year_built   && d.year_built)  setCfg('year_built',   String(d.year_built))
      if (!cfg.price_per_unit && p.list_price && d.total_units)
        setCfg('price_per_unit', String(Math.round(Number(p.list_price) / Number(d.total_units))))
    } else {
      if (!cfg.beds       && p.beds)       setCfg('beds',        String(p.beds))
      if (!cfg.baths      && p.baths)      setCfg('baths',       String(p.baths))
      if (!cfg.sqft       && p.sqft)       setCfg('sqft',        String(p.sqft))
      if (!cfg.year_built && p.year_built) setCfg('year_built',  String(p.year_built))
    }

    // Auto-import the property's photos into the showcase if none added yet
    const hasImages = (cfg.images || []).some(im => (typeof im === 'string' ? im : im?.url)?.trim())
    if (!hasImages) {
      const imported = importPhotosFrom(p)
      if (imported) pushToast(`${propertyPhotos(p).length} photo(s) imported from the property`, 'success')
    }
  }

  const RESIDENTIAL_FIELDS = [
    { key:'price',      label:'List Price',      ph:'$895,000' },
    { key:'beds',       label:'Bedrooms',        ph:'3' },
    { key:'baths',      label:'Bathrooms',       ph:'2' },
    { key:'sqft',       label:'Sq Ft',           ph:'1,850' },
    { key:'lot_size',   label:'Lot Size (sqft)', ph:'5,200' },
    { key:'year_built', label:'Year Built',      ph:'1928' },
  ]
  const COMMERCIAL_FIELDS = [
    { key:'price',         label:'Asking Price',  ph:'$3,200,000' },
    { key:'units',         label:'Units',         ph:'24' },
    { key:'price_per_unit',label:'Price / Unit',  ph:'$133,000' },
    { key:'cap_rate',      label:'Cap Rate',      ph:'6.1%' },
    { key:'noi',           label:'NOI',           ph:'$195,000' },
    { key:'gross_income',  label:'Gross Income',  ph:'$320,000' },
    { key:'building_sqft', label:'Building Sq Ft',ph:'18,000' },
    { key:'occupancy',     label:'Occupancy',     ph:'94%' },
    { key:'year_built',    label:'Year Built',    ph:'1998' },
  ]
  const detailFields = detailMode === 'commercial' ? COMMERCIAL_FIELDS : RESIDENTIAL_FIELDS

  const selectedProperty = properties.find(x => x.id === form.property_id)

  const setImageField = (i, field, val) => {
    const next = images.map((img, idx) => idx === i ? { ...img, [field]: val } : img)
    setCfg('images', next)
  }
  const addImage    = () => setCfg('images', [...images, { url:'', caption:'', price:'' }].slice(0, 10))
  const removeImage = (i) => setCfg('images', images.filter((_, idx) => idx !== i))

  const uploadFile = async (i, file) => {
    if (!file) return
    try {
      const url = await uploadImageToStorage(file, setUploading, i)
      setImageField(i, 'url', url)
    } catch (err) { pushToast('Upload failed: ' + err.message, 'error') }
  }

  const setFeatureAt    = (i, v) => { const n = [...features]; n[i] = v; setCfg('features', n) }
  const addFeature      = ()     => setCfg('features', [...features, ''])
  const removeFeature   = (i)    => setCfg('features', features.filter((_, idx) => idx !== i))

  return (
    <div style={{ border:'1px solid var(--gw-border)', borderRadius:10, padding:14, background:'#fafaf7' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
        <Icon name="building" size={14} />
        <div style={{ fontSize:13, fontWeight:700 }}>Property Showcase Builder</div>
        <div style={{ fontSize:11, color:'#10b981', fontWeight:600 }}>· Your private CRM notes are never shown</div>
      </div>

      <div style={{ display:'grid', gap:10 }}>
        {properties.length > 0 && (
          <div>
            <label style={fieldLabel}>Link to CRM Property (auto-fills details below)</label>
            <select className="input" value={form.property_id || ''} onChange={e => handlePropertySelect(e.target.value)}>
              <option value="">— select to auto-fill, or fill manually below —</option>
              {properties.map(p => (
                <option key={p.id} value={p.id}>
                  {streetLine(p)}{p.city ? `, ${p.city}` : ''}{p.state ? `, ${p.state}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label style={fieldLabel}>Headline *</label>
          <input className="input" maxLength={160} value={cfg.headline || ''}
                 onChange={e => setCfg('headline', e.target.value)}
                 placeholder="123 Oak Street, Oakland — A Rare Opportunity" />
        </div>

        {/* Hero lines: the pill, the gold line over the headline, and the
            letter-spaced location line under it. */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
          <div>
            <label style={fieldLabel}>Status pill</label>
            <input className="input" maxLength={40} value={cfg.eyebrow || ''}
                   onChange={e => setCfg('eyebrow', e.target.value)}
                   placeholder={detailMode === 'commercial' ? 'Exclusive Offering' : 'Property For Sale'} />
          </div>
          <div>
            <label style={fieldLabel}>Asset line</label>
            <input className="input" maxLength={60} value={cfg.asset_line || ''}
                   onChange={e => setCfg('asset_line', e.target.value)} placeholder="Multifamily · 24 Units" />
          </div>
          <div>
            <label style={fieldLabel}>Location line</label>
            <input className="input" maxLength={100} value={cfg.location_line || ''}
                   onChange={e => setCfg('location_line', e.target.value)} placeholder="Ames · Ankeny · Des Moines" />
          </div>
        </div>

        <div>
          <label style={fieldLabel}>Opening Copy</label>
          <textarea className="input" rows={3} value={cfg.subheadline || ''}
                    onChange={e => setCfg('subheadline', e.target.value)}
                    placeholder="Describe what makes this property special. Your private CRM notes never appear here." />
        </div>

        <div>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8 }}>
            <label style={fieldLabel}>Key Property Details</label>
            {/* Residential / Commercial toggle — swaps which detail fields are shown */}
            <div style={{ display:'flex', border:'1px solid var(--gw-border)', borderRadius:7, overflow:'hidden' }}>
              {[['residential','Residential'],['commercial','Commercial · Multifamily']].map(([val, lbl]) => {
                const sel = detailMode === val
                return (
                  <button key={val} type="button" onClick={() => setCfg('detail_mode', val)}
                          style={{ padding:'5px 12px', border:'none', cursor:'pointer', fontSize:11.5, fontWeight:700,
                                   background: sel ? 'var(--gw-azure)' : '#fff', color: sel ? '#fff' : 'var(--gw-mist)' }}>
                    {lbl}
                  </button>
                )
              })}
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:8, marginTop:8 }}>
            {detailFields.map(f => (
              <div key={f.key}>
                <label style={{ fontSize:10, fontWeight:700, color:'var(--gw-mist)', textTransform:'uppercase', letterSpacing:0.4, display:'block', marginBottom:3 }}>
                  {f.label}
                </label>
                <input className="input" placeholder={f.ph} value={cfg[f.key] || ''}
                       onChange={e => setCfg(f.key, e.target.value)} />
              </div>
            ))}
          </div>
          {detailMode === 'commercial' && (
            <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6, lineHeight:1.4 }}>
              Leave any field blank to hide it on the live page. Cap rate, NOI &amp; gross income aren't stored on the
              CRM property record — enter the figures you want to advertise. With a Deal Room in teaser mode (below),
              cap rate, NOI, gross income, price/unit and occupancy show only to registered visitors.
            </div>
          )}
        </div>

        <div>
          <label style={fieldLabel}>Public Description (visible to visitors)</label>
          <textarea className="input" rows={4} value={cfg.description || ''}
                    onChange={e => setCfg('description', e.target.value)}
                    placeholder="Write a compelling marketing description. Your private CRM notes will never appear here." />
        </div>

        <div>
          <label style={fieldLabel}>Investment Highlights / Selling Points</label>
          <div style={{ display:'grid', gap:6, marginTop:4 }}>
            {features.map((feat, i) => (
              <div key={i} style={{ display:'flex', gap:6 }}>
                <input className="input" placeholder="e.g. Chef's kitchen with quartz counters"
                       value={feat} onChange={e => setFeatureAt(i, e.target.value)} style={{ flex:1 }} />
                <button type="button" className="btn btn--ghost" onClick={() => removeFeature(i)} style={{ padding:'6px 8px' }}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
            {features.length < 10 && (
              <button type="button" className="btn btn--ghost" onClick={addFeature} style={{ fontSize:12, alignSelf:'flex-start' }}>
                <Icon name="plus" size={12} /> Add feature
              </button>
            )}
          </div>
        </div>

        <div>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8 }}>
            <label style={fieldLabel}>Photos (up to 10) — upload or paste URL</label>
            {selectedProperty && propertyPhotos(selectedProperty).length > 0 && (
              <button type="button" className="btn btn--ghost" style={{ fontSize:11.5 }}
                      onClick={() => {
                        if (importPhotosFrom(selectedProperty))
                          pushToast(`${propertyPhotos(selectedProperty).length} photo(s) pulled from the property`, 'success')
                      }}>
                <Icon name="download" size={12} /> Use property's {propertyPhotos(selectedProperty).length} photo(s)
              </button>
            )}
          </div>
          <div style={{ display:'grid', gap:8, marginTop:4 }}>
            {images.map((img, i) => (
              <ImageRow key={i} img={img} index={i} uploading={uploading}
                        onField={(f, v) => setImageField(i, f, v)}
                        onUpload={file => uploadFile(i, file)}
                        onRemove={() => removeImage(i)}
                        unitsLabel="Caption / label"
                        priceLabel="Sold price (optional)" />
            ))}
            {images.length < 10 && (
              <button type="button" className="btn btn--ghost" onClick={addImage} style={{ fontSize:12, alignSelf:'flex-start' }}>
                <Icon name="plus" size={12} /> Add photo
              </button>
            )}
          </div>
          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6, lineHeight:1.4 }}>
            The first photo becomes the page's hero banner; the rest fill the gallery below it.
          </div>
        </div>

        <DealRoomBuilder cfg={cfg} setCfg={setCfg} agentId={form.agent_id} />

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
          <div>
            <label style={fieldLabel}>CTA button text</label>
            <input className="input" maxLength={40} placeholder="Schedule a showing"
                   value={cfg.cta_text || ''} onChange={e => setCfg('cta_text', e.target.value)} />
          </div>
          <div>
            <label style={fieldLabel}>Accent color</label>
            <div style={{ display:'flex', gap:6, alignItems:'center' }}>
              <input type="color" value={cfg.accent || '#1e2642'} onChange={e => setCfg('accent', e.target.value)}
                     style={{ width:42, height:36, border:'1px solid var(--gw-border)', borderRadius:6, padding:2, background:'#fff' }} />
              <input className="input" placeholder="#1e2642" value={cfg.accent || ''}
                     onChange={e => setCfg('accent', e.target.value)} style={{ flex:1 }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
