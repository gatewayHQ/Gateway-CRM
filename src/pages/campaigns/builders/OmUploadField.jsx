import React, { useState } from 'react'
import { Icon, pushToast } from '../../../components/UI.jsx'
import { normalizeOm, uploadOm, deleteOm, formatBytes } from '../../../lib/om.js'
import { fieldLabel } from './imageUpload.js'

// ─── Offering Memorandum upload (shared between builders) ────────────────────
/**
 * Attach an OM PDF to a landing page, behind a name/phone/email gate.
 *
 * The PDF goes into the PRIVATE `campaign-oms` bucket (migration 0045), so
 * unlike the photo uploads above there is no public URL to paste or copy — the
 * only way a visitor reads it is by filling in the gate, which is the entire
 * point. What lands in landing_config is a descriptor: { path, filename, title,
 * size, uploaded_at }.
 */
export function OmUploadField({ cfg, setCfg, label = 'Offering Memorandum (PDF)', hint }) {
  const [busy, setBusy] = useState(false)
  const om = normalizeOm(cfg.om)

  const pick = async (file) => {
    if (!file) return
    setBusy(true)
    try {
      const next = await uploadOm(file)
      // Replacing an OM: drop the old object rather than leaving it paid-for and
      // unreachable in the bucket forever.
      if (om?.path && om.path !== next.path) deleteOm(om.path)
      setCfg('om', { ...next, title: om?.title || '' })
      pushToast('Offering memorandum attached — visitors trade name, phone & email for it', 'success')
    } catch (err) {
      pushToast('Upload failed: ' + err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = () => {
    if (om?.path) deleteOm(om.path)
    setCfg('om', null)
    pushToast('Offering memorandum removed from this page')
  }

  return (
    <div>
      <label style={fieldLabel}>{label}</label>
      <div style={{ fontSize:11, color:'var(--gw-mist)', margin:'3px 0 7px', lineHeight:1.45 }}>
        {hint || 'Gated: the download only unlocks after the visitor gives their name, phone and email. Every unlock lands in the campaign\u2019s OM Downloads tab as a lead.'}
      </div>

      {om ? (
        <div style={{ border:'1px solid var(--gw-border)', borderRadius:8, padding:10, background:'#fff',
                      display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:36, height:36, borderRadius:6, flexShrink:0, display:'grid', placeItems:'center',
                        background:'#fdf3e0', color:'#b8860b', border:'1px solid #f0e0c0' }}>
            <Icon name="om" size={16} />
          </div>
          <div style={{ minWidth:0, flex:1 }}>
            <div style={{ fontSize:12.5, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {om.filename}
            </div>
            <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
              {[formatBytes(om.size), 'gated download'].filter(Boolean).join(' · ')}
            </div>
          </div>
          <label title="Replace this PDF"
                 style={{ cursor: busy ? 'wait' : 'pointer', padding:'6px 10px', fontSize:11.5, fontWeight:600,
                          border:'1px solid var(--gw-border)', borderRadius:6, background:'#fff', flexShrink:0 }}>
            {busy ? 'Uploading…' : 'Replace'}
            <input type="file" accept="application/pdf" style={{ display:'none' }}
                   onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
          </label>
          <button type="button" className="btn btn--ghost" onClick={remove}
                  style={{ padding:'6px 8px', flexShrink:0 }} title="Remove">
            <Icon name="x" size={12} />
          </button>
        </div>
      ) : (
        <label style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:7,
                        cursor: busy ? 'wait' : 'pointer', padding:'14px 10px', fontSize:12.5, fontWeight:600,
                        border:'1px dashed var(--gw-border)', borderRadius:8, background:'#fff',
                        color:'var(--gw-mist)' }}>
          {busy
            ? <>Uploading…</>
            : <><Icon name="upload" size={13} /> Upload the OM (PDF, up to 50 MB)</>}
          <input type="file" accept="application/pdf" style={{ display:'none' }}
                 onChange={e => { pick(e.target.files?.[0]); e.target.value = '' }} />
        </label>
      )}

      {om && (
        <div style={{ marginTop:8 }}>
          <input className="input" maxLength={80} value={om.title || ''}
                 onChange={e => setCfg('om', { ...om, title: e.target.value })}
                 placeholder="Label shown on the page — e.g. “Riverside Apartments · Offering Memorandum”"
                 style={{ fontSize:12 }} />
        </div>
      )}
    </div>
  )
}
