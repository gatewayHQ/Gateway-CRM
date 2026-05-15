import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Modal, Badge, Avatar, pushToast, EmptyState, ConfirmDialog, SearchDropdown } from '../components/UI.jsx'

// ── SQL hint for missing tables ───────────────────────────────────────────────
const SQL_SETUP = `-- Run in Supabase SQL Editor:
-- (already included in schema.sql — re-run that file)
create table if not exists mail_campaigns (...);
create table if not exists mail_sends (...);
create table if not exists mail_suppressions (...);`

const CHANNEL_CONFIG = {
  mail:       { label: 'Mail Flyer',  icon: 'mail',     bg: '#dbeafe', color: '#1d4ed8' },
  'cold-call':{ label: 'Cold Call',   icon: 'phone',    bg: '#fef3c7', color: '#92400e' },
  email:      { label: 'Email',       icon: 'mail',     bg: '#d1fae5', color: '#065f46' },
}

const RESPONSE_CONFIG = {
  'no-response': { label: 'No Response', bg: 'var(--gw-bone)',        color: 'var(--gw-mist)' },
  callback:      { label: 'Callback',    bg: '#fef3c7',               color: '#92400e'         },
  interested:    { label: 'Interested',  bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  dnc:           { label: 'DNC',         bg: 'var(--gw-red-light)',   color: 'var(--gw-red)'   },
  converted:     { label: 'Converted',   bg: '#ede9fe',               color: '#6d28d9'          },
}

const STATUS_CONFIG = {
  draft:     { label: 'Draft',     bg: 'var(--gw-bone)',        color: 'var(--gw-mist)' },
  active:    { label: 'Active',    bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  paused:    { label: 'Paused',    bg: '#fef3c7',               color: '#92400e' },
  completed: { label: 'Completed', bg: '#ede9fe',               color: '#6d28d9' },
}

const PROPERTY_TYPES = ['residential','rental','multifamily','office','land','retail','industrial','mixed-use','commercial']
const CHANNEL_OPTS   = Object.entries(CHANNEL_CONFIG).map(([v, c]) => ({ value: v, label: c.label }))
const RESPONSE_OPTS  = Object.entries(RESPONSE_CONFIG).map(([v, c]) => ({ value: v, label: c.label }))

const CAMPAIGN_TEMPLATES = [
  { id: 'just_listed',     label: 'Just Listed',          emoji: '🏠' },
  { id: 'just_sold',       label: 'Just Sold',            emoji: '✅' },
  { id: 'buyers_waiting',  label: 'Buyers Waiting',       emoji: '🔍' },
  { id: 'exclusive_offer', label: 'Exclusive Off-Market', emoji: '⭐' },
  { id: 'market_update',   label: 'Market Update',        emoji: '📊' },
  { id: 'sellers_wanted',  label: 'Sellers Wanted',       emoji: '🎯' },
]

function generateTrackingCode() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

// ── QR Panel ──────────────────────────────────────────────────────────────────
function QRPanel({ campaign, onUpdate, onScanCountLoad }) {
  const [scans,     setScans]     = useState([])
  const [scanCount, setScanCount] = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [copied,    setCopied]    = useState(false)
  const [genLoading,setGenLoading]= useState(false)

  const trackingUrl = campaign.tracking_code
    ? `${window.location.origin}/r/${campaign.tracking_code}`
    : null

  const qrUrl = trackingUrl
    ? `https://api.qrserver.com/v1/create-qr-code/?size=400x400&format=png&data=${encodeURIComponent(trackingUrl)}`
    : null

  useEffect(() => {
    if (!campaign.id) return
    setLoading(true)
    supabase
      .from('campaign_scans')
      .select('id, device_type, scanned_at', { count: 'exact' })
      .eq('campaign_id', campaign.id)
      .order('scanned_at', { ascending: false })
      .limit(30)
      .then(({ data, count, error }) => {
        if (!error) {
          setScans(data || [])
          setScanCount(count || 0)
          if (onScanCountLoad) onScanCountLoad(count || 0)
        }
        setLoading(false)
      })
  }, [campaign.id])

  const copyLink = () => {
    if (!trackingUrl) return
    navigator.clipboard.writeText(trackingUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const downloadQR = () => {
    if (!qrUrl) return
    const a = document.createElement('a')
    a.href = qrUrl
    a.download = `qr-${campaign.name.toLowerCase().replace(/\s+/g, '-')}.png`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  const generateCode = async () => {
    setGenLoading(true)
    try {
      const code = generateTrackingCode()
      const res  = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_campaign', id: campaign.id, tracking_code: code }),
      })
      const data = await res.json()
      if (!res.ok) { pushToast(data.error || 'Failed to generate code', 'error'); return }
      if (onUpdate) onUpdate(data.campaign)
      pushToast('Tracking code generated')
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setGenLoading(false)
    }
  }

  // Device breakdown
  const deviceCounts = { mobile: 0, tablet: 0, desktop: 0 }
  scans.forEach(s => { if (s.device_type) deviceCounts[s.device_type] = (deviceCounts[s.device_type] || 0) + 1 })
  const total = scans.length

  if (!campaign.tracking_code) {
    return (
      <div style={{ display:'flex', flexDirection:'column', gap:16, padding:'8px 0' }}>
        <div style={{ background:'#fef9c3', border:'1px solid #fde047', borderRadius:8, padding:'12px 16px', fontSize:13, color:'#713f12' }}>
          This campaign does not have a tracking code yet. Generate one to enable QR scan tracking.
        </div>
        <button className="btn btn--primary btn--sm" onClick={generateCode} disabled={genLoading} style={{ alignSelf:'flex-start' }}>
          {genLoading ? 'Generating…' : 'Generate Tracking Code'}
        </button>
      </div>
    )
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20, padding:'8px 0' }}>
      {/* Scan count */}
      <div style={{ display:'flex', gap:12, alignItems:'stretch', flexWrap:'wrap' }}>
        <div style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'14px 20px', minWidth:120, flex:1 }}>
          <div style={{ fontSize:36, fontWeight:800, color:'var(--gw-azure)', lineHeight:1, fontFamily:'var(--font-display)' }}>
            {loading ? '…' : scanCount ?? 0}
          </div>
          <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginTop:4 }}>Total QR Scans</div>
        </div>
        {/* Device breakdown */}
        {!loading && total > 0 && (
          <div style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'14px 20px', flex:2, minWidth:200 }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)', marginBottom:8, textTransform:'uppercase', letterSpacing:'0.05em' }}>Device Breakdown</div>
            {Object.entries(deviceCounts).filter(([,n]) => n > 0).map(([dev, n]) => (
              <div key={dev} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:5 }}>
                <span style={{ fontSize:11, fontWeight:700, minWidth:54, color:'var(--gw-ink)', textTransform:'capitalize' }}>{dev}</span>
                <div style={{ flex:1, height:6, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden' }}>
                  <div style={{ width:`${Math.round(n/total*100)}%`, height:'100%', background:'var(--gw-azure)', borderRadius:4 }}/>
                </div>
                <span style={{ fontSize:11, color:'var(--gw-mist)', minWidth:30, textAlign:'right' }}>{Math.round(n/total*100)}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tracking URL */}
      <div>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)', marginBottom:6, textTransform:'uppercase', letterSpacing:'0.05em' }}>Tracking URL</div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <code style={{ flex:1, padding:'8px 12px', background:'var(--gw-bone)', borderRadius:8, fontSize:12, color:'var(--gw-ink)', wordBreak:'break-all' }}>
            {trackingUrl}
          </code>
          <button className="btn btn--ghost btn--sm" onClick={copyLink} style={{ flexShrink:0 }}>
            {copied ? '✓ Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      {/* QR Code */}
      <div>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)', marginBottom:8, textTransform:'uppercase', letterSpacing:'0.05em' }}>QR Code</div>
        <div style={{ display:'flex', gap:16, alignItems:'flex-start', flexWrap:'wrap' }}>
          <img
            src={qrUrl}
            alt="QR Code"
            style={{ width:140, height:140, borderRadius:10, border:'1px solid var(--gw-border)', background:'#fff', padding:6 }}
          />
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            <button className="btn btn--primary btn--sm" onClick={downloadQR}>
              Download QR (.png)
            </button>
            {campaign.landing_mode === 'landing' && (
              <a
                href={`/campaign/${campaign.tracking_code}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn--ghost btn--sm">
                Preview Landing Page
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Landing destination */}
      <div style={{ background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:'12px 14px', fontSize:13 }}>
        <span style={{ fontWeight:700 }}>Redirect: </span>
        {campaign.landing_mode === 'external' && campaign.landing_url
          ? <a href={campaign.landing_url} target="_blank" rel="noopener noreferrer" style={{ color:'var(--gw-azure)' }}>
              {campaign.landing_url}
            </a>
          : campaign.landing_mode === 'landing'
            ? <span style={{ color:'var(--gw-green)' }}>CRM Landing Page (/campaign/{campaign.tracking_code})</span>
            : <span style={{ color:'var(--gw-mist)' }}>No destination set — edit campaign to configure</span>
        }
      </div>

      {!loading && scanCount === 0 && (
        <EmptyState icon="bar-chart-2" title="No scans yet" message="Print the QR code on your flyer and distribute it to start tracking scans."/>
      )}
    </div>
  )
}

// ── Flyer / AI Copy Tab ───────────────────────────────────────────────────────
function FlyerTab({ campaign, agents, activeAgent, onUpdate }) {
  const [selectedTemplate, setSelectedTemplate] = useState(campaign.flyer_template || '')
  const [generatedCopy,    setGeneratedCopy]    = useState(null)
  const [generating,       setGenerating]       = useState(false)
  const [copied,           setCopied]           = useState(false)
  const [saving,           setSaving]           = useState(false)
  const [canvaUrl,         setCanvaUrl]         = useState(campaign.canva_design_url || '')
  const [savingCanva,      setSavingCanva]      = useState(false)

  const agentObj = agents?.find(a => a.id === campaign.agent_id)

  const generateCopy = async () => {
    if (!selectedTemplate) { pushToast('Select a template first', 'error'); return }
    setGenerating(true)
    try {
      const res  = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template:       selectedTemplate,
          campaign_name:  campaign.name,
          property_types: campaign.property_types,
          agent_name:     agentObj?.name || activeAgent?.name || '',
          target_area:    '',
        }),
      })
      const data = await res.json()
      if (!res.ok) { pushToast(data.error || 'Failed to generate copy', 'error'); return }
      setGeneratedCopy(data.copy)
      pushToast('Copy generated!')
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setGenerating(false)
    }
  }

  const copyAllText = () => {
    if (!generatedCopy) return
    const text = [
      generatedCopy.headline,
      generatedCopy.subheadline,
      '',
      generatedCopy.tagline,
      '',
      ...(generatedCopy.bullets || []).map(b => `• ${b}`),
      '',
      `CTA: ${generatedCopy.cta}`,
    ].join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const saveToCampaign = async () => {
    if (!generatedCopy) return
    setSaving(true)
    try {
      const res  = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action:           'update_campaign',
          id:               campaign.id,
          landing_headline: generatedCopy.headline,
          landing_tagline:  generatedCopy.tagline,
          landing_cta:      generatedCopy.cta,
          flyer_template:   selectedTemplate,
        }),
      })
      const data = await res.json()
      if (!res.ok) { pushToast(data.error || 'Failed to save', 'error'); return }
      if (onUpdate) onUpdate(data.campaign)
      pushToast('Saved to campaign')
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const saveCanvaUrl = async () => {
    if (!canvaUrl.trim()) return
    setSavingCanva(true)
    try {
      const res  = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_campaign', id: campaign.id, canva_design_url: canvaUrl.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { pushToast(data.error || 'Failed to save Canva URL', 'error'); return }
      if (onUpdate) onUpdate(data.campaign)
      pushToast('Canva design URL saved')
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setSavingCanva(false)
    }
  }

  const canvaSearchUrl = `https://www.canva.com/templates/?query=${encodeURIComponent('real estate ' + (CAMPAIGN_TEMPLATES.find(t => t.id === selectedTemplate)?.label || 'postcard') + ' postcard')}`

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:20, padding:'8px 0' }}>
      {/* Template picker */}
      <div>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)', marginBottom:8, textTransform:'uppercase', letterSpacing:'0.05em' }}>Campaign Type</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          {CAMPAIGN_TEMPLATES.map(t => (
            <button key={t.id} onClick={() => setSelectedTemplate(t.id)}
              style={{
                display:'flex', alignItems:'center', gap:8,
                padding:'9px 12px', borderRadius:10, fontSize:13, fontWeight:700, cursor:'pointer',
                border:`2px solid ${selectedTemplate === t.id ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                background: selectedTemplate === t.id ? '#dbeafe' : '#fff',
                color:      selectedTemplate === t.id ? '#1d4ed8' : 'var(--gw-ink)',
                textAlign:'left',
              }}>
              <span style={{ fontSize:16 }}>{t.emoji}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Generate button */}
      <button className="btn btn--primary" onClick={generateCopy} disabled={generating || !selectedTemplate}>
        {generating ? 'Generating…' : 'Generate Copy with AI'}
      </button>

      {/* Generated copy preview */}
      {generatedCopy && (
        <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
          <div style={{ padding:'14px 16px', background:'var(--gw-bone)', borderBottom:'1px solid var(--gw-border)' }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)', textTransform:'uppercase', letterSpacing:'0.05em' }}>Generated Copy Preview</div>
          </div>
          <div style={{ padding:'16px', display:'flex', flexDirection:'column', gap:10 }}>
            <div style={{ fontSize:18, fontWeight:800, letterSpacing:'0.04em', color:'var(--gw-ink)', textTransform:'uppercase', lineHeight:1.2 }}>
              {generatedCopy.headline}
            </div>
            <div style={{ fontSize:14, fontWeight:700, color:'#374151' }}>
              {generatedCopy.subheadline}
            </div>
            <p style={{ fontSize:13, color:'#4b5563', lineHeight:1.7, margin:0 }}>
              {generatedCopy.tagline}
            </p>
            {generatedCopy.bullets?.length > 0 && (
              <ul style={{ margin:0, paddingLeft:18, fontSize:13, color:'var(--gw-ink)', display:'flex', flexDirection:'column', gap:4 }}>
                {generatedCopy.bullets.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            )}
            <div style={{ display:'inline-block', background:'var(--gw-azure)', color:'#fff', padding:'8px 16px', borderRadius:8, fontSize:13, fontWeight:700, alignSelf:'flex-start' }}>
              {generatedCopy.cta}
            </div>
          </div>
          <div style={{ padding:'10px 16px', borderTop:'1px solid var(--gw-border)', display:'flex', gap:8 }}>
            <button className="btn btn--ghost btn--sm" onClick={copyAllText}>{copied ? '✓ Copied!' : 'Copy All Copy'}</button>
            <button className="btn btn--primary btn--sm" onClick={saveToCampaign} disabled={saving}>{saving ? 'Saving…' : 'Save to Campaign'}</button>
          </div>
        </div>
      )}

      {/* Divider */}
      <div style={{ borderTop:'1px solid var(--gw-border)', paddingTop:16 }}>
        <div style={{ fontSize:13, fontWeight:700, color:'var(--gw-ink)', marginBottom:4 }}>Design in Canva</div>
        <div style={{ fontSize:12, color:'var(--gw-mist)', marginBottom:10 }}>
          1. Click below to open Canva templates · 2. Apply your generated copy · 3. Paste your Canva share URL below
        </div>
        <a href={canvaSearchUrl} target="_blank" rel="noopener noreferrer" className="btn btn--ghost btn--sm"
          style={{ display:'inline-block', marginBottom:12, background:'#dbeafe', borderColor:'#93c5fd', color:'#1d4ed8' }}>
          Open Canva Templates →
        </a>
        <div style={{ display:'flex', gap:8, marginBottom:8 }}>
          <input
            className="form-control"
            placeholder="Paste Canva design URL here…"
            value={canvaUrl}
            onChange={e => setCanvaUrl(e.target.value)}
            style={{ flex:1 }}
          />
          <button className="btn btn--ghost btn--sm" onClick={saveCanvaUrl} disabled={savingCanva || !canvaUrl.trim()}>
            {savingCanva ? 'Saving…' : 'Save'}
          </button>
        </div>
        {campaign.canva_design_url && (
          <a href={campaign.canva_design_url} target="_blank" rel="noopener noreferrer" style={{ fontSize:12, color:'var(--gw-azure)' }}>
            Open Design →
          </a>
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.draft
  return <span style={{ padding:'2px 9px', borderRadius:10, fontSize:11, fontWeight:700, background:c.bg, color:c.color, whiteSpace:'nowrap' }}>{c.label}</span>
}

function ResponseBadge({ response }) {
  const c = RESPONSE_CONFIG[response] || RESPONSE_CONFIG['no-response']
  return <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700, background:c.bg, color:c.color, whiteSpace:'nowrap' }}>{c.label}</span>
}

function ChannelBadge({ channel }) {
  const c = CHANNEL_CONFIG[channel] || CHANNEL_CONFIG.mail
  return <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700, background:c.bg, color:c.color, whiteSpace:'nowrap' }}>{c.label}</span>
}

function StatCard({ value, label, sub, color }) {
  return (
    <div style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'14px 18px', minWidth:110 }}>
      <div style={{ fontSize:26, fontWeight:800, color: color || 'var(--gw-ink)', fontFamily:'var(--font-display)', lineHeight:1 }}>{value}</div>
      <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginTop:2 }}>{label}</div>
      {sub && <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:1 }}>{sub}</div>}
    </div>
  )
}

// ── Campaign form ─────────────────────────────────────────────────────────────
function CampaignForm({ initial, agents, activeAgent, onSave, onCancel, saving }) {
  const [form, setForm] = useState({
    name: '', description: '', status: 'active',
    property_types: [], flyer_url: '',
    frequency_cap: 0, frequency_days: 30,
    agent_id: activeAgent?.id || '',
    flyer_template: '', landing_mode: 'external', landing_url: '',
    landing_headline: '', landing_tagline: '', landing_cta: 'Schedule a Call',
    date_sent: '', date_completed: '', cost_per_piece: 0, fixed_cost: 0,
    ...initial,
  })
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const toggleType = (t) => set('property_types', form.property_types.includes(t)
    ? form.property_types.filter(x => x !== t)
    : [...form.property_types, t])

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div className="form-group">
        <label className="form-label required">Campaign Name</label>
        <input className="form-control" placeholder="e.g. Q2 Multifamily Mailer" value={form.name} onChange={e => set('name', e.target.value)}/>
      </div>
      <div className="form-group">
        <label className="form-label">Description</label>
        <textarea className="form-control" rows={2} placeholder="Target audience, goal, notes…" value={form.description || ''} onChange={e => set('description', e.target.value)}/>
      </div>
      <div className="form-group">
        <label className="form-label">Target Property Types <span style={{fontWeight:400,color:'var(--gw-mist)',fontSize:11}}>— leave empty to target all</span></label>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:4 }}>
          {PROPERTY_TYPES.map(t => (
            <button key={t} type="button" onClick={() => toggleType(t)}
              style={{ padding:'4px 10px', borderRadius:10, fontSize:12, fontWeight:700, cursor:'pointer',
                border:`1.5px solid ${form.property_types.includes(t) ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                background: form.property_types.includes(t) ? '#dbeafe' : '#fff',
                color:      form.property_types.includes(t) ? '#1d4ed8' : 'var(--gw-mist)' }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
        <div className="form-group" style={{ margin:0 }}>
          <label className="form-label">Status</label>
          <select className="form-control" value={form.status} onChange={e => set('status', e.target.value)}>
            {Object.entries(STATUS_CONFIG).map(([v, c]) => <option key={v} value={v}>{c.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ margin:0 }}>
          <label className="form-label">Assigned Agent</label>
          <select className="form-control" value={form.agent_id || ''} onChange={e => set('agent_id', e.target.value)}>
            <option value="">— Any —</option>
            {(agents || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">Flyer / Asset URL <span style={{fontWeight:400,color:'var(--gw-mist)',fontSize:11}}>— link to Canva, Google Drive, PDF…</span></label>
        <input className="form-control" placeholder="https://…" value={form.flyer_url || ''} onChange={e => set('flyer_url', e.target.value)}/>
      </div>

      {/* Campaign Type */}
      <div className="form-group">
        <label className="form-label">Campaign Type</label>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:4 }}>
          {CAMPAIGN_TEMPLATES.map(t => (
            <button key={t.id} type="button" onClick={() => set('flyer_template', form.flyer_template === t.id ? '' : t.id)}
              style={{
                display:'flex', alignItems:'center', gap:5,
                padding:'4px 10px', borderRadius:10, fontSize:12, fontWeight:700, cursor:'pointer',
                border:`1.5px solid ${form.flyer_template === t.id ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                background: form.flyer_template === t.id ? '#dbeafe' : '#fff',
                color:      form.flyer_template === t.id ? '#1d4ed8' : 'var(--gw-mist)',
              }}>
              <span>{t.emoji}</span><span>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div style={{ background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
        <div style={{ fontSize:12, fontWeight:700, marginBottom:8 }}>Frequency Cap <span style={{fontWeight:400,color:'var(--gw-mist)'}}>— prevent over-mailing the same contact</span></div>
        <div style={{ display:'flex', alignItems:'center', gap:10, fontSize:13 }}>
          <span>Max</span>
          <input type="number" min={0} max={99} className="form-control" style={{ width:60 }}
            value={form.frequency_cap} onChange={e => set('frequency_cap', parseInt(e.target.value)||0)}/>
          <span>sends in</span>
          <input type="number" min={1} max={365} className="form-control" style={{ width:70 }}
            value={form.frequency_days} onChange={e => set('frequency_days', parseInt(e.target.value)||30)}/>
          <span>days <span style={{color:'var(--gw-mist)',fontSize:11}}>(0 = no cap)</span></span>
        </div>
      </div>

      {/* Tracking & Landing */}
      <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'12px 14px', display:'flex', flexDirection:'column', gap:10 }}>
        <div style={{ fontSize:12, fontWeight:700, marginBottom:2 }}>Tracking &amp; Landing</div>
        <div>
          <label className="form-label" style={{ marginBottom:4 }}>Landing Mode</label>
          <div style={{ display:'flex', gap:0, borderRadius:'var(--radius)', border:'1px solid var(--gw-border)', overflow:'hidden' }}>
            {[['external','External URL'],['landing','CRM Landing Page']].map(([v,l]) => (
              <button key={v} type="button" onClick={() => set('landing_mode', v)}
                style={{ flex:1, padding:'7px 0', fontSize:12, fontWeight:700, cursor:'pointer', border:'none',
                  background: form.landing_mode === v ? 'var(--gw-azure)' : '#fff',
                  color: form.landing_mode === v ? '#fff' : 'var(--gw-mist)' }}>{l}</button>
            ))}
          </div>
        </div>
        {form.landing_mode === 'external' ? (
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">External URL</label>
            <input className="form-control" placeholder="https://www.gatewayreadvisors.com/agents/…" value={form.landing_url || ''} onChange={e => set('landing_url', e.target.value)}/>
          </div>
        ) : (
          <>
            <div className="form-group" style={{ margin:0 }}>
              <label className="form-label">Landing Headline</label>
              <input className="form-control" placeholder="Your compelling headline…" value={form.landing_headline || ''} onChange={e => set('landing_headline', e.target.value)}/>
            </div>
            <div className="form-group" style={{ margin:0 }}>
              <label className="form-label">Landing Tagline</label>
              <textarea className="form-control" rows={2} placeholder="A few sentences about your campaign…" value={form.landing_tagline || ''} onChange={e => set('landing_tagline', e.target.value)}/>
            </div>
            <div className="form-group" style={{ margin:0 }}>
              <label className="form-label">CTA Button Text</label>
              <input className="form-control" placeholder="Schedule a Call" value={form.landing_cta || ''} onChange={e => set('landing_cta', e.target.value)}/>
            </div>
          </>
        )}
      </div>

      {/* Dates & Cost */}
      <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'12px 14px', display:'flex', flexDirection:'column', gap:10 }}>
        <div style={{ fontSize:12, fontWeight:700 }}>Dates &amp; Cost</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Date Sent</label>
            <input type="date" className="form-control" value={form.date_sent || ''} onChange={e => set('date_sent', e.target.value)}/>
          </div>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Date Completed</label>
            <input type="date" className="form-control" value={form.date_completed || ''} onChange={e => set('date_completed', e.target.value)}/>
          </div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Cost / Piece ($)</label>
            <input type="number" min={0} step="0.01" className="form-control"
              value={form.cost_per_piece || 0} onChange={e => set('cost_per_piece', parseFloat(e.target.value)||0)}/>
          </div>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Fixed Costs ($)</label>
            <input type="number" min={0} step="0.01" className="form-control"
              value={form.fixed_cost || 0} onChange={e => set('fixed_cost', parseFloat(e.target.value)||0)}/>
          </div>
        </div>
        {form.cost_per_piece > 0 && (
          <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
            Estimated spend: $— (enter recipient count to calculate)
          </div>
        )}
      </div>

      <div style={{ display:'flex', gap:8, justifyContent:'flex-end', paddingTop:4 }}>
        <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn--primary" onClick={() => onSave(form)} disabled={saving || !form.name.trim()}>
          {saving ? 'Saving…' : initial?.id ? 'Update Campaign' : 'Create Campaign'}
        </button>
      </div>
    </div>
  )
}

// ── Log Send modal ────────────────────────────────────────────────────────────
function LogSendModal({ campaign, contacts, agents, activeAgent, coldLeads, onSave, onClose }) {
  const [form, setForm] = useState({
    contact_id: '', cold_lead_id: '',
    recipient_name: '', recipient_address: '', recipient_city: '', recipient_state: '', recipient_zip: '',
    channel: 'mail', response: 'no-response',
    sent_at: new Date().toISOString().slice(0, 16),
    agent_id: activeAgent?.id || '',
    notes: '',
  })
  const [recipientMode, setRecipientMode] = useState('contact') // 'contact' | 'cold-lead' | 'manual'
  const [saving, setSaving] = useState(false)
  const [warning, setWarning] = useState('')

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const checkHistory = async (contactId) => {
    if (!contactId) return
    const { count } = await supabase
      .from('mail_sends')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('contact_id', contactId)
    if (count > 0) setWarning(`This contact has already been sent to ${count} time${count > 1 ? 's' : ''} in this campaign.`)
    else setWarning('')
  }

  const save = async () => {
    setSaving(true)
    const payload = {
      action: 'log_send',
      campaign_id:  campaign.id,
      contact_id:   recipientMode === 'contact'   ? form.contact_id   || null : null,
      cold_lead_id: recipientMode === 'cold-lead' ? form.cold_lead_id || null : null,
      recipient_name:    recipientMode === 'manual' ? form.recipient_name    : null,
      recipient_address: recipientMode === 'manual' ? form.recipient_address : null,
      recipient_city:    recipientMode === 'manual' ? form.recipient_city    : null,
      recipient_state:   recipientMode === 'manual' ? form.recipient_state   : null,
      recipient_zip:     recipientMode === 'manual' ? form.recipient_zip     : null,
      channel:   form.channel,
      sent_at:   new Date(form.sent_at).toISOString(),
      agent_id:  form.agent_id || null,
      response:  form.response,
      notes:     form.notes || null,
    }
    const resp = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await resp.json()
    setSaving(false)
    if (!resp.ok || data.error) {
      if (data.suppressed) pushToast(`Suppressed: ${data.error}`, 'error')
      else if (data.capped)      pushToast(data.error, 'error')
      else                       pushToast(data.error || 'Failed to log send', 'error')
      return
    }
    if (form.response === 'interested') pushToast('Follow-up task created automatically', 'info')
    onSave(data.send)
  }

  const contactOpts = (contacts || []).map(c => ({
    id: c.id,
    name: `${c.first_name} ${c.last_name}`,
    sub: c.phone || c.email || '',
  }))
  const coldLeadOpts = (coldLeads || []).map(l => ({
    id: l.id,
    name: l.owner_name || l.contact_name || l.property_address || 'Unknown',
    sub: l.property_address || '',
  }))

  return (
    <Modal open={true} onClose={onClose} width={500}>
      <div className="modal__head">
        <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>Log Send — {campaign.name}</h3>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body" style={{ display:'flex', flexDirection:'column', gap:14 }}>

        {/* Recipient mode tabs */}
        <div>
          <label className="form-label">Recipient</label>
          <div style={{ display:'flex', gap:0, borderRadius:'var(--radius)', border:'1px solid var(--gw-border)', overflow:'hidden', marginTop:4 }}>
            {[['contact','Contact'],['cold-lead','Cold Lead'],['manual','Enter Address']].map(([v,l]) => (
              <button key={v} onClick={() => setRecipientMode(v)}
                style={{ flex:1, padding:'7px 0', fontSize:12, fontWeight:700, cursor:'pointer', border:'none',
                  background: recipientMode === v ? 'var(--gw-azure)' : '#fff',
                  color: recipientMode === v ? '#fff' : 'var(--gw-mist)' }}>{l}</button>
            ))}
          </div>
        </div>

        {recipientMode === 'contact' && (
          <div className="form-group" style={{ margin:0 }}>
            <SearchDropdown
              items={contactOpts}
              value={form.contact_id}
              onSelect={id => { set('contact_id', id); checkHistory(id) }}
              placeholder="Search contacts…"
            />
            {warning && (
              <div style={{ marginTop:6, padding:'6px 10px', background:'#fef3c7', borderRadius:6, fontSize:12, color:'#92400e', fontWeight:600 }}>
                ⚠ {warning}
              </div>
            )}
          </div>
        )}

        {recipientMode === 'cold-lead' && (
          <div className="form-group" style={{ margin:0 }}>
            <SearchDropdown
              items={coldLeadOpts}
              value={form.cold_lead_id}
              onSelect={id => set('cold_lead_id', id)}
              placeholder="Search cold call leads…"
            />
          </div>
        )}

        {recipientMode === 'manual' && (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            <input className="form-control" placeholder="Full name" value={form.recipient_name} onChange={e => set('recipient_name', e.target.value)}/>
            <input className="form-control" placeholder="Mailing address" value={form.recipient_address} onChange={e => set('recipient_address', e.target.value)}/>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 80px 90px', gap:8 }}>
              <input className="form-control" placeholder="City" value={form.recipient_city} onChange={e => set('recipient_city', e.target.value)}/>
              <input className="form-control" placeholder="ST" value={form.recipient_state} onChange={e => set('recipient_state', e.target.value)}/>
              <input className="form-control" placeholder="Zip" value={form.recipient_zip} onChange={e => set('recipient_zip', e.target.value)}/>
            </div>
          </div>
        )}

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Channel</label>
            <select className="form-control" value={form.channel} onChange={e => set('channel', e.target.value)}>
              {CHANNEL_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Date Sent</label>
            <input type="datetime-local" className="form-control" value={form.sent_at} onChange={e => set('sent_at', e.target.value)}/>
          </div>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Response</label>
            <select className="form-control" value={form.response} onChange={e => set('response', e.target.value)}>
              {RESPONSE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Agent</label>
            <select className="form-control" value={form.agent_id || ''} onChange={e => set('agent_id', e.target.value)}>
              <option value="">— Unassigned —</option>
              {(agents || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        {form.response === 'interested' && (
          <div style={{ padding:'8px 12px', background:'var(--gw-green-light)', borderRadius:6, fontSize:12, color:'var(--gw-green)', fontWeight:600 }}>
            ✓ A high-priority follow-up task will be created automatically.
          </div>
        )}
        {form.response === 'dnc' && (
          <div style={{ padding:'8px 12px', background:'var(--gw-red-light)', borderRadius:6, fontSize:12, color:'var(--gw-red)', fontWeight:600 }}>
            This contact will not be added to the suppression list automatically — use "Suppression" tab if needed.
          </div>
        )}

        <div className="form-group" style={{ margin:0 }}>
          <label className="form-label">Notes</label>
          <textarea className="form-control" rows={2} placeholder="Call notes, voicemail, etc." value={form.notes} onChange={e => set('notes', e.target.value)}/>
        </div>

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Log Send'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Campaign detail drawer ────────────────────────────────────────────────────
function CampaignDrawer({ campaign, contacts, agents, activeAgent, coldLeads, onUpdate, onClose }) {
  const [tab,          setTab]          = useState('sends')
  const [sends,        setSends]        = useState([])
  const [suppressions, setSuppressions] = useState([])
  const [analytics,    setAnalytics]    = useState(null)
  const [loading,      setLoading]      = useState(false)
  const [logOpen,      setLogOpen]      = useState(false)
  const [editOpen,     setEditOpen]     = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [addSupp,      setAddSupp]      = useState(false)
  const [suppForm,     setSuppForm]     = useState({ full_name:'', address:'', reason:'dnc', notes:'' })
  const [confirmDel,   setConfirmDel]   = useState(null)
  const [scanCount,    setScanCount]    = useState(null)

  useEffect(() => { loadSends(); loadAnalytics() }, [campaign.id])
  useEffect(() => { if (tab === 'suppression') loadSuppressions() }, [tab])

  const loadSends = async () => {
    setLoading(true)
    const res  = await fetch(`/api/campaigns?action=list_sends&campaign_id=${campaign.id}`)
    const data = await res.json()
    setSends(data.sends || [])
    setLoading(false)
  }

  const loadAnalytics = async () => {
    const res  = await fetch(`/api/campaigns?action=campaign_analytics&campaign_id=${campaign.id}`)
    const data = await res.json()
    setAnalytics(data.analytics || null)
  }

  const loadSuppressions = async () => {
    const res  = await fetch(`/api/campaigns?action=list_suppressions`)
    const data = await res.json()
    setSuppressions(data.suppressions || [])
  }

  const deleteSend = async (id) => {
    await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_send', id }),
    })
    setSends(p => p.filter(s => s.id !== id))
    pushToast('Send removed')
  }

  const updateResponse = async (send, response) => {
    const res  = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_send', id: send.id, response }),
    })
    const data = await res.json()
    setSends(p => p.map(s => s.id === send.id ? data.send : s))
    loadAnalytics()
    if (response === 'interested') pushToast('Follow-up task created', 'info')
  }

  const addSuppression = async () => {
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add_suppression',
        full_name: suppForm.full_name,
        address:   suppForm.address,
        reason:    suppForm.reason,
        notes:     suppForm.notes,
        agent_id:  activeAgent?.id,
      }),
    })
    const data = await res.json()
    if (!res.ok) { pushToast(data.error, 'error'); return }
    setSuppressions(p => [data.suppression, ...p])
    setSuppForm({ full_name:'', address:'', reason:'dnc', notes:'' })
    setAddSupp(false)
    pushToast('Added to suppression list')
  }

  const removeSupp = async (id) => {
    await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove_suppression', id }),
    })
    setSuppressions(p => p.filter(s => s.id !== id))
    pushToast('Removed from suppression list')
  }

  const findContact = id => contacts?.find(c => c.id === id)
  const findAgent   = id => agents?.find(a => a.id === id)

  const responseRate    = analytics ? analytics.response_rate : 0
  const conversionRate  = analytics ? analytics.conversion_rate : 0

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
      {/* Header */}
      <div style={{ padding:'20px 24px 0', borderBottom:'1px solid var(--gw-border)', paddingBottom:0 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <h2 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>{campaign.name}</h2>
              <StatusBadge status={campaign.status}/>
            </div>
            {campaign.description && <div style={{ fontSize:13, color:'var(--gw-mist)', marginTop:4 }}>{campaign.description}</div>}
            {campaign.property_types?.length > 0 && (
              <div style={{ display:'flex', gap:5, marginTop:6, flexWrap:'wrap' }}>
                {campaign.property_types.map(t => (
                  <span key={t} style={{ padding:'2px 8px', borderRadius:8, fontSize:11, fontWeight:700, background:'#dbeafe', color:'#1d4ed8' }}>{t}</span>
                ))}
              </div>
            )}
          </div>
          <div style={{ display:'flex', gap:6 }}>
            {campaign.flyer_url && (
              <a href={campaign.flyer_url} target="_blank" rel="noopener noreferrer" className="btn btn--ghost btn--sm">
                <Icon name="download" size={13}/> Flyer
              </a>
            )}
            <button className="btn btn--ghost btn--sm" onClick={() => setEditOpen(true)}>Edit</button>
            <button className="btn btn--primary btn--sm" onClick={() => setLogOpen(true)}>
              <Icon name="plus" size={13}/> Log Send
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div style={{ display:'flex', gap:10, marginBottom:14, flexWrap:'wrap' }}>
          <StatCard value={analytics?.total       ?? sends.length} label="Total Sends"/>
          <StatCard value={analytics?.responded   ?? 0}            label="Responded" color={analytics?.responded > 0 ? 'var(--gw-azure)' : undefined}/>
          <StatCard value={`${responseRate}%`}   label="Response Rate" sub="industry avg ~12%" color={responseRate > 12 ? 'var(--gw-green)' : undefined}/>
          <StatCard value={`${conversionRate}%`} label="Conversion" color={conversionRate > 0 ? '#7c3aed' : undefined}/>
          <StatCard value={analytics?.converted  ?? 0}             label="Deals"/>
          <StatCard value={scanCount ?? '—'}                       label="QR Scans" color={scanCount > 0 ? 'var(--gw-azure)' : undefined}/>
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', gap:0, borderBottom:'1px solid var(--gw-border)', marginTop:0, overflowX:'auto' }}>
          {[['sends','Send Log'],['analytics','Analytics'],['qr','QR Code'],['flyer','Flyer & AI'],['suppression','Suppression']].map(([v,l]) => (
            <button key={v} onClick={() => setTab(v)}
              style={{ padding:'8px 14px', fontSize:13, fontWeight:600, cursor:'pointer', border:'none', background:'transparent', whiteSpace:'nowrap',
                borderBottom: tab === v ? '2.5px solid var(--gw-azure)' : '2.5px solid transparent',
                color: tab === v ? 'var(--gw-azure)' : 'var(--gw-mist)' }}>{l}</button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex:1, overflowY:'auto', padding:'16px 24px' }}>

        {/* ── Send Log ── */}
        {tab === 'sends' && (
          loading
            ? <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:32, fontSize:13 }}>Loading…</div>
            : sends.length === 0
              ? <EmptyState icon="mail" title="No sends yet" message="Click 'Log Send' to record the first outreach for this campaign." action={<button className="btn btn--primary btn--sm" onClick={()=>setLogOpen(true)}>Log Send</button>}/>
              : (
                <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
                  {sends.map(s => {
                    const contact = s.contact_id ? findContact(s.contact_id) : null
                    const agent   = s.agent_id   ? findAgent(s.agent_id)   : null
                    const name    = contact ? `${contact.first_name} ${contact.last_name}` : s.recipient_name || '—'
                    const addr    = s.recipient_address || contact?.owner_address || ''
                    return (
                      <div key={s.id} style={{ padding:'10px 0', borderBottom:'1px solid var(--gw-border)', display:'grid', gridTemplateColumns:'1fr auto', gap:8, alignItems:'start' }}>
                        <div>
                          <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                            <span style={{ fontWeight:700, fontSize:13 }}>{name}</span>
                            <ChannelBadge channel={s.channel}/>
                            <ResponseBadge response={s.response}/>
                          </div>
                          {addr && <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>{addr}{s.recipient_city ? `, ${s.recipient_city}` : ''}{s.recipient_state ? ` ${s.recipient_state}` : ''}{s.recipient_zip ? ` ${s.recipient_zip}` : ''}</div>}
                          <div style={{ display:'flex', gap:10, marginTop:4, fontSize:11, color:'var(--gw-mist)', flexWrap:'wrap' }}>
                            <span>{new Date(s.sent_at).toLocaleDateString()}</span>
                            {agent && <span>· {agent.name}</span>}
                            {s.notes && <span>· {s.notes}</span>}
                          </div>
                        </div>
                        <div style={{ display:'flex', gap:6, alignItems:'center', flexShrink:0 }}>
                          <select
                            value={s.response}
                            onChange={e => updateResponse(s, e.target.value)}
                            style={{ fontSize:11, padding:'3px 6px', borderRadius:6, border:'1px solid var(--gw-border)', cursor:'pointer', background:'#fff' }}>
                            {RESPONSE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          <button className="btn btn--ghost btn--icon btn--sm" onClick={() => setConfirmDel(s.id)} title="Remove">
                            <Icon name="trash" size={13}/>
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
        )}

        {/* ── Analytics ── */}
        {tab === 'analytics' && (
          analytics
            ? (
              <div style={{ display:'flex', flexDirection:'column', gap:20 }}>
                <div>
                  <div className="eyebrow-label" style={{ marginBottom:8 }}>Sends by Channel</div>
                  {Object.entries(analytics.by_channel || {}).map(([ch, n]) => (
                    <div key={ch} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                      <ChannelBadge channel={ch}/>
                      <div style={{ flex:1, height:8, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden' }}>
                        <div style={{ width:`${Math.round(n/analytics.total*100)}%`, height:'100%', background:'var(--gw-azure)', borderRadius:4 }}/>
                      </div>
                      <span style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', minWidth:28, textAlign:'right' }}>{n}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="eyebrow-label" style={{ marginBottom:8 }}>Response Breakdown</div>
                  {Object.entries(analytics.by_response || {}).map(([r, n]) => (
                    <div key={r} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                      <ResponseBadge response={r}/>
                      <div style={{ flex:1, height:8, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden' }}>
                        <div style={{ width:`${Math.round(n/analytics.total*100)}%`, height:'100%', background:'var(--gw-green)', borderRadius:4 }}/>
                      </div>
                      <span style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', minWidth:40, textAlign:'right' }}>{n} ({Math.round(n/analytics.total*100)}%)</span>
                    </div>
                  ))}
                </div>
                {Object.keys(analytics.by_zip || {}).length > 0 && (
                  <div>
                    <div className="eyebrow-label" style={{ marginBottom:8 }}>Top Zip Codes</div>
                    {Object.entries(analytics.by_zip || {})
                      .sort((a,b) => b[1]-a[1]).slice(0,10)
                      .map(([zip, n]) => (
                        <div key={zip} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:5 }}>
                          <span style={{ fontSize:12, fontWeight:700, minWidth:55 }}>{zip}</span>
                          <div style={{ flex:1, height:6, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden' }}>
                            <div style={{ width:`${n}px`, maxWidth:'100%', height:'100%', background:'var(--gw-azure)', borderRadius:4 }}/>
                          </div>
                          <span style={{ fontSize:12, color:'var(--gw-mist)', minWidth:20, textAlign:'right' }}>{n}</span>
                        </div>
                      ))}
                  </div>
                )}
                {Object.keys(analytics.by_month || {}).length > 0 && (
                  <div>
                    <div className="eyebrow-label" style={{ marginBottom:8 }}>Monthly Volume</div>
                    {Object.entries(analytics.by_month || {})
                      .sort(([a],[b]) => a.localeCompare(b))
                      .map(([mo, n]) => (
                        <div key={mo} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:5 }}>
                          <span style={{ fontSize:12, fontWeight:700, minWidth:60 }}>{mo}</span>
                          <div style={{ flex:1, height:8, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden' }}>
                            <div style={{ width:`${Math.min(n*6,100)}%`, height:'100%', background:'var(--gw-azure)', borderRadius:4 }}/>
                          </div>
                          <span style={{ fontSize:12, color:'var(--gw-mist)', minWidth:28, textAlign:'right' }}>{n}</span>
                        </div>
                      ))}
                  </div>
                )}
                <div style={{ padding:'12px', background:'var(--gw-bone)', borderRadius:'var(--radius)', fontSize:12 }}>
                  <strong>Benchmark:</strong> Direct mail response rates in CRE typically run 1–5% for cold lists and 8–15% for warm lists.
                  {responseRate > 12 && <span style={{ color:'var(--gw-green)', fontWeight:700 }}> Your {responseRate}% is above benchmark. 🏆</span>}
                  {responseRate < 5  && responseRate > 0 && <span style={{ color:'var(--gw-mist)' }}> Consider refining your target list or flyer design.</span>}
                </div>
              </div>
            )
            : <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:40, fontSize:13 }}>No data yet — log some sends first.</div>
        )}

        {/* ── QR Code ── */}
        {tab === 'qr' && (
          <QRPanel campaign={campaign} onUpdate={onUpdate} onScanCountLoad={setScanCount} />
        )}

        {/* ── Flyer & AI ── */}
        {tab === 'flyer' && (
          <FlyerTab campaign={campaign} agents={agents} activeAgent={activeAgent} onUpdate={onUpdate} />
        )}

        {/* ── Suppression List ── */}
        {tab === 'suppression' && (
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <div style={{ fontSize:13, color:'var(--gw-mist)' }}>Global DNC / opt-out list. Applies across all campaigns.</div>
              <button className="btn btn--ghost btn--sm" onClick={() => setAddSupp(true)}>
                <Icon name="plus" size={13}/> Add Entry
              </button>
            </div>
            {addSupp && (
              <div style={{ background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:14, marginBottom:14 }}>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8 }}>
                  <input className="form-control" placeholder="Full name" value={suppForm.full_name} onChange={e => setSuppForm(p=>({...p,full_name:e.target.value}))}/>
                  <input className="form-control" placeholder="Address / email / phone" value={suppForm.address} onChange={e => setSuppForm(p=>({...p,address:e.target.value}))}/>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:8, marginBottom:8 }}>
                  <select className="form-control" value={suppForm.reason} onChange={e => setSuppForm(p=>({...p,reason:e.target.value}))}>
                    <option value="dnc">DNC</option>
                    <option value="opted-out">Opted Out</option>
                    <option value="deceased">Deceased</option>
                    <option value="returned-mail">Returned Mail</option>
                    <option value="other">Other</option>
                  </select>
                  <input className="form-control" placeholder="Notes (optional)" value={suppForm.notes} onChange={e => setSuppForm(p=>({...p,notes:e.target.value}))}/>
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <button className="btn btn--ghost btn--sm" onClick={()=>setAddSupp(false)}>Cancel</button>
                  <button className="btn btn--primary btn--sm" onClick={addSuppression}>Add</button>
                </div>
              </div>
            )}
            {suppressions.length === 0
              ? <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:32, fontSize:13 }}>No suppressed entries yet.</div>
              : suppressions.map(s => (
                <div key={s.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid var(--gw-border)' }}>
                  <div>
                    <span style={{ fontWeight:700, fontSize:13 }}>{s.full_name || s.address || s.email || s.phone || '—'}</span>
                    <span style={{ marginLeft:8, padding:'2px 8px', borderRadius:8, fontSize:11, fontWeight:700, background:'var(--gw-red-light)', color:'var(--gw-red)' }}>{s.reason}</span>
                    {s.notes && <span style={{ fontSize:11, color:'var(--gw-mist)', marginLeft:8 }}>{s.notes}</span>}
                  </div>
                  <button className="btn btn--ghost btn--icon btn--sm" onClick={()=>removeSupp(s.id)} title="Remove">
                    <Icon name="trash" size={13}/>
                  </button>
                </div>
              ))}
          </div>
        )}
      </div>

      {/* Modals */}
      {logOpen && (
        <LogSendModal
          campaign={campaign}
          contacts={contacts}
          agents={agents}
          activeAgent={activeAgent}
          coldLeads={coldLeads}
          onSave={send => { setSends(p => [send, ...p]); setLogOpen(false); loadAnalytics(); pushToast('Send logged') }}
          onClose={() => setLogOpen(false)}
        />
      )}
      {editOpen && (
        <Modal open={true} onClose={() => setEditOpen(false)} width={560}>
          <div className="modal__head">
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>Edit Campaign</h3>
            <button className="drawer__close" onClick={() => setEditOpen(false)}><Icon name="x" size={18}/></button>
          </div>
          <div className="modal__body">
            <CampaignForm
              initial={campaign}
              agents={agents}
              activeAgent={activeAgent}
              saving={saving}
              onCancel={() => setEditOpen(false)}
              onSave={async form => {
                setSaving(true)
                const res  = await fetch('/api/campaigns', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'update_campaign', ...form }) })
                const data = await res.json()
                setSaving(false)
                if (!res.ok) { pushToast(data.error, 'error'); return }
                onUpdate(data.campaign)
                setEditOpen(false)
                pushToast('Campaign updated')
              }}
            />
          </div>
        </Modal>
      )}
      {confirmDel && (
        <ConfirmDialog
          title="Remove Send"
          message="Remove this send record? This cannot be undone."
          onConfirm={() => { deleteSend(confirmDel); setConfirmDel(null) }}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CampaignsPage({ db, setDb, activeAgent }) {
  const [campaigns,    setCampaigns]    = useState([])
  const [agents,       setAgents]       = useState([])
  const [contacts,     setContacts]     = useState([])
  const [coldLeads,    setColdLeads]    = useState([])
  const [loading,      setLoading]      = useState(true)
  const [selected,     setSelected]     = useState(null)
  const [newOpen,      setNewOpen]      = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [search,       setSearch]       = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [ready,        setReady]        = useState(true)

  useEffect(() => { loadAll() }, [])

  const loadAll = async () => {
    setLoading(true)
    const [campRes, agentsRes, contactsRes] = await Promise.all([
      fetch('/api/campaigns?action=list_campaigns'),
      supabase.from('agents').select('id, name, initials, color').order('name'),
      supabase.from('contacts').select('id, first_name, last_name, email, phone, owner_address, owner_city, owner_state, owner_zip').order('last_name'),
    ])

    if (!campRes.ok) {
      const err = await campRes.json()
      if (err.error?.includes('does not exist') || err.error?.includes('relation')) setReady(false)
      setLoading(false)
      return
    }

    const campData = await campRes.json()
    setCampaigns(campData.campaigns || [])
    setAgents(agentsRes.data || [])
    setContacts(contactsRes.data || [])

    // Load cold call leads in background
    supabase.from('cold_call_leads').select('id, owner_name, contact_name, property_address, list_id').limit(500).then(({ data }) => {
      setColdLeads(data || [])
    })

    setLoading(false)
  }

  const createCampaign = async (form) => {
    setSaving(true)
    const res  = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_campaign', ...form }),
    })
    const data = await res.json()
    setSaving(false)
    if (!res.ok || data.error) { pushToast(data.error || 'Failed to create campaign', 'error'); return }
    setCampaigns(p => [data.campaign, ...p])
    setNewOpen(false)
    setSelected(data.campaign)
    pushToast('Campaign created')
  }

  const updateCampaign = (updated) => {
    setCampaigns(p => p.map(c => c.id === updated.id ? updated : c))
    if (selected?.id === updated.id) setSelected(updated)
  }

  const deleteCampaign = async (id) => {
    await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_campaign', id }),
    })
    setCampaigns(p => p.filter(c => c.id !== id))
    if (selected?.id === id) setSelected(null)
    pushToast('Campaign deleted')
  }

  const filtered = campaigns.filter(c => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false
    if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const totalSends     = campaigns.reduce((n, c) => n + (c.total_sends || 0), 0)
  const totalResponses = campaigns.reduce((n, c) => n + (c.total_responses || 0), 0)
  const overallRate    = totalSends > 0 ? Math.round(totalResponses / totalSends * 100) : 0

  if (!ready) {
    return (
      <div style={{ padding:40, maxWidth:560 }}>
        <h2 style={{ fontFamily:'var(--font-display)' }}>Campaign Tracking</h2>
        <p style={{ color:'var(--gw-mist)' }}>Run the following SQL in your Supabase SQL Editor to enable this feature:</p>
        <pre style={{ background:'var(--gw-bone)', padding:16, borderRadius:8, fontSize:12, overflowX:'auto' }}>{SQL_SETUP}</pre>
        <button className="btn btn--primary" onClick={loadAll}>Check Again</button>
      </div>
    )
  }

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>
      {/* ── Left: campaign list ── */}
      <div style={{ width: selected ? 380 : '100%', minWidth:320, flexShrink:0, display:'flex', flexDirection:'column', borderRight: selected ? '1px solid var(--gw-border)' : 'none', overflow:'hidden' }}>

        {/* Page header */}
        <div style={{ padding:'20px 24px 12px', borderBottom:'1px solid var(--gw-border)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
            <div>
              <h1 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:22 }}>Campaigns</h1>
              <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:2 }}>Mail flyers · Cold calls · Email blasts</div>
            </div>
            <button className="btn btn--primary btn--sm" onClick={() => setNewOpen(true)}>
              <Icon name="plus" size={13}/> New Campaign
            </button>
          </div>

          {/* Global stats */}
          <div style={{ display:'flex', gap:10, marginBottom:12 }}>
            <StatCard value={campaigns.length} label="Campaigns"/>
            <StatCard value={totalSends}        label="Total Sends"/>
            <StatCard value={`${overallRate}%`} label="Avg Response" color={overallRate > 12 ? 'var(--gw-green)' : undefined}/>
          </div>

          {/* Search + filter */}
          <div style={{ display:'flex', gap:8 }}>
            <input
              className="form-control"
              style={{ flex:1 }}
              placeholder="Search campaigns…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <select className="form-control" style={{ width:120 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">All Statuses</option>
              {Object.entries(STATUS_CONFIG).map(([v,c]) => <option key={v} value={v}>{c.label}</option>)}
            </select>
          </div>
        </div>

        {/* Campaign list */}
        <div style={{ flex:1, overflowY:'auto', padding:'8px 0' }}>
          {loading
            ? <div style={{ textAlign:'center', padding:40, color:'var(--gw-mist)', fontSize:13 }}>Loading…</div>
            : filtered.length === 0
              ? <EmptyState icon="mail" title="No campaigns yet" message="Create your first campaign to start tracking mail flyers and cold call outreach." action={<button className="btn btn--primary btn--sm" onClick={()=>setNewOpen(true)}>New Campaign</button>}/>
              : filtered.map(c => {
                const responseRate = c.total_sends > 0 ? Math.round(c.total_responses / c.total_sends * 100) : 0
                const agent = agents.find(a => a.id === c.agent_id)
                return (
                  <div key={c.id}
                    onClick={() => setSelected(selected?.id === c.id ? null : c)}
                    style={{
                      padding:'14px 20px',
                      cursor:'pointer',
                      borderBottom:'1px solid var(--gw-border)',
                      background: selected?.id === c.id ? '#f0f7ff' : '#fff',
                      borderLeft: selected?.id === c.id ? '3px solid var(--gw-azure)' : '3px solid transparent',
                    }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:7, flexWrap:'wrap' }}>
                          <span style={{ fontWeight:700, fontSize:14, color:'var(--gw-ink)' }}>{c.name}</span>
                          <StatusBadge status={c.status}/>
                        </div>
                        {c.property_types?.length > 0 && (
                          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:3 }}>
                            {c.property_types.slice(0,3).map(t => t.charAt(0).toUpperCase()+t.slice(1)).join(' · ')}
                            {c.property_types.length > 3 && ` +${c.property_types.length-3}`}
                          </div>
                        )}
                        <div style={{ display:'flex', gap:12, marginTop:6, fontSize:12, color:'var(--gw-mist)' }}>
                          <span><strong style={{ color:'var(--gw-ink)' }}>{c.total_sends || 0}</strong> sends</span>
                          <span><strong style={{ color: responseRate > 0 ? 'var(--gw-azure)' : 'var(--gw-mist)' }}>{responseRate}%</strong> response</span>
                          {agent && <span>· {agent.name}</span>}
                        </div>
                      </div>
                      {/* Frequency cap indicator */}
                      {c.frequency_cap > 0 && (
                        <span title={`Cap: ${c.frequency_cap} sends per ${c.frequency_days} days`} style={{ fontSize:10, fontWeight:700, color:'var(--gw-mist)', background:'var(--gw-bone)', padding:'2px 6px', borderRadius:8, whiteSpace:'nowrap', flexShrink:0 }}>
                          cap {c.frequency_cap}/{c.frequency_days}d
                        </span>
                      )}
                    </div>
                  </div>
                )
              })
          }
        </div>
      </div>

      {/* ── Right: detail panel ── */}
      {selected && (
        <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
          <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--gw-border)', display:'flex', justifyContent:'flex-end', gap:8 }}>
            <button className="btn btn--ghost btn--sm" style={{ color:'var(--gw-red)' }}
              onClick={() => {
                if (confirm(`Delete campaign "${selected.name}"? All send history will be lost.`)) deleteCampaign(selected.id)
              }}>
              <Icon name="trash" size={13}/> Delete
            </button>
            <button className="btn btn--ghost btn--icon btn--sm" onClick={() => setSelected(null)}><Icon name="x" size={16}/></button>
          </div>
          <div style={{ flex:1, overflow:'auto' }}>
            <CampaignDrawer
              campaign={selected}
              contacts={contacts}
              agents={agents}
              activeAgent={activeAgent}
              coldLeads={coldLeads}
              onUpdate={updateCampaign}
              onClose={() => setSelected(null)}
            />
          </div>
        </div>
      )}

      {/* New campaign modal */}
      {newOpen && (
        <Modal open={true} onClose={() => setNewOpen(false)} width={560}>
          <div className="modal__head">
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>New Campaign</h3>
            <button className="drawer__close" onClick={() => setNewOpen(false)}><Icon name="x" size={18}/></button>
          </div>
          <div className="modal__body">
            <CampaignForm
              agents={agents}
              activeAgent={activeAgent}
              saving={saving}
              onCancel={() => setNewOpen(false)}
              onSave={createCampaign}
            />
          </div>
        </Modal>
      )}
    </div>
  )
}
