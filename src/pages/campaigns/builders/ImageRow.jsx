import React from 'react'
import { Icon } from '../../../components/UI.jsx'

// ─── Image row with upload (shared between builders) ─────────────────────────

export function ImageRow({ img, index, uploading, onField, onUpload, onRemove, maxPhotos, unitsLabel = 'Units', priceLabel = 'Sale price / note' }) {
  return (
    <div style={{ border:'1px solid var(--gw-border)', borderRadius:8, padding:10, background:'#fff' }}>
      <div style={{ display:'flex', gap:6, alignItems:'center' }}>
        <div style={{ width:52, height:52, borderRadius:6, border:'1px solid var(--gw-border)',
                      flexShrink:0, overflow:'hidden', background:'var(--gw-bone)',
                      display:'flex', alignItems:'center', justifyContent:'center' }}>
          {img.url
            ? <img src={img.url} alt="" style={{ width:'100%', height:'100%', objectFit:'cover' }}
                   onError={e => { e.currentTarget.style.display = 'none' }} />
            : <span style={{ fontSize:10, color:'var(--gw-mist)' }}>#{index + 1}</span>}
        </div>
        <input className="input" placeholder="Paste image URL…" value={img.url}
               onChange={e => onField('url', e.target.value)} style={{ flex:1 }} />
        <label title="Upload from your computer"
               style={{ display:'flex', alignItems:'center', gap:4,
                        cursor: uploading[index] ? 'wait' : 'pointer',
                        padding:'7px 10px', border:'1px solid var(--gw-border)', borderRadius:6,
                        fontSize:11.5, fontWeight:600, background:'#fff', flexShrink:0, whiteSpace:'nowrap' }}>
          {uploading[index]
            ? <><Icon name="loader" size={11} /> Uploading…</>
            : <><Icon name="upload" size={11} /> Upload</>}
          <input type="file" accept="image/*" style={{ display:'none' }}
                 onChange={e => { onUpload(e.target.files?.[0]); e.target.value = '' }} />
        </label>
        <button type="button" className="btn btn--ghost" onClick={onRemove}
                style={{ padding:'6px 8px', flexShrink:0 }} title="Remove">
          <Icon name="x" size={12} />
        </button>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6, marginTop:8 }}>
        <input className="input" placeholder={unitsLabel} value={img.units || img.caption || ''}
               onChange={e => onField('units', e.target.value)} style={{ fontSize:12 }} />
        <input className="input" placeholder={priceLabel} value={img.price || ''}
               onChange={e => onField('price', e.target.value)} style={{ fontSize:12 }} />
      </div>
    </div>
  )
}
