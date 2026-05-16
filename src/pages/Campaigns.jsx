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

const TEMPLATE_DESIGNS = {
  just_listed:     { bg:'#1d4ed8', headerBg:'#1e3a8a', text:'#ffffff', accent:'#fbbf24', accentText:'#1e1b4b' },
  just_sold:       { bg:'#166534', headerBg:'#14532d', text:'#ffffff', accent:'#86efac', accentText:'#14532d' },
  buyers_waiting:  { bg:'#5b21b6', headerBg:'#4c1d95', text:'#ffffff', accent:'#fbbf24', accentText:'#3b0764' },
  exclusive_offer: { bg:'#92400e', headerBg:'#78350f', text:'#ffffff', accent:'#fef3c7', accentText:'#78350f' },
  market_update:   { bg:'#0f172a', headerBg:'#1e293b', text:'#ffffff', accent:'#38bdf8', accentText:'#0c4a6e' },
  sellers_wanted:  { bg:'#b91c1c', headerBg:'#991b1b', text:'#ffffff', accent:'#fecaca', accentText:'#7f1d1d' },
}
const TEMPLATE_BADGE_LABELS = {
  just_listed:'Just Listed', just_sold:'Just Sold', buyers_waiting:'Buyers Wanted',
  exclusive_offer:'Exclusive Off-Market', market_update:'Market Update', sellers_wanted:'Sellers Wanted',
}

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

// ── Postcard visual renderer ──────────────────────────────────────────────────
function PostcardPreview({ copy, template, agentObj, photoUrl, photoCaption }) {
  const d = TEMPLATE_DESIGNS[template] || TEMPLATE_DESIGNS.just_listed
  const badge = TEMPLATE_BADGE_LABELS[template] || 'Campaign'
  const hasPhoto = !!photoUrl
  return (
    <div style={{ borderRadius:10, overflow:'hidden', boxShadow:'0 6px 28px rgba(0,0,0,0.22)', background:d.bg, display:'flex', flexDirection:'column' }}>
      {/* Header */}
      <div style={{ background:d.headerBg, padding: hasPhoto ? '8px 14px' : '10px 16px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span style={{ background:d.accent, color:d.accentText, padding:'3px 12px', borderRadius:20, fontSize:10, fontWeight:800, letterSpacing:'0.07em', textTransform:'uppercase' }}>
          {badge}
        </span>
        {agentObj && (
          <div style={{ width:30, height:30, borderRadius:'50%', background:agentObj.color||d.accent, display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:800, color:'#fff', boxShadow:'0 2px 8px rgba(0,0,0,0.25)', flexShrink:0 }}>
            {agentObj.initials || agentObj.name?.[0] || '?'}
          </div>
        )}
      </div>
      {/* Property photo */}
      {hasPhoto && (
        <div style={{ position:'relative', height:130, flexShrink:0, overflow:'hidden' }}>
          <img src={photoUrl} alt="Property" style={{ width:'100%', height:'100%', objectFit:'cover' }} loading="lazy"/>
          {photoCaption && (
            <div style={{ position:'absolute', bottom:0, left:0, right:0, background:'rgba(0,0,0,0.58)', padding:'4px 10px', fontSize:9, color:'#fff', lineHeight:1.3 }}>
              {photoCaption}
            </div>
          )}
        </div>
      )}
      {/* Body */}
      <div style={{ padding: hasPhoto ? '8px 14px' : '14px 18px', display:'flex', flexDirection:'column', gap: hasPhoto ? 4 : 8, flex:1 }}>
        <div style={{ fontSize: hasPhoto ? 15 : 20, fontWeight:900, color:d.text, lineHeight:1.15, textTransform:'uppercase', letterSpacing:'0.02em', fontFamily:'var(--font-display)' }}>
          {copy.headline}
        </div>
        <div style={{ fontSize: hasPhoto ? 10 : 13, fontWeight:700, color:d.accent, lineHeight:1.3 }}>
          {copy.subheadline}
        </div>
        {!hasPhoto && (
          <p style={{ fontSize:12, color:d.text, opacity:0.9, lineHeight:1.6, margin:0 }}>
            {copy.tagline}
          </p>
        )}
        {copy.bullets?.length > 0 && (
          <div style={{ display:'flex', flexWrap: hasPhoto ? 'wrap' : 'nowrap', flexDirection: hasPhoto ? 'row' : 'column', gap: hasPhoto ? '3px 10px' : 4 }}>
            {copy.bullets.map((b, i) => (
              <div key={i} style={{ display:'flex', gap: hasPhoto ? 4 : 8, alignItems:'flex-start', fontSize: hasPhoto ? 9 : 12, color:d.text }}>
                <span style={{ color:d.accent, fontWeight:800, flexShrink:0, lineHeight:1.5 }}>✓</span>
                <span style={{ lineHeight:1.5 }}>{b}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ alignSelf:'flex-start', background:d.accent, color:d.accentText, padding: hasPhoto ? '5px 14px' : '9px 20px', borderRadius:8, fontSize: hasPhoto ? 10 : 12, fontWeight:800, letterSpacing:'0.03em', marginTop:2 }}>
          {copy.cta}
        </div>
      </div>
      {/* Footer */}
      {agentObj?.name && (
        <div style={{ borderTop:`1px solid ${d.headerBg}`, padding:'6px 14px', display:'flex', gap:8, alignItems:'center' }}>
          <div style={{ width:20, height:20, borderRadius:'50%', background:agentObj.color||d.accent, display:'flex', alignItems:'center', justifyContent:'center', fontSize:8, fontWeight:800, color:'#fff', flexShrink:0 }}>
            {agentObj.initials || agentObj.name?.[0] || '?'}
          </div>
          <span style={{ fontSize:9, color:d.text, opacity:0.65 }}>
            {[agentObj.name, agentObj.role, agentObj.email].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}
    </div>
  )
}

function printFlyerWindow(copy, template, agentObj, campaignName, photoUrl = '', photoCaption = '') {
  const d = TEMPLATE_DESIGNS[template] || TEMPLATE_DESIGNS.just_listed
  const badge = TEMPLATE_BADGE_LABELS[template] || 'Campaign'
  const agentInitials = agentObj ? (agentObj.initials || agentObj.name?.[0] || '') : ''
  const agentColor    = agentObj?.color || d.accent
  const agentInfo     = agentObj ? [agentObj.name, agentObj.role, agentObj.email].filter(Boolean).join(' · ') : ''
  const hasPhoto      = !!photoUrl
  const bulletsHtml   = (copy.bullets || []).map(b =>
    `<li><span style="color:${d.accent};font-weight:800;flex-shrink:0;">✓</span> ${b}</li>`
  ).join('')

  const photoSection = hasPhoto ? `
    <div class="photo-wrap">
      <img src="${photoUrl}" class="photo-img" alt="Property"/>
      ${photoCaption ? `<div class="photo-cap">${photoCaption}</div>` : ''}
    </div>` : ''

  const w = window.open('', '_blank', 'width=960,height=700')
  if (!w) { pushToast('Allow pop-ups to print the flyer', 'error'); return }
  w.document.write(`<!DOCTYPE html><html><head><title>${campaignName} — Flyer</title>
<style>
  @page { size: 6in 4in; margin: 0; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 6in; height: 4in; overflow: hidden; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background: ${d.bg}; display: flex; flex-direction: column; }
  .hdr { background: ${d.headerBg}; padding: ${hasPhoto ? '8px 18px' : '12px 20px'}; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
  .badge { background: ${d.accent}; color: ${d.accentText}; padding: 4px 14px; border-radius: 20px; font-size: 10pt; font-weight: 800; letter-spacing: 0.07em; text-transform: uppercase; }
  .av { width: ${hasPhoto ? '32px' : '40px'}; height: ${hasPhoto ? '32px' : '40px'}; border-radius: 50%; background: ${agentColor}; display: flex; align-items: center; justify-content: center; font-size: 11pt; font-weight: 800; color: #fff; }
  .photo-wrap { position: relative; height: ${hasPhoto ? '1.6in' : '0'}; flex-shrink: 0; overflow: hidden; }
  .photo-img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .photo-cap { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.58); padding: 4px 12px; font-size: 8pt; color: #fff; }
  .body { flex: 1; padding: ${hasPhoto ? '10px 20px 8px' : '16px 22px 10px'}; display: flex; flex-direction: column; gap: ${hasPhoto ? '5px' : '8px'}; overflow: hidden; }
  .hl { font-size: ${hasPhoto ? '16pt' : '22pt'}; font-weight: 900; color: ${d.text}; line-height: 1.1; text-transform: uppercase; letter-spacing: 0.02em; }
  .sub { font-size: ${hasPhoto ? '10pt' : '11pt'}; font-weight: 700; color: ${d.accent}; }
  .tag { font-size: 10pt; color: ${d.text}; opacity: 0.9; line-height: 1.5; }
  ul { list-style: none; display: flex; flex-direction: ${hasPhoto ? 'row' : 'column'}; flex-wrap: ${hasPhoto ? 'wrap' : 'nowrap'}; gap: ${hasPhoto ? '4px 14px' : '5px'}; }
  li { font-size: ${hasPhoto ? '9pt' : '10pt'}; color: ${d.text}; display: flex; gap: 6px; align-items: flex-start; }
  .cta { display: inline-block; background: ${d.accent}; color: ${d.accentText}; padding: ${hasPhoto ? '6px 16px' : '9px 20px'}; border-radius: 8px; font-size: ${hasPhoto ? '9pt' : '10pt'}; font-weight: 800; letter-spacing: 0.03em; margin-top: 4px; }
  .ftr { border-top: 1px solid ${d.headerBg}; padding: 7px 20px; display: flex; gap: 10px; align-items: center; flex-shrink: 0; }
  .av-sm { width: 20px; height: 20px; border-radius: 50%; background: ${agentColor}; display: inline-flex; align-items: center; justify-content: center; font-size: 7pt; font-weight: 800; color: #fff; flex-shrink: 0; }
  .ftr-txt { font-size: 9pt; color: ${d.text}; opacity: 0.65; }
</style>
</head><body>
  <div class="hdr">
    <span class="badge">${badge}</span>
    ${agentInitials ? `<div class="av">${agentInitials}</div>` : ''}
  </div>
  ${photoSection}
  <div class="body">
    <div class="hl">${copy.headline}</div>
    <div class="sub">${copy.subheadline}</div>
    ${!hasPhoto ? `<div class="tag">${copy.tagline}</div>` : ''}
    <ul>${bulletsHtml}</ul>
    <span class="cta">${copy.cta}</span>
  </div>
  ${agentInfo ? `<div class="ftr"><div class="av-sm">${agentInitials}</div><span class="ftr-txt">${agentInfo}</span></div>` : ''}
</body></html>`)
  w.document.close()
  setTimeout(() => w.print(), 500)
}

// ── Flyer / AI Copy Tab ───────────────────────────────────────────────────────
function FlyerTab({ campaign, agents, activeAgent, onUpdate }) {
  const [selectedTemplate, setSelectedTemplate] = useState(campaign.flyer_template || '')
  const [generatedCopy,    setGeneratedCopy]    = useState(null)
  const [generating,       setGenerating]       = useState(false)
  const [generateError,    setGenerateError]    = useState(null)
  const [copied,           setCopied]           = useState(false)
  const [saving,           setSaving]           = useState(false)
  const [canvaUrl,         setCanvaUrl]         = useState(campaign.canva_design_url || '')
  const [savingCanva,      setSavingCanva]      = useState(false)
  // Personalization Engine (#6)
  const [persTarget,       setPersTarget]       = useState('')  // contact_type
  const [persTone,         setPersTone]         = useState('')  // urgent/warm/luxury/data
  const [persArea,         setPersArea]         = useState('')  // target_area

  // ── Property photo states ──────────────────────────────────────────────────
  const [properties,       setProperties]       = useState([])
  const [propsLoaded,      setPropsLoaded]      = useState(false)
  const [linkedProperty,   setLinkedProperty]   = useState(null)
  const [propertyPhotos,   setPropertyPhotos]   = useState([])
  const [selectedPhotoUrl, setSelectedPhotoUrl] = useState(campaign.flyer_photo_urls?.[0] || '')
  const [photoCaption,     setPhotoCaption]     = useState(campaign.flyer_photo_caption || '')
  const [savingProperty,   setSavingProperty]   = useState(false)

  const agentObj = agents?.find(a => a.id === campaign.agent_id)

  // Load linked property on mount
  useEffect(() => {
    if (!campaign.property_id) return
    fetch(`/api/campaigns?action=get_property_photos&property_id=${campaign.property_id}`)
      .then(r => r.json())
      .then(d => {
        if (d.property) setLinkedProperty(d.property)
        if (d.photos)   setPropertyPhotos(d.photos)
      })
      .catch(() => {})
  }, [campaign.property_id])

  const loadProperties = async () => {
    if (propsLoaded) return
    const { data } = await supabase
      .from('properties')
      .select('id, address, city, state, zip, type, status, list_price, details')
      .order('created_at', { ascending: false })
      .limit(300)
    setProperties(data || [])
    setPropsLoaded(true)
  }

  const onSelectProperty = (id) => {
    if (!id) {
      setLinkedProperty(null)
      setPropertyPhotos([])
      setSelectedPhotoUrl('')
      setPhotoCaption('')
      return
    }
    const prop = properties.find(p => p.id === id)
    if (!prop) return
    setLinkedProperty(prop)
    setPropertyPhotos(prop.details?.photos || [])
    const pricePart = prop.list_price ? ` — Listed at $${Number(prop.list_price).toLocaleString()}` : ''
    setPhotoCaption(`${prop.address}${prop.city ? `, ${prop.city}` : ''}${prop.state ? ` ${prop.state}` : ''}${pricePart}`)
    setSelectedPhotoUrl('')
  }

  const savePropertyLink = async () => {
    setSavingProperty(true)
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update_campaign',
          id: campaign.id,
          property_id: linkedProperty?.id || null,
          flyer_photo_urls: selectedPhotoUrl ? [selectedPhotoUrl] : [],
          flyer_photo_caption: photoCaption || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) { pushToast(data.error || 'Failed to save property link', 'error'); return }
      if (onUpdate) onUpdate(data.campaign)
      pushToast('Property linked to campaign')
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setSavingProperty(false)
    }
  }

  const effectivePhotoUrl     = selectedPhotoUrl || campaign.flyer_photo_urls?.[0] || ''
  const effectivePhotoCaption = photoCaption || campaign.flyer_photo_caption || ''

  const generateCopy = async () => {
    if (!selectedTemplate) { pushToast('Select a campaign type first', 'error'); return }
    setGenerating(true)
    setGenerateError(null)
    try {
      const res  = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template:              selectedTemplate,
          campaign_name:         campaign.name,
          property_types:        campaign.property_types,
          agent_name:            agentObj?.name || activeAgent?.name || '',
          target_area:           persArea || '',
          // Property personalization
          property_address:      linkedProperty?.address || '',
          property_price:        linkedProperty?.list_price || '',
          property_beds:         linkedProperty?.beds || '',
          property_baths:        linkedProperty?.baths || '',
          property_sqft:         linkedProperty?.sqft || '',
          photo_caption:         effectivePhotoCaption || '',
          // Audience personalization
          contact_type:          persTarget || '',
          // Tone
          personalization_tone:  persTone || '',
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        const msg = data.error || 'Failed to generate copy'
        setGenerateError(msg)
        pushToast(msg, 'error')
        return
      }
      setGeneratedCopy(data.copy)
      pushToast('Copy generated!')
    } catch (err) {
      const msg = err.message || 'Network error — could not reach server'
      setGenerateError(msg)
      pushToast(msg, 'error')
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

      {/* Personalization Engine (#6) */}
      <div style={{ background:'#eff6ff', border:'1.5px solid #bfdbfe', borderRadius:10, padding:'12px 14px' }}>
        <div style={{ fontSize:12, fontWeight:700, color:'#1d4ed8', marginBottom:8 }}>Personalization Options</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
          <div>
            <label className="form-label" style={{ fontSize:11 }}>Target Audience</label>
            <select className="form-control" style={{ fontSize:12 }} value={persTarget} onChange={e => setPersTarget(e.target.value)}>
              <option value="">General</option>
              <option value="buyer">Buyers</option>
              <option value="seller">Sellers</option>
              <option value="investor">Investors</option>
              <option value="landlord">Landlords</option>
              <option value="tenant">Tenants</option>
            </select>
          </div>
          <div>
            <label className="form-label" style={{ fontSize:11 }}>Copy Tone</label>
            <select className="form-control" style={{ fontSize:12 }} value={persTone} onChange={e => setPersTone(e.target.value)}>
              <option value="">Professional</option>
              <option value="urgent">Urgent / FOMO</option>
              <option value="warm">Warm / Community</option>
              <option value="luxury">Luxury / Premium</option>
              <option value="data">Data-Driven</option>
            </select>
          </div>
          <div>
            <label className="form-label" style={{ fontSize:11 }}>Target Area</label>
            <input className="form-control" style={{ fontSize:12 }} placeholder="e.g. Buckhead, Atlanta" value={persArea} onChange={e => setPersArea(e.target.value)}/>
          </div>
        </div>
        {linkedProperty && (
          <div style={{ fontSize:11, color:'#1d4ed8', marginTop:8 }}>
            Property details from {linkedProperty.address} will be included in the AI prompt.
          </div>
        )}
      </div>

      {/* Generate button */}
      <button className="btn btn--primary" onClick={generateCopy} disabled={generating || !selectedTemplate}>
        {generating ? 'Generating…' : '✨ Generate Personalized Copy with AI'}
      </button>
      {!selectedTemplate && (
        <div style={{ fontSize:12, color:'var(--gw-mist)', textAlign:'center', marginTop:-12 }}>
          ↑ Select a campaign type above to enable AI copy generation
        </div>
      )}
      {generateError && (
        <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:'var(--radius)', padding:'10px 14px', fontSize:12, color:'#dc2626', lineHeight:1.6 }}>
          <strong>AI generation failed:</strong> {generateError}
          {generateError.includes('ANTHROPIC_API_KEY') && (
            <div style={{ marginTop:6, color:'#7f1d1d' }}>
              To fix: add <code style={{ background:'#fee2e2', padding:'1px 5px', borderRadius:3, fontSize:11 }}>ANTHROPIC_API_KEY</code> to your Vercel project under <strong>Settings → Environment Variables</strong>, then redeploy.
            </div>
          )}
        </div>
      )}

      {/* Property Photo Section */}
      <div style={{ borderTop:'1px solid var(--gw-border)', paddingTop:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--gw-ink)' }}>Property Photos</div>
          {(campaign.property_id || linkedProperty) && (
            <span style={{ fontSize:11, fontWeight:700, color:'var(--gw-green)', background:'var(--gw-green-light)', padding:'1px 8px', borderRadius:10 }}>✓ Linked</span>
          )}
        </div>
        <div style={{ fontSize:12, color:'var(--gw-mist)', marginBottom:10 }}>Link a listing to show its photo on the flyer.</div>

        <div onClick={loadProperties}>
          <SearchDropdown
            items={properties.map(p => ({
              id: p.id,
              name: `${p.address}${p.city ? `, ${p.city}` : ''}`,
              sub: `${p.type} · ${p.status}${p.list_price ? ` · $${Number(p.list_price).toLocaleString()}` : ''}`,
            }))}
            value={linkedProperty?.id || campaign.property_id || ''}
            onSelect={onSelectProperty}
            placeholder="Search & link a property…"
          />
        </div>

        {/* Photo grid */}
        {propertyPhotos.length > 0 && (
          <div style={{ marginTop:10 }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)', marginBottom:6, textTransform:'uppercase', letterSpacing:'0.05em' }}>Select Flyer Photo</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:6 }}>
              {propertyPhotos.slice(0, 6).map((url, i) => (
                <div key={url}
                  onClick={() => setSelectedPhotoUrl(selectedPhotoUrl === url ? '' : url)}
                  style={{ height:64, borderRadius:8, overflow:'hidden', cursor:'pointer', border:`3px solid ${selectedPhotoUrl === url ? 'var(--gw-azure)' : 'transparent'}`, position:'relative', background:'var(--gw-bone)' }}>
                  <img src={url} alt={`Photo ${i+1}`} style={{ width:'100%', height:'100%', objectFit:'cover' }} loading="lazy"/>
                  {selectedPhotoUrl === url && (
                    <div style={{ position:'absolute', top:3, right:3, background:'var(--gw-azure)', color:'#fff', borderRadius:'50%', width:16, height:16, display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, fontWeight:800 }}>✓</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {linkedProperty && propertyPhotos.length === 0 && (
          <div style={{ marginTop:8, fontSize:12, color:'var(--gw-mist)', padding:'8px 12px', background:'var(--gw-bone)', borderRadius:8 }}>
            No photos on this listing yet — add photos in the Properties tab.
          </div>
        )}

        {/* Caption */}
        {(selectedPhotoUrl || effectivePhotoUrl) && (
          <div style={{ marginTop:8 }}>
            <input className="form-control" placeholder="Photo caption on flyer…" value={photoCaption} onChange={e => setPhotoCaption(e.target.value)}/>
          </div>
        )}

        {linkedProperty && (
          <button className="btn btn--ghost btn--sm" onClick={savePropertyLink} disabled={savingProperty} style={{ marginTop:8 }}>
            {savingProperty ? 'Saving…' : 'Save Property Link'}
          </button>
        )}
      </div>

      {/* Visual postcard preview */}
      {generatedCopy && (
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)', textTransform:'uppercase', letterSpacing:'0.05em' }}>Flyer Preview</div>
          <PostcardPreview copy={generatedCopy} template={selectedTemplate} agentObj={agentObj}
            photoUrl={effectivePhotoUrl} photoCaption={effectivePhotoCaption} />
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <button className="btn btn--ghost btn--sm" onClick={copyAllText}>{copied ? '✓ Copied!' : 'Copy Text'}</button>
            <button className="btn btn--primary btn--sm" onClick={saveToCampaign} disabled={saving}>{saving ? 'Saving…' : 'Save to Campaign'}</button>
            <button className="btn btn--ghost btn--sm"
              onClick={() => printFlyerWindow(generatedCopy, selectedTemplate, agentObj, campaign.name, effectivePhotoUrl, effectivePhotoCaption)}
              style={{ background:'#f0f7ff', borderColor:'#bfdbfe', color:'#1d4ed8' }}>
              Print / Download
            </button>
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

// ── Audience Builder Modal ────────────────────────────────────────────────────
const CONTACT_TYPES   = ['buyer','seller','landlord','tenant','investor']
const CONTACT_SOURCES = ['referral','website','open house','social','cold call','other']

function AudienceBuilderModal({ campaign, agents, activeAgent, onSent, onClose }) {
  const [filters, setFilters] = useState({ types:[], statuses:['active'], zip_codes:'', cities:'', states:'', tags:'', sources:[], days_since_contact:'', assigned_agent_id:'' })
  const [preview, setPreview]   = useState(null)
  const [loading, setLoading]   = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [channel,  setChannel]  = useState('direct-mail')
  const [sending,  setSending]  = useState(false)
  const [sentAt,   setSentAt]   = useState(new Date().toISOString().slice(0,10))
  const [scores,   setScores]   = useState(null)
  const [scoresTab, setScoresTab] = useState('builder')  // 'builder' | 'scores'

  const setF = (k, v) => setFilters(p => ({ ...p, [k]: v }))

  const toggleArr = (k, v) => setFilters(p => {
    const arr = p[k] || []
    return { ...p, [k]: arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v] }
  })

  const runPreview = async () => {
    setLoading(true)
    const params = new URLSearchParams({ action:'audience_preview' })
    if (filters.types.length)     params.set('types',            filters.types.join(','))
    if (filters.statuses.length)  params.set('statuses',         filters.statuses.join(','))
    if (filters.zip_codes.trim()) params.set('zip_codes',        filters.zip_codes)
    if (filters.cities.trim())    params.set('cities',           filters.cities)
    if (filters.states.trim())    params.set('states',           filters.states)
    if (filters.tags.trim())      params.set('tags',             filters.tags)
    if (filters.sources.length)   params.set('sources',          filters.sources.join(','))
    if (filters.days_since_contact) params.set('days_since_contact', filters.days_since_contact)
    if (filters.assigned_agent_id)  params.set('assigned_agent_id', filters.assigned_agent_id)
    const res  = await fetch(`/api/campaigns?${params}`)
    const data = await res.json()
    const contacts = data.contacts || []
    setPreview(contacts)
    setSelected(new Set(contacts.map(c => c.id)))
    setLoading(false)
  }

  const sendBatch = async () => {
    if (!selected.size) return
    setSending(true)
    const res  = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:      'bulk_log_sends',
        campaign_id: campaign.id,
        contact_ids: [...selected],
        channel,
        agent_id:    activeAgent?.id || null,
        sent_at:     sentAt ? new Date(sentAt).toISOString() : new Date().toISOString(),
      }),
    })
    const data = await res.json()
    setSending(false)
    if (res.ok) {
      onSent(data.sends || [])
      pushToast(`${data.count} sends logged`)
      onClose()
    } else {
      pushToast(data.error || 'Failed to log batch', 'error')
    }
  }

  const loadScores = async () => {
    if (scores) return
    const res  = await fetch('/api/campaigns?action=get_engagement_scores')
    const data = await res.json()
    setScores(data.scores || [])
  }

  const allSelected = preview && selected.size === preview.length
  const toggleAll   = () => setSelected(allSelected ? new Set() : new Set(preview.map(c => c.id)))
  const toggleOne   = id => setSelected(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n })

  return (
    <Modal open={true} onClose={onClose} width={700}>
      <div className="modal__head">
        <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>Smart Audience Builder</h3>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body" style={{ display:'flex', flexDirection:'column', gap:16 }}>

        {/* Sub-tabs */}
        <div style={{ display:'flex', gap:0, borderBottom:'1px solid var(--gw-border)' }}>
          {[['builder','Audience Builder'],['scores','Engagement Scores']].map(([v,l]) => (
            <button key={v} onClick={() => { setScoresTab(v); if (v==='scores') loadScores() }}
              style={{ padding:'6px 14px', fontSize:13, fontWeight:600, cursor:'pointer', border:'none', background:'transparent',
                borderBottom: scoresTab===v ? '2.5px solid var(--gw-azure)' : '2.5px solid transparent',
                color: scoresTab===v ? 'var(--gw-azure)' : 'var(--gw-mist)' }}>{l}</button>
          ))}
        </div>

        {/* Engagement Scores Panel */}
        {scoresTab === 'scores' && (
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            {scores === null
              ? <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:24 }}>Loading…</div>
              : scores.length === 0
              ? <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:24, fontSize:13 }}>No scored contacts yet. Send some mailers first.</div>
              : (
                <div>
                  <div style={{ display:'flex', gap:10, marginBottom:12 }}>
                    {['hot','warm','cold'].map(tier => {
                      const cnt = scores.filter(s=>s.tier===tier).length
                      const cfg = { hot:{ bg:'#fef2f2', color:'#dc2626', label:'Hot' }, warm:{ bg:'#fef9c3', color:'#92400e', label:'Warm' }, cold:{ bg:'#eff6ff', color:'#1d4ed8', label:'Cold' } }[tier]
                      return (
                        <div key={tier} style={{ flex:1, background:cfg.bg, borderRadius:10, padding:'10px 14px', textAlign:'center' }}>
                          <div style={{ fontSize:20, fontWeight:800, color:cfg.color }}>{cnt}</div>
                          <div style={{ fontSize:11, color:cfg.color, marginTop:2 }}>{cfg.label} Contacts</div>
                        </div>
                      )
                    })}
                  </div>
                  <div style={{ maxHeight:320, overflowY:'auto', border:'1px solid var(--gw-border)', borderRadius:8 }}>
                    {scores.slice(0,50).map(s => {
                      const TIER = { hot:{ bg:'#fef2f2', color:'#dc2626' }, warm:{ bg:'#fef9c3', color:'#92400e' }, cold:{ bg:'#eff6ff', color:'#1d4ed8' } }[s.tier]
                      return (
                        <div key={s.contact_id} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 12px', borderBottom:'1px solid var(--gw-border)' }}>
                          <span style={{ flex:1, fontSize:13, fontWeight:600, color:'var(--gw-ink)' }}>{s.contact_id?.slice(0,8)}</span>
                          <span style={{ fontSize:11, color:'var(--gw-mist)' }}>{s.sends} sends · {s.responses} resp</span>
                          <span style={{ fontSize:11, fontWeight:800, color:TIER.color, background:TIER.bg, padding:'1px 8px', borderRadius:8 }}>{s.score}pts</span>
                          <span style={{ fontSize:10, fontWeight:700, padding:'1px 6px', borderRadius:8, background:TIER.bg, color:TIER.color, textTransform:'uppercase' }}>{s.tier}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            }
          </div>
        )}

        {scoresTab === 'builder' && (<>
        {/* Filters */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div>
            <label className="form-label">Contact Type</label>
            <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
              {CONTACT_TYPES.map(t => (
                <button key={t} onClick={() => toggleArr('types', t)}
                  style={{ padding:'3px 10px', borderRadius:20, fontSize:12, fontWeight:600, cursor:'pointer', border:'1.5px solid', textTransform:'capitalize',
                    background: filters.types.includes(t) ? 'var(--gw-azure)' : 'transparent',
                    color:      filters.types.includes(t) ? '#fff' : 'var(--gw-mist)',
                    borderColor:filters.types.includes(t) ? 'var(--gw-azure)' : 'var(--gw-border)' }}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="form-label">Status</label>
            <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
              {['active','cold','closed'].map(s => (
                <button key={s} onClick={() => toggleArr('statuses', s)}
                  style={{ padding:'3px 10px', borderRadius:20, fontSize:12, fontWeight:600, cursor:'pointer', border:'1.5px solid', textTransform:'capitalize',
                    background: filters.statuses.includes(s) ? '#7c3aed' : 'transparent',
                    color:      filters.statuses.includes(s) ? '#fff' : 'var(--gw-mist)',
                    borderColor:filters.statuses.includes(s) ? '#7c3aed' : 'var(--gw-border)' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="form-label">Zip Codes (comma-separated)</label>
            <input className="form-control" placeholder="e.g. 30301, 30302" value={filters.zip_codes} onChange={e => setF('zip_codes', e.target.value)}/>
          </div>
          <div>
            <label className="form-label">Cities (comma-separated)</label>
            <input className="form-control" placeholder="e.g. Atlanta, Decatur" value={filters.cities} onChange={e => setF('cities', e.target.value)}/>
          </div>
          <div>
            <label className="form-label">Tags (comma-separated)</label>
            <input className="form-control" placeholder="e.g. investor, vip" value={filters.tags} onChange={e => setF('tags', e.target.value)}/>
          </div>
          <div>
            <label className="form-label">Days Since Last Contact</label>
            <input className="form-control" type="number" min="0" placeholder="e.g. 90 (contacts not touched in 90+ days)" value={filters.days_since_contact} onChange={e => setF('days_since_contact', e.target.value)}/>
          </div>
          <div>
            <label className="form-label">Assigned Agent</label>
            <select className="form-control" value={filters.assigned_agent_id} onChange={e => setF('assigned_agent_id', e.target.value)}>
              <option value="">All agents</option>
              {agents?.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label">Source</label>
            <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
              {CONTACT_SOURCES.map(s => (
                <button key={s} onClick={() => toggleArr('sources', s)}
                  style={{ padding:'2px 8px', borderRadius:20, fontSize:11, fontWeight:600, cursor:'pointer', border:'1.5px solid', textTransform:'capitalize',
                    background: filters.sources.includes(s) ? '#0f766e' : 'transparent',
                    color:      filters.sources.includes(s) ? '#fff' : 'var(--gw-mist)',
                    borderColor:filters.sources.includes(s) ? '#0f766e' : 'var(--gw-border)' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        <button className="btn btn--primary" onClick={runPreview} disabled={loading} style={{ alignSelf:'flex-start' }}>
          {loading ? 'Loading…' : 'Preview Audience'}
        </button>

        {/* Preview list */}
        {preview !== null && (
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--gw-ink)' }}>
                {preview.length} contacts matched · {selected.size} selected
              </div>
              <button className="btn btn--ghost btn--sm" onClick={toggleAll}>
                {allSelected ? 'Deselect All' : 'Select All'}
              </button>
            </div>
            <div style={{ maxHeight:220, overflowY:'auto', border:'1px solid var(--gw-border)', borderRadius:8 }}>
              {preview.length === 0
                ? <div style={{ padding:24, textAlign:'center', color:'var(--gw-mist)', fontSize:13 }}>No contacts match these filters.</div>
                : preview.map(c => (
                  <label key={c.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 12px', borderBottom:'1px solid var(--gw-border)', cursor:'pointer', background: selected.has(c.id) ? '#eff6ff' : '#fff' }}>
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleOne(c.id)} style={{ cursor:'pointer' }}/>
                    <span style={{ flex:1, fontSize:13, fontWeight:600 }}>{c.first_name} {c.last_name}</span>
                    {c.owner_zip && <span style={{ fontSize:11, color:'var(--gw-mist)' }}>{c.owner_city || ''} {c.owner_zip}</span>}
                    <span style={{ fontSize:11, padding:'1px 7px', borderRadius:8, background:'var(--gw-bone)', color:'var(--gw-mist)', textTransform:'capitalize' }}>{c.type}</span>
                    {c.last_contacted_at && <span style={{ fontSize:11, color:'var(--gw-mist)' }}>{new Date(c.last_contacted_at).toLocaleDateString()}</span>}
                  </label>
                ))
              }
            </div>
          </div>
        )}

        {/* Send options */}
        {preview !== null && selected.size > 0 && (
          <div style={{ display:'flex', gap:10, alignItems:'center', flexWrap:'wrap', paddingTop:8, borderTop:'1px solid var(--gw-border)' }}>
            <div>
              <label className="form-label" style={{ marginBottom:4 }}>Channel</label>
              <select className="form-control" value={channel} onChange={e => setChannel(e.target.value)} style={{ width:160 }}>
                <option value="direct-mail">Direct Mail</option>
                <option value="email">Email</option>
                <option value="text">Text</option>
                <option value="door-hanger">Door Hanger</option>
              </select>
            </div>
            <div>
              <label className="form-label" style={{ marginBottom:4 }}>Send Date</label>
              <input className="form-control" type="date" value={sentAt} onChange={e => setSentAt(e.target.value)} style={{ width:160 }}/>
            </div>
            <button className="btn btn--primary" onClick={sendBatch} disabled={sending} style={{ alignSelf:'flex-end', marginBottom:0 }}>
              {sending ? 'Logging…' : `Log ${selected.size} Send${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        )}
        </>)}
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
  const [roi,          setRoi]          = useState(null)
  const [audienceOpen, setAudienceOpen] = useState(false)
  const [deals,        setDeals]        = useState([])
  const [linkDealId,   setLinkDealId]   = useState(null)  // send.id currently being linked
  const [costItems,    setCostItems]    = useState([])
  const [costLoaded,   setCostLoaded]   = useState(false)
  const [addingCost,   setAddingCost]   = useState(false)
  const [costForm,     setCostForm]     = useState({ category:'postage', description:'', unit_cost:'', quantity:'1', date_incurred:'' })
  const [savingCost,   setSavingCost]   = useState(false)
  const [abComparison, setAbComparison] = useState(null)
  const [abLoaded,     setAbLoaded]     = useState(false)
  const [creatingVariant, setCreatingVariant] = useState(false)
  const [seqSteps,     setSeqSteps]     = useState(() => campaign.schedule_steps || [])
  const [seqDirty,     setSeqDirty]     = useState(false)
  const [seqSaving,    setSeqSaving]    = useState(false)
  const [seqDueMap,    setSeqDueMap]    = useState({})  // { stepIndex: {sends, count} }
  const [duplicates,   setDuplicates]   = useState(null)
  const [dupLoading,   setDupLoading]   = useState(false)

  useEffect(() => { loadSends(); loadAnalytics(); loadROI(); setAbLoaded(false); setAbComparison(null) }, [campaign.id])
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

  const loadROI = async () => {
    const res  = await fetch(`/api/campaigns?action=campaign_roi&campaign_id=${campaign.id}`)
    const data = await res.json()
    setRoi(data.roi || null)
  }

  const loadDeals = async () => {
    if (deals.length > 0) return
    const res  = await fetch('/api/campaigns?action=list_deals')
    const data = await res.json()
    setDeals(data.deals || [])
  }

  const loadCostItems = async () => {
    if (costLoaded) return
    const res  = await fetch(`/api/campaigns?action=list_cost_items&campaign_id=${campaign.id}`)
    const data = await res.json()
    setCostItems(data.items || [])
    setCostLoaded(true)
  }

  const addCostItem = async () => {
    if (!costForm.unit_cost) return
    setSavingCost(true)
    const res  = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add_cost_item', campaign_id: campaign.id, ...costForm }),
    })
    const data = await res.json()
    if (res.ok) {
      setCostItems(p => [data.item, ...p])
      setCostForm({ category:'postage', description:'', unit_cost:'', quantity:'1', date_incurred:'' })
      setAddingCost(false)
      pushToast('Cost item added')
    } else {
      pushToast(data.error || 'Failed to add cost item', 'error')
    }
    setSavingCost(false)
  }

  const deleteCostItem = async (id) => {
    await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_cost_item', id }),
    })
    setCostItems(p => p.filter(i => i.id !== id))
    pushToast('Cost item removed')
  }

  const loadABComparison = async () => {
    if (abLoaded) return
    setAbLoaded(true)
    const res  = await fetch(`/api/campaigns?action=get_ab_comparison&campaign_id=${campaign.id}`)
    const data = await res.json()
    setAbComparison(data.comparison || null)
  }

  const createVariantB = async () => {
    setCreatingVariant(true)
    const res  = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_ab_variant', campaign_id: campaign.id }),
    })
    const data = await res.json()
    setCreatingVariant(false)
    if (res.ok) {
      pushToast(`Variant B created: "${data.variant?.name}"`)
      // Reload parent with updated is_ab_test flag
      onUpdate({ ...campaign, is_ab_test: true, ab_variant: 'A' })
    } else {
      pushToast(data.error || 'Failed to create variant', 'error')
    }
  }

  const declareWinner = async (winner) => {
    const parentId = campaign.ab_parent_campaign_id || campaign.id
    await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'declare_ab_winner', campaign_id: parentId, winner }),
    })
    onUpdate({ ...campaign, ab_winning_variant: winner })
    pushToast(`Variant ${winner} declared winner`)
    setAbComparison(null)
    setAbLoaded(false)
    loadABComparison()
  }

  const checkDuplicates = async () => {
    setDupLoading(true)
    const res  = await fetch(`/api/campaigns?action=find_duplicate_sends&campaign_id=${campaign.id}`)
    const data = await res.json()
    setDuplicates(data.duplicates || [])
    setDupLoading(false)
    if ((data.duplicates || []).length === 0) pushToast('No duplicates found')
  }

  const removeDuplicates = async () => {
    if (!duplicates?.length) return
    // Keep the first send in each group, remove the rest
    const toRemove = duplicates.flatMap(d => d.sends.slice(1).map(s => s.id))
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove_duplicate_sends', send_ids: toRemove }),
    })
    const data = await res.json()
    if (res.ok) {
      setSends(p => p.filter(s => !toRemove.includes(s.id)))
      setDuplicates([])
      pushToast(`Removed ${data.removed} duplicate sends`)
    }
  }

  const saveSeqSteps = async () => {
    setSeqSaving(true)
    await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_sequence_steps', campaign_id: campaign.id, steps: seqSteps }),
    })
    setSeqSaving(false)
    setSeqDirty(false)
    pushToast('Sequence saved')
  }

  const loadSeqDue = async (stepIdx, delayDays, filterResponse) => {
    const params = new URLSearchParams({ action:'get_sequence_due', campaign_id:campaign.id, step_delay_days:delayDays })
    if (filterResponse && filterResponse !== 'all') params.set('filter_response', filterResponse)
    const res  = await fetch(`/api/campaigns?${params}`)
    const data = await res.json()
    setSeqDueMap(p => ({ ...p, [stepIdx]: { sends: data.sends || [], count: data.count || 0 } }))
  }

  const linkDeal = async (sendId, dealId) => {
    await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'link_deal', send_id: sendId, deal_id: dealId || null }),
    })
    setLinkDealId(null)
    pushToast('Deal linked')
    loadROI()
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
            {campaign.is_ab_test && campaign.ab_variant && (
              <span style={{ padding:'2px 10px', borderRadius:20, fontSize:11, fontWeight:700, background:'#fef9c3', color:'#92400e', border:'1.5px solid #f59e0b' }}>
                Variant {campaign.ab_variant}
              </span>
            )}
            {campaign.ab_winning_variant && (
              <span style={{ padding:'2px 10px', borderRadius:20, fontSize:11, fontWeight:700, background:'#d1fae5', color:'#065f46' }}>
                Winner: {campaign.ab_winning_variant}
              </span>
            )}
            <button className="btn btn--ghost btn--sm" onClick={() => setEditOpen(true)}>Edit</button>
            {!campaign.is_ab_test && (
              <button className="btn btn--ghost btn--sm" onClick={createVariantB} disabled={creatingVariant} title="Duplicate as Variant B for A/B testing">
                {creatingVariant ? 'Creating…' : 'A/B Test'}
              </button>
            )}
            <button className="btn btn--ghost btn--sm" onClick={() => setAudienceOpen(true)} title="Build a targeted audience and log batch sends">
              <Icon name="users" size={13}/> Batch Send
            </button>
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
          {roi?.roi_pct != null && <StatCard value={`${roi.roi_pct > 0 ? '+' : ''}${roi.roi_pct}%`} label="ROI" color={roi.roi_pct > 0 ? '#16a34a' : roi.roi_pct < 0 ? 'var(--gw-red)' : undefined}/>}
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', gap:0, borderBottom:'1px solid var(--gw-border)', marginTop:0, overflowX:'auto' }}>
          {[['sends','Send Log'],['timeline','Timeline'],['analytics','Analytics'],['budget','Budget'],['sequence','Sequence'],['qr','QR Code'],['flyer','Flyer & AI'],['suppression','Suppression']].map(([v,l]) => (
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
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', paddingBottom:8 }}>
                    <button className="btn btn--ghost btn--sm" style={{ fontSize:12 }} onClick={checkDuplicates} disabled={dupLoading}>
                      {dupLoading ? 'Checking…' : 'Check Duplicates'}
                    </button>
                    <a href={`/api/campaigns?action=export_sends_csv&campaign_id=${campaign.id}`} download className="btn btn--ghost btn--sm" style={{ fontSize:12 }}>
                      <Icon name="download" size={12}/> Export CSV
                    </a>
                  </div>
                  {duplicates !== null && duplicates.length > 0 && (
                    <div style={{ background:'#fef9c3', border:'1.5px solid #f59e0b', borderRadius:8, padding:'10px 14px', marginBottom:8 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                        <span style={{ fontSize:13, fontWeight:700, color:'#92400e' }}>{duplicates.length} duplicate group{duplicates.length!==1?'s':''} found</span>
                        <button className="btn btn--primary btn--sm" style={{ fontSize:12, background:'#d97706', border:'none' }} onClick={removeDuplicates}>
                          Remove Duplicates (keep first)
                        </button>
                      </div>
                      {duplicates.slice(0,3).map((d,i) => (
                        <div key={i} style={{ fontSize:11, color:'#92400e', marginTop:2 }}>
                          {d.sends[0]?.recipient_name || d.sends[0]?.contact_id?.slice(0,8) || 'Unknown'} — {d.sends.length} sends
                        </div>
                      ))}
                      {duplicates.length > 3 && <div style={{ fontSize:11, color:'#92400e' }}>…and {duplicates.length-3} more</div>}
                    </div>
                  )}
                  {duplicates !== null && duplicates.length === 0 && (
                    <div style={{ fontSize:12, color:'var(--gw-green)', paddingBottom:8 }}>No duplicates found.</div>
                  )}
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
                        <div style={{ display:'flex', gap:6, alignItems:'center', flexShrink:0, flexWrap:'wrap', justifyContent:'flex-end' }}>
                          <select
                            value={s.response}
                            onChange={e => updateResponse(s, e.target.value)}
                            style={{ fontSize:11, padding:'3px 6px', borderRadius:6, border:'1px solid var(--gw-border)', cursor:'pointer', background:'#fff' }}>
                            {RESPONSE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                          <button
                            className="btn btn--ghost btn--sm"
                            title={s.deal_id ? 'Change linked deal' : 'Link to a deal for ROI tracking'}
                            onClick={() => { setLinkDealId(s.id); loadDeals() }}
                            style={{ fontSize:11, padding:'3px 8px', color: s.deal_id ? 'var(--gw-green)' : undefined }}>
                            {s.deal_id ? '$ Linked' : '$ Link Deal'}
                          </button>
                          <button className="btn btn--ghost btn--icon btn--sm" onClick={() => setConfirmDel(s.id)} title="Remove">
                            <Icon name="trash" size={13}/>
                          </button>
                        </div>
                        {linkDealId === s.id && (
                          <div style={{ gridColumn:'1/-1', marginTop:6, padding:'10px 12px', background:'var(--gw-bone)', borderRadius:8, display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                            <span style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Link deal:</span>
                            <select
                              className="form-control"
                              style={{ fontSize:12, flex:1, minWidth:180 }}
                              defaultValue={s.deal_id || ''}
                              id={`deal-select-${s.id}`}>
                              <option value="">— no deal —</option>
                              {deals.map(d => (
                                <option key={d.id} value={d.id}>
                                  {d.address || d.id.slice(0,8)} · {d.stage} {d.value ? `· $${Number(d.value).toLocaleString()}` : ''}
                                </option>
                              ))}
                            </select>
                            <button className="btn btn--primary btn--sm" style={{ fontSize:12 }}
                              onClick={() => {
                                const sel = document.getElementById(`deal-select-${s.id}`)
                                linkDeal(s.id, sel?.value || null)
                              }}>
                              Save
                            </button>
                            <button className="btn btn--ghost btn--sm" style={{ fontSize:12 }} onClick={() => setLinkDealId(null)}>Cancel</button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
        )}

        {/* ── Multi-Channel Timeline ── */}
        {tab === 'timeline' && (() => {
          const CHANNEL_DOT = {
            'direct-mail': { color:'#2563eb', label:'Mail' },
            mail:          { color:'#2563eb', label:'Mail' },
            email:         { color:'#16a34a', label:'Email' },
            text:          { color:'#7c3aed', label:'Text' },
            'cold-call':   { color:'#d97706', label:'Call' },
            'door-hanger': { color:'#0891b2', label:'Hanger' },
          }
          // Group sends by date
          const byDate = {}
          ;[...sends].sort((a,b) => new Date(a.sent_at) - new Date(b.sent_at)).forEach(s => {
            const d = s.sent_at ? new Date(s.sent_at).toLocaleDateString() : 'Unknown'
            if (!byDate[d]) byDate[d] = []
            byDate[d].push(s)
          })
          const dates = Object.keys(byDate)
          const channels = [...new Set(sends.map(s => s.channel).filter(Boolean))]
          return (
            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              {/* Channel legend */}
              <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
                {channels.map(ch => {
                  const cfg = CHANNEL_DOT[ch] || { color:'#9ca3af', label:ch }
                  const cnt = sends.filter(s => s.channel === ch).length
                  return (
                    <div key={ch} style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 12px', borderRadius:20, background:'var(--gw-bone)' }}>
                      <div style={{ width:10, height:10, borderRadius:'50%', background:cfg.color, flexShrink:0 }}/>
                      <span style={{ fontSize:12, fontWeight:700 }}>{cfg.label}</span>
                      <span style={{ fontSize:11, color:'var(--gw-mist)' }}>{cnt}</span>
                    </div>
                  )
                })}
              </div>
              {/* Timeline */}
              {dates.length === 0
                ? <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:32, fontSize:13 }}>No sends yet.</div>
                : dates.map(date => {
                  const daySends = byDate[date]
                  const byChannel = {}
                  daySends.forEach(s => { byChannel[s.channel] = (byChannel[s.channel]||0) + 1 })
                  const responded = daySends.filter(s=>s.response!=='no-response').length
                  return (
                    <div key={date} style={{ display:'grid', gridTemplateColumns:'90px 1fr', gap:12, alignItems:'start' }}>
                      <div style={{ textAlign:'right', paddingTop:4 }}>
                        <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>{date}</div>
                        <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{daySends.length} sends</div>
                      </div>
                      <div style={{ borderLeft:'2px solid var(--gw-border)', paddingLeft:16, paddingBottom:8 }}>
                        <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:4 }}>
                          {Object.entries(byChannel).map(([ch, n]) => {
                            const cfg = CHANNEL_DOT[ch] || { color:'#9ca3af', label:ch }
                            return (
                              <span key={ch} style={{ display:'flex', alignItems:'center', gap:5, padding:'2px 10px', borderRadius:12, fontSize:12, fontWeight:600, background: cfg.color+'18', color:cfg.color }}>
                                <span style={{ width:6, height:6, borderRadius:'50%', background:cfg.color, display:'inline-block' }}/>
                                {n} {cfg.label}
                              </span>
                            )
                          })}
                          {responded > 0 && (
                            <span style={{ fontSize:12, color:'var(--gw-green)', fontWeight:700 }}>· {responded} response{responded!==1?'s':''}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })
              }
            </div>
          )
        })()}

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
                    <div className="eyebrow-label" style={{ marginBottom:8 }}>Geographic Heatmap — Zip Code Performance</div>
                    <div style={{ display:'grid', gridTemplateColumns:'auto 1fr auto auto auto', gap:'4px 12px', alignItems:'center', fontSize:12 }}>
                      <span style={{ fontWeight:700, color:'var(--gw-mist)', fontSize:10 }}>ZIP</span>
                      <span style={{ fontWeight:700, color:'var(--gw-mist)', fontSize:10 }}>VOLUME</span>
                      <span style={{ fontWeight:700, color:'var(--gw-mist)', fontSize:10, textAlign:'right' }}>SENDS</span>
                      <span style={{ fontWeight:700, color:'var(--gw-mist)', fontSize:10, textAlign:'right' }}>RESP</span>
                      <span style={{ fontWeight:700, color:'var(--gw-mist)', fontSize:10, textAlign:'right' }}>RATE</span>
                      {Object.entries(analytics.by_zip_detail || analytics.by_zip || {})
                        .map(([zip, v]) => {
                          const detail = analytics.by_zip_detail?.[zip] || { sends: typeof v === 'number' ? v : 0, responses: 0 }
                          return { zip, ...detail }
                        })
                        .sort((a,b) => (b.responses/Math.max(b.sends,1)) - (a.responses/Math.max(a.sends,1)) || b.sends - a.sends)
                        .slice(0,15)
                        .map(({ zip, sends, responses }) => {
                          const rate = sends > 0 ? Math.round(responses/sends*100) : 0
                          const maxSends = Math.max(...Object.values(analytics.by_zip_detail || analytics.by_zip || {1:1}).map(v => typeof v === 'number' ? v : v.sends || 0))
                          const heatColor = rate >= 15 ? '#16a34a' : rate >= 8 ? '#2563eb' : rate >= 3 ? '#d97706' : '#e5e7eb'
                          return (
                            <React.Fragment key={zip}>
                              <span style={{ fontWeight:700, color:'var(--gw-ink)' }}>{zip}</span>
                              <div style={{ height:8, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden' }}>
                                <div style={{ width:`${Math.round(sends/maxSends*100)}%`, height:'100%', background: heatColor, borderRadius:4 }}/>
                              </div>
                              <span style={{ color:'var(--gw-mist)', textAlign:'right' }}>{sends}</span>
                              <span style={{ color:'var(--gw-mist)', textAlign:'right' }}>{responses}</span>
                              <span style={{ fontWeight:700, color: heatColor, textAlign:'right' }}>{rate}%</span>
                            </React.Fragment>
                          )
                        })}
                    </div>
                    <div style={{ display:'flex', gap:12, marginTop:8, fontSize:11, color:'var(--gw-mist)' }}>
                      <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:8, height:8, borderRadius:'50%', background:'#16a34a', display:'inline-block' }}/> Top ≥15%</span>
                      <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:8, height:8, borderRadius:'50%', background:'#2563eb', display:'inline-block' }}/> Good 8–14%</span>
                      <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:8, height:8, borderRadius:'50%', background:'#d97706', display:'inline-block' }}/> Avg 3–7%</span>
                      <span style={{ display:'flex', alignItems:'center', gap:4 }}><span style={{ width:8, height:8, borderRadius:'50%', background:'#e5e7eb', display:'inline-block' }}/> Low &lt;3%</span>
                    </div>
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
                {/* ── Industry Benchmarks ── */}
                {(() => {
                  const BENCHMARKS = [
                    { label:'Response Rate',   your: responseRate,                    low:1,  mid:5,  high:12, unit:'%', tip:'Warm lists (past clients, farm area) see 8–15%. Cold lists typically 1–5%.' },
                    { label:'Conversion Rate', your: conversionRate,                  low:0.5,mid:2,  high:5,  unit:'%', tip:'Top-performing agents convert 3–5% of mailer responses into deals.' },
                    { label:'Cost / Send',     your: costItems.length > 0 && sends.length > 0 ? Math.round(costItems.reduce((a,i)=>a+i.unit_cost*i.quantity,0)/sends.length*100)/100 : null,
                      low:0.3, mid:0.8, high:1.5, unit:'$', prefix:true, tip:'USPS Every Door Direct Mail: $0.20–$0.50/piece. Full-service with printing: $0.80–$1.50.' },
                    { label:'ROI',             your: roi?.roi_pct ?? null,            low:0,  mid:200,high:500, unit:'%', tip:'A single closed deal from 500 mailers ($400 cost, $10k commission) = 2,400% ROI.' },
                  ]
                  return (
                    <div>
                      <div className="eyebrow-label" style={{ marginBottom:10 }}>Industry Benchmarks</div>
                      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                        {BENCHMARKS.map(b => {
                          const hasData = b.your != null && b.your !== 0
                          const pct = hasData ? Math.min(Math.round(b.your / b.high * 100), 100) : 0
                          const status = !hasData ? 'none' : b.your >= b.high ? 'top' : b.your >= b.mid ? 'good' : b.your >= b.low ? 'ok' : 'low'
                          const color = { top:'#16a34a', good:'#2563eb', ok:'#d97706', low:'#dc2626', none:'#9ca3af' }[status]
                          const label = { top:'Above Benchmark', good:'At Benchmark', ok:'Below Average', low:'Needs Attention', none:'No data yet' }[status]
                          return (
                            <div key={b.label} style={{ background:'var(--gw-bone)', borderRadius:10, padding:'10px 14px' }}>
                              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
                                <span style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>{b.label}</span>
                                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                                  {hasData && (
                                    <span style={{ fontSize:13, fontWeight:800, color }}>
                                      {b.prefix ? '$' : ''}{b.your}{!b.prefix ? b.unit : ''}
                                    </span>
                                  )}
                                  <span style={{ fontSize:10, fontWeight:700, padding:'1px 7px', borderRadius:8, background: color+'22', color }}>{label}</span>
                                </div>
                              </div>
                              <div style={{ position:'relative', height:6, background:'#e5e7eb', borderRadius:4, overflow:'visible', marginBottom:6 }}>
                                {/* benchmark markers */}
                                <div style={{ position:'absolute', left:`${Math.round(b.low/b.high*100)}%`, top:-2, width:2, height:10, background:'#d97706', borderRadius:1, opacity:0.6 }}/>
                                <div style={{ position:'absolute', left:`${Math.round(b.mid/b.high*100)}%`, top:-2, width:2, height:10, background:'#2563eb', borderRadius:1, opacity:0.6 }}/>
                                {hasData && <div style={{ width:`${pct}%`, height:'100%', background: color, borderRadius:4, transition:'width 0.4s' }}/>}
                              </div>
                              <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'var(--gw-mist)' }}>
                                <span>Low {b.prefix?'$':''}{b.low}{!b.prefix?b.unit:''}</span>
                                <span>Avg {b.prefix?'$':''}{b.mid}{!b.prefix?b.unit:''}</span>
                                <span>Top {b.prefix?'$':''}{b.high}{!b.prefix?b.unit:''}</span>
                              </div>
                              {(!hasData || status === 'low' || status === 'ok') && (
                                <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6, borderTop:'1px solid var(--gw-border)', paddingTop:6 }}>{b.tip}</div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}

                {/* ── Revenue Attribution (ROI) ── */}
                <div>
                  <div className="eyebrow-label" style={{ marginBottom:10 }}>Revenue Attribution</div>
                  {roi ? (
                    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(130px,1fr))', gap:10 }}>
                        <div style={{ background:'var(--gw-bone)', borderRadius:10, padding:'10px 14px', textAlign:'center' }}>
                          <div style={{ fontSize:18, fontWeight:800, color:'var(--gw-ink)' }}>${roi.total_spend.toLocaleString()}</div>
                          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>Total Spend</div>
                        </div>
                        <div style={{ background:'var(--gw-bone)', borderRadius:10, padding:'10px 14px', textAlign:'center' }}>
                          <div style={{ fontSize:18, fontWeight:800, color:'var(--gw-azure)' }}>{roi.deal_count}</div>
                          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>Attributed Deals</div>
                        </div>
                        <div style={{ background:'var(--gw-bone)', borderRadius:10, padding:'10px 14px', textAlign:'center' }}>
                          <div style={{ fontSize:18, fontWeight:800, color:'#16a34a' }}>${roi.estimated_commission.toLocaleString()}</div>
                          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>Est. Commission</div>
                        </div>
                        <div style={{ background: roi.roi_pct > 0 ? '#f0fdf4' : 'var(--gw-bone)', border: roi.roi_pct > 0 ? '1.5px solid #86efac' : 'none', borderRadius:10, padding:'10px 14px', textAlign:'center' }}>
                          <div style={{ fontSize:18, fontWeight:800, color: roi.roi_pct > 0 ? '#16a34a' : roi.roi_pct < 0 ? 'var(--gw-red)' : 'var(--gw-mist)' }}>
                            {roi.roi_pct > 0 ? '+' : ''}{roi.roi_pct}%
                          </div>
                          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>ROI</div>
                        </div>
                      </div>

                      {roi.attributed_deals?.length > 0 && (
                        <div>
                          <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginBottom:6 }}>Attributed Deals</div>
                          <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
                            {roi.attributed_deals.map((d, i) => (
                              <div key={d.deal_id + i} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 0', borderBottom:'1px solid var(--gw-border)', fontSize:12 }}>
                                <span style={{ flex:1, fontWeight:600 }}>{d.address || d.deal_id?.slice(0,8) || '—'}</span>
                                <span style={{ fontSize:11, color:'var(--gw-mist)' }}>{d.stage}</span>
                                {d.value > 0 && <span style={{ fontWeight:700, color:'var(--gw-green)' }}>${Number(d.value).toLocaleString()}</span>}
                                <span style={{
                                  fontSize:10, fontWeight:700, padding:'2px 7px', borderRadius:8,
                                  background: d.attribution === 'explicit' ? '#dbeafe' : '#fef9c3',
                                  color:      d.attribution === 'explicit' ? '#1d4ed8' : '#92400e',
                                }}>
                                  {d.attribution === 'explicit' ? 'Direct' : 'Inferred'}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <div style={{ fontSize:11, color:'var(--gw-mist)', padding:'8px 12px', background:'var(--gw-bone)', borderRadius:8 }}>
                        Commission estimated at {Math.round((roi.commission_rate || 0.025) * 100)}% rate · {roi.attribution_window_days}-day attribution window.
                        Link deals to sends in the Send Log for direct attribution.
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize:12, color:'var(--gw-mist)', padding:'16px 0' }}>
                      No ROI data yet. Use "$ Link Deal" on send log rows to attribute closed deals to this campaign.
                    </div>
                  )}
                </div>
                {/* ── A/B Test Comparison ── */}
                {campaign.is_ab_test && (() => {
                  if (!abLoaded) loadABComparison()
                  const variants = abComparison ? Object.entries(abComparison) : []
                  const winner   = campaign.ab_winning_variant
                  const metrics  = ['total','response_rate','conversion_rate']
                  const labels   = { total:'Total Sends', response_rate:'Response Rate', conversion_rate:'Conversion Rate' }
                  return (
                    <div>
                      <div className="eyebrow-label" style={{ marginBottom:10 }}>A/B Test Comparison</div>
                      {variants.length < 2
                        ? <div style={{ fontSize:12, color:'var(--gw-mist)' }}>Variant B sends will appear here once logged.</div>
                        : (
                          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
                            {metrics.map(m => {
                              const best = variants.reduce((b, [, v]) => Math.max(b, v[m] || 0), 0)
                              return (
                                <div key={m}>
                                  <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginBottom:6 }}>{labels[m]}</div>
                                  <div style={{ display:'flex', gap:10 }}>
                                    {variants.map(([label, v]) => {
                                      const val    = v[m] || 0
                                      const isBest = val === best && best > 0
                                      const isWon  = winner === label
                                      return (
                                        <div key={label} style={{ flex:1, background: isWon ? '#f0fdf4' : isBest ? '#eff6ff' : 'var(--gw-bone)',
                                          border: isWon ? '2px solid #16a34a' : isBest ? '2px solid var(--gw-azure)' : '2px solid transparent',
                                          borderRadius:10, padding:'10px 14px', textAlign:'center' }}>
                                          <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-mist)', marginBottom:4 }}>Variant {label}</div>
                                          <div style={{ fontSize:20, fontWeight:800, color: isWon ? '#16a34a' : isBest ? 'var(--gw-azure)' : 'var(--gw-ink)' }}>
                                            {m === 'total' ? val : `${val}%`}
                                          </div>
                                          {isBest && !isWon && <div style={{ fontSize:10, color:'var(--gw-azure)', marginTop:2 }}>Leading</div>}
                                          {isWon && <div style={{ fontSize:10, color:'#16a34a', fontWeight:700, marginTop:2 }}>Winner</div>}
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>
                              )
                            })}
                            {!winner && (
                              <div style={{ display:'flex', gap:8, paddingTop:8, borderTop:'1px solid var(--gw-border)' }}>
                                <span style={{ fontSize:12, color:'var(--gw-mist)', flex:1, alignSelf:'center' }}>Declare winner when ready:</span>
                                {variants.map(([label]) => (
                                  <button key={label} className="btn btn--ghost btn--sm"
                                    onClick={() => declareWinner(label)}
                                    style={{ fontWeight:700 }}>
                                    Variant {label} wins
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      }
                    </div>
                  )
                })()}
              </div>
            )
            : <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:40, fontSize:13 }}>No data yet — log some sends first.</div>
        )}

        {/* ── Budget & Cost Dashboard ── */}
        {tab === 'budget' && (() => {
          if (!costLoaded) loadCostItems()
          const totalCost = costItems.reduce((acc, i) => acc + (i.unit_cost * i.quantity), 0)
          const costPerSend = sends.length > 0 ? totalCost / sends.length : 0
          const byCategory = costItems.reduce((acc, i) => {
            acc[i.category] = (acc[i.category] || 0) + i.unit_cost * i.quantity
            return acc
          }, {})
          const CATEGORY_COLORS = { printing:'#3b82f6', postage:'#8b5cf6', design:'#f59e0b', vendor:'#10b981', other:'#6b7280' }
          return (
            <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
              {/* Summary Cards */}
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))', gap:10 }}>
                <div style={{ background:'var(--gw-bone)', borderRadius:10, padding:'12px 16px', textAlign:'center' }}>
                  <div style={{ fontSize:20, fontWeight:800, color:'var(--gw-ink)' }}>${totalCost.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                  <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>Total Spend</div>
                </div>
                <div style={{ background:'var(--gw-bone)', borderRadius:10, padding:'12px 16px', textAlign:'center' }}>
                  <div style={{ fontSize:20, fontWeight:800, color:'var(--gw-azure)' }}>{costItems.length}</div>
                  <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>Line Items</div>
                </div>
                <div style={{ background:'var(--gw-bone)', borderRadius:10, padding:'12px 16px', textAlign:'center' }}>
                  <div style={{ fontSize:20, fontWeight:800, color:'#7c3aed' }}>
                    {costPerSend > 0 ? `$${costPerSend.toFixed(2)}` : '—'}
                  </div>
                  <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>Cost / Send</div>
                </div>
                {roi?.estimated_commission > 0 && (
                  <div style={{ background: roi.roi_pct > 0 ? '#f0fdf4' : 'var(--gw-bone)', border: roi.roi_pct > 0 ? '1.5px solid #86efac' : 'none', borderRadius:10, padding:'12px 16px', textAlign:'center' }}>
                    <div style={{ fontSize:20, fontWeight:800, color: roi.roi_pct > 0 ? '#16a34a' : 'var(--gw-mist)' }}>
                      {roi.roi_pct > 0 ? '+' : ''}{roi.roi_pct}%
                    </div>
                    <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>ROI</div>
                  </div>
                )}
              </div>

              {/* Spend by Category */}
              {Object.keys(byCategory).length > 0 && (
                <div>
                  <div className="eyebrow-label" style={{ marginBottom:8 }}>Spend by Category</div>
                  {Object.entries(byCategory).sort((a,b) => b[1]-a[1]).map(([cat, amt]) => (
                    <div key={cat} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                      <span style={{ fontSize:11, fontWeight:700, minWidth:70, textTransform:'capitalize', color: CATEGORY_COLORS[cat] || '#6b7280' }}>{cat}</span>
                      <div style={{ flex:1, height:8, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden' }}>
                        <div style={{ width:`${totalCost > 0 ? Math.round(amt/totalCost*100) : 0}%`, height:'100%', background: CATEGORY_COLORS[cat] || '#6b7280', borderRadius:4 }}/>
                      </div>
                      <span style={{ fontSize:12, fontWeight:700, minWidth:70, textAlign:'right' }}>${amt.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Add Cost Item */}
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <div className="eyebrow-label">Cost Line Items</div>
                <button className="btn btn--ghost btn--sm" onClick={() => setAddingCost(true)}>
                  <Icon name="plus" size={13}/> Add Cost
                </button>
              </div>

              {addingCost && (
                <div style={{ background:'var(--gw-bone)', borderRadius:10, padding:14 }}>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8 }}>
                    <select className="form-control" value={costForm.category} onChange={e => setCostForm(p=>({...p,category:e.target.value}))}>
                      <option value="postage">Postage</option>
                      <option value="printing">Printing</option>
                      <option value="design">Design</option>
                      <option value="vendor">Vendor</option>
                      <option value="other">Other</option>
                    </select>
                    <input className="form-control" placeholder="Description" value={costForm.description} onChange={e => setCostForm(p=>({...p,description:e.target.value}))}/>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8, marginBottom:10 }}>
                    <input className="form-control" type="number" min="0" step="0.01" placeholder="Unit cost ($)" value={costForm.unit_cost} onChange={e => setCostForm(p=>({...p,unit_cost:e.target.value}))}/>
                    <input className="form-control" type="number" min="1" placeholder="Qty" value={costForm.quantity} onChange={e => setCostForm(p=>({...p,quantity:e.target.value}))}/>
                    <input className="form-control" type="date" value={costForm.date_incurred} onChange={e => setCostForm(p=>({...p,date_incurred:e.target.value}))}/>
                  </div>
                  <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
                    <button className="btn btn--ghost btn--sm" onClick={() => setAddingCost(false)}>Cancel</button>
                    <button className="btn btn--primary btn--sm" disabled={savingCost} onClick={addCostItem}>
                      {savingCost ? 'Adding…' : 'Add'}
                    </button>
                  </div>
                </div>
              )}

              {/* Line Items Table */}
              {costItems.length === 0
                ? <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:24, fontSize:13 }}>No cost items yet. Add printing, postage, design, and vendor costs.</div>
                : (
                  <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
                    {costItems.map(item => (
                      <div key={item.id} style={{ display:'grid', gridTemplateColumns:'auto 1fr auto auto auto', gap:10, alignItems:'center', padding:'8px 0', borderBottom:'1px solid var(--gw-border)' }}>
                        <span style={{ fontSize:11, fontWeight:700, padding:'2px 8px', borderRadius:8, background:'var(--gw-bone)', color: CATEGORY_COLORS[item.category] || '#6b7280', textTransform:'capitalize' }}>
                          {item.category}
                        </span>
                        <span style={{ fontSize:13, color:'var(--gw-ink)' }}>{item.description || '—'}</span>
                        <span style={{ fontSize:12, color:'var(--gw-mist)' }}>×{item.quantity}</span>
                        <span style={{ fontSize:13, fontWeight:700, color:'var(--gw-ink)' }}>
                          ${(item.unit_cost * item.quantity).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                        </span>
                        <button className="btn btn--ghost btn--icon btn--sm" onClick={() => deleteCostItem(item.id)} title="Remove">
                          <Icon name="trash" size={12}/>
                        </button>
                      </div>
                    ))}
                    <div style={{ display:'flex', justifyContent:'flex-end', paddingTop:10, fontWeight:800, fontSize:14 }}>
                      Total: ${totalCost.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                    </div>
                  </div>
                )
              }
            </div>
          )
        })()}

        {/* ── Sequence Scheduler ── */}
        {tab === 'sequence' && (
          <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
            <div style={{ fontSize:13, color:'var(--gw-mist)' }}>
              Define a drip sequence of follow-up sends. Each step targets contacts from this campaign who meet the response filter after a set number of days.
            </div>

            {/* Steps */}
            {seqSteps.map((step, i) => {
              const due = seqDueMap[i]
              return (
                <div key={i} style={{ background:'var(--gw-bone)', borderRadius:12, padding:14, display:'flex', flexDirection:'column', gap:10 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <span style={{ width:24, height:24, borderRadius:'50%', background:'var(--gw-azure)', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:800, flexShrink:0 }}>{i+1}</span>
                    <input className="form-control" style={{ flex:1, fontSize:13 }} placeholder="Step name" value={step.name} onChange={e => {
                      const s = [...seqSteps]; s[i] = { ...s[i], name: e.target.value }; setSeqSteps(s); setSeqDirty(true)
                    }}/>
                    <button className="btn btn--ghost btn--icon btn--sm" onClick={() => { setSeqSteps(p => p.filter((_,j)=>j!==i)); setSeqDirty(true) }} title="Remove step">
                      <Icon name="trash" size={13}/>
                    </button>
                  </div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
                    <div>
                      <label className="form-label" style={{ fontSize:11 }}>Days after initial send</label>
                      <input className="form-control" type="number" min="1" value={step.delay_days} onChange={e => {
                        const s = [...seqSteps]; s[i] = { ...s[i], delay_days: parseInt(e.target.value)||0 }; setSeqSteps(s); setSeqDirty(true)
                      }}/>
                    </div>
                    <div>
                      <label className="form-label" style={{ fontSize:11 }}>Only contacts with response</label>
                      <select className="form-control" value={step.filter_response || 'no-response'} onChange={e => {
                        const s = [...seqSteps]; s[i] = { ...s[i], filter_response: e.target.value }; setSeqSteps(s); setSeqDirty(true)
                      }}>
                        <option value="all">All contacts</option>
                        <option value="no-response">No Response only</option>
                        <option value="callback">Callback only</option>
                        <option value="interested">Interested only</option>
                      </select>
                    </div>
                    <div>
                      <label className="form-label" style={{ fontSize:11 }}>Channel</label>
                      <select className="form-control" value={step.channel || 'direct-mail'} onChange={e => {
                        const s = [...seqSteps]; s[i] = { ...s[i], channel: e.target.value }; setSeqSteps(s); setSeqDirty(true)
                      }}>
                        <option value="direct-mail">Direct Mail</option>
                        <option value="email">Email</option>
                        <option value="text">Text</option>
                        <option value="cold-call">Cold Call</option>
                      </select>
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                    <button className="btn btn--ghost btn--sm" style={{ fontSize:12 }}
                      onClick={() => loadSeqDue(i, step.delay_days, step.filter_response)}>
                      Check Who's Due
                    </button>
                    {due !== undefined && (
                      <span style={{ fontSize:12, color: due.count > 0 ? '#d97706' : 'var(--gw-mist)', fontWeight: due.count > 0 ? 700 : 400 }}>
                        {due.count} contact{due.count !== 1 ? 's' : ''} due
                      </span>
                    )}
                    {due?.count > 0 && (
                      <button className="btn btn--primary btn--sm" style={{ fontSize:12 }} onClick={() => setAudienceOpen(true)}>
                        Execute via Batch Send
                      </button>
                    )}
                  </div>
                </div>
              )
            })}

            <div style={{ display:'flex', gap:8, alignItems:'center' }}>
              <button className="btn btn--ghost btn--sm" onClick={() => {
                setSeqSteps(p => [...p, { name:`Follow-up ${p.length+1}`, delay_days:30, filter_response:'no-response', channel:'direct-mail' }])
                setSeqDirty(true)
              }}>
                <Icon name="plus" size={13}/> Add Step
              </button>
              {seqDirty && (
                <button className="btn btn--primary btn--sm" onClick={saveSeqSteps} disabled={seqSaving}>
                  {seqSaving ? 'Saving…' : 'Save Sequence'}
                </button>
              )}
            </div>

            {seqSteps.length === 0 && (
              <div style={{ padding:'24px', textAlign:'center', color:'var(--gw-mist)', fontSize:13 }}>
                No steps defined. Add a step to create your follow-up sequence.
              </div>
            )}
          </div>
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
      {audienceOpen && (
        <AudienceBuilderModal
          campaign={campaign}
          agents={agents}
          activeAgent={activeAgent}
          onSent={newSends => { setSends(p => [...newSends, ...p]); loadAnalytics(); loadROI() }}
          onClose={() => setAudienceOpen(false)}
        />
      )}
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
                try {
                  const res  = await fetch('/api/campaigns', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'update_campaign', ...form }) })
                  const data = await res.json()
                  if (!res.ok) { pushToast(data.error || 'Failed to update campaign', 'error'); return }
                  onUpdate(data.campaign)
                  setEditOpen(false)
                  pushToast('Campaign updated')
                } catch (err) {
                  pushToast(err.message || 'Network error — could not reach server', 'error')
                } finally {
                  setSaving(false)
                }
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
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templates,     setTemplates]     = useState([])
  const [templatesLoaded, setTemplatesLoaded] = useState(false)

  useEffect(() => { loadAll() }, [])

  const loadAll = async () => {
    setLoading(true)
    try {
      const [campRes, agentsRes, contactsRes] = await Promise.all([
        fetch('/api/campaigns?action=list_campaigns'),
        supabase.from('agents').select('id, name, initials, color, email, role').order('name'),
        supabase.from('contacts').select('id, first_name, last_name, email, phone, owner_address, owner_city, owner_state, owner_zip').order('last_name'),
      ])

      if (!campRes.ok) {
        const err = await campRes.json().catch(() => ({}))
        if (err.error?.includes('does not exist') || err.error?.includes('relation')) {
          setReady(false)
        } else {
          pushToast(err.error || `Failed to load campaigns (HTTP ${campRes.status})`, 'error')
        }
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
    } catch (err) {
      pushToast(err.message || 'Network error loading campaigns', 'error')
    } finally {
      setLoading(false)
    }
  }

  const createCampaign = async (form) => {
    setSaving(true)
    try {
      const res  = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create_campaign', ...form }),
      })
      const data = await res.json()
      if (!res.ok || data.error) { pushToast(data.error || 'Failed to create campaign', 'error'); return }
      setCampaigns(p => [data.campaign, ...p])
      setNewOpen(false)
      setSelected(data.campaign)
      pushToast('Campaign created')
    } catch (err) {
      pushToast(err.message || 'Network error — could not reach server', 'error')
    } finally {
      setSaving(false)
    }
  }

  const loadTemplates = async () => {
    if (templatesLoaded) return
    const res  = await fetch('/api/campaigns?action=list_campaign_templates')
    const data = await res.json()
    setTemplates(data.templates || [])
    setTemplatesLoaded(true)
  }

  const saveAsTemplate = async (campaign) => {
    const name = window.prompt(`Template name:`, campaign.name + ' Template')
    if (!name) return
    const config = {
      property_types: campaign.property_types,
      flyer_template: campaign.flyer_template,
      landing_mode:   campaign.landing_mode,
      landing_headline: campaign.landing_headline,
      landing_tagline: campaign.landing_tagline,
      landing_cta:    campaign.landing_cta,
      cost_per_piece: campaign.cost_per_piece,
      fixed_cost:     campaign.fixed_cost,
      frequency_cap:  campaign.frequency_cap,
      frequency_days: campaign.frequency_days,
      commission_rate: campaign.commission_rate,
      attribution_window_days: campaign.attribution_window_days,
      schedule_steps: campaign.schedule_steps,
    }
    const res  = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save_campaign_template', name, config }),
    })
    const data = await res.json()
    if (res.ok) {
      setTemplates(p => [data.template, ...p])
      setTemplatesLoaded(true)
      pushToast('Template saved')
    } else {
      pushToast(data.error || 'Failed to save template', 'error')
    }
  }

  const deleteTemplate = async (id) => {
    await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_campaign_template', id }),
    })
    setTemplates(p => p.filter(t => t.id !== id))
    pushToast('Template deleted')
  }

  const updateCampaign = (updated) => {
    setCampaigns(p => p.map(c => c.id === updated.id ? updated : c))
    if (selected?.id === updated.id) setSelected(updated)
  }

  const deleteCampaign = async (id) => {
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_campaign', id }),
    })
    if (!res.ok) { const d = await res.json().catch(() => ({})); pushToast(d.error || 'Failed to delete campaign', 'error'); return }
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
            <div style={{ display:'flex', gap:6 }}>
              <button className="btn btn--ghost btn--sm" onClick={() => { setTemplatesOpen(true); loadTemplates() }}>Templates</button>
              <button className="btn btn--primary btn--sm" onClick={() => setNewOpen(true)}>
                <Icon name="plus" size={13}/> New Campaign
              </button>
            </div>
          </div>

          {/* Global stats */}
          <div style={{ display:'flex', gap:10, marginBottom:12 }}>
            <StatCard value={campaigns.length} label="Campaigns"/>
            <StatCard value={totalSends}        label="Total Sends"/>
            <StatCard value={`${overallRate}%`} label="Avg Response" color={overallRate > 12 ? 'var(--gw-green)' : undefined}/>
          </div>

          {/* Search + filter */}
          <div style={{ display:'flex', gap:8 }}>
            <div style={{ flex:1, position:'relative' }}>
              <input
                className="form-control"
                style={{ width:'100%', paddingRight: search ? 28 : undefined }}
                placeholder="Search campaigns…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && (
                <button onClick={() => setSearch('')} style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', color:'var(--gw-mist)', fontSize:16, lineHeight:1, padding:0 }}>×</button>
              )}
            </div>
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
            : campaigns.length === 0
              ? <EmptyState icon="mail" title="No campaigns yet" message="Create your first campaign to start tracking mail flyers and cold call outreach." action={<button className="btn btn--primary btn--sm" onClick={()=>setNewOpen(true)}>New Campaign</button>}/>
            : filtered.length === 0
              ? <EmptyState icon="mail" title="No campaigns match your filters" message="Try adjusting your search or status filter." action={<button className="btn btn--secondary btn--sm" onClick={()=>{ setSearch(''); setStatusFilter('all') }}>Clear Filters</button>}/>
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
            <button className="btn btn--ghost btn--sm" onClick={() => saveAsTemplate(selected)} title="Save this campaign as a reusable template">
              Save as Template
            </button>
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

      {/* Templates library modal */}
      {templatesOpen && (
        <Modal open={true} onClose={() => setTemplatesOpen(false)} width={560}>
          <div className="modal__head">
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>Campaign Templates</h3>
            <button className="drawer__close" onClick={() => setTemplatesOpen(false)}><Icon name="x" size={18}/></button>
          </div>
          <div className="modal__body" style={{ display:'flex', flexDirection:'column', gap:12 }}>
            <div style={{ fontSize:13, color:'var(--gw-mist)' }}>
              Save campaigns as reusable templates. Use "Save as Template" when viewing a campaign to add it here.
            </div>
            {templates.length === 0
              ? <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:32, fontSize:13 }}>No templates yet. Save a campaign as a template to get started.</div>
              : templates.map(t => (
                <div key={t.id} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'12px 14px', background:'var(--gw-bone)', borderRadius:10 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight:700, fontSize:14, color:'var(--gw-ink)' }}>{t.name}</div>
                    {t.description && <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:2 }}>{t.description}</div>}
                    <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:4 }}>
                      {t.config?.property_types?.length > 0 && `${t.config.property_types.join(', ')} · `}
                      {t.config?.flyer_template && `${t.config.flyer_template} template · `}
                      Saved {new Date(t.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ display:'flex', gap:6, flexShrink:0 }}>
                    <button className="btn btn--primary btn--sm" style={{ fontSize:12 }}
                      onClick={() => {
                        setTemplatesOpen(false)
                        setNewOpen(true)
                        // Template config will be pre-filled via CampaignForm's initial prop if we wire it up
                        pushToast('Template loaded — fill in the name and save', 'info')
                      }}>
                      Use Template
                    </button>
                    <button className="btn btn--ghost btn--icon btn--sm" onClick={() => deleteTemplate(t.id)} title="Delete template">
                      <Icon name="trash" size={13}/>
                    </button>
                  </div>
                </div>
              ))
            }
          </div>
        </Modal>
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
