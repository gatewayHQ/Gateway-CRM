/**
 * Property Showcase Landing — public-facing, served at /lp/property/:mailingId
 *
 * Renders entirely from mailings.landing_config — no private CRM notes ever shown.
 * landing_config shape:
 *   { headline, subheadline, price, beds, baths, sqft, lot_size, year_built,
 *     description, features[], images[{url,caption,price}], cta_text, accent }
 */

import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'

function useMosaicLayout(n) {
  return useMemo(() => {
    const L = {
      1: { cols:1, rows:1, areas:[['a']] },
      2: { cols:2, rows:1, areas:[['a','b']] },
      3: { cols:3, rows:2, areas:[['a','a','b'],['a','a','c']] },
      4: { cols:4, rows:2, areas:[['a','a','b','c'],['a','a','d','b']] },
      5: { cols:4, rows:2, areas:[['a','a','b','c'],['a','a','d','e']] },
    }[Math.min(n, 5)]
    if (!L) return { gridStyle:{}, cells:[] }
    const unique = [...new Set(L.areas.flat())]
    return {
      gridStyle: {
        gridTemplateColumns:`repeat(${L.cols}, 1fr)`,
        gridTemplateAreas: L.areas.map(r => `"${r.join(' ')}"`).join(' '),
      },
      cells: unique.map(letter => ({ gridArea:letter, minHeight: n===1 ? 320 : n<=2 ? 240 : 160 })),
    }
  }, [n])
}

export default function LandingProperty({ mailingId }) {
  const [mailing,    setMailing]    = useState(null)
  const [agent,      setAgent]      = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [submitted,  setSubmitted]  = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState(null)
  const [form, setForm] = useState({ name:'', phone:'', email:'', message:'' })

  useEffect(() => {
    ;(async () => {
      const { data: m } = await supabase
        .from('mailings')
        .select('id, name, agent_id, landing_config')
        .eq('id', mailingId).single()
      if (!m) { setError('Mailing not found'); setLoading(false); return }
      setMailing(m)
      if (m.agent_id) {
        const { data: a } = await supabase.from('agents')
          .select('id, name, phone, email, photo_url, color, role')
          .eq('id', m.agent_id).single()
        setAgent(a || null)
      }
      setLoading(false)
    })()
  }, [mailingId])

  const cfg         = mailing?.landing_config || {}
  const accent      = cfg.accent      || '#1e2642'
  const headline    = cfg.headline    || mailing?.name || 'Property For Sale'
  const subhead     = cfg.subheadline || ''
  const ctaText     = cfg.cta_text    || 'Get more info'
  const description = cfg.description || ''
  const features    = Array.isArray(cfg.features) ? cfg.features.filter(Boolean) : []
  const images      = (Array.isArray(cfg.images) ? cfg.images : [])
    .map(v => typeof v === 'string' ? { url:v, caption:'', price:'' } : v)
    .filter(v => v?.url)

  const galleryImages = images.slice(1)
  const mosaic = useMosaicLayout(Math.min(galleryImages.length, 5))

  const fmtNum   = v => { const n = Number(String(v).replace(/[^0-9.]/g,'')); return isNaN(n) ? String(v) : n.toLocaleString() }
  const fmtPrice = v => { if (!v) return null; const n = Number(String(v).replace(/[^0-9.]/g,'')); return isNaN(n) ? String(v) : '$' + n.toLocaleString() }
  const fmtPct   = v => { if (!v) return null; const s = String(v).trim(); return s.endsWith('%') ? s : s + '%' }

  const details = (cfg.detail_mode === 'commercial' ? [
    cfg.price          && { label:'Price',        value: fmtPrice(cfg.price) },
    cfg.units          && { label:'Units',        value: cfg.units },
    cfg.price_per_unit && { label:'Price / Unit', value: fmtPrice(cfg.price_per_unit) },
    cfg.cap_rate       && { label:'Cap Rate',     value: fmtPct(cfg.cap_rate) },
    cfg.noi            && { label:'NOI',          value: fmtPrice(cfg.noi) },
    cfg.gross_income   && { label:'Gross Income', value: fmtPrice(cfg.gross_income) },
    cfg.building_sqft  && { label:'Building SF',  value: fmtNum(cfg.building_sqft) },
    cfg.occupancy      && { label:'Occupancy',    value: fmtPct(cfg.occupancy) },
    cfg.year_built     && { label:'Year Built',   value: cfg.year_built },
  ] : [
    cfg.price      && { label:'Price',       value: fmtPrice(cfg.price) },
    cfg.beds       && { label:'Bedrooms',     value: cfg.beds },
    cfg.baths      && { label:'Bathrooms',    value: cfg.baths },
    cfg.sqft       && { label:'Sq Ft',        value: fmtNum(cfg.sqft) },
    cfg.lot_size   && { label:'Lot',          value: fmtNum(cfg.lot_size) + ' sqft' },
    cfg.year_built && { label:'Year Built',   value: cfg.year_built },
  ]).filter(Boolean)

  const submit = async (e) => {
    e.preventDefault()
    if (!form.name.trim())  { setError('Please enter your name'); return }
    if (!form.phone.trim()) { setError('Please enter a phone number'); return }
    setError(null); setSubmitting(true)
    const res = await fetch('/api/campaigns', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ action:'capture_lead', mailing_id:mailingId, source_landing:'property', ...form }),
    })
    const data = await res.json()
    setSubmitting(false)
    if (!res.ok || data.error) { setError(data.error || 'Could not submit — please try again'); return }
    setSubmitted(true)
  }

  if (loading) return <div style={loadingSt}>Loading…</div>
  if (error && !mailing) return <div style={{ ...loadingSt, color:'#c0392b' }}>{error}</div>

  return (
    <div style={{ minHeight:'100vh', fontFamily:'DM Sans, system-ui, sans-serif', background:'#fafaf7', color:'#1e2642' }}>

      {/* Top bar */}
      <header style={{ background:'#fff', borderBottom:'1px solid #eaecf0', padding:'14px 24px',
                       display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:20, color:accent, fontWeight:600 }}>
          Gateway Real Estate Advisors
        </div>
        {agent?.phone && (
          <a href={`tel:${agent.phone}`}
             style={{ fontSize:13, color:'#1e2642', textDecoration:'none', fontWeight:600,
                      padding:'7px 16px', border:`1.5px solid ${accent}`, borderRadius:99 }}>
            Call {agent.name?.split(' ')[0] || 'Us'}
          </a>
        )}
      </header>

      {/* Hero */}
      <div style={{
        background: images.length > 0
          ? `linear-gradient(rgba(10,12,20,0.40) 0%, rgba(10,12,20,0.68) 100%), url(${images[0].url}) center/cover no-repeat`
          : `linear-gradient(135deg, ${accent} 0%, #2c3a5e 100%)`,
        padding:'72px 24px 56px', color:'#fff',
      }}>
        <div style={{ maxWidth:980, margin:'0 auto' }}>
          <div style={{ display:'inline-block', fontSize:11, letterSpacing:1.8, textTransform:'uppercase',
                        padding:'3px 10px', border:'1px solid rgba(255,255,255,0.4)', borderRadius:99, marginBottom:14 }}>
            Property For Sale
          </div>
          <h1 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:'clamp(30px,4.8vw,56px)',
                       fontWeight:600, lineHeight:1.08, margin:'0 0 16px' }}>
            {headline}
          </h1>
          {details.length > 0 && (
            <div style={{ display:'flex', gap:24, flexWrap:'wrap', fontSize:15, fontWeight:500 }}>
              {details.map((d, i) => (
                <span key={i} style={{ opacity:0.95 }}>
                  <strong style={{ fontWeight:700 }}>{d.value}</strong>{' '}{d.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth:980, margin:'0 auto', padding:'28px 24px 80px' }}>
        <div style={{ display:'grid', gridTemplateColumns:'minmax(0,1.35fr) minmax(0,1fr)', gap:32 }}
             className="prop-grid">

          {/* Left */}
          <div style={{ display:'flex', flexDirection:'column', gap:24 }}>

            {/* Details card */}
            {details.length > 0 && (
              <div style={card}>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(120px,1fr))', gap:18 }}>
                  {details.map((d, i) => (
                    <div key={i}>
                      <div style={{ fontSize:10, textTransform:'uppercase', letterSpacing:0.9, color:'#9aa3b2', fontWeight:700, marginBottom:3 }}>
                        {d.label}
                      </div>
                      <div style={{ fontSize:22, fontWeight:800, color:accent, fontFamily:'Cormorant Garamond, serif' }}>
                        {d.value}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Subheadline + description */}
            {(subhead || description) && (
              <div style={card}>
                {subhead && (
                  <p style={{ fontFamily:'Cormorant Garamond, serif', fontSize:18, lineHeight:1.6,
                               color:'#1e2642', fontWeight:500, margin:'0 0 10px' }}>
                    {subhead}
                  </p>
                )}
                {description && (
                  <p style={{ lineHeight:1.75, color:'#4a5263', margin:0, fontSize:14 }}>{description}</p>
                )}
              </div>
            )}

            {/* Features */}
            {features.length > 0 && (
              <div style={card}>
                <h3 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:20, fontWeight:600,
                             margin:'0 0 14px', color:'#1e2642' }}>
                  Property Highlights
                </h3>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                  {features.map((f, i) => (
                    <div key={i} style={{ display:'flex', gap:9, alignItems:'flex-start', fontSize:13 }}>
                      <span style={{ color:accent, fontWeight:700, flexShrink:0, marginTop:1 }}>✓</span>
                      <span style={{ color:'#4a5263', lineHeight:1.5 }}>{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Gallery */}
            {galleryImages.length > 0 && (
              <div>
                <h3 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:20, fontWeight:600,
                             margin:'0 0 14px', color:'#1e2642' }}>
                  Gallery
                </h3>
                <div className="prop-gallery" style={{ display:'grid', gap:8, ...mosaic.gridStyle }}>
                  {galleryImages.slice(0, 5).map((img, i) => (
                    <div key={i} className="prop-gallery__cell" style={{
                      ...(mosaic.cells[i] || {}),
                      backgroundImage:`url(${img.url})`, backgroundSize:'cover', backgroundPosition:'center',
                      borderRadius:8, overflow:'hidden', position:'relative',
                    }}>
                      {(img.caption || img.units || img.price) && (
                        <div style={{ position:'absolute', bottom:0, left:0, right:0,
                                      background:'linear-gradient(transparent, rgba(10,12,20,0.6))',
                                      padding:'18px 10px 8px', color:'#fff' }}>
                          {(img.caption || img.units) && (
                            <div style={{ fontSize:11, fontWeight:600 }}>{img.caption || img.units}</div>
                          )}
                          {img.price && (
                            <div style={{ fontSize:13, fontWeight:700, color: accent === '#1e2642' ? '#c9a961' : accent }}>
                              {img.price}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right — sticky lead form */}
          <div style={{ alignSelf:'start', position:'sticky', top:20 }}>
            <div style={{ ...card, padding:28, boxShadow:'0 8px 40px rgba(30,38,66,0.13)' }}>
              {submitted ? (
                <div style={{ textAlign:'center', padding:'16px 0' }}>
                  <div style={{ width:56, height:56, borderRadius:'50%', background:`${accent}18`, color:accent,
                                display:'flex', alignItems:'center', justifyContent:'center',
                                margin:'0 auto', fontSize:28 }}>✓</div>
                  <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:26, margin:'14px 0 8px' }}>
                    We'll be in touch!
                  </h2>
                  <p style={{ color:'#9aa3b2', fontSize:14, lineHeight:1.6, margin:0 }}>
                    {agent ? `${agent.name} will reach out shortly.` : "We'll reach out shortly."}
                  </p>
                </div>
              ) : (
                <>
                  <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:22, fontWeight:600,
                               margin:'0 0 4px', color:'#1e2642' }}>
                    {ctaText}
                  </h2>
                  <p style={{ fontSize:12, color:'#9aa3b2', margin:'0 0 16px', lineHeight:1.5 }}>
                    Leave your info — we'll get back to you fast. No spam, ever.
                  </p>
                  <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:10 }}>
                    <input required value={form.name} placeholder="Your name *"
                           onChange={e => setForm(f => ({...f, name:e.target.value}))} style={inputSt(accent)} />
                    <input required type="tel" value={form.phone} placeholder="Phone number *"
                           onChange={e => setForm(f => ({...f, phone:e.target.value}))} style={inputSt(accent)} />
                    <input type="email" value={form.email} placeholder="Email (optional)"
                           onChange={e => setForm(f => ({...f, email:e.target.value}))} style={inputSt(accent)} />
                    <textarea rows={3} value={form.message} placeholder="Questions or notes (optional)"
                              onChange={e => setForm(f => ({...f, message:e.target.value}))}
                              style={{ ...inputSt(accent), resize:'vertical', fontFamily:'inherit' }} />
                    {error && <div style={{ color:'#c0392b', fontSize:12, lineHeight:1.4 }}>{error}</div>}
                    <button type="submit" disabled={submitting}
                            style={{ background:accent, color:'#fff', padding:'13px', border:'none',
                                     borderRadius:8, fontSize:15, fontWeight:700, cursor:'pointer',
                                     opacity: submitting ? 0.7 : 1, marginTop:4, letterSpacing:0.2 }}>
                      {submitting ? 'Sending…' : ctaText + ' →'}
                    </button>
                    <p style={{ fontSize:11, color:'#9aa3b2', textAlign:'center', margin:'4px 0 0' }}>
                      Your information stays private.
                    </p>
                  </form>
                </>
              )}
            </div>

            {agent && (
              <div style={{ marginTop:14, ...card, padding:'14px 18px',
                            display:'flex', alignItems:'center', gap:14 }}>
                <div style={{ width:44, height:44, borderRadius:'50%', background: agent.color || accent,
                              display:'flex', alignItems:'center', justifyContent:'center',
                              fontWeight:700, color:'#fff', fontSize:16, flexShrink:0 }}>
                  {(agent.name || '?').split(/\s+/).map(w => w[0]).slice(0,2).join('').toUpperCase()}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:700, fontSize:14 }}>{agent.name}</div>
                  <div style={{ fontSize:11.5, color:'#9aa3b2' }}>
                    {agent.role || 'Listing Agent'} · Gateway Real Estate
                  </div>
                </div>
                {agent.phone && (
                  <a href={`tel:${agent.phone}`}
                     style={{ color:accent, fontSize:12, textDecoration:'none',
                              padding:'6px 10px', border:`1px solid ${accent}55`, borderRadius:99, whiteSpace:'nowrap' }}>
                    Call
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer style={{ textAlign:'center', padding:'20px 16px 48px', fontSize:12, color:'#9aa3b2',
                       borderTop:'1px solid #eaecf0' }}>
        Gateway Real Estate Advisors · Licensed Brokerage · Information believed accurate but not guaranteed.
      </footer>

      <style>{`
        @media (max-width: 820px) { .prop-grid { grid-template-columns: 1fr !important; } }
        @media (max-width: 640px) {
          .prop-gallery { grid-template-columns: 1fr 1fr !important; grid-template-areas: none !important; }
          .prop-gallery__cell { grid-area: auto !important; min-height: 150px !important; }
        }
        input:focus, textarea:focus { outline:none; border-color: ${accent} !important; box-shadow: 0 0 0 3px ${accent}18; }
      `}</style>
    </div>
  )
}

const card = {
  background:'#fff', borderRadius:12, padding:22,
  boxShadow:'0 2px 12px rgba(30,38,66,0.07)', border:'1px solid #eaecf0',
}
const inputSt = (accent) => ({
  padding:'10px 12px', border:'1px solid #d6d9e0', borderRadius:7, fontSize:14,
  fontFamily:'inherit', outline:'none', width:'100%', boxSizing:'border-box',
  transition:'border-color 150ms, box-shadow 150ms',
})
const loadingSt = {
  padding:60, textAlign:'center', fontFamily:'DM Sans, system-ui, sans-serif',
  color:'#9aa3b2', fontSize:14, minHeight:'100vh', display:'flex',
  alignItems:'center', justifyContent:'center',
}
