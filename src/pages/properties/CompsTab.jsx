// Property drawer → Comps tab.

import React, { useState } from 'react'
import { formatCurrency } from '../../lib/helpers.js'
import { Icon, pushToast } from '../../components/UI.jsx'
import { updatePropertyComps } from '../../lib/services/properties.js'

export function CompsTab({ property, onUpdateComps }) {
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
    const { error } = await updatePropertyComps(property.id, newComps)
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    onUpdateComps(newComps)
    setForm({ address:'', sold_price:'', sold_date:'', sqft:'', beds:'', baths:'', distance:'' })
    setShowForm(false)
    pushToast('Comp added')
  }

  const remove = async (id) => {
    const newComps = comps.filter(c => c.id !== id)
    await updatePropertyComps(property.id, newComps)
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
