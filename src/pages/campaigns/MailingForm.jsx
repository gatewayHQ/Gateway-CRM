// Create / edit a mailing: its type, landing page, advisors and builder.

import React, { useState } from 'react'
import { Icon, pushToast } from '../../components/UI.jsx'
import { uploadImageToStorage } from './builders/imageUpload.js'
import { LANDING_OPTS, MAILING_TYPE_OPTS } from './campaignConfig.js'
import { PropertyLandingBuilder } from './builders/PropertyLandingBuilder.jsx'
import { CollageBuilder } from './builders/CollageBuilder.jsx'
import { MailingListBuilder } from './builders/MailingListBuilder.jsx'

// ─── Advisors panel — who appears in "Meet your advisor(s)" on the landing ────
// Primary agent comes from the mailing's agent_id; an optional co-agent is
// stored in landing_config.agent_ids. Per-mailing bio/photo tweaks (without
// touching the agent's profile) live in landing_config.agent_overrides[id].

function AdvisorsField({ agents, primaryId, form, setCfg }) {
  const cfg       = form.landing_config || {}
  const secondId  = (Array.isArray(cfg.agent_ids) ? cfg.agent_ids : [])[0] || ''
  const overrides = cfg.agent_overrides || {}
  const byId      = (id) => agents.find(a => a.id === id)
  const ids       = [primaryId, secondId].filter(Boolean)

  const setSecond   = (id) => setCfg('agent_ids', id ? [id] : [])
  const setOverride = (id, patch) => setCfg('agent_overrides', { ...overrides, [id]: { ...(overrides[id] || {}), ...patch } })
  const clearOverride = (id) => { const next = { ...overrides }; delete next[id]; setCfg('agent_overrides', next) }

  return (
    <div style={{ border:'1px solid var(--gw-border)', borderRadius:10, padding:14 }}>
      <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Agents on this landing page</div>
      <div style={{ fontSize:11, color:'var(--gw-mist)', margin:'2px 0 12px', lineHeight:1.5 }}>
        Each agent’s headshot &amp; bio come from their profile (Team → edit agent). Add a co-agent for shared
        listings, and optionally tailor what shows on this mailing.
      </div>

      <label style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)' }}>Co-agent (optional)</label>
      <select className="input" value={secondId} onChange={e => setSecond(e.target.value)} disabled={!primaryId}>
        <option value="">— None —</option>
        {agents.filter(a => a.id !== primaryId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      {!primaryId && <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:4 }}>Choose a primary agent above first.</div>}

      <div style={{ display:'flex', flexDirection:'column', gap:8, marginTop:12 }}>
        {ids.map((id, i) => (
          <AdvisorCustomize key={id} agent={byId(id)} role={i === 0 ? 'Primary' : 'Co-agent'}
            ov={overrides[id] || {}} onPatch={(patch) => setOverride(id, patch)} onClear={() => clearOverride(id)} />
        ))}
      </div>
    </div>
  )
}

function AdvisorCustomize({ agent, role, ov, onPatch, onClear }) {
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState({})
  if (!agent) return null
  const photo       = ov.photo_url || agent.photo_url
  const profileBio  = (agent.bio || '').trim()
  const hasOverride = Boolean((ov.bio && ov.bio.trim()) || ov.photo_url)
  const inits       = (agent.name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()

  return (
    <div style={{ border:'1px solid var(--gw-border)', borderRadius:8, padding:10, background:'#fff' }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        {photo
          ? <img src={photo} alt="" style={{ width:38, height:38, borderRadius:8, objectFit:'cover' }} />
          : <div style={{ width:38, height:38, borderRadius:8, background:agent.color || '#2d3561', color:'#fff',
                          display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:13 }}>{inits}</div>}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:700 }}>
            {agent.name} <span style={{ fontSize:10, color:'var(--gw-mist)', fontWeight:600 }}>· {role}</span>
          </div>
          <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
            {hasOverride ? 'Customized for this mailing' : profileBio ? 'Using their profile bio' : 'No bio on file — add one in their profile'}
          </div>
        </div>
        <button type="button" className="btn btn--ghost btn--sm" style={{ fontSize:11 }} onClick={() => setOpen(o => !o)}>
          {open ? 'Done' : 'Customize'}
        </button>
      </div>

      {open && (
        <div style={{ marginTop:10, display:'flex', flexDirection:'column', gap:8 }}>
          <textarea className="input" rows={3} maxLength={600} value={ov.bio ?? ''}
            placeholder={profileBio || 'Bio shown on this mailing…'}
            onChange={e => onPatch({ bio: e.target.value })} />
          <div style={{ fontSize:11, color:'var(--gw-mist)' }}>Leave blank to use their profile bio.</div>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <label className="btn btn--secondary btn--sm" style={{ cursor:'pointer', fontSize:11 }}>
              {uploading.photo ? 'Uploading…' : 'Upload photo'}
              <input type="file" accept="image/*" style={{ display:'none' }}
                onChange={async e => {
                  const f = e.target.files?.[0]; if (!f) return
                  try { const url = await uploadImageToStorage(f, setUploading, 'photo'); onPatch({ photo_url: url }) }
                  catch (err) { pushToast(err.message || 'Upload failed', 'error') }
                }} />
            </label>
            {hasOverride && (
              <button type="button" className="btn btn--ghost btn--sm" style={{ fontSize:11 }} onClick={onClear}>
                Reset to profile
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── New / Edit Mailing form ──────────────────────────────────────────────────

export function MailingForm({ initial, agents, properties, activeAgent, onSave, onCancel, saving, initialTemplate }) {
  const [form, setForm] = useState(() => ({
    name:               initial?.name               || initialTemplate?.fields?.name               || '',
    description:        initial?.description        || initialTemplate?.fields?.description        || '',
    // New mailings default to the agent creating them; existing keep their agent.
    agent_id:           initial?.agent_id           || activeAgent?.id                             || '',
    property_id:        initial?.property_id        || '',
    mailing_type:       initial?.mailing_type       || initialTemplate?.fields?.mailing_type       || 'postcard',
    landing_type:       initial?.landing_type       || initialTemplate?.fields?.landing_type       || 'property',
    landing_custom_url: initial?.landing_custom_url || '',
    landing_config:     initial?.landing_config     || initialTemplate?.fields?.landing_config     || {},
    send_date:          initial?.send_date          || '',
    status:             initial?.status             || 'draft',
  }))
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setCfg = (k, v) => setForm(f => ({ ...f, landing_config: { ...(f.landing_config || {}), [k]: v } }))

  const submit = (e) => {
    e.preventDefault()
    if (!form.name.trim()) return pushToast('Name is required', 'error')
    if (form.landing_type === 'property') {
      const hasHeadline = form.landing_config?.headline?.trim()
      const hasImages   = [form.landing_config?.images, ...(form.landing_config?.portfolio || []).map(p => p?.images)]
        .some(list => (list || []).some(img => (typeof img === 'string' ? img : img?.url)?.trim()))
      if (!hasHeadline && !hasImages) return pushToast('Add a headline or at least one photo for the property showcase', 'error')
    }
    if (form.landing_type === 'custom' && !form.landing_custom_url?.trim()) {
      return pushToast('Provide a custom URL or pick a different landing type', 'error')
    }
    const getUrl = img => (typeof img === 'string' ? img : img?.url || '').trim()
    if (form.landing_type === 'multifamily') {
      if (!(form.landing_config?.images || []).some(img => getUrl(img))) {
        return pushToast('Add at least one photo for the multifamily landing page', 'error')
      }
    }
    const cfg = { ...(form.landing_config || {}) }
    if (Array.isArray(cfg.images)) {
      cfg.images = cfg.images.map(img => {
        if (typeof img === 'string') return { url: img.trim(), units: '', price: '', caption: '' }
        return { url: (img.url || '').trim(), units: (img.units || '').trim(), price: (img.price || '').trim(), caption: (img.caption || '').trim() }
      }).filter(img => img.url)
    }
    if (Array.isArray(cfg.portfolio) && cfg.portfolio.length) {
      const unnamed = cfg.portfolio.findIndex(p => !String(p?.name || '').trim())
      if (unnamed >= 0) return pushToast(`Give portfolio property ${unnamed + 1} a name`, 'error')
      cfg.portfolio = cfg.portfolio.map(p => ({
        ...p,
        name: p.name.trim(),
        images: (Array.isArray(p.images) ? p.images : [])
          .map(img => (typeof img === 'string' ? { url: img.trim(), caption: '' } : { ...img, url: (img?.url || '').trim() }))
          .filter(img => img.url),
      }))
    }
    if (Array.isArray(cfg.highlights)) cfg.highlights = cfg.highlights.filter(h => (h.label || '').trim() && (h.value || '').trim()).slice(0, 4)
    if (Array.isArray(cfg.features))   cfg.features   = cfg.features.map(f => (f || '').trim()).filter(Boolean)
    // Empty <select>/<input> values must become null for uuid/date columns —
    // Postgres rejects "" for uuid ("invalid input syntax for type uuid").
    onSave({
      ...form,
      agent_id:    form.agent_id    || null,
      property_id: form.property_id || null,
      send_date:   form.send_date   || null,
      landing_config: cfg,
    })
  }

  return (
    <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div>
        <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Mailing Name *</label>
        <input className="input" value={form.name} onChange={e => set('name', e.target.value)}
               placeholder="e.g. Just Sold — 123 Oak St (June Postcard)" autoFocus />
      </div>

      <div>
        <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Description</label>
        <textarea className="input" rows={2} value={form.description} onChange={e => set('description', e.target.value)}
                  placeholder="Optional notes — target neighborhood, design version, etc." />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
        <div>
          <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Mailing Type</label>
          <select className="input" value={form.mailing_type} onChange={e => set('mailing_type', e.target.value)}>
            {MAILING_TYPE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Send Date</label>
          <input className="input" type="date" value={form.send_date} onChange={e => set('send_date', e.target.value)} />
        </div>
      </div>

      <div>
        <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Primary agent</label>
        <select className="input" value={form.agent_id} onChange={e => set('agent_id', e.target.value)}>
          <option value="">Unassigned</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:4 }}>
          Defaults to you. Their headshot &amp; bio appear on the landing page.
        </div>
      </div>

      <AdvisorsField agents={agents} primaryId={form.agent_id} form={form} setCfg={setCfg} />

      <div>
        <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', display:'block', marginBottom:8 }}>
          Landing Page (where the QR sends people)
        </label>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          {LANDING_OPTS.map(o => {
            const sel = form.landing_type === o.value
            return (
              <button key={o.value} type="button" onClick={() => set('landing_type', o.value)}
                      style={{ textAlign:'left', padding:'12px 14px', border:`1.5px solid ${sel ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                               background: sel ? '#eff6ff' : '#fff', borderRadius:10, cursor:'pointer', transition:'all 150ms' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <div style={{ width:28, height:28, borderRadius:6, background: sel ? 'var(--gw-azure)' : 'var(--gw-bone)',
                                color: sel ? '#fff' : 'var(--gw-ink)',
                                display:'flex', alignItems:'center', justifyContent:'center' }}>
                    <Icon name={o.icon} size={14} />
                  </div>
                  <div style={{ fontWeight:700, fontSize:13.5 }}>{o.label}</div>
                </div>
                <div style={{ fontSize:11.5, color:'var(--gw-mist)', marginTop:6, lineHeight:1.4 }}>{o.sub}</div>
              </button>
            )
          })}
        </div>
      </div>

      {form.landing_type === 'property' && (
        <PropertyLandingBuilder cfg={form.landing_config || {}} setCfg={setCfg}
                                properties={properties} form={form} set={set} />
      )}

      {form.landing_type === 'custom' && (
        <div>
          <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Destination URL *</label>
          <input className="input" type="url" value={form.landing_custom_url}
                 onChange={e => set('landing_custom_url', e.target.value)}
                 placeholder="https://yourdomain.com/special-offer" />
        </div>
      )}

      {form.landing_type === 'valuation' && (
        <CollageBuilder cfg={form.landing_config || {}} setCfg={setCfg} variant="valuation" />
      )}

      {form.landing_type === 'multifamily' && (
        <CollageBuilder cfg={form.landing_config || {}} setCfg={setCfg} variant="multifamily" />
      )}

      {form.landing_type === 'mailing' && (
        <MailingListBuilder cfg={form.landing_config || {}} setCfg={setCfg} />
      )}

      <div>
        <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Status</label>
        <select className="input" value={form.status} onChange={e => set('status', e.target.value)}>
          <option value="draft">Draft</option>
          <option value="active">Active (ready to print)</option>
          <option value="sent">Sent (in the mail)</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:8 }}>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Saving…' : (initial ? 'Save Changes' : 'Create Mailing')}
        </button>
      </div>
    </form>
  )
}
