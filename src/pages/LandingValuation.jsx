/**
 * Home Valuation Landing — light luxury "Private Advisory Consultation"
 * URL: /lp/valuation/:mailingId
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'

// ─── Brand tokens ────────────────────────────────────────────────────────────
const T = {
  bg:      '#F8F7F4',
  bgAlt:   '#F0EFE9',
  deep:    '#1E2F39',
  deeper:  '#142028',
  cream:   '#E4E3DF',
  muted:   '#6B7F88',
  faint:   '#9AABB3',
  gold:    '#C5A46E',
  goldDim: 'rgba(197,164,110,0.14)',
  border:  'rgba(30,47,57,0.10)',
  borderM: 'rgba(30,47,57,0.18)',
}

const PROPERTY_TYPES = [
  { value: 'single-family', label: 'Single-Family Home'        },
  { value: 'condo',         label: 'Condo / Townhome'          },
  { value: 'multifamily',   label: 'Multifamily (2–4 units)'   },
  { value: 'multifamily-5', label: 'Apartment Bldg (5+ units)' },
  { value: 'commercial',    label: 'Commercial Property'        },
  { value: 'land',          label: 'Land / Lot'                 },
  { value: 'other',         label: 'Other'                      },
]

const DEFAULT_HIGHLIGHTS = [
  { label: 'Homeowners served', value: '120+'  },
  { label: 'Avg days to close', value: '18'    },
  { label: 'Neighborhoods',     value: '12'    },
]

// ─── Hooks ────────────────────────────────────────────────────────────────────
function useReveal() {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect() } }, { threshold: 0.12 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  return [ref, visible]
}

function useMosaicLayout(n) {
  return useMemo(() => {
    const L = {
      1: { cols:1, rows:1, areas:[['a','a'],['a','a']]           },
      2: { cols:2, rows:2, areas:[['a','b'],['a','b']]           },
      3: { cols:3, rows:2, areas:[['a','a','b'],['a','a','c']]   },
      4: { cols:3, rows:2, areas:[['a','a','b'],['c','d','b']]   },
      5: { cols:4, rows:2, areas:[['a','a','b','c'],['a','a','d','e']] },
      6: { cols:4, rows:3, areas:[['a','a','b','c'],['a','a','d','e'],['f','f','d','e']] },
    }[Math.min(n, 6)] || { cols:1, rows:1, areas:[['a','a'],['a','a']] }
    const unique = [...new Set(L.areas.flat())]
    return {
      gridStyle: {
        gridTemplateColumns: `repeat(${L.cols}, 1fr)`,
        gridTemplateAreas: L.areas.map(r => `"${r.join(' ')}"`).join(' '),
      },
      cells: unique.map(letter => ({ gridArea: letter, minHeight: n === 1 ? 320 : n <= 2 ? 220 : 140 })),
    }
  }, [n])
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Loader() {
  return (
    <div style={{ minHeight:'100vh', background: T.bg, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ width:36, height:36, border:`2px solid ${T.border}`, borderTopColor: T.gold,
                    borderRadius:'50%', animation:'vl-spin 0.8s linear infinite' }} />
      <style>{`@keyframes vl-spin { to { transform:rotate(360deg) } }`}</style>
    </div>
  )
}

function LuxeInput({ style, className, ...props }) {
  return <input className={`vl-inp ${className||''}`} style={{
    width:'100%', boxSizing:'border-box', padding:'11px 14px',
    background:'#fff', border:`1px solid ${T.borderM}`, borderRadius:4,
    color: T.deep, fontSize:14, fontFamily:'DM Sans, sans-serif', outline:'none',
    transition:'border-color 180ms', ...style }} {...props} />
}

function LuxeTextarea({ style, className, ...props }) {
  return <textarea className={`vl-inp ${className||''}`} style={{
    width:'100%', boxSizing:'border-box', padding:'11px 14px',
    background:'#fff', border:`1px solid ${T.borderM}`, borderRadius:4,
    color: T.deep, fontSize:14, fontFamily:'DM Sans, sans-serif', outline:'none',
    transition:'border-color 180ms', resize:'vertical', ...style }} {...props} />
}

function LuxeSelect({ value, onChange, children }) {
  return (
    <select value={value} onChange={onChange} className="vl-inp" style={{
      width:'100%', boxSizing:'border-box', padding:'11px 36px 11px 14px',
      background:'#fff', border:`1px solid ${T.borderM}`, borderRadius:4,
      color: T.deep, fontSize:14, fontFamily:'DM Sans, sans-serif', outline:'none',
      appearance:'none', transition:'border-color 180ms',
      backgroundImage:`url("data:image/svg+xml;utf8,<svg fill='%231E2F39' xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M7 10l5 5 5-5z'/></svg>")`,
      backgroundRepeat:'no-repeat', backgroundPosition:'right 10px center' }}>
      {children}
    </select>
  )
}

function FieldLabel({ children }) {
  return <span style={{ display:'block', fontSize:10, textTransform:'uppercase', letterSpacing:1.4,
    color: T.muted, fontWeight:600, marginBottom:6 }}>{children}</span>
}

function SuccessView({ agent }) {
  return (
    <div style={{ textAlign:'center', padding:'28px 8px' }}>
      <div style={{ width:60, height:60, borderRadius:'50%', background: T.goldDim,
                    border:`1px solid ${T.gold}50`, display:'flex', alignItems:'center',
                    justifyContent:'center', margin:'0 auto', fontSize:26, color: T.gold }}>✓</div>
      <h2 style={{ fontFamily:'Cormorant Garamond, Georgia, serif', fontSize:28,
                   color: T.deep, margin:'18px 0 10px', fontWeight:500 }}>
        Request received.
      </h2>
      <p style={{ color: T.muted, fontSize:14, lineHeight:1.7, maxWidth:280, margin:'0 auto' }}>
        We are pulling recent comps in your area now.
        {agent && (
          <><br /><br />
          <span style={{ color: T.deep, fontWeight:500 }}>{agent.name}</span> will be in touch within one business day.
          </>
        )}
      </p>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function LandingValuation({ mailingId }) {
  const [mailing,    setMailing]    = useState(null)
  const [agent,      setAgent]      = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [submitted,  setSubmitted]  = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState(null)

  const [form, setForm] = useState({
    property_address: '', property_type: 'single-family', name: '', phone: '', email: '', message: '',
  })

  const [bodyRef,    bodyVisible]    = useReveal()
  const [galleryRef, galleryVisible] = useReveal()
  const [trustRef,   trustVisible]   = useReveal()

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

  const cfg        = mailing?.landing_config || {}
  const accent     = cfg.accent      || T.gold
  const headline   = cfg.headline    || "What is your home worth today?"
  const subhead    = cfg.subheadline || "A private, no-obligation valuation from a licensed broker who knows your neighborhood — not a software estimate."
  const ctaText    = cfg.cta_text    || 'Request private valuation'
  const images     = (Array.isArray(cfg.images) ? cfg.images : [])
    .map(v => typeof v === 'string' ? { url: v } : v)
    .filter(v => v?.url)
    .slice(0, 6)
  const highlights = Array.isArray(cfg.highlights) && cfg.highlights.length > 0
    ? cfg.highlights.slice(0, 4)
    : DEFAULT_HIGHLIGHTS

  const heroImage  = images[0]?.url || null
  const mosaic     = useMosaicLayout(images.length)

  const submit = async (e) => {
    e.preventDefault()
    if (!form.property_address.trim()) { setError('Please enter the property address'); return }
    if (!form.name.trim())             { setError('Please enter your name'); return }
    if (!form.phone.trim())            { setError('Please enter a phone number'); return }
    setError(null); setSubmitting(true)
    const res  = await fetch('/api/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'capture_lead', mailing_id: mailingId, source_landing: 'valuation', ...form }),
    })
    const data = await res.json()
    setSubmitting(false)
    if (!res.ok || data.error) { setError(data.error || 'Could not submit — please try again'); return }
    setSubmitted(true)
  }

  if (loading) return <Loader />
  if (error && !mailing) return (
    <div style={{ minHeight:'100vh', background: T.bg, display:'flex', alignItems:'center', justifyContent:'center', padding:40 }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:22, color: T.deep, marginBottom:12 }}>
          Gateway Real Estate Advisors
        </div>
        <div style={{ color:'#c0392b', fontSize:14 }}>{error}</div>
      </div>
    </div>
  )

  const agentInitials = agent ? (agent.name || '').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() : ''

  return (
    <div style={{ minHeight:'100vh', background: T.bg, color: T.deep,
                  fontFamily:'DM Sans, system-ui, sans-serif' }}>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=DM+Sans:wght@300;400;500;600&display=swap');

        @keyframes vl-kb {
          0%   { transform: scale(1.08) translate(0%, 0%); }
          50%  { transform: scale(1.14) translate(-1%, -1.5%); }
          100% { transform: scale(1.08) translate(0%, 0%); }
        }
        @keyframes vl-spin { to { transform: rotate(360deg) } }
        @keyframes vl-fade { from { opacity:0; transform:translateY(20px) } to { opacity:1; transform:none } }

        .vl-hero-kb  { animation: vl-kb 22s ease-in-out infinite; will-change: transform; }
        .vl-reveal   { opacity:0; transform:translateY(22px); transition: opacity 0.65s ease, transform 0.65s ease; }
        .vl-reveal.on{ opacity:1; transform:none; }

        .vl-layout   { display:grid; grid-template-columns:minmax(0,1fr) minmax(320px,400px); gap:56px; align-items:start; }
        @media (max-width:900px) {
          .vl-layout { grid-template-columns:1fr !important; gap:32px !important; }
        }

        .vl-cta-btn:hover  { opacity:0.85 !important; }
        .vl-cta-btn:active { transform:translateY(1px); }
        .vl-inp:focus      { border-color:${accent} !important; outline:none !important; }
        .vl-inp::placeholder { color:${T.faint}; }
      `}</style>

      {/* ── Header ── */}
      <header style={{ position:'sticky', top:0, zIndex:50,
                       background:'rgba(248,247,244,0.96)', backdropFilter:'blur(12px)',
                       borderBottom:`1px solid ${T.border}` }}>
        <div style={{ maxWidth:1200, margin:'0 auto', padding:'0 28px',
                      height:60, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:20, letterSpacing:'0.03em', color: T.deep }}>
            Gateway <span style={{ color: accent }}>Advisors</span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:20 }}>
            <div style={{ fontSize:10, textTransform:'uppercase', letterSpacing:2, color: T.faint }}>
              Private · Residential
            </div>
            {agent?.phone && (
              <a href={`tel:${agent.phone}`}
                 style={{ color: T.muted, textDecoration:'none', fontSize:13 }}>
                {agent.phone}
              </a>
            )}
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section style={{ position:'relative', height:'68vh', minHeight:480, overflow:'hidden' }}>
        {heroImage ? (
          <div className="vl-hero-kb" style={{ position:'absolute', inset:0,
               backgroundImage:`url(${heroImage})`, backgroundSize:'cover', backgroundPosition:'center' }} />
        ) : (
          <div style={{ position:'absolute', inset:0,
               background:`linear-gradient(135deg, ${T.deep} 0%, #2C4A5A 50%, #3A6070 100%)` }} />
        )}
        {/* Overlay — left-heavy for light bg pages */}
        <div style={{ position:'absolute', inset:0,
             background:'linear-gradient(to right, rgba(30,47,57,0.75) 0%, rgba(30,47,57,0.4) 55%, rgba(30,47,57,0.1) 100%)' }} />
        <div style={{ position:'absolute', inset:0,
             background:'linear-gradient(to top, rgba(30,47,57,0.6) 0%, transparent 50%)' }} />

        {/* Hero content */}
        <div style={{ position:'relative', zIndex:2, maxWidth:1200, margin:'0 auto',
                      padding:'0 28px', height:'100%', display:'flex', flexDirection:'column',
                      justifyContent:'flex-end', paddingBottom:52 }}>
          <div style={{ animation:'vl-fade 0.9s ease both' }}>
            <div style={{ display:'inline-flex', alignItems:'center', gap:8,
                          padding:'4px 14px', border:`1px solid ${T.cream}50`,
                          borderRadius:99, marginBottom:20,
                          background:'rgba(228,227,223,0.10)' }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background: T.cream, opacity:0.85 }} />
              <span style={{ fontSize:10, textTransform:'uppercase', letterSpacing:2.5, color: T.cream, opacity:0.9 }}>
                Private Advisory Consultation
              </span>
            </div>

            <h1 style={{ fontFamily:'Cormorant Garamond, Georgia, serif',
                         fontSize:'clamp(36px, 5.6vw, 66px)', fontWeight:500, lineHeight:1.05,
                         margin:'0 0 18px', color:'#fff', letterSpacing:'-0.01em', maxWidth:660 }}>
              {headline}
            </h1>

            <p style={{ fontSize:16, lineHeight:1.65, color: T.cream, maxWidth:500, margin:'0 0 28px', opacity:0.88 }}>
              {subhead}
            </p>

            <a href="#valuation-form"
               style={{ display:'inline-flex', alignItems:'center', gap:10,
                        background: accent, color:'#fff', padding:'14px 28px',
                        borderRadius:3, fontSize:14, fontWeight:600, letterSpacing:0.4,
                        textDecoration:'none', cursor:'pointer' }}
               className="vl-cta-btn">
              {ctaText}
              <span style={{ fontSize:18, lineHeight:1 }}>→</span>
            </a>
          </div>
        </div>
      </section>

      {/* ── Key Facts Bar ── */}
      <div style={{ background: T.deep, borderBottom:`1px solid rgba(255,255,255,0.06)` }}>
        <div style={{ maxWidth:1200, margin:'0 auto', padding:'0 28px',
                      display:'flex', alignItems:'stretch', flexWrap:'wrap' }}>
          {highlights.map((h, i) => (
            <React.Fragment key={i}>
              {i > 0 && (
                <div style={{ width:1, background:'rgba(162,182,192,0.15)', alignSelf:'stretch', flexShrink:0 }} />
              )}
              <div style={{ padding:'22px 36px', display:'flex', flexDirection:'column', gap:4 }}>
                <span style={{ fontFamily:'Cormorant Garamond, serif', fontSize:30, fontWeight:600,
                               color: T.cream, lineHeight:1 }}>
                  {h.value || '—'}
                </span>
                <span style={{ fontSize:10, textTransform:'uppercase', letterSpacing:1.5, color: T.faint }}>
                  {h.label}
                </span>
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* ── Body ── */}
      <div style={{ maxWidth:1200, margin:'0 auto', padding:'64px 28px 80px' }}>
        <div className="vl-layout">

          {/* Left column */}
          <div>
            {/* Story */}
            <div ref={bodyRef} className={`vl-reveal${bodyVisible ? ' on' : ''}`}>
              <p style={{ fontFamily:'Cormorant Garamond, serif', fontSize:'clamp(20px,2.4vw,26px)',
                          fontWeight:400, fontStyle:'italic', lineHeight:1.55,
                          color: T.deep, margin:'0 0 20px', opacity:0.85 }}>
                Most home valuations are generated by an algorithm that has never
                walked your street, been inside your kitchen, or spoken to a buyer
                actively searching your zip code.
              </p>
              <p style={{ fontSize:15, lineHeight:1.75, color: T.muted, margin:'0 0 36px' }}>
                We compare recent closed sales that actually match your home — same vintage,
                same condition, same buyer pool — and layer in what is happening with active
                demand today. The result is a number you can make a decision from.
              </p>
            </div>

            {/* Gallery */}
            {images.length > 0 && (
              <div ref={galleryRef} className={`vl-reveal${galleryVisible ? ' on' : ''}`}
                   style={{ marginBottom:48 }}>
                <div style={{ display:'grid', gap:5, ...mosaic.gridStyle }}>
                  {images.map((img, i) => (
                    <div key={i} style={{
                      ...mosaic.cells[i],
                      backgroundImage:`url(${img.url})`, backgroundSize:'cover', backgroundPosition:'center',
                      borderRadius:4, overflow:'hidden', boxShadow:'0 8px 28px rgba(30,47,57,0.18)',
                      position:'relative',
                    }}>
                      {(img.units || img.price) && (
                        <div style={{ position:'absolute', bottom:0, left:0, right:0,
                                      background:'linear-gradient(transparent, rgba(30,47,57,0.75))',
                                      padding:'24px 12px 10px', color:'#fff' }}>
                          {img.units && <div style={{ fontSize:11, fontWeight:500, opacity:0.85 }}>{img.units}</div>}
                          {img.price && <div style={{ fontSize:14, fontWeight:600, color: accent }}>{img.price}</div>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Trust */}
            <div ref={trustRef} className={`vl-reveal${trustVisible ? ' on' : ''}`}>
              <div style={{ borderTop:`1px solid ${T.border}`, paddingTop:32 }}>
                <div style={{ fontSize:10, textTransform:'uppercase', letterSpacing:2,
                              color: T.faint, marginBottom:20 }}>
                  Our commitment
                </div>
                {[
                  'Valuations based on real closed comps — not automated software estimates.',
                  "Completely confidential. We will not share your property without your explicit direction.",
                  'Response within one business day — or your time back. We mean it.',
                ].map((line, i) => (
                  <div key={i} style={{ display:'flex', gap:14, marginBottom:16 }}>
                    <div style={{ width:20, height:20, borderRadius:'50%', background: T.goldDim,
                                  border:`1px solid ${accent}40`, display:'flex', alignItems:'center',
                                  justifyContent:'center', flexShrink:0, marginTop:1 }}>
                      <span style={{ fontSize:10, color: accent }}>✓</span>
                    </div>
                    <p style={{ fontSize:14, lineHeight:1.7, color: T.muted, margin:0 }}>{line}</p>
                  </div>
                ))}
              </div>

              {/* Gateway perspective */}
              <blockquote style={{ margin:'40px 0 0', padding:'24px 28px',
                                   borderLeft:`3px solid ${accent}`,
                                   background: T.bgAlt,
                                   borderRadius:'0 4px 4px 0' }}>
                <p style={{ fontFamily:'Cormorant Garamond, serif', fontSize:19, fontStyle:'italic',
                             lineHeight:1.6, color: T.deep, margin:0, opacity:0.85 }}>
                  "Your home is not a data point. It is a specific property on a specific street,
                   in a specific condition, for a specific buyer. We price it that way."
                </p>
                <footer style={{ marginTop:12, fontSize:11, textTransform:'uppercase',
                                 letterSpacing:1.5, color: T.faint }}>
                  Gateway Advisors · Residential Division
                </footer>
              </blockquote>
            </div>
          </div>

          {/* Right column — form */}
          <div id="valuation-form" style={{ position:'sticky', top:80 }}>
            <div style={{ background:'#fff', border:`1px solid ${T.border}`,
                          borderRadius:6, padding:28,
                          boxShadow:'0 4px 24px rgba(30,47,57,0.08), 0 24px 64px rgba(30,47,57,0.06)' }}>
              {submitted ? <SuccessView agent={agent} /> : (
                <>
                  <div style={{ fontSize:10, textTransform:'uppercase', letterSpacing:2,
                                color: accent, marginBottom:8 }}>
                    Free · Confidential · No obligation
                  </div>
                  <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:26, fontWeight:500,
                               color: T.deep, margin:'0 0 4px', lineHeight:1.2 }}>
                    Request your valuation
                  </h2>
                  <p style={{ fontSize:13, color: T.muted, margin:'0 0 22px', lineHeight:1.5 }}>
                    Takes 60 seconds. Response within one business day.
                  </p>

                  <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:12 }}>
                    <label>
                      <FieldLabel>Property address *</FieldLabel>
                      <LuxeInput required placeholder="123 Main St, Springfield"
                                 value={form.property_address}
                                 onChange={e => setForm(p => ({ ...p, property_address: e.target.value }))} />
                    </label>

                    <label>
                      <FieldLabel>Property type</FieldLabel>
                      <LuxeSelect value={form.property_type}
                                  onChange={e => setForm(p => ({ ...p, property_type: e.target.value }))}>
                        {PROPERTY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </LuxeSelect>
                    </label>

                    <label>
                      <FieldLabel>Your name *</FieldLabel>
                      <LuxeInput required autoComplete="name"
                                 value={form.name}
                                 onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                    </label>

                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                      <label>
                        <FieldLabel>Phone *</FieldLabel>
                        <LuxeInput required type="tel" autoComplete="tel" placeholder="(555) 555-5555"
                                   value={form.phone}
                                   onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} />
                      </label>
                      <label>
                        <FieldLabel>Email (optional)</FieldLabel>
                        <LuxeInput type="email" autoComplete="email"
                                   value={form.email}
                                   onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
                      </label>
                    </div>

                    <label>
                      <FieldLabel>Anything we should know? (optional)</FieldLabel>
                      <LuxeTextarea rows={2}
                                    placeholder="Renovations, timeline, reason for selling, etc."
                                    value={form.message}
                                    onChange={e => setForm(p => ({ ...p, message: e.target.value }))} />
                    </label>

                    {error && (
                      <div style={{ color:'#c0392b', fontSize:12,
                                    background:'rgba(192,57,43,0.06)',
                                    border:'1px solid rgba(192,57,43,0.15)',
                                    padding:'9px 12px', borderRadius:4 }}>
                        {error}
                      </div>
                    )}

                    <button type="submit" disabled={submitting} className="vl-cta-btn"
                            style={{ background: T.deep, color:'#fff', padding:'14px 20px',
                                     border:'none', borderRadius:3, fontSize:14, fontWeight:500,
                                     letterSpacing:0.5, cursor:'pointer', marginTop:4,
                                     opacity: submitting ? 0.6 : 1, transition:'opacity 180ms' }}>
                      {submitting ? 'Sending…' : `${ctaText} →`}
                    </button>

                    <p style={{ fontSize:11, color: T.faint, textAlign:'center', margin:'2px 0 0', lineHeight:1.5 }}>
                      Your information is private. We never sell or share your data.
                    </p>
                  </form>
                </>
              )}
            </div>

            {/* Agent card */}
            {agent && (
              <div style={{ marginTop:12, padding:'16px 18px', background:'#fff',
                            border:`1px solid ${T.border}`, borderRadius:6,
                            display:'flex', alignItems:'center', gap:14,
                            boxShadow:'0 2px 12px rgba(30,47,57,0.06)' }}>
                <div style={{ width:44, height:44, borderRadius:'50%',
                              background: agent.color || `${accent}22`,
                              border:`1px solid ${accent}40`,
                              display:'flex', alignItems:'center', justifyContent:'center',
                              fontFamily:'Cormorant Garamond, serif', fontWeight:600,
                              color: T.deep, fontSize:16, flexShrink:0 }}>
                  {agentInitials || '?'}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color: T.deep, fontSize:14, fontWeight:500 }}>{agent.name}</div>
                  <div style={{ color: T.muted, fontSize:11.5, marginTop:2 }}>
                    {agent.role || 'Residential Advisor'} · Gateway Advisors
                  </div>
                </div>
                {agent.phone && (
                  <a href={`tel:${agent.phone}`}
                     style={{ color: T.deep, fontSize:12, textDecoration:'none',
                              padding:'6px 14px', border:`1px solid ${T.borderM}`,
                              borderRadius:99, flexShrink:0 }}>
                    Call
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <footer style={{ borderTop:`1px solid ${T.border}`, padding:'24px 28px 48px', textAlign:'center' }}>
        <div style={{ fontSize:11, color: T.faint, lineHeight:1.7 }}>
          Gateway Real Estate Advisors · Licensed Brokerage · IA · SD · NE
          <br />
          This analysis is a broker opinion of value and does not constitute a formal appraisal.
          <br />
          <span style={{ opacity:0.65 }}>This communication is private and intended solely for its recipient.</span>
        </div>
      </footer>
    </div>
  )
}
