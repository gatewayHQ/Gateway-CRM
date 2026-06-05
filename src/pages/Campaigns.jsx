/**
 * Gateway CRM — Campaigns / Mailings (v2)
 *
 * A clean, focused dashboard for tracking physical mail campaigns.
 *
 *  • Create a mailing → mints a unique QR token
 *  • Upload recipients via CSV/Excel, or pick from contacts DB
 *  • Generate QR code (copy URL or download SVG for Canva/print)
 *  • Configure landing page (property showcase, home valuation, or custom URL)
 *  • Track scans + lead captures in real time
 *  • Per-mailing analytics + agent-filtered org dashboard
 */

import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Modal, pushToast, EmptyState, ConfirmDialog } from '../components/UI.jsx'

const MAILING_TYPE_OPTS = [
  { value: 'postcard',    label: 'Postcard'    },
  { value: 'letter',      label: 'Letter'      },
  { value: 'flyer',       label: 'Flyer'       },
  { value: 'door-hanger', label: 'Door Hanger' },
  { value: 'other',       label: 'Other'       },
]

const LANDING_OPTS = [
  { value: 'property',    label: 'Property Showcase',     icon: 'building',    sub: 'Hero photo + details of a property in your CRM. Best when you have a clean listing.' },
  { value: 'multifamily', label: 'Multifamily Valuation', icon: 'trending-up', sub: 'Dark, premium "what\'s your multifamily worth?" page. Bring your own photos + market stats.' },
  { value: 'valuation',   label: 'Home Valuation',        icon: 'dollar',      sub: 'Single-family / general "what\'s your home worth?" page. Captures seller leads.' },
  { value: 'custom',      label: 'Custom URL',            icon: 'link',        sub: 'Redirect the QR to any URL you control — your own site, MLS, video, etc.' },
]

// Quick-start templates — pre-fill the form so an agent can spin up a mailing in 5 seconds
const TEMPLATES = [
  {
    id:          'just-sold',
    label:       'Just Sold',
    description: 'Postcard to neighbors after a closing — drives valuation requests.',
    accent:      '#10b981',
    icon:        'check',
    fields: {
      name:         'Just Sold — [Address]',
      description:  'Sent to surrounding 200 homes after a closing.',
      mailing_type: 'postcard',
      landing_type: 'multifamily',
      landing_config: {
        headline:    'Your neighbor just sold. Curious what yours is worth?',
        subheadline: "We just closed nearby. Get the same cap-rate-driven analysis we used — no obligation, no sales pitch.",
        cta_text:    'See my valuation',
      },
    },
  },
  {
    id:          'just-listed',
    label:       'Just Listed',
    description: 'Drive showings + buyer leads for an active listing.',
    accent:      '#2563eb',
    icon:        'home',
    fields: {
      name:         'Just Listed — [Address]',
      description:  'Postcard drop to drive showings on a new listing.',
      mailing_type: 'postcard',
      landing_type: 'property',
    },
  },
  {
    id:          'multifamily-farm',
    label:       'Multifamily Farm',
    description: 'Targeted mailer to multifamily owners in a submarket.',
    accent:      '#c9a961',
    icon:        'trending-up',
    fields: {
      name:         'Multifamily Farm — [Submarket]',
      description:  'Quarterly touch to multifamily owners in our farm area.',
      mailing_type: 'postcard',
      landing_type: 'multifamily',
      landing_config: {
        headline:    "What's your multifamily really worth in today's market?",
        subheadline: "Rates moved. Comps moved. Get a fresh cap-rate-driven number from a broker who actually closes deals here.",
        cta_text:    'Get my free valuation',
        highlights: [
          { label: 'Closed in submarket', value: '$240M+' },
          { label: 'Avg days on market',  value: '38' },
          { label: 'Owners served',       value: '120+' },
        ],
      },
    },
  },
  {
    id:          'open-house',
    label:       'Open House',
    description: 'Drive foot traffic to a Saturday/Sunday open house.',
    accent:      '#7c3aed',
    icon:        'calendar',
    fields: {
      name:         'Open House — [Address]',
      description:  'Door hangers for the weekend before an open house.',
      mailing_type: 'door-hanger',
      landing_type: 'property',
    },
  },
]

const STATUS_CONFIG = {
  draft:    { label: 'Draft',    bg: 'var(--gw-bone)',        color: 'var(--gw-mist)'  },
  active:   { label: 'Active',   bg: '#dbeafe',               color: '#1d4ed8'         },
  sent:     { label: 'Sent',     bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  archived: { label: 'Archived', bg: '#f3f4f6',               color: '#6b7280'         },
}

function StatusBadge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.draft
  return <span style={{ padding:'2px 9px', borderRadius:10, fontSize:11, fontWeight:700, background:c.bg, color:c.color }}>{c.label}</span>
}

function LandingTypeChip({ type }) {
  const cfg = {
    property:    { label: 'Property',    bg: '#dbeafe',   color: '#1d4ed8' },
    multifamily: { label: 'Multifamily', bg: '#fef3c7',   color: '#92400e' },
    valuation:   { label: 'Valuation',   bg: '#dcfce7',   color: '#166534' },
    custom:      { label: 'Custom URL',  bg: '#f3e8ff',   color: '#6b21a8' },
  }
  const c = cfg[type] || cfg.property
  return (
    <span style={{ padding:'1px 7px', borderRadius:9, fontSize:10, fontWeight:700,
                   background:c.bg, color:c.color, letterSpacing:0.3 }}>
      {c.label}
    </span>
  )
}

function FunnelBar({ scanRate, leadRate }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
      <FunnelRow label="Scanned" rate={scanRate} color="var(--gw-azure)" />
      <FunnelRow label="Lead"    rate={leadRate} color="var(--gw-green)" />
    </div>
  )
}
function FunnelRow({ label, rate, color }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <div style={{ width:48, fontSize:10, color:'var(--gw-mist)', textTransform:'uppercase', fontWeight:600 }}>{label}</div>
      <div style={{ flex:1, height:5, background:'var(--gw-bone)', borderRadius:3, overflow:'hidden' }}>
        <div style={{ width:`${rate}%`, height:'100%', background:color, transition:'width 300ms' }} />
      </div>
      <div style={{ width:32, textAlign:'right', fontSize:10, color:'var(--gw-mist)', fontWeight:700 }}>
        {rate > 0 ? `${rate.toFixed(rate < 10 ? 1 : 0)}%` : '—'}
      </div>
    </div>
  )
}

function StatCard({ value, label, sub, color }) {
  return (
    <div style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'14px 18px', minWidth:120 }}>
      <div style={{ fontSize:28, fontWeight:800, color: color || 'var(--gw-ink)', fontFamily:'var(--font-display)', lineHeight:1 }}>{value}</div>
      <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginTop:3 }}>{label}</div>
      {sub && <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:1 }}>{sub}</div>}
    </div>
  )
}

// ─── QR code utilities ────────────────────────────────────────────────────────

// Branded short-link domain. Set VITE_PUBLIC_LINK_DOMAIN (e.g. https://gatewayre.link)
// in Vercel to make QR codes point at a clean, professional domain instead of the
// CRM's own URL. Falls back to the current origin when unset.
function linkBase() {
  const custom = import.meta.env.VITE_PUBLIC_LINK_DOMAIN
  return (custom && custom.trim() ? custom.trim().replace(/\/+$/, '') : window.location.origin)
}

function qrImageUrl(token, opts = {}) {
  const { size = 400, format = 'png', margin = 1 } = opts
  const target = `${linkBase()}/m/${token}`
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&format=${format}&margin=${margin}&data=${encodeURIComponent(target)}`
}

function shortUrl(token) {
  return `${linkBase()}/m/${token}`
}

// ─── CSV parser (handles quoted fields with commas/newlines) ──────────────────

function parseCSV(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++ }
      else if (c === '"') { inQuotes = false }
      else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && next === '\n') i++
        row.push(field); rows.push(row); row = []; field = ''
      }
      else field += c
    }
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim()))
}

function autoMapColumns(headers) {
  // Best-guess mapping of CSV column headers → recipient fields
  const map = {}
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i])
    if (map.recipient_name === undefined && /^(name|fullname|recipient|contact)$/.test(h)) map.recipient_name = i
    if (map.first_name === undefined && /^firstname$/.test(h)) map.first_name = i
    if (map.last_name === undefined && /^lastname$/.test(h)) map.last_name = i
    if (map.address_line1 === undefined && /^(address|street|addr|address1|addressline1|streetaddress)$/.test(h)) map.address_line1 = i
    if (map.address_line2 === undefined && /^(address2|addressline2|unit|apt|suite)$/.test(h)) map.address_line2 = i
    if (map.city === undefined && /^city$/.test(h)) map.city = i
    if (map.state === undefined && /^(state|st|province)$/.test(h)) map.state = i
    if (map.zip === undefined && /^(zip|zipcode|postal|postalcode)$/.test(h)) map.zip = i
  }
  return map
}

// ─── API helper ───────────────────────────────────────────────────────────────

async function api(action, payload = {}, method = 'POST') {
  if (method === 'GET') {
    const qs = new URLSearchParams({ action, ...payload }).toString()
    const r = await fetch(`/api/campaigns?${qs}`)
    return r.json()
  }
  const r = await fetch('/api/campaigns', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  return r.json()
}

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

function MailingForm({ initial, agents, properties, activeAgent, onSave, onCancel, saving, initialTemplate }) {
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
      const hasImages   = (form.landing_config?.images || []).some(img => (typeof img === 'string' ? img : img?.url)?.trim())
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
    if (Array.isArray(cfg.highlights)) cfg.highlights = cfg.highlights.filter(h => (h.label || '').trim() && (h.value || '').trim()).slice(0, 4)
    if (Array.isArray(cfg.features))   cfg.features   = cfg.features.map(f => (f || '').trim()).filter(Boolean)
    onSave({ ...form, landing_config: cfg })
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

// ─── Shared image-upload helper ──────────────────────────────────────────────

async function uploadImageToStorage(file, setUploading, idx) {
  setUploading(u => ({ ...u, [idx]: true }))
  try {
    const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase()
    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    const { error: upErr } = await supabase.storage
      .from('campaign-images')
      .upload(path, file, { contentType: file.type, upsert: false })
    if (upErr) throw upErr
    const { data: { publicUrl } } = supabase.storage.from('campaign-images').getPublicUrl(path)
    return publicUrl
  } finally {
    setUploading(u => { const n = { ...u }; delete n[idx]; return n })
  }
}

const normImg = v => typeof v === 'string' || !v
  ? { url: v || '', units: '', price: '', caption: '' }
  : { url: v.url || '', units: v.units || '', price: v.price || '', caption: v.caption || '' }

// ─── Image row with upload (shared between builders) ─────────────────────────

function ImageRow({ img, index, uploading, onField, onUpload, onRemove, maxPhotos, unitsLabel = 'Units', priceLabel = 'Sale price / note' }) {
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

// ─── CollageBuilder — multifamily + valuation landing config ─────────────────

function CollageBuilder({ cfg, setCfg, variant = 'multifamily' }) {
  const [aiOpen, setAiOpen]       = useState(false)
  const [aiInput, setAiInput]     = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiTone, setAiTone]       = useState('professional')
  const [uploading, setUploading] = useState({})

  const images     = Array.isArray(cfg.images)     ? cfg.images.map(normImg) : []
  const highlights = Array.isArray(cfg.highlights) ? cfg.highlights           : []

  const setImageField = (i, field, val) => {
    const next = images.map((img, idx) => idx === i ? { ...img, [field]: val } : img)
    setCfg('images', next)
  }
  const addImage    = () => setCfg('images', [...images, { url:'', units:'', price:'', caption:'' }].slice(0, 6))
  const removeImage = (i) => setCfg('images', images.filter((_, idx) => idx !== i))

  const uploadFile = async (i, file) => {
    if (!file) return
    try {
      const url = await uploadImageToStorage(file, setUploading, i)
      setImageField(i, 'url', url)
    } catch (err) { pushToast('Upload failed: ' + err.message, 'error') }
  }

  const setHighlight = (i, key, v) => {
    const next = [...highlights]; next[i] = { ...(next[i] || {}), [key]: v }
    setCfg('highlights', next)
  }
  const addHighlight    = () => setCfg('highlights', [...highlights, { label: '', value: '' }].slice(0, 4))
  const removeHighlight = (i) => setCfg('highlights', highlights.filter((_, idx) => idx !== i))

  const generateCopy = async (tone) => {
    if (!aiInput.trim()) return pushToast('Describe the property or campaign first', 'error')
    setAiLoading(true)
    try {
      const r = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          max_tokens: 600,
          system: `You are an elite real estate marketing copywriter. Write landing page copy for a ${variant === 'valuation' ? 'home valuation' : 'multifamily property valuation'} capture page. Return ONLY a raw JSON object — no markdown, no code fences. Keys: headline (max 90 chars), subheadline (max 260 chars), highlights (array of 3 objects each with "label" and "value"), cta_text (max 30 chars).`,
          messages: [{ role:'user', content:`Write ${tone === 'punchy' ? 'punchy, bold, and urgent' : tone === 'conversational' ? 'warm, conversational, and approachable' : 'professional, authoritative, and credible'} copy:\n\n${aiInput}` }],
        }),
      })
      const data = await r.json()
      if (data.error) { pushToast(data.error, 'error'); return }
      const text  = data.content?.[0]?.text || ''
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) { pushToast('AI returned unexpected format — try again', 'error'); return }
      const copy = JSON.parse(match[0])
      if (copy.headline)    setCfg('headline',    copy.headline)
      if (copy.subheadline) setCfg('subheadline', copy.subheadline)
      if (copy.highlights)  setCfg('highlights',  copy.highlights)
      if (copy.cta_text)    setCfg('cta_text',    copy.cta_text)
      setAiOpen(false)
      pushToast('AI copy applied — review and make it yours!')
    } catch (err) {
      pushToast('AI generation failed: ' + err.message, 'error')
    } finally {
      setAiLoading(false)
    }
  }

  const isVal    = variant === 'valuation'
  const hlHint   = isVal
    ? '"120+ homeowners served", "18 days avg close", "12 neighborhoods"'
    : '"$240M+ closed", "38 days avg sale", "14 sub-markets"'

  return (
    <div style={{ border:'1px solid var(--gw-border)', borderRadius:10, padding:14, background:'#fafaf7' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom: aiOpen ? 8 : 10 }}>
        <Icon name="sparkles" size={14} />
        <div style={{ fontSize:13, fontWeight:700 }}>
          {isVal ? 'Home Valuation Page Builder' : 'Multifamily Landing Page Builder'}
        </div>
        <button type="button" onClick={() => setAiOpen(o => !o)}
                style={{ marginLeft:'auto', fontSize:11, padding:'4px 12px', borderRadius:20, cursor:'pointer',
                         fontWeight:700, background: aiOpen ? 'var(--gw-azure)' : '#eff6ff',
                         color: aiOpen ? '#fff' : 'var(--gw-azure)', border:'1px solid var(--gw-azure)' }}>
          ✨ {aiOpen ? 'Close AI' : 'Generate with AI'}
        </button>
      </div>

      {aiOpen && (
        <div style={{ background:'#eff6ff', border:'1px solid #bfdbfe', borderRadius:8, padding:12, marginBottom:10 }}>
          <div style={{ fontSize:12, fontWeight:700, color:'#1d4ed8', marginBottom:6 }}>
            Describe the property or campaign — AI writes headline, subheadline, stats, and CTA
          </div>
          <textarea className="input" rows={3} value={aiInput} onChange={e => setAiInput(e.target.value)}
                    placeholder={isVal
                      ? "e.g. 'Just sold a home in East Oakland. Targeting neighboring homeowners. Market moving fast — under 3 weeks.'"
                      : "e.g. 'Just sold 24-unit in Oakland near BART. Targeting apartment owners nearby. Cap rates at 5.2%.'"}  />
          <div style={{ display:'flex', gap:6, alignItems:'center', marginTop:8, flexWrap:'wrap' }}>
            <span style={{ fontSize:11, color:'var(--gw-mist)', fontWeight:700 }}>Tone:</span>
            {['professional','punchy','conversational'].map(t => (
              <button key={t} type="button" onClick={() => setAiTone(t)}
                      style={{ fontSize:11, padding:'3px 10px', borderRadius:12, cursor:'pointer', fontWeight:600,
                               background: aiTone === t ? 'var(--gw-azure)' : '#fff',
                               color: aiTone === t ? '#fff' : 'var(--gw-ink)',
                               border:`1px solid ${aiTone === t ? 'var(--gw-azure)' : 'var(--gw-border)'}` }}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
            <button type="button" disabled={aiLoading} onClick={() => generateCopy(aiTone)}
                    style={{ marginLeft:'auto', padding:'6px 16px', fontSize:12, fontWeight:700,
                             background: aiLoading ? '#93c5fd' : 'var(--gw-azure)', color:'#fff',
                             border:'none', borderRadius:8, cursor: aiLoading ? 'default' : 'pointer' }}>
              {aiLoading ? 'Generating…' : '✨ Generate Copy'}
            </button>
          </div>
          {(cfg.headline || cfg.subheadline) && !aiLoading && (
            <div style={{ display:'flex', gap:6, alignItems:'center', marginTop:8, borderTop:'1px solid #bfdbfe', paddingTop:8, flexWrap:'wrap' }}>
              <span style={{ fontSize:11, color:'#3b82f6', fontWeight:600 }}>Refine:</span>
              {[['Make it punchier','punchy'],['More professional','professional'],['Conversational','conversational']].map(([lbl, t]) => (
                <button key={t} type="button" onClick={() => generateCopy(t)}
                        style={{ fontSize:11, padding:'3px 10px', border:'1px solid #bfdbfe', borderRadius:12, background:'#fff', cursor:'pointer', color:'#1d4ed8' }}>
                  {lbl}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display:'grid', gap:10 }}>
        <div>
          <label style={fieldLabel}>Headline</label>
          <input className="input" maxLength={140} value={cfg.headline || ''}
                 placeholder={isVal ? "What's your home worth in today's market?" : "What's your multifamily really worth?"}
                 onChange={e => setCfg('headline', e.target.value)} />
        </div>
        <div>
          <label style={fieldLabel}>Subheadline</label>
          <textarea className="input" rows={2} maxLength={300} value={cfg.subheadline || ''}
                    placeholder={isVal
                      ? "Get a private, no-obligation valuation from a licensed broker who knows your neighborhood."
                      : "Get a cap-rate-driven valuation from a broker who actually closes deals in your submarket."}
                    onChange={e => setCfg('subheadline', e.target.value)} />
        </div>

        <div>
          <label style={fieldLabel}>Photos (up to 6) — upload from computer or paste URL</label>
          <div style={{ display:'grid', gap:8, marginTop:4 }}>
            {images.map((img, i) => (
              <ImageRow key={i} img={img} index={i} uploading={uploading}
                        onField={(f, v) => setImageField(i, f, v)}
                        onUpload={file => uploadFile(i, file)}
                        onRemove={() => removeImage(i)}
                        unitsLabel="Units (e.g. 24 units)"
                        priceLabel="Sale price / note (e.g. $4.2M)" />
            ))}
            {images.length < 6 && (
              <button type="button" className="btn btn--ghost" onClick={addImage} style={{ fontSize:12, alignSelf:'flex-start' }}>
                <Icon name="plus" size={12} /> Add photo
              </button>
            )}
          </div>
          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6 }}>
            Units and sale price appear as a caption under each photo on the live page.
          </div>
        </div>

        <div>
          <label style={fieldLabel}>Highlight stats (up to 4) — your credibility strip</label>
          {highlights.length === 0 && (
            <div style={{ fontSize:11, color:'var(--gw-mist)', margin:'4px 0 6px' }}>
              Try: {hlHint}
            </div>
          )}
          <div style={{ display:'grid', gap:6, marginTop:4 }}>
            {highlights.map((h, i) => (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'140px 1fr 30px', gap:6 }}>
                <input className="input" placeholder="Value (e.g. $240M+)" value={h.value || ''}
                       onChange={e => setHighlight(i, 'value', e.target.value)} />
                <input className="input" placeholder="Label (e.g. Closed in submarket)" value={h.label || ''}
                       onChange={e => setHighlight(i, 'label', e.target.value)} />
                <button type="button" className="btn btn--ghost" onClick={() => removeHighlight(i)} style={{ padding:'6px 8px' }}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
            {highlights.length < 4 && (
              <button type="button" className="btn btn--ghost" onClick={addHighlight} style={{ fontSize:12, alignSelf:'flex-start' }}>
                <Icon name="plus" size={12} /> Add stat
              </button>
            )}
          </div>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
          <div>
            <label style={fieldLabel}>CTA button text</label>
            <input className="input" maxLength={40} placeholder="Get my free valuation" value={cfg.cta_text || ''}
                   onChange={e => setCfg('cta_text', e.target.value)} />
          </div>
          <div>
            <label style={fieldLabel}>Accent color</label>
            <div style={{ display:'flex', gap:6, alignItems:'center' }}>
              <input type="color" value={cfg.accent || '#c9a961'} onChange={e => setCfg('accent', e.target.value)}
                     style={{ width:42, height:36, border:'1px solid var(--gw-border)', borderRadius:6, padding:2, background:'#fff' }} />
              <input className="input" placeholder="#c9a961" value={cfg.accent || ''} onChange={e => setCfg('accent', e.target.value)} style={{ flex:1 }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Property Showcase landing config builder ─────────────────────────────────

function PropertyLandingBuilder({ cfg, setCfg, properties, form, set }) {
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

    if (!cfg.headline)                   setCfg('headline',    [p.address, p.city, p.state].filter(Boolean).join(', '))
    if (!cfg.price      && p.list_price) setCfg('price',       String(p.list_price))

    if (commercial) {
      setCfg('detail_mode', 'commercial')
      if (!cfg.units        && d.total_units) setCfg('units',        String(d.total_units))
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
                  {p.address}{p.city ? `, ${p.city}` : ''}{p.state ? `, ${p.state}` : ''}
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
              CRM property record — enter the figures you want to advertise.
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
          <label style={fieldLabel}>Key Features / Selling Points</label>
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

const fieldLabel = { fontSize: 11, fontWeight: 700, color: 'var(--gw-ink)', textTransform: 'uppercase', letterSpacing: 0.5 }

// ─── Recipient picker / importer ──────────────────────────────────────────────

function RecipientImporter({ mailingId, contacts, onDone, onCancel }) {
  const [mode, setMode] = useState('database') // 'database' | 'csv' | 'manual'
  const [picked, setPicked] = useState(new Set())
  const [search, setSearch] = useState('')

  // CSV state
  const [csvRows, setCsvRows] = useState(null)
  const [csvHeaders, setCsvHeaders] = useState([])
  const [csvMap, setCsvMap] = useState({})
  const [csvHasHeader, setCsvHasHeader] = useState(true)

  // Manual state
  const [manual, setManual] = useState({ recipient_name:'', address_line1:'', city:'', state:'', zip:'' })

  const [saving, setSaving] = useState(false)

  // Deal Machine neighbor lookup state
  const [dmAddress, setDmAddress]       = useState('')
  const [dmRadius, setDmRadius]         = useState(500)
  const [dmResults, setDmResults]       = useState(null)
  const [dmPicked, setDmPicked]         = useState(new Set())
  const [dmLoading, setDmLoading]       = useState(false)
  const [dmSetupNeeded, setDmSetupNeeded] = useState(false)

  const filteredContacts = useMemo(() => {
    if (!search.trim()) return contacts.slice(0, 200)
    const q = search.toLowerCase()
    return contacts.filter(c =>
      `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.owner_address || '').toLowerCase().includes(q)
    ).slice(0, 200)
  }, [contacts, search])

  const onFile = async (file) => {
    if (!file) return
    const text = await file.text()
    const rows = parseCSV(text)
    if (rows.length === 0) return pushToast('CSV looks empty', 'error')
    setCsvRows(rows)
    setCsvHeaders(rows[0])
    setCsvMap(autoMapColumns(rows[0]))
  }

  const submitDatabase = async () => {
    if (picked.size === 0) return pushToast('Pick at least one contact', 'error')
    setSaving(true)
    const recipients = contacts.filter(c => picked.has(c.id)).map(c => ({
      contact_id:     c.id,
      recipient_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
      address_line1:  c.owner_address || null,
      city:           c.owner_city    || null,
      state:          c.owner_state   || null,
      zip:            c.owner_zip     || null,
      source:         'database',
    }))
    const res = await api('add_recipients', { mailing_id: mailingId, recipients })
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    pushToast(`Added ${res.count} recipient${res.count === 1 ? '' : 's'}`)
    onDone(res.count)
  }

  const submitCSV = async () => {
    if (!csvRows) return
    const dataRows = csvHasHeader ? csvRows.slice(1) : csvRows
    const recipients = dataRows.map(r => {
      const get = key => csvMap[key] !== undefined ? (r[csvMap[key]] || '').trim() : ''
      const first = get('first_name')
      const last  = get('last_name')
      const fullName = get('recipient_name') || [first, last].filter(Boolean).join(' ')
      return {
        recipient_name: fullName || null,
        address_line1:  get('address_line1') || null,
        address_line2:  get('address_line2') || null,
        city:           get('city')          || null,
        state:          get('state')         || null,
        zip:            get('zip')           || null,
        source:         'csv_import',
      }
    }).filter(r => r.recipient_name || r.address_line1)
    if (recipients.length === 0) return pushToast('No usable rows — check column mapping', 'error')
    setSaving(true)
    const res = await api('add_recipients', { mailing_id: mailingId, recipients })
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    pushToast(`Imported ${res.count} recipient${res.count === 1 ? '' : 's'}`)
    onDone(res.count)
  }

  const submitManual = async () => {
    if (!manual.recipient_name?.trim() && !manual.address_line1?.trim()) {
      return pushToast('Provide at least a name or address', 'error')
    }
    setSaving(true)
    const res = await api('add_recipients', { mailing_id: mailingId, recipients: [{ ...manual, source: 'manual' }] })
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    pushToast('Added recipient')
    onDone(1)
  }

  const searchDealMachine = async () => {
    if (!dmAddress.trim()) return pushToast('Enter a center address first', 'error')
    setDmLoading(true)
    setDmResults(null)
    setDmSetupNeeded(false)
    try {
      const data = await api('deal_machine', { address: dmAddress, radius: dmRadius })
      if (data.setup) { setDmSetupNeeded(true); return }
      if (data.error) { pushToast(data.error, 'error'); return }
      const props = data.properties || []
      setDmResults(props)
      setDmPicked(new Set(props.map((_, i) => i)))
      if (props.length === 0) pushToast('No property records found in that radius', 'error')
    } catch (err) {
      pushToast('Search failed: ' + err.message, 'error')
    } finally {
      setDmLoading(false)
    }
  }

  const submitDealMachine = async () => {
    if (!dmResults || dmPicked.size === 0) return pushToast('Select at least one property', 'error')
    const recipients = dmResults
      .filter((_, i) => dmPicked.has(i))
      .map(p => ({
        recipient_name: p.owner_name || null,
        address_line1:  p.address_line1 || null,
        city:           p.city  || null,
        state:          p.state || null,
        zip:            p.zip   || null,
        source:         'deal_machine',
      }))
      .filter(r => r.recipient_name || r.address_line1)
    if (recipients.length === 0) return pushToast('No usable records selected', 'error')
    setSaving(true)
    const res = await api('add_recipients', { mailing_id: mailingId, recipients })
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    pushToast(`Imported ${res.count} neighbor${res.count === 1 ? '' : 's'} from Deal Machine`)
    onDone(res.count)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'flex', gap:6, borderBottom:'1px solid var(--gw-border)', paddingBottom:8, flexWrap:'wrap' }}>
        {[
          { id:'database',    label:'From CRM Contacts', icon:'contacts' },
          { id:'csv',         label:'Upload CSV',         icon:'upload'   },
          { id:'manual',      label:'Add Manually',       icon:'plus'     },
          { id:'dealmachine', label:'Neighbor Lookup',    icon:'map-pin'  },
        ].map(t => (
          <button key={t.id} type="button"
                  className={`btn ${mode === t.id ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => setMode(t.id)}
                  style={{ fontSize:12 }}>
            <Icon name={t.icon} size={12} /> {t.label}
          </button>
        ))}
      </div>

      {mode === 'database' && (
        <>
          <input className="input" placeholder="Search contacts by name, email, or address…"
                 value={search} onChange={e => setSearch(e.target.value)} />
          <div style={{ maxHeight:360, overflowY:'auto', border:'1px solid var(--gw-border)', borderRadius:8 }}>
            {filteredContacts.length === 0
              ? <div style={{ padding:20, textAlign:'center', color:'var(--gw-mist)', fontSize:13 }}>No matching contacts</div>
              : filteredContacts.map(c => (
                  <label key={c.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderBottom:'1px solid var(--gw-border)', cursor:'pointer' }}>
                    <input type="checkbox" checked={picked.has(c.id)}
                           onChange={e => setPicked(p => { const s = new Set(p); e.target.checked ? s.add(c.id) : s.delete(c.id); return s })} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:600, fontSize:13 }}>{c.first_name} {c.last_name}</div>
                      <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
                        {c.owner_address ? `${c.owner_address}${c.owner_city ? `, ${c.owner_city}` : ''}${c.owner_state ? `, ${c.owner_state}` : ''}` : (c.email || c.phone || '—')}
                      </div>
                    </div>
                  </label>
                ))
            }
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ fontSize:12, color:'var(--gw-mist)' }}>{picked.size} selected</div>
            <div style={{ display:'flex', gap:8 }}>
              <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
              <button type="button" className="btn btn--primary" disabled={saving || picked.size === 0} onClick={submitDatabase}>
                {saving ? 'Adding…' : `Add ${picked.size} Recipient${picked.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </>
      )}

      {mode === 'csv' && (
        <>
          {!csvRows ? (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              <label style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, padding:'40px 20px', border:'2px dashed var(--gw-border)', borderRadius:8, cursor:'pointer' }}>
                <Icon name="upload" size={32} color="var(--gw-mist)" />
                <div style={{ fontSize:13, fontWeight:600 }}>Drop a CSV file here, or click to browse</div>
                <div style={{ fontSize:11, color:'var(--gw-mist)' }}>Expected columns: name, address, city, state, zip</div>
                <input type="file" accept=".csv,text/csv" style={{ display:'none' }} onChange={e => onFile(e.target.files?.[0])} />
              </label>
              <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
                Tip: export from Excel as CSV (UTF-8). Column order doesn't matter — we'll auto-map common headers.
              </div>
            </div>
          ) : (
            <>
              <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12 }}>
                <input type="checkbox" checked={csvHasHeader} onChange={e => setCsvHasHeader(e.target.checked)} />
                First row is a header
              </label>
              <div style={{ display:'grid', gridTemplateColumns:'160px 1fr', gap:6 }}>
                {['recipient_name','address_line1','address_line2','city','state','zip'].map(field => (
                  <React.Fragment key={field}>
                    <div style={{ fontSize:12, fontWeight:600, alignSelf:'center' }}>
                      {field === 'recipient_name' ? 'Name' :
                       field === 'address_line1'  ? 'Address' :
                       field === 'address_line2'  ? 'Address 2 (apt/unit)' :
                       field[0].toUpperCase() + field.slice(1)}
                    </div>
                    <select className="input" value={csvMap[field] ?? ''} onChange={e => setCsvMap(m => ({ ...m, [field]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                      <option value="">— none —</option>
                      {csvHeaders.map((h, i) => <option key={i} value={i}>{h}</option>)}
                    </select>
                  </React.Fragment>
                ))}
              </div>
              <div style={{ fontSize:12, color:'var(--gw-mist)' }}>
                Preview: {(csvHasHeader ? csvRows.length - 1 : csvRows.length).toLocaleString()} rows
              </div>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <button type="button" className="btn btn--ghost" onClick={() => { setCsvRows(null); setCsvHeaders([]); setCsvMap({}) }}>← Pick a different file</button>
                <div style={{ display:'flex', gap:8 }}>
                  <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
                  <button type="button" className="btn btn--primary" disabled={saving} onClick={submitCSV}>
                    {saving ? 'Importing…' : 'Import Recipients'}
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {mode === 'manual' && (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <input className="input" placeholder="Recipient name"
                   value={manual.recipient_name} onChange={e => setManual(m => ({ ...m, recipient_name: e.target.value }))} />
            <input className="input" placeholder="Street address"
                   value={manual.address_line1} onChange={e => setManual(m => ({ ...m, address_line1: e.target.value }))} />
            <input className="input" placeholder="City"
                   value={manual.city} onChange={e => setManual(m => ({ ...m, city: e.target.value }))} />
            <input className="input" placeholder="State"
                   value={manual.state} onChange={e => setManual(m => ({ ...m, state: e.target.value }))} />
            <input className="input" placeholder="ZIP" style={{ gridColumn:'1 / -1' }}
                   value={manual.zip} onChange={e => setManual(m => ({ ...m, zip: e.target.value }))} />
          </div>
          <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
            <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn--primary" disabled={saving} onClick={submitManual}>
              {saving ? 'Adding…' : 'Add Recipient'}
            </button>
          </div>
        </>
      )}

      {mode === 'dealmachine' && (
        <>
          {dmSetupNeeded ? (
            <div style={{ background:'#fffbeb', border:'1px solid #fcd34d', borderRadius:8, padding:16 }}>
              <div style={{ fontWeight:700, fontSize:13, color:'#92400e', marginBottom:6 }}>Deal Machine API not configured</div>
              <div style={{ fontSize:12, color:'#78350f', lineHeight:1.6 }}>
                To use neighbor lookup, add your Deal Machine API key to Vercel:
              </div>
              <ol style={{ fontSize:12, color:'#78350f', marginTop:8, lineHeight:1.8, paddingLeft:18 }}>
                <li>Go to <strong>Deal Machine app → Account → Integrations → API</strong> to get your key</li>
                <li>In <strong>Vercel → Project → Settings → Environment Variables</strong>, add <code>DEAL_MACHINE_API_KEY</code></li>
                <li>Redeploy, then come back here</li>
              </ol>
              <button type="button" className="btn btn--ghost" onClick={onCancel} style={{ marginTop:10 }}>Close</button>
            </div>
          ) : (
            <>
              <div style={{ fontSize:12, color:'var(--gw-mist)', lineHeight:1.5 }}>
                Paste a center address (e.g. a property you just sold) and we'll pull the surrounding owner names + mailing addresses from Deal Machine — ready to import as recipients.
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:8, alignItems:'flex-end' }}>
                <div>
                  <label style={{ fontSize:11, fontWeight:700, color:'var(--gw-ink)', display:'block', marginBottom:4 }}>Center Address</label>
                  <input className="input" value={dmAddress} onChange={e => setDmAddress(e.target.value)}
                         placeholder="123 Main St, Oakland CA 94612"
                         onKeyDown={e => e.key === 'Enter' && searchDealMachine()} />
                </div>
                <div>
                  <label style={{ fontSize:11, fontWeight:700, color:'var(--gw-ink)', display:'block', marginBottom:4 }}>Radius</label>
                  <select className="input" value={dmRadius} onChange={e => setDmRadius(Number(e.target.value))} style={{ width:130 }}>
                    <option value={200}>200 ft (~1 blk)</option>
                    <option value={500}>500 ft</option>
                    <option value={1000}>1,000 ft</option>
                    <option value={2640}>½ mile</option>
                    <option value={5280}>1 mile</option>
                  </select>
                </div>
              </div>
              <button type="button" className="btn btn--primary" disabled={dmLoading} onClick={searchDealMachine}
                      style={{ alignSelf:'flex-start' }}>
                {dmLoading ? 'Searching…' : '🔍 Find Neighbors'}
              </button>

              {dmResults !== null && (
                <>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <div style={{ fontSize:12, color:'var(--gw-mist)' }}>
                      {dmResults.length} properties found · {dmPicked.size} selected
                    </div>
                    <div style={{ display:'flex', gap:6 }}>
                      <button type="button" className="btn btn--ghost" style={{ fontSize:11 }}
                              onClick={() => setDmPicked(new Set(dmResults.map((_, i) => i)))}>
                        Select all
                      </button>
                      <button type="button" className="btn btn--ghost" style={{ fontSize:11 }}
                              onClick={() => setDmPicked(new Set())}>
                        Deselect all
                      </button>
                    </div>
                  </div>
                  {dmResults.length > 0 && (
                    <div style={{ maxHeight:320, overflowY:'auto', border:'1px solid var(--gw-border)', borderRadius:8 }}>
                      {dmResults.map((p, i) => (
                        <label key={i} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'8px 12px',
                                                borderBottom:'1px solid var(--gw-border)', cursor:'pointer' }}>
                          <input type="checkbox" checked={dmPicked.has(i)} style={{ marginTop:2 }}
                                 onChange={e => setDmPicked(s => {
                                   const n = new Set(s)
                                   e.target.checked ? n.add(i) : n.delete(i)
                                   return n
                                 })} />
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontWeight:600, fontSize:13 }}>{p.owner_name || '(Owner unknown)'}</div>
                            <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:1 }}>
                              {[p.address_line1, p.city, p.state, p.zip].filter(Boolean).join(', ') || '—'}
                            </div>
                            {p.property_type && (
                              <div style={{ fontSize:10, color:'var(--gw-mist)', marginTop:1 }}>{p.property_type}{p.estimated_value ? ` · est. ${Number(p.estimated_value).toLocaleString('en-US', { style:'currency', currency:'USD', maximumFractionDigits:0 })}` : ''}</div>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <button type="button" className="btn btn--ghost" onClick={() => setDmResults(null)}>← New search</button>
                    <div style={{ display:'flex', gap:8 }}>
                      <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
                      <button type="button" className="btn btn--primary" disabled={saving || dmPicked.size === 0} onClick={submitDealMachine}>
                        {saving ? 'Importing…' : `Import ${dmPicked.size} Recipient${dmPicked.size === 1 ? '' : 's'}`}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {dmResults === null && !dmLoading && (
                <div style={{ display:'flex', justifyContent:'flex-end' }}>
                  <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

// ─── Mailing detail drawer ────────────────────────────────────────────────────

function MailingDetail({ mailing, agents, properties, contacts, activeAgent, onClose, onUpdate, onDelete }) {
  const [tab, setTab] = useState('overview') // overview | recipients | scans | leads | edit
  const [recipients, setRecipients] = useState([])
  const [scans, setScans] = useState([])
  const [leads, setLeads] = useState([])
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [importerOpen, setImporterOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)

  const refresh = async () => {
    setLoading(true)
    const [r, s, l, a] = await Promise.all([
      api('recipients', { mailing_id: mailing.id }, 'GET'),
      api('scans',      { mailing_id: mailing.id }, 'GET'),
      api('leads',      { mailing_id: mailing.id }, 'GET'),
      api('analytics',  { mailing_id: mailing.id }, 'GET'),
    ])
    setRecipients(r.recipients || [])
    setScans(s.scans || [])
    setLeads(l.leads || [])
    setAnalytics(a)
    setLoading(false)
  }

  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [mailing.id])

  const property = properties.find(p => p.id === mailing.property_id)
  const agent    = agents.find(a => a.id === mailing.agent_id)

  const copyUrl = async () => {
    await navigator.clipboard.writeText(shortUrl(mailing.qr_token))
    pushToast('Tracking URL copied')
  }

  const downloadQR = (format = 'png') => {
    const url = qrImageUrl(mailing.qr_token, { size: 1000, format, margin: 2 })
    const a = document.createElement('a')
    a.href = url
    a.download = `mailing-${mailing.qr_token}.${format}`
    a.target = '_blank'
    a.click()
  }

  const removeRecipient = async (id) => {
    const res = await api('remove_recipient', { id })
    if (res.error) return pushToast(res.error, 'error')
    refresh()
  }

  const setResponse = async (recipientId, response_type) => {
    const res = await api('update_recipient', { id: recipientId, response_type, responded: !!response_type })
    if (res.error) return pushToast(res.error, 'error')
    setRecipients(rs => rs.map(r => r.id === recipientId ? res.recipient : r))
  }

  const saveEdit = async (form) => {
    setSaving(true)
    const res = await api('update', { id: mailing.id, ...form })
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    onUpdate(res.mailing)
    setTab('overview')
    pushToast('Mailing updated')
  }

  const exportRecipientsCSV = () => {
    const headers = ['Name','Address','City','State','Zip','Scans','Responded','Response Type']
    const rows = recipients.map(r => [
      r.recipient_name || '', r.address_line1 || '', r.city || '', r.state || '', r.zip || '',
      r.scan_count || 0, r.responded ? 'Yes' : 'No', r.response_type || '',
    ])
    const csv = [headers, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${mailing.name.replace(/[^a-z0-9]/gi, '_')}-recipients.csv`
    a.click()
  }

  return (
    <Modal open={true} onClose={onClose} width={920}>
      <div className="modal__head" style={{ alignItems:'flex-start' }}>
        <div style={{ flex:1 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>{mailing.name}</h3>
            <StatusBadge status={mailing.status} />
          </div>
          {mailing.description && <div style={{ fontSize:13, color:'var(--gw-mist)', marginTop:4 }}>{mailing.description}</div>}
          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6, display:'flex', gap:14, flexWrap:'wrap' }}>
            {agent && <span><Icon name="user" size={11} /> {agent.name}</span>}
            {property && <span><Icon name="building" size={11} /> {property.address}{property.city ? `, ${property.city}` : ''}</span>}
            {mailing.send_date && <span><Icon name="calendar" size={11} /> {mailing.send_date}</span>}
            <span><Icon name="layers" size={11} /> {mailing.mailing_type}</span>
          </div>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>

      <div style={{ display:'flex', gap:4, borderBottom:'1px solid var(--gw-border)', padding:'0 20px' }}>
        {[
          { id:'overview',   label:'Overview'                                                    },
          { id:'recipients', label:`Recipients (${analytics?.recipients_total ?? recipients.length})` },
          { id:'scans',      label:`Scans (${analytics?.total_scans ?? scans.length})` },
          { id:'leads',      label:`Leads (${analytics?.total_leads ?? leads.length})` },
          { id:'edit',       label:'Edit' },
        ].map(t => (
          <button key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{ padding:'10px 14px', background:'none', border:'none', cursor:'pointer',
                           fontSize:13, fontWeight:600,
                           color: tab === t.id ? 'var(--gw-azure)' : 'var(--gw-mist)',
                           borderBottom: tab === t.id ? '2px solid var(--gw-azure)' : '2px solid transparent' }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding:20, maxHeight:'70vh', overflowY:'auto' }}>
        {loading && tab === 'overview' && <div style={{ color:'var(--gw-mist)' }}>Loading…</div>}

        {tab === 'overview' && !loading && (
          <div style={{ display:'grid', gridTemplateColumns:'320px 1fr', gap:24 }}>
            <div>
              <div style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:12, padding:16, textAlign:'center' }}>
                <img src={qrImageUrl(mailing.qr_token, { size: 400 })}
                     alt="QR code"
                     style={{ width:'100%', maxWidth:280, height:'auto', display:'block', margin:'0 auto' }} />
                <div style={{ fontFamily:'monospace', fontSize:13, marginTop:8, padding:'6px 10px',
                              background:'var(--gw-bone)', borderRadius:6, wordBreak:'break-all' }}>
                  {shortUrl(mailing.qr_token)}
                </div>
                <div style={{ display:'flex', gap:6, marginTop:10, justifyContent:'center', flexWrap:'wrap' }}>
                  <button className="btn btn--ghost" style={{ fontSize:12 }} onClick={copyUrl}>
                    <Icon name="copy" size={12} /> Copy URL
                  </button>
                  <button className="btn btn--ghost" style={{ fontSize:12 }} onClick={() => downloadQR('png')}>
                    <Icon name="download" size={12} /> PNG
                  </button>
                  <button className="btn btn--ghost" style={{ fontSize:12 }} onClick={() => downloadQR('svg')}>
                    <Icon name="download" size={12} /> SVG
                  </button>
                </div>
              </div>
              <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:8, textAlign:'center' }}>
                Drop the SVG into Canva or Vistaprint for crisp printing at any size.
              </div>
            </div>

            <div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10 }}>
                <StatCard value={analytics?.recipients_total ?? '—'} label="Mailed" />
                <StatCard value={analytics?.total_scans ?? '—'}      label="Scans" color="var(--gw-azure)" />
                <StatCard value={analytics?.unique_scanners ?? '—'}  label="Unique" sub="(approx.)" />
                <StatCard value={analytics?.total_leads ?? '—'}      label="Leads" color="var(--gw-green)" />
              </div>

              <div style={{ marginTop:18 }}>
                <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginBottom:8 }}>Scan Rate</div>
                <div style={{ background:'var(--gw-bone)', borderRadius:6, height:10, overflow:'hidden' }}>
                  <div style={{ width:`${Math.min(100, (analytics?.scan_rate || 0) * 100)}%`, height:'100%',
                                background:'linear-gradient(90deg, var(--gw-azure), var(--gw-green))' }} />
                </div>
                <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:4 }}>
                  {Math.round((analytics?.scan_rate || 0) * 100)}% of recipients scanned the QR
                </div>
              </div>

              {analytics?.timeline?.length > 0 && (
                <div style={{ marginTop:18 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginBottom:8 }}>Scan Activity</div>
                  <div style={{ display:'flex', alignItems:'flex-end', gap:2, height:80 }}>
                    {(() => {
                      const max = Math.max(1, ...analytics.timeline.map(t => t.count))
                      return analytics.timeline.map(t => (
                        <div key={t.date} style={{ flex:1, background:'var(--gw-azure)', borderRadius:'2px 2px 0 0',
                                                   height:`${(t.count / max) * 100}%`, minHeight:2 }}
                             title={`${t.date}: ${t.count} scan${t.count === 1 ? '' : 's'}`} />
                      ))
                    })()}
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'var(--gw-mist)', marginTop:4 }}>
                    <span>{analytics.timeline[0]?.date}</span>
                    <span>{analytics.timeline[analytics.timeline.length - 1]?.date}</span>
                  </div>
                </div>
              )}

              <div style={{ marginTop:18, display:'flex', gap:8 }}>
                <button className="btn btn--ghost" onClick={() => {
                  const path = mailing.landing_type === 'custom' && mailing.landing_custom_url
                    ? mailing.landing_custom_url
                    : `/lp/${['valuation','multifamily','property'].includes(mailing.landing_type) ? mailing.landing_type : 'property'}/${mailing.id}`
                  window.open(path, '_blank')
                }}>
                  <Icon name="external" size={12} /> Preview Landing Page
                </button>
                <button className="btn btn--ghost" onClick={() => setConfirmDelete(true)} style={{ marginLeft:'auto', color:'var(--gw-red)' }}>
                  <Icon name="trash" size={12} /> Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'recipients' && (
          <>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:12 }}>
              <div style={{ fontSize:13, color:'var(--gw-mist)' }}>
                {recipients.length} recipient{recipients.length === 1 ? '' : 's'}
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button className="btn btn--ghost" onClick={exportRecipientsCSV} disabled={recipients.length === 0}>
                  <Icon name="download" size={12} /> Export CSV
                </button>
                <button className="btn btn--primary" onClick={() => setImporterOpen(true)}>
                  <Icon name="plus" size={12} /> Add Recipients
                </button>
              </div>
            </div>
            {recipients.length === 0 ? (
              <EmptyState title="No recipients yet"
                          message="Add contacts from the CRM, upload a CSV/Excel file, or enter them manually."
                          action={<button className="btn btn--primary" onClick={() => setImporterOpen(true)}>Add Recipients</button>} />
            ) : (
              <div style={{ border:'1px solid var(--gw-border)', borderRadius:8, overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead style={{ background:'var(--gw-bone)' }}>
                    <tr>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Name</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Address</th>
                      <th style={{ padding:'8px 12px', textAlign:'center', fontSize:11, textTransform:'uppercase' }}>Scans</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Response</th>
                      <th style={{ padding:'8px 12px', width:30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.map(r => (
                      <tr key={r.id} style={{ borderTop:'1px solid var(--gw-border)' }}>
                        <td style={{ padding:'8px 12px', fontWeight:600 }}>{r.recipient_name || '—'}</td>
                        <td style={{ padding:'8px 12px', color:'var(--gw-mist)' }}>
                          {[r.address_line1, r.city, r.state, r.zip].filter(Boolean).join(', ') || '—'}
                        </td>
                        <td style={{ padding:'8px 12px', textAlign:'center' }}>
                          {r.scan_count > 0
                            ? <span style={{ color:'var(--gw-azure)', fontWeight:700 }}>{r.scan_count}</span>
                            : <span style={{ color:'var(--gw-mist)' }}>0</span>}
                        </td>
                        <td style={{ padding:'8px 12px' }}>
                          <select value={r.response_type || ''} onChange={e => setResponse(r.id, e.target.value)}
                                  style={{ padding:'3px 6px', fontSize:12, border:'1px solid var(--gw-border)', borderRadius:6 }}>
                            <option value="">No response</option>
                            <option value="lead_captured">Lead captured</option>
                            <option value="called">Called us</option>
                            <option value="emailed">Emailed us</option>
                            <option value="interested">Interested</option>
                            <option value="not_interested">Not interested</option>
                            <option value="converted">Converted</option>
                          </select>
                        </td>
                        <td style={{ padding:'8px 12px' }}>
                          <button className="btn btn--ghost" style={{ padding:4 }} onClick={() => removeRecipient(r.id)} title="Remove">
                            <Icon name="x" size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === 'scans' && (
          <>
            {scans.length === 0 ? (
              <EmptyState title="No scans yet"
                          message="When recipients scan the QR code on your mailer, the events will appear here." />
            ) : (
              <div style={{ border:'1px solid var(--gw-border)', borderRadius:8, overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead style={{ background:'var(--gw-bone)' }}>
                    <tr>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>When</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Country</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Device</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scans.map(s => (
                      <tr key={s.id} style={{ borderTop:'1px solid var(--gw-border)' }}>
                        <td style={{ padding:'8px 12px' }}>{new Date(s.scanned_at).toLocaleString()}</td>
                        <td style={{ padding:'8px 12px' }}>{s.country || '—'}</td>
                        <td style={{ padding:'8px 12px', color:'var(--gw-mist)', fontSize:11 }}>
                          {(s.user_agent || '').slice(0, 80) || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === 'leads' && (
          <>
            {leads.length === 0 ? (
              <EmptyState title="No leads captured yet"
                          message="When someone fills out the form on the landing page, they'll appear here." />
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {leads.map(l => (
                  <div key={l.id} style={{ border:'1px solid var(--gw-border)', borderRadius:8, padding:12 }}>
                    <div style={{ display:'flex', justifyContent:'space-between' }}>
                      <div style={{ fontWeight:700 }}>{l.name || 'Anonymous'}</div>
                      <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{new Date(l.created_at).toLocaleString()}</div>
                    </div>
                    <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:4, display:'flex', gap:14, flexWrap:'wrap' }}>
                      {l.email && <span><Icon name="mail" size={11} /> {l.email}</span>}
                      {l.phone && <span><Icon name="phone" size={11} /> {l.phone}</span>}
                      {l.property_address && <span><Icon name="building" size={11} /> {l.property_address}</span>}
                    </div>
                    {l.message && <div style={{ marginTop:6, fontSize:13, color:'var(--gw-ink)' }}>{l.message}</div>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'edit' && (
          <MailingForm initial={mailing} agents={agents} properties={properties} activeAgent={activeAgent}
                       saving={saving} onSave={saveEdit} onCancel={() => setTab('overview')} />
        )}
      </div>

      {importerOpen && (
        <Modal open={true} onClose={() => setImporterOpen(false)} width={640}>
          <div className="modal__head">
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>Add Recipients</h3>
            <button className="drawer__close" onClick={() => setImporterOpen(false)}><Icon name="x" size={18} /></button>
          </div>
          <div style={{ padding:20 }}>
            <RecipientImporter
              mailingId={mailing.id}
              contacts={contacts}
              onDone={() => { setImporterOpen(false); refresh() }}
              onCancel={() => setImporterOpen(false)}
            />
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete mailing?"
          message={`This will permanently delete "${mailing.name}" along with all ${recipients.length} recipients, ${scans.length} scans, and ${leads.length} captured leads. This cannot be undone.`}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            const res = await api('delete', { id: mailing.id })
            if (res.error) return pushToast(res.error, 'error')
            pushToast('Mailing deleted')
            onDelete(mailing.id)
            onClose()
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </Modal>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function CampaignsPage({ db, isAdmin, activeAgent }) {
  const agents     = db?.agents     || []
  const properties = db?.properties || []

  const [mailings, setMailings]     = useState([])
  const [contacts, setContacts]     = useState([])
  const [loading,  setLoading]      = useState(true)
  const [selected, setSelected]     = useState(null)
  const [creating,    setCreating]    = useState(false)
  const [templateSel, setTemplateSel] = useState(null) // pre-fill template (null = blank form)
  const [saving,      setSaving]      = useState(false)
  const [dashboard, setDashboard]   = useState(null)
  const [setupNeeded, setSetupNeeded] = useState(false)
  const [setupError,  setSetupError]  = useState('')

  // Filters
  const [search, setSearch]         = useState('')
  const [statusFilter, setStatus]   = useState('all')
  const [agentFilter, setAgentF]    = useState('all')
  const [sort, setSort]             = useState('newest')

  const loadAll = async () => {
    setLoading(true)
    const [mRes, dRes, cRes] = await Promise.all([
      api('list', {}, 'GET'),
      api('dashboard', {}, 'GET'),
      supabase.from('contacts').select('id, first_name, last_name, email, phone, owner_address, owner_city, owner_state, owner_zip').order('last_name'),
    ])
    if (mRes.error && /does not exist|relation|invalid path|server misconfigured/i.test(mRes.error)) {
      setSetupNeeded(true)
      setSetupError(mRes.error)
      setLoading(false)
      return
    }
    setMailings(mRes.mailings || [])
    setDashboard(dRes?.error ? null : dRes)
    setContacts(cRes.data || [])
    setLoading(false)
  }

  useEffect(() => { loadAll() }, [])

  const createMailing = async (form) => {
    setSaving(true)
    const res = await api('create', form)
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    setMailings(m => [res.mailing, ...m])
    setCreating(false)
    setSelected(res.mailing)
    pushToast('Mailing created — add recipients next')
  }

  const updateMailing = (updated) => {
    setMailings(m => m.map(x => x.id === updated.id ? updated : x))
    if (selected?.id === updated.id) setSelected(updated)
  }

  const handleDelete = (id) => {
    setMailings(m => m.filter(x => x.id !== id))
    setSelected(null)
  }

  const filtered = useMemo(() => {
    let out = mailings
    if (statusFilter !== 'all') out = out.filter(m => m.status === statusFilter)
    if (agentFilter !== 'all')  out = out.filter(m => m.agent_id === agentFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      out = out.filter(m => m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q))
    }
    if (sort === 'newest')      out = [...out].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    else if (sort === 'oldest') out = [...out].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    else if (sort === 'scans')  out = [...out].sort((a, b) => (b.scan_count || 0) - (a.scan_count || 0))
    else if (sort === 'leads')  out = [...out].sort((a, b) => (b.lead_count || 0) - (a.lead_count || 0))
    else if (sort === 'recipients') out = [...out].sort((a, b) => (b.recipient_count || 0) - (a.recipient_count || 0))
    return out
  }, [mailings, statusFilter, agentFilter, search, sort])

  if (setupNeeded) {
    const isEnvError = /invalid path|server misconfigured/i.test(setupError)
    return (
      <div style={{ padding:40, maxWidth:780 }}>
        <h2 style={{ fontFamily:'var(--font-display)', margin:0 }}>Campaign Tracking — Setup Required</h2>
        {isEnvError ? (
          <>
            <p style={{ color:'var(--gw-mist)', marginTop:8 }}>
              The campaigns API can't reach the database. This is usually a missing environment variable in Vercel.
            </p>
            <p style={{ marginTop:8, fontSize:13 }}>
              Go to <strong>Vercel → Project → Settings → Environment Variables</strong> and confirm these are set:
            </p>
            <ul style={{ fontSize:13, marginTop:8, lineHeight:1.8 }}>
              <li><code>SUPABASE_URL</code> — your Supabase project URL (e.g. <code>https://xxxx.supabase.co</code>)</li>
              <li><code>SUPABASE_SERVICE_KEY</code> — the <em>service_role</em> secret key from Supabase → Settings → API</li>
            </ul>
            {setupError && <pre style={{ marginTop:8, fontSize:11, background:'var(--gw-bone)', padding:'8px 12px', borderRadius:6, color:'var(--gw-red)', whiteSpace:'pre-wrap' }}>{setupError}</pre>}
          </>
        ) : (
          <p style={{ color:'var(--gw-mist)', marginTop:8 }}>
            The mailings tables haven't been created yet. Run the migration once in your Supabase SQL editor — it's in <code>src/lib/schema.sql</code> under the <strong>MAILINGS (v2)</strong> section.
          </p>
        )}
        <button className="btn btn--primary" onClick={loadAll} style={{ marginTop:16 }}>
          {isEnvError ? 'Retry' : "I've run the migration — Reload"}
        </button>
      </div>
    )
  }

  if (loading) return <div style={{ padding:40 }}>Loading mailings…</div>

  return (
    <div style={{ padding:'24px 32px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
        <div>
          <h1 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:28 }}>Mail Campaigns</h1>
          <div style={{ color:'var(--gw-mist)', fontSize:13, marginTop:4 }}>
            Track postcards, flyers, and direct mail with per-piece QR codes
          </div>
        </div>
        <button className="btn btn--primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> New Mailing
        </button>
      </div>

      {dashboard && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:10, marginBottom:20 }}>
          <StatCard value={dashboard.total_mailings}    label="Total Mailings" />
          <StatCard value={dashboard.active_mailings}   label="Active / Sent"   color="var(--gw-azure)" />
          <StatCard value={(dashboard.total_recipients || 0).toLocaleString()} label="Pieces Mailed" />
          <StatCard value={dashboard.total_scans_30d}   label="Scans (30d)"     color="var(--gw-green)" />
          <StatCard value={dashboard.total_leads_30d}   label="Leads (30d)"     color="#7c3aed" />
        </div>
      )}

      {/* Quick-start templates */}
      <div style={{ marginBottom:20 }}>
        <div style={{ fontSize:11, textTransform:'uppercase', letterSpacing:0.8, color:'var(--gw-mist)',
                      fontWeight:700, marginBottom:8 }}>
          Quick start
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))', gap:10 }}>
          {TEMPLATES.map(t => (
            <button key={t.id} type="button"
                    onClick={() => { setTemplateSel(t); setCreating(true) }}
                    style={{ textAlign:'left', padding:'14px 16px', background:'#fff',
                             border:'1px solid var(--gw-border)', borderRadius:10, cursor:'pointer',
                             transition:'all 150ms', position:'relative', overflow:'hidden' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = t.accent; e.currentTarget.style.transform = 'translateY(-1px)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--gw-border)'; e.currentTarget.style.transform = 'translateY(0)' }}>
              <div style={{ position:'absolute', top:0, left:0, right:0, height:3, background:t.accent }} />
              <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:2 }}>
                <div style={{ width:28, height:28, borderRadius:6, background:`${t.accent}22`, color:t.accent,
                              display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <Icon name={t.icon} size={14} />
                </div>
                <div style={{ fontWeight:700, fontSize:13.5 }}>{t.label}</div>
              </div>
              <div style={{ fontSize:11.5, color:'var(--gw-mist)', marginTop:6, lineHeight:1.4 }}>
                {t.description}
              </div>
            </button>
          ))}
          <button type="button" onClick={() => { setTemplateSel(null); setCreating(true) }}
                  style={{ textAlign:'left', padding:'14px 16px', background:'transparent',
                           border:'1.5px dashed var(--gw-border)', borderRadius:10, cursor:'pointer',
                           transition:'all 150ms', display:'flex', alignItems:'center', gap:8 }}
                  onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--gw-azure)'}
                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--gw-border)'}>
            <div style={{ width:28, height:28, borderRadius:6, background:'var(--gw-bone)',
                          display:'flex', alignItems:'center', justifyContent:'center', color:'var(--gw-mist)' }}>
              <Icon name="plus" size={14} />
            </div>
            <div>
              <div style={{ fontWeight:700, fontSize:13.5 }}>Blank Mailing</div>
              <div style={{ fontSize:11.5, color:'var(--gw-mist)' }}>Start from scratch</div>
            </div>
          </button>
        </div>
      </div>

      <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
        <input className="input" placeholder="Search mailings…" value={search}
               onChange={e => setSearch(e.target.value)} style={{ flex:1, minWidth:200 }} />
        <select className="input" value={statusFilter} onChange={e => setStatus(e.target.value)} style={{ width:160 }}>
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="sent">Sent</option>
          <option value="archived">Archived</option>
        </select>
        {isAdmin && (
          <select className="input" value={agentFilter} onChange={e => setAgentF(e.target.value)} style={{ width:180 }}>
            <option value="all">All agents</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        <select className="input" value={sort} onChange={e => setSort(e.target.value)} style={{ width:170 }}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="scans">Most scans</option>
          <option value="leads">Most leads</option>
          <option value="recipients">Most recipients</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title={mailings.length === 0 ? 'No mailings yet' : 'No mailings match these filters'}
                    message={mailings.length === 0 ? 'Create your first mailing to get a unique trackable QR code.' : 'Try clearing the filters.'}
                    action={mailings.length === 0 && <button className="btn btn--primary" onClick={() => setCreating(true)}>Create First Mailing</button>} />
      ) : (
        <div style={{ display:'grid', gap:10 }}>
          {filtered.map(m => {
            const agent    = agents.find(a => a.id === m.agent_id)
            const property = properties.find(p => p.id === m.property_id)
            const mailed   = m.recipient_count || 0
            const scans    = m.scan_count || 0
            const leads    = m.lead_count || 0
            const scanRate = mailed > 0 ? Math.min(100, (scans / mailed) * 100) : 0
            const leadRate = mailed > 0 ? Math.min(100, (leads / mailed) * 100) : 0
            return (
              <div key={m.id} onClick={() => setSelected(m)}
                   style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)',
                            padding:'14px 18px', cursor:'pointer', display:'grid',
                            gridTemplateColumns:'1fr 220px 80px 80px 80px 56px', gap:14, alignItems:'center',
                            transition:'all 150ms' }}
                   onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--gw-azure)'}
                   onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--gw-border)'}>
                <div style={{ minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ fontWeight:700, fontSize:15, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{m.name}</div>
                    <StatusBadge status={m.status} />
                    <LandingTypeChip type={m.landing_type} />
                  </div>
                  <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:4, display:'flex', gap:10, flexWrap:'wrap' }}>
                    {agent && <span>{agent.name}</span>}
                    {property && <span>· {property.address}</span>}
                    {m.send_date && <span>· {m.send_date}</span>}
                    <span>· {m.mailing_type}</span>
                  </div>
                </div>

                {/* Conversion funnel mini-viz */}
                <div title={`${mailed} mailed → ${scans} scans → ${leads} leads`}>
                  <FunnelBar scanRate={scanRate} leadRate={leadRate} />
                </div>

                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:17, fontWeight:700 }}>{mailed.toLocaleString()}</div>
                  <div style={{ fontSize:10, color:'var(--gw-mist)', textTransform:'uppercase' }}>Mailed</div>
                </div>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:17, fontWeight:700, color:'var(--gw-azure)' }}>{scans}</div>
                  <div style={{ fontSize:10, color:'var(--gw-mist)', textTransform:'uppercase' }}>Scans</div>
                </div>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:17, fontWeight:700, color:'var(--gw-green)' }}>{leads}</div>
                  <div style={{ fontSize:10, color:'var(--gw-mist)', textTransform:'uppercase' }}>Leads</div>
                </div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end' }}>
                  <img src={qrImageUrl(m.qr_token, { size: 60 })} alt=""
                       style={{ width:38, height:38, border:'1px solid var(--gw-border)', borderRadius:4 }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {creating && (
        <Modal open={true} onClose={() => { setCreating(false); setTemplateSel(null) }} width={680}>
          <div className="modal__head">
            <div>
              <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>
                {templateSel ? `${templateSel.label} Mailing` : 'New Mailing'}
              </h3>
              {templateSel && (
                <div style={{ fontSize:11.5, color:'var(--gw-mist)', marginTop:3 }}>
                  Pre-filled from the <strong>{templateSel.label}</strong> template — edit anything before saving.
                </div>
              )}
            </div>
            <button className="drawer__close" onClick={() => { setCreating(false); setTemplateSel(null) }}>
              <Icon name="x" size={18} />
            </button>
          </div>
          <div style={{ padding:20, maxHeight:'calc(100vh - 180px)', overflowY:'auto' }}>
            <MailingForm
              key={templateSel?.id || 'blank'}
              initialTemplate={templateSel}
              agents={agents}
              properties={properties}
              activeAgent={activeAgent}
              saving={saving}
              onSave={createMailing}
              onCancel={() => { setCreating(false); setTemplateSel(null) }}
            />
          </div>
        </Modal>
      )}

      {selected && (
        <MailingDetail
          mailing={selected}
          agents={agents}
          properties={properties}
          contacts={contacts}
          activeAgent={activeAgent}
          onClose={() => setSelected(null)}
          onUpdate={updateMailing}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}
