/**
 * Multifamily Valuation Landing — dark luxury "Private Investment Dossier"
 * URL: /lp/multifamily/:mailingId
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'

// ─── Brand tokens ────────────────────────────────────────────────────────────
const T = {
  deep:    '#1E2F39',
  darker:  '#141F26',
  darkest: '#0D1519',
  cream:   '#E4E3DF',
  muted:   '#A2B6C0',
  faint:   '#6B8490',
  gold:    '#C5A46E',
  goldDim: 'rgba(197,164,110,0.18)',
  surface: 'rgba(20,31,38,0.92)',
  border:  'rgba(162,182,192,0.12)',
}

const UNIT_RANGES = [
  { value: '2-4',     label: '2–4 units'   },
  { value: '5-20',    label: '5–20 units'  },
  { value: '21-50',   label: '21–50 units' },
  { value: '51-100',  label: '51–100 units'},
  { value: '100+',    label: '100+ units'  },
  { value: 'unknown', label: 'Not sure yet'},
]

const DEFAULT_HIGHLIGHTS = [
  { label: 'Closed volume',  value: '$240M+' },
  { label: 'Avg sale time',  value: '38 days'},
  { label: 'Submarkets',     value: '14'     },
]

// ─── Reveal hook ─────────────────────────────────────────────────────────────
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

// ─── Mosaic hook ─────────────────────────────────────────────────────────────
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
    <div style={{ minHeight:'100vh', background: T.darkest, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ width:36, height:36, border:`2px solid ${T.border}`, borderTopColor: T.gold,
                      borderRadius:'50%', margin:'0 auto', animation:'mf-spin 0.8s linear infinite' }} />
        <style>{`@keyframes mf-spin { to { transform:rotate(360deg) } }`}</style>
      </div>
    </div>
  )
}

function LuxeInput({ style, ...props }) {
  return <input style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px',
    background:'rgba(13,21,25,0.7)', border:`1px solid ${T.border}`, borderRadius:4,
    color: T.cream, fontSize:14, fontFamily:'DM Sans, sans-serif', outline:'none',
    transition:'border-color 180ms', ...style }} {...props} />
}

function LuxeTextarea({ style, ...props }) {
  return <textarea style={{ width:'100%', boxSizing:'border-box', padding:'11px 14px',
    background:'rgba(13,21,25,0.7)', border:`1px solid ${T.border}`, borderRadius:4,
    color: T.cream, fontSize:14, fontFamily:'DM Sans, sans-serif', outline:'none',
    transition:'border-color 180ms', resize:'vertical', ...style }} {...props} />
}

function LuxeSelect({ style, value, onChange, children }) {
  return (
    <select value={value} onChange={onChange} style={{ width:'100%', boxSizing:'border-box',
      padding:'11px 36px 11px 14px', background:'rgba(13,21,25,0.7)', border:`1px solid ${T.border}`,
      borderRadius:4, color: T.cream, fontSize:14, fontFamily:'DM Sans, sans-serif', outline:'none',
      appearance:'none', transition:'border-color 180ms',
      backgroundImage:`url("data:image/svg+xml;utf8,<svg fill='%23A2B6C0' xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M7 10l5 5 5-5z'/></svg>")`,
      backgroundRepeat:'no-repeat', backgroundPosition:'right 10px center', ...style }}>
      {children}
    </select>
  )
}

function FieldLabel({ children }) {
  return <span style={{ display:'block', fontSize:10, textTransform:'uppercase', letterSpacing:1.4,
    color: T.faint, fontWeight:600, marginBottom:6 }}>{children}</span>
}

function SuccessView({ agent }) {
  return (
    <div style={{ textAlign:'center', padding:'28px 8px' }}>
      <div style={{ width:60, height:60, borderRadius:'50%', background: T.goldDim,
                    border:`1px solid ${T.gold}44`, display:'flex', alignItems:'center',
                    justifyContent:'center', margin:'0 auto', fontSize:26, color: T.gold }}>✓</div>
      <h2 style={{ fontFamily:'Cormorant Garamond, Georgia, serif', fontSize:28,
                   color: T.cream, margin:'18px 0 10px', fontWeight:500 }}>
        Dossier received.
      </h2>
      <p style={{ color: T.muted, fontSize:14, lineHeight:1.7, maxWidth:280, margin:'0 auto' }}>
        We're pulling cap-rate comps and recent sales in your submarket now.
        {agent && (
          <><br /><br />
          <span style={{ color: T.cream }}>{agent.name}</span> will reach out within one business day.
          </>
        )}
      </p>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function LandingMultifamily({ mailingId }) {
  const [mailing,    setMailing]    = useState(null)
  const [agent,      setAgent]      = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [submitted,  setSubmitted]  = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState(null)

  const [form, setForm] = useState({
    name: '', phone: '', email: '', property_address: '', units: '5-20', message: '',
  })

  // Reveal refs
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
  const headline   = cfg.headline    || "What is your multifamily really worth?"
  const subhead    = cfg.subheadline || "A private, cap-rate-driven analysis from a broker who closes deals in your submarket — not a software estimate."
  const ctaText    = cfg.cta_text    || 'Request private valuation'
  const accent     = cfg.accent      || T.gold
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
    if (!form.name.trim())             { setError('Please enter your name'); return }
    if (!form.phone.trim())            { setError('Please enter a phone number'); return }
    if (!form.property_address.trim()) { setError('Please enter the property address'); return }
    setError(null)
    setSubmitting(true)
    const payload = {
      action: 'capture_lead',
      mailing_id: mailingId,
      source_landing: 'multifamily',
      name: form.name,
      phone: form.phone,
      email: form.email,
      property_address: form.property_address,
      property_type: 'multifamily',
      message: form.units && form.units !== 'unknown'
        ? `Size: ${form.units} units. ${form.message}`.trim()
        : form.message,
    }
    const res  = await fetch('/api/campaigns', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
    const data = await res.json()
    setSubmitting(false)
    if (!res.ok || data.error) { setError(data.error || 'Could not submit — please try again'); return }
    setSubmitted(true)
  }

  if (loading) return <Loader />
  if (error && !mailing) return (
    <div style={{ minHeight:'100vh', background: T.darkest, display:'flex', alignItems:'center', justifyContent:'center', padding:40 }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:22, color: T.cream, marginBottom:12 }}>
          Gateway Real Estate Advisors
        </div>
        <div style={{ color:'#e57373', fontSize:14 }}>{error}</div>
      </div>
    </div>
  )

  const agentInitials = agent ? (agent.name || '').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() : ''

  return (
    <div style={{ minHeight:'100vh', background: T.deep, color: T.cream,
                  fontFamily:'DM Sans, system-ui, sans-serif' }}>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=DM+Sans:wght@300;400;500;600&display=swap');

        @keyframes mf-kb {
          0%   { transform: scale(1.08) translate(0%, 0%); }
          50%  { transform: scale(1.14) translate(-1.5%, -1%); }
          100% { transform: scale(1.08) translate(0%, 0%); }
        }
        @keyframes mf-spin { to { transform: rotate(360deg) } }
        @keyframes mf-fade { from { opacity:0; transform:translateY(18px) } to { opacity:1; transform:none } }

        .mf-hero-kb  { animation: mf-kb 22s ease-in-out infinite; will-change: transform; }
        .mf-reveal   { opacity:0; transform:translateY(22px); transition: opacity 0.65s ease, transform 0.65s ease; }
        .mf-reveal.on{ opacity:1; transform:none; }

        .mf-layout   { display:grid; grid-template-columns:minmax(0,1fr) minmax(320px,420px); gap:56px; align-items:start; }
        @media (max-width:900px) {
          .mf-layout { grid-template-columns:1fr !important; gap:32px !important; }
        }

        .mf-cta-btn:hover  { opacity:0.88 !important; }
        .mf-cta-btn:active { transform:translateY(1px); }
        .mf-inp:focus      { border-color:${accent} !important; }
        .mf-inp::placeholder { color:${T.faint}; }
        select.mf-inp:focus { border-color:${accent} !important; }
      `}</style>

      {/* ── Header ── */}
      <header style={{ position:'sticky', top:0, zIndex:50,
                       background:'rgba(20,31,38,0.95)', backdropFilter:'blur(12px)',
                       borderBottom:`1px solid ${T.border}` }}>
        <div style={{ maxWidth:1200, margin:'0 auto', padding:'0 28px',
                      height:60, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:20, letterSpacing:'0.03em', color: T.cream }}>
            Gateway <span style={{ color: accent }}>Advisors</span>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:20 }}>
            <div style={{ fontSize:10, textTransform:'uppercase', letterSpacing:2, color: T.faint }}>
              Private · Investment
            </div>
            {agent?.phone && (
              <a href={`tel:${agent.phone}`} style={{ color: T.muted, textDecoration:'none', fontSize:13 }}>
                {agent.phone}
              </a>
            )}
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section style={{ position:'relative', height:'68vh', minHeight:480, overflow:'hidden' }}>
        {heroImage ? (
          <div className="mf-hero-kb" style={{ position:'absolute', inset:0,
               backgroundImage:`url(${heroImage})`, backgroundSize:'cover', backgroundPosition:'center' }} />
        ) : (
          <div style={{ position:'absolute', inset:0,
               background:`radial-gradient(ellipse at 30% 50%, ${T.darker} 0%, ${T.darkest} 70%)` }} />
        )}
        {/* Overlay */}
        <div style={{ position:'absolute', inset:0,
             background:'linear-gradient(to right, rgba(14,22,28,0.82) 0%, rgba(14,22,28,0.45) 60%, rgba(14,22,28,0.15) 100%)' }} />
        <div style={{ position:'absolute', inset:0,
             background:'linear-gradient(to top, rgba(14,22,28,0.7) 0%, transparent 55%)' }} />

        {/* Hero content */}
        <div style={{ position:'relative', zIndex:2, maxWidth:1200, margin:'0 auto',
                      padding:'0 28px', height:'100%', display:'flex', flexDirection:'column', justifyContent:'flex-end',
                      paddingBottom:52 }}>
          <div style={{ animation:'mf-fade 0.9s ease both' }}>
            <div style={{ display:'inline-flex', alignItems:'center', gap:8,
                          padding:'4px 14px', border:`1px solid ${accent}50`,
                          borderRadius:99, marginBottom:20,
                          background:'rgba(197,164,110,0.08)' }}>
              <div style={{ width:6, height:6, borderRadius:'50%', background: accent }} />
              <span style={{ fontSize:10, textTransform:'uppercase', letterSpacing:2.5, color: accent }}>
                Private Investment Dossier
              </span>
            </div>

            <h1 style={{ fontFamily:'Cormorant Garamond, Georgia, serif',
                         fontSize:'clamp(38px, 5.8vw, 68px)', fontWeight:500, lineHeight:1.05,
                         margin:'0 0 18px', color: T.cream, letterSpacing:'-0.01em',
                         maxWidth:680 }}>
              {headline}
            </h1>

            <p style={{ fontSize:16, lineHeight:1.65, color: T.muted, maxWidth:520, margin:'0 0 28px' }}>
              {subhead}
            </p>

            <a href="#valuation-form"
               style={{ display:'inline-flex', alignItems:'center', gap:10,
                        background: accent, color: T.darkest, padding:'14px 28px',
                        borderRadius:3, fontSize:14, fontWeight:600, letterSpacing:0.4,
                        textDecoration:'none', cursor:'pointer' }}
               className="mf-cta-btn">
              {ctaText}
              <span style={{ fontSize:18, lineHeight:1 }}>→</span>
            </a>
          </div>
        </div>
      </section>

      {/* ── Key Metrics Bar ── */}
      <div style={{ background: T.darkest, borderBottom:`1px solid ${T.border}` }}>
        <div style={{ maxWidth:1200, margin:'0 auto', padding:'0 28px',
                      display:'flex', alignItems:'stretch', flexWrap:'wrap' }}>
          {highlights.map((h, i) => (
            <React.Fragment key={i}>
              {i > 0 && (
                <div style={{ width:1, background: T.border, alignSelf:'stretch', flexShrink:0 }} />
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
        <div className="mf-layout">

          {/* Left column */}
          <div>
            {/* Story */}
            <div ref={bodyRef} className={`mf-reveal${bodyVisible ? ' on' : ''}`}>
              <p style={{ fontFamily:'Cormorant Garamond, serif', fontSize:'clamp(20px,2.4vw,26px)',
                          fontWeight:400, fontStyle:'italic', lineHeight:1.55,
                          color: T.cream, margin:'0 0 20px', opacity:0.9 }}>
                Most valuations are software-generated guesses that ignore cap rate compression,
                submarket absorption, and the intangibles that move institutional buyers.
              </p>
              <p style={{ fontSize:15, lineHeight:1.75, color: T.muted, margin:'0 0 36px' }}>
                We pull actual T12s, recent arm's-length sales within your competitive set, and
                active buyer appetite to give you a number you can negotiate from — not a range
                wide enough to be useless.
              </p>
            </div>

            {/* Gallery */}
            {images.length > 0 && (
              <div ref={galleryRef} className={`mf-reveal${galleryVisible ? ' on' : ''}`}
                   style={{ marginBottom:48 }}>
                <div style={{ display:'grid', gap:5, ...mosaic.gridStyle }}>
                  {images.map((img, i) => (
                    <div key={i} style={{
                      ...mosaic.cells[i],
                      backgroundImage:`url(${img.url})`, backgroundSize:'cover', backgroundPosition:'center',
                      borderRadius:4, overflow:'hidden', boxShadow:'0 12px 32px rgba(0,0,0,0.5)',
                      position:'relative',
                    }}>
                      {(img.units || img.price) && (
                        <div style={{ position:'absolute', bottom:0, left:0, right:0,
                                      background:'linear-gradient(transparent, rgba(0,0,0,0.7))',
                                      padding:'24px 12px 10px', color:'#fff' }}>
                          {img.units && <div style={{ fontSize:11, fontWeight:500, color: T.muted }}>{img.units}</div>}
                          {img.price && <div style={{ fontSize:14, fontWeight:600, color: accent }}>{img.price}</div>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Trust items */}
            <div ref={trustRef} className={`mf-reveal${trustVisible ? ' on' : ''}`}>
              <div style={{ borderTop:`1px solid ${T.border}`, paddingTop:32 }}>
                <div style={{ fontSize:10, textTransform:'uppercase', letterSpacing:2,
                              color: T.faint, marginBottom:20 }}>
                  Our commitment
                </div>
                {[
                  'Cap-rate analysis from active comps — not Zillow or automated estimates.',
                  'Confidential. We will not list, market, or share your property without your explicit direction.',
                  'Response within one business day, or we return your time.',
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
                                   background:'rgba(197,164,110,0.05)',
                                   borderRadius:'0 4px 4px 0' }}>
                <p style={{ fontFamily:'Cormorant Garamond, serif', fontSize:19, fontStyle:'italic',
                             lineHeight:1.6, color: T.cream, margin:0, opacity:0.85 }}>
                  "Multifamily is not priced on bedrooms and square footage.
                   It is priced on what a disciplined buyer will underwrite today.
                   That number changes every quarter. We track it so you don't have to."
                </p>
                <footer style={{ marginTop:12, fontSize:11, textTransform:'uppercase',
                                 letterSpacing:1.5, color: T.faint }}>
                  Gateway Advisors · Commercial Division
                </footer>
              </blockquote>
            </div>
          </div>

          {/* Right column — form */}
          <div id="valuation-form" style={{ position:'sticky', top:80 }}>
            <div style={{ background: T.darker, border:`1px solid ${T.border}`,
                          borderRadius:6, padding:28, boxShadow:'0 32px 80px rgba(0,0,0,0.5)' }}>
              {submitted ? <SuccessView agent={agent} /> : (
                <>
                  <div style={{ fontSize:10, textTransform:'uppercase', letterSpacing:2, color: accent, marginBottom:8 }}>
                    Free · Confidential · No obligation
                  </div>
                  <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:26, fontWeight:500,
                               color: T.cream, margin:'0 0 4px', lineHeight:1.2 }}>
                    Request your valuation
                  </h2>
                  <p style={{ fontSize:13, color: T.faint, margin:'0 0 22px', lineHeight:1.5 }}>
                    Takes 60 seconds. Response within one business day.
                  </p>

                  <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:12 }}>
                    <label>
                      <FieldLabel>Your name *</FieldLabel>
                      <LuxeInput required autoComplete="name" className="mf-inp"
                                 value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                    </label>

                    <label>
                      <FieldLabel>Phone number *</FieldLabel>
                      <LuxeInput required type="tel" autoComplete="tel" className="mf-inp"
                                 placeholder="(555) 555-5555"
                                 value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                    </label>

                    <label>
                      <FieldLabel>Email (optional)</FieldLabel>
                      <LuxeInput type="email" autoComplete="email" className="mf-inp"
                                 value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
                    </label>

                    <label>
                      <FieldLabel>Property address *</FieldLabel>
                      <LuxeInput required className="mf-inp" placeholder="123 Oak Ave, City, ST"
                                 value={form.property_address}
                                 onChange={e => setForm(f => ({ ...f, property_address: e.target.value }))} />
                    </label>

                    <label>
                      <FieldLabel>How many units?</FieldLabel>
                      <LuxeSelect value={form.units} className="mf-inp"
                                  onChange={e => setForm(f => ({ ...f, units: e.target.value }))}>
                        {UNIT_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </LuxeSelect>
                    </label>

                    <label>
                      <FieldLabel>Anything we should know? (optional)</FieldLabel>
                      <LuxeTextarea rows={2} className="mf-inp"
                                    placeholder="Recent renovations, T12, considering 1031, etc."
                                    value={form.message}
                                    onChange={e => setForm(f => ({ ...f, message: e.target.value }))} />
                    </label>

                    {error && (
                      <div style={{ color:'#f4a4a4', fontSize:12, background:'rgba(200,60,60,0.12)',
                                    border:'1px solid rgba(200,60,60,0.2)', padding:'9px 12px', borderRadius:4 }}>
                        {error}
                      </div>
                    )}

                    <button type="submit" disabled={submitting} className="mf-cta-btn"
                            style={{ background: accent, color: T.darkest, padding:'14px 20px',
                                     border:'none', borderRadius:3, fontSize:14, fontWeight:600,
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
              <div style={{ marginTop:12, padding:'16px 18px', background: T.darker,
                            border:`1px solid ${T.border}`, borderRadius:6,
                            display:'flex', alignItems:'center', gap:14 }}>
                <div style={{ width:44, height:44, borderRadius:'50%',
                              background: agent.color ? agent.color : `${accent}33`,
                              border:`1px solid ${accent}40`,
                              display:'flex', alignItems:'center', justifyContent:'center',
                              fontFamily:'Cormorant Garamond, serif', fontWeight:600,
                              color: accent, fontSize:16, flexShrink:0 }}>
                  {agentInitials || '?'}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color: T.cream, fontSize:14, fontWeight:500 }}>{agent.name}</div>
                  <div style={{ color: T.faint, fontSize:11.5, marginTop:2 }}>
                    {agent.role || 'Commercial Advisor'} · Gateway Advisors
                  </div>
                </div>
                {agent.phone && (
                  <a href={`tel:${agent.phone}`}
                     style={{ color: accent, fontSize:12, textDecoration:'none',
                              padding:'6px 14px', border:`1px solid ${accent}50`,
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
          Gateway Real Estate Advisors · Licensed Brokerage
          <br />
          This analysis is a broker opinion of value and does not constitute a formal appraisal.
          <br />
          <span style={{ opacity:0.6 }}>This communication is private and intended solely for its recipient.</span>
        </div>
      </footer>
    </div>
  )
}
