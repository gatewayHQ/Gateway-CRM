import React, { useEffect, useState } from 'react'
import { Icon, pushToast } from '../../../components/UI.jsx'
import { supabase } from '../../../lib/supabase.js'
import {
  normalizeOm, uploadDealRoomDoc, deleteOm, formatBytes, DEAL_ROOM_ACCEPT, DEAL_ROOM_DOC_KINDS,
} from '../../../lib/om.js'
import { fieldLabel } from './imageUpload.js'
import { OmUploadField } from './OmUploadField.jsx'

// ─── Deal Room builder ────────────────────────────────────────────────────────
/**
 * Everything behind the landing page's registration form, and the rules for
 * what stays public. Stored on landing_config:
 *
 *   teaser_mode, price_display, call_for_offers_date, public_photo_count,
 *   followup_sequence_id, om, deal_room: { documents[], updates[] }
 *
 * What a visitor may see is enforced on the server (api/_lib/dealRoom.js) —
 * this panel only sets the switches.
 */

const PRICE_OPTS = [
  { value: 'public',          label: 'Show the price' },
  { value: 'call_for_offers', label: 'Show "Call for Offers"' },
  { value: 'unpriced',        label: 'Show "Unpriced"' },
  { value: 'gated',           label: 'Hide it — Deal Room only' },
]

const newId = (p) => `${p}-${Math.random().toString(36).slice(2, 10)}`
const today = () => new Date().toISOString().slice(0, 10)

export function DealRoomBuilder({ cfg, setCfg, agentId }) {
  const [busy, setBusy] = useState(false)
  const [sequences, setSequences] = useState([])
  const room    = cfg.deal_room || {}
  const docs    = Array.isArray(room.documents) ? room.documents : []
  const updates = Array.isArray(room.updates) ? room.updates : []
  const hasRoom = !!normalizeOm(cfg.om) || docs.length > 0
  const teaser  = cfg.teaser_mode !== false

  useEffect(() => {
    let active = true
    supabase.from('sequences').select('id, name, agent_id').order('created_at', { ascending: false })
      .then(({ data }) => {
        if (!active) return
        // Only the agent's own sequences: a drip sends from its owner's Outlook.
        setSequences((data || []).filter(s => !agentId || !s.agent_id || s.agent_id === agentId))
      })
    return () => { active = false }
  }, [agentId])

  const setRoom = (patch) => setCfg('deal_room', { ...room, ...patch })
  const setDoc = (i, patch) => setRoom({ documents: docs.map((d, idx) => idx === i ? { ...d, ...patch } : d) })
  const removeDoc = (i) => {
    if (docs[i]?.path) deleteOm(docs[i].path)
    setRoom({ documents: docs.filter((_, idx) => idx !== i) })
  }
  const addDoc = async (file) => {
    if (!file) return
    setBusy(true)
    try {
      const doc = await uploadDealRoomDoc(file)
      const guess = /rent.?roll/i.test(file.name) ? 'rent_roll' : /t-?12|operating/i.test(file.name) ? 't12' : 'other'
      setRoom({ documents: [...docs, { ...doc, kind: guess }].slice(0, 20) })
      pushToast('Added to the Deal Room', 'success')
    } catch (err) {
      pushToast('Upload failed: ' + err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const setUpdate = (i, patch) => setRoom({ updates: updates.map((u, idx) => idx === i ? { ...u, ...patch } : u) })
  const addUpdate = () => setRoom({ updates: [{ id: newId('upd'), date: today(), title: '', body: '' }, ...updates].slice(0, 30) })
  const removeUpdate = (i) => setRoom({ updates: updates.filter((_, idx) => idx !== i) })

  const small = { fontSize:11, color:'var(--gw-mist)', lineHeight:1.45 }

  return (
    <div style={{ border:'1px solid #f0e0c0', borderRadius:10, padding:12, background:'#fffdf8', display:'grid', gap:12 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        <Icon name="om" size={14} />
        <div style={{ fontSize:13, fontWeight:700 }}>Deal Room</div>
        <div style={small}>· one registration opens everything below</div>
      </div>

      <OmUploadField cfg={cfg} setCfg={setCfg}
                     hint="The OM, plus anything you add below, unlocks after the visitor gives their name, phone and email (mailing address optional). Every registration alerts you by email and text, adds a call task, and lands in the campaign's Deal Room tab." />

      <div>
        <label style={fieldLabel}>Other documents (rent roll, T-12, photos…)</label>
        <div style={{ display:'grid', gap:6, marginTop:4 }}>
          {docs.map((d, i) => (
            <div key={d.id || i} style={{ display:'grid', gridTemplateColumns:'1fr 150px auto', gap:6, alignItems:'center',
                                          border:'1px solid var(--gw-border)', borderRadius:8, padding:8, background:'#fff' }}>
              <div style={{ minWidth:0 }}>
                <input className="input" style={{ fontSize:12 }} maxLength={80} value={d.title || ''}
                       placeholder={DEAL_ROOM_DOC_KINDS.find(k => k.value === d.kind)?.label || 'Title'}
                       onChange={e => setDoc(i, { title: e.target.value })} />
                <div style={{ ...small, marginTop:3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {[d.filename, formatBytes(d.size)].filter(Boolean).join(' · ')}
                </div>
              </div>
              <select className="input" style={{ fontSize:12 }} value={d.kind || 'other'}
                      onChange={e => setDoc(i, { kind: e.target.value })}>
                {DEAL_ROOM_DOC_KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
              <button type="button" className="btn btn--ghost" onClick={() => removeDoc(i)} style={{ padding:'6px 8px' }} title="Remove">
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          <label style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:7, cursor: busy ? 'wait' : 'pointer',
                          padding:'11px 10px', fontSize:12.5, fontWeight:600, border:'1px dashed var(--gw-border)',
                          borderRadius:8, background:'#fff', color:'var(--gw-mist)' }}>
            {busy ? 'Uploading…' : <><Icon name="upload" size={13} /> Add a document (PDF, Excel, CSV, Word, image, zip)</>}
            <input type="file" accept={DEAL_ROOM_ACCEPT} style={{ display:'none' }}
                   onChange={e => { addDoc(e.target.files?.[0]); e.target.value = '' }} />
          </label>
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
        <div>
          <label style={fieldLabel}>Asking price on the public page</label>
          <select className="input" value={cfg.price_display || 'public'} onChange={e => setCfg('price_display', e.target.value)}>
            {PRICE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label style={fieldLabel}>Call for Offers date (optional)</label>
          <input className="input" type="date" value={cfg.call_for_offers_date || ''}
                 onChange={e => setCfg('call_for_offers_date', e.target.value || null)} />
          <div style={{ ...small, marginTop:3 }}>Shows a countdown in the hero and in update emails.</div>
        </div>
      </div>

      <label style={{ display:'flex', gap:8, alignItems:'flex-start', fontSize:12.5, cursor:'pointer' }}>
        <input type="checkbox" checked={teaser} onChange={e => setCfg('teaser_mode', e.target.checked)} style={{ marginTop:2 }} />
        <span>
          <b>Teaser mode</b> — keep cap rate, NOI, gross income, price/unit and occupancy, and all but the first{' '}
          <input type="number" min={1} max={10} value={cfg.public_photo_count || 3}
                 onChange={e => setCfg('public_photo_count', Math.max(1, Math.min(10, Number(e.target.value) || 3)))}
                 onClick={e => e.stopPropagation()}
                 style={{ width:44, fontSize:12, padding:'1px 4px' }} /> photos, inside the Deal Room.
          {!hasRoom && <span style={{ ...small, display:'block' }}>Takes effect once the Deal Room has a document.</span>}
        </span>
      </label>

      <div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <label style={fieldLabel}>Deal updates (newest first)</label>
          <button type="button" className="btn btn--ghost" onClick={addUpdate} style={{ fontSize:12 }}>
            <Icon name="plus" size={12} /> Add update
          </button>
        </div>
        <div style={{ ...small, margin:'2px 0 6px' }}>
          e.g. "September financials uploaded". After saving, email everyone registered from the campaign's Deal Room tab.
        </div>
        <div style={{ display:'grid', gap:8 }}>
          {updates.map((u, i) => (
            <div key={u.id || i} style={{ border:'1px solid var(--gw-border)', borderRadius:8, padding:8, background:'#fff', display:'grid', gap:6 }}>
              <div style={{ display:'grid', gridTemplateColumns:'140px 1fr auto', gap:6 }}>
                <input className="input" type="date" value={u.date || ''} onChange={e => setUpdate(i, { date: e.target.value })} style={{ fontSize:12 }} />
                <input className="input" maxLength={120} value={u.title || ''} placeholder="September financials uploaded"
                       onChange={e => setUpdate(i, { title: e.target.value })} style={{ fontSize:12 }} />
                <button type="button" className="btn btn--ghost" onClick={() => removeUpdate(i)} style={{ padding:'6px 8px' }} title="Remove">
                  <Icon name="x" size={12} />
                </button>
              </div>
              <textarea className="input" rows={2} value={u.body || ''} style={{ fontSize:12 }}
                        placeholder="Occupancy improved to 91%; T-12 revenue $1.42M. Updated rent roll is in the documents."
                        onChange={e => setUpdate(i, { body: e.target.value })} />
            </div>
          ))}
        </div>
      </div>

      <div>
        <label style={fieldLabel}>Automatic follow-up (optional)</label>
        <select className="input" value={cfg.followup_sequence_id || ''}
                onChange={e => setCfg('followup_sequence_id', e.target.value || null)}>
          <option value="">No drip — just the alert and a call task</option>
          {sequences.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div style={{ ...small, marginTop:3 }}>
          Enrolls each new registrant in one of your drip sequences. It stops on its own when they reply. Set the first
          step's delay (e.g. 3 days) in Sequences.
        </div>
      </div>
    </div>
  )
}
