/**
 * Signature Property Dossier — /lp/property/:mailingId
 *
 * Gateway Real Estate Advisors · Private Landing Page
 *
 * landing_config: { headline, subheadline, price, beds, baths, sqft,
 *   lot_size, year_built, description, features[], images[], cta_text, accent }
 *
 * Key stats are displayed ONCE — in the key-facts bar between hero and body.
 * Never in the hero and again in a card.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'

// ── Brand tokens ─────────────────────────────────────────────────────────────
const B = {
  dark:     '#282828',
  deep:     '#1E2F39',
  bluegray: '#A2B6C0',
  cream:    '#E4E3DF',
  offwhite: '#F8F7F4',
  gold:     '#C5A46E',
  white:    '#FFFFFF',
}

// ── Scroll-reveal hook ────────────────────────────────────────────────────────
function useReveal(threshold = 0.1) {
  const ref = useRef(null)
  const [vis, setVis] = useState(false)
  useEffect(() => {
    const el = ref.current; if (!el) return
    const ob = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVis(true); ob.disconnect() } }, { threshold }
    )
    ob.observe(el)
    return () => ob.disconnect()
  }, [])
  return [ref, vis]
}

// ── Mosaic gallery layout ─────────────────────────────────────────────────────
function useMosaicLayout(n) {
  return useMemo(() => {
    const L = {
      1: { cols:1, areas:[['a']] },
      2: { cols:2, areas:[['a','b']] },
      3: { cols:3, areas:[['a','a','b'],['a','a','c']] },
      4: { cols:4, areas:[['a','a','b','c'],['a','a','d','b']] },
      5: { cols:4, areas:[['a','a','b','c'],['a','a','d','e']] },
    }[Math.min(n, 5)]
    if (!L) return { gridStyle:{}, cells:[] }
    const unique = [...new Set(L.areas.flat())]
    return {
      gridStyle: { gridTemplateColumns:`repeat(${L.cols}, 1fr)`, gridTemplateAreas: L.areas.map(r=>`"${r.join(' ')}"`).join(' ') },
      cells: unique.map(ltr => ({ gridArea:ltr, minHeight: n===1?360:n<=2?260:180 })),
    }
  }, [n])
}

// ── Sub-components ────────────────────────────────────────────────────────────
function LuxeInput({ label, value, onChange, type='text', placeholder, required, accent }) {
  return (
    <label style={{ display:'flex', flexDirection:'column', gap:6 }}>
      <span style={{ fontSize:10, letterSpacing:'0.12em', textTransform:'uppercase', color:B.bluegray, fontWeight:600 }}>
        {label}{required && <span style={{ color:accent, marginLeft:3 }}>*</span>}
      </span>
      <input required={required} type={type} value={value} placeholder={placeholder||''} onChange={onChange}
        style={{ width:'100%', padding:'12px 14px', background:B.offwhite, border:`1px solid ${B.cream}`, borderRadius:3,
                 fontSize:14, fontFamily:'inherit', outline:'none', color:B.dark, transition:'border-color 200ms, box-shadow 200ms' }} />
    </label>
  )
}

function SuccessView({ agent, accent }) {
  return (
    <div style={{ textAlign:'center', padding:'28px 8px' }}>
      <div style={{ width:56, height:56, borderRadius:'50%', background:B.deep, color:accent, display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto 20px', fontSize:22 }}>✓</div>
      <h2 style={{ fontFamily:`'Cormorant Garamond', Georgia, serif`, fontSize:24, margin:'0 0 12px', color:B.deep, letterSpacing:'-0.02em', fontWeight:600 }}>
        Message received.
      </h2>
      <p style={{ color:B.bluegray, fontSize:14, lineHeight:1.75, margin:0 }}>
        {agent ? `${agent.name} will reach out to you personally within the business day.` : "We'll be in touch shortly."}
        <br /><br />
        <em style={{ fontSize:12 }}>Your details are held in the strictest confidence.</em>
      </p>
    </div>
  )
}

function Loader() {
  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:14, background:B.offwhite }}>
      <div style={{ fontFamily:`'Cormorant Garamond', Georgia, serif`, fontSize:22, color:B.deep, letterSpacing:'-0.02em' }}>Gateway</div>
      <div style={{ width:22, height:22, border:`2px solid ${B.cream}`, borderTopColor:B.deep, borderRadius:'50%', animation:'gwspin 0.85s linear infinite' }} />
      <style>{`@keyframes gwspin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
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
      const { data: m } = await supabase.from('mailings').select('id, name, agent_id, landing_config').eq('id', mailingId).single()
      if (!m) { setError('Mailing not found'); setLoading(false); return }
      setMailing(m)
      if (m.agent_id) {
        const { data: a } = await supabase.from('agents').select('id, name, phone, email, photo_url, color, role').eq('id', m.agent_id).single()
        setAgent(a || null)
      }
      setLoading(false)
    })()
  }, [mailingId])

  const cfg         = mailing?.landing_config || {}
  const accent      = cfg.accent      || B.gold
  const headline    = cfg.headline    || mailing?.name || 'A Private Opportunity'
  const subhead     = cfg.subheadline || ''
  const ctaText     = cfg.cta_text    || 'Request a Private Viewing'
  const description = cfg.description || ''
  const features    = Array.isArray(cfg.features) ? cfg.features.filter(Boolean) : []
  const images      = (Array.isArray(cfg.images) ? cfg.images : [])
    .map(v => typeof v==='string' ? { url:v, caption:'', price:'' } : v).filter(v => v?.url)
  const heroImg       = images[0]?.url
  const galleryImages = images.slice(1)
  const mosaic        = useMosaicLayout(Math.min(galleryImages.length, 5))

  const fmtNum   = v => { const n = Number(String(v).replace(/[^0-9.]/g,'')); return isNaN(n) ? String(v) : n.toLocaleString() }
  const fmtPrice = v => { if (!v) return null; const n = Number(String(v).replace(/[^0-9.]/g,'')); return isNaN(n) ? String(v) : '$'+n.toLocaleString() }

  // Stats defined ONCE — rendered in the key-facts bar only, never the hero
  const details = [
    cfg.price      && { label:'Offered at',  value: fmtPrice(cfg.price) },
    cfg.beds       && { label:'Bedrooms',    value: cfg.beds },
    cfg.baths      && { label:'Bathrooms',   value: cfg.baths },
    cfg.sqft       && { label:'Sq Ft',       value: fmtNum(cfg.sqft) },
    cfg.lot_size   && { label:'Lot',         value: fmtNum(cfg.lot_size)+' sqft' },
    cfg.year_built && { label:'Year Built',  value: cfg.year_built },
  ].filter(Boolean)

  const submit = async (e) => {
    e.preventDefault()
    if (!form.name.trim())  { setError('Please enter your name'); return }
    if (!form.phone.trim()) { setError('Please enter a phone number'); return }
    setError(null); setSubmitting(true)
    const res = await fetch('/api/campaigns', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'capture_lead', mailing_id:mailingId, source_landing:'property', ...form }),
    })
    const data = await res.json()
    setSubmitting(false)
    if (!res.ok || data.error) { setError(data.error||'Could not submit — please try again'); return }
    setSubmitted(true)
  }

  const [storyRef, storyVis]   = useReveal()
  const [featRef,  featVis]    = useReveal()
  const [gallRef,  gallVis]    = useReveal()

  const agentInitials = (agent?.name||'?').split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase()

  if (loading) return <Loader />
  if (error && !mailing) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:B.offwhite, fontFamily:'sans-serif', flexDirection:'column', gap:12 }}>
      <div style={{ fontFamily:`'Cormorant Garamond', Georgia, serif`, fontSize:20, color:B.deep }}>Gateway Real Estate Advisors</div>
      <div style={{ color:'#c0392b', fontSize:14 }}>{error}</div>
    </div>
  )

  return (
    <div style={{ minHeight:'100vh', fontFamily:`'DM Sans', system-ui, sans-serif`, background:B.offwhite, color:B.dark }}>

      {/* ── Fonts + Global CSS ───────────────────────────────────────────── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;0,700;1,400;1,600&family=DM+Sans:wght@300;400;500;600&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        .gwp-grid { display: grid; grid-template-columns: minmax(0,1.4fr) minmax(0,1fr); gap: 56px; }
        .gwp-sticky { position: sticky; top: 88px; align-self: start; }
        @media (max-width: 860px) {
          .gwp-grid  { grid-template-columns: 1fr !important; gap: 40px !important; }
          .gwp-sticky { position: static !important; }
        }
        .gwp-hero-bg { animation: gwp-kb 16s ease-in-out infinite alternate; }
        @keyframes gwp-kb { 0% { transform: scale(1); } 100% { transform: scale(1.06); } }
        @media (prefers-reduced-motion: reduce) { .gwp-hero-bg { animation: none !important; } }
        .gwp-reveal { opacity: 0; transform: translateY(22px); transition: opacity 0.75s ease, transform 0.75s ease; }
        .gwp-reveal.on { opacity: 1; transform: none; }
        .gwp-gimg > div { transition: transform 0.85s cubic-bezier(0.25,0.46,0.45,0.94); }
        .gwp-gimg:hover > div { transform: scale(1.04); }
        .gwp-cta-btn { transition: background 0.3s ease, transform 0.3s ease, box-shadow 0.3s ease; cursor: pointer; }
        .gwp-cta-btn:hover { transform: translateY(-2px); box-shadow: 0 10px 28px rgba(30,47,57,0.22); }
        .gwp-sub-btn { transition: background 0.25s ease; cursor: pointer; }
        .gwp-sub-btn:hover { background: #152530 !important; }
        input:focus, textarea:focus { outline: none !important; border-color: ${accent} !important; box-shadow: 0 0 0 3px ${accent}1a !important; }
        @keyframes gwspin { to { transform: rotate(360deg); } }
      `}</style>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header style={{ background:B.white, borderBottom:`1px solid ${B.cream}`, padding:'16px 36px', display:'flex', alignItems:'center', justifyContent:'space-between', position:'sticky', top:0, zIndex:200 }}>
        <div>
          <div style={{ fontFamily:`'Cormorant Garamond', Georgia, serif`, fontSize:18, fontWeight:600, color:B.deep, letterSpacing:'-0.02em' }}>Gateway</div>
          <div style={{ fontSize:8.5, letterSpacing:'0.2em', textTransform:'uppercase', color:B.bluegray, fontWeight:500, marginTop:1 }}>Real Estate Advisors</div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:18 }}>
          {agent?.phone && (
            <a href={`tel:${agent.phone}`} style={{ fontSize:13, color:B.deep, textDecoration:'none', fontWeight:500 }}>
              {agent.phone}
            </a>
          )}
          <div style={{ fontSize:8.5, letterSpacing:'0.22em', textTransform:'uppercase', color:B.white, background:B.deep, padding:'4px 12px', borderRadius:99, fontWeight:600 }}>
            Private
          </div>
        </div>
      </header>

      {/* ── Hero — stats NOT shown here ──────────────────────────────────── */}
      <div style={{ position:'relative', height:'72vh', minHeight:500, maxHeight:760, overflow:'hidden' }}>
        {heroImg ? (
          <>
            <div className="gwp-hero-bg" style={{ position:'absolute', inset:'-8%', backgroundImage:`url(${heroImg})`, backgroundSize:'cover', backgroundPosition:'center' }} />
            <div style={{ position:'absolute', inset:0, background:'linear-gradient(to bottom, rgba(30,47,57,0.08) 0%, rgba(30,47,57,0.52) 52%, rgba(30,47,57,0.93) 100%)' }} />
          </>
        ) : (
          <div style={{ position:'absolute', inset:0, background:`linear-gradient(135deg, ${B.deep} 0%, #0d1d26 100%)` }} />
        )}
        <div style={{ position:'absolute', inset:0, display:'flex', flexDirection:'column', justifyContent:'flex-end', padding:'52px 40px', maxWidth:1100, left:'50%', transform:'translateX(-50%)' }}>
          <div style={{ position:'absolute', top:28, left:40 }}>
            <div style={{ display:'inline-flex', alignItems:'center', gap:8, border:'1px solid rgba(228,227,223,0.3)', borderRadius:99, padding:'5px 14px' }}>
              <div style={{ width:5, height:5, borderRadius:'50%', background:accent }} />
              <span style={{ fontSize:9, letterSpacing:'0.22em', textTransform:'uppercase', color:'rgba(228,227,223,0.8)', fontWeight:600 }}>
                Private Listing · Gateway Advisors
              </span>
            </div>
          </div>
          <h1 style={{ fontFamily:`'Cormorant Garamond', Georgia, serif`, fontSize:'clamp(30px,4.8vw,60px)', fontWeight:600, lineHeight:1.06, marginBottom:16, color:'#fff', letterSpacing:'-0.03em', maxWidth:680 }}>
            {headline}
          </h1>
          {subhead && (
            <p style={{ fontSize:'clamp(14px,1.5vw,17px)', color:B.cream, opacity:0.9, marginBottom:26, maxWidth:500, lineHeight:1.58, fontWeight:300 }}>
              {subhead}
            </p>
          )}
          <button onClick={() => document.getElementById('gwp-form')?.scrollIntoView({ behavior:'smooth' })}
            className="gwp-cta-btn"
            style={{ display:'inline-flex', alignItems:'center', gap:10, background:accent, color:B.dark, padding:'14px 26px', border:'none', borderRadius:3, fontSize:12, fontWeight:600, letterSpacing:'0.08em', textTransform:'uppercase', width:'fit-content' }}>
            {ctaText} &nbsp;→
          </button>
        </div>
      </div>

      {/* ── Key Facts Bar — the ONE and ONLY place stats appear ─────────── */}
      {details.length > 0 && (
        <div style={{ background:B.deep }}>
          <div style={{ maxWidth:1100, margin:'0 auto', padding:'0 40px', display:'flex', flexWrap:'wrap', alignItems:'stretch' }}>
            {details.map((d, i) => (
              <React.Fragment key={i}>
                <div style={{ padding:'24px 36px 24px 0', display:'flex', flexDirection:'column', gap:4 }}>
                  <span style={{ fontSize:9, letterSpacing:'0.18em', textTransform:'uppercase', color:B.bluegray, fontWeight:600 }}>{d.label}</span>
                  <span style={{ fontFamily:`'Cormorant Garamond', Georgia, serif`, fontSize:24, fontWeight:600, color:B.cream, letterSpacing:'-0.02em', lineHeight:1 }}>{d.value}</span>
                </div>
                {i < details.length - 1 && (
                  <div style={{ width:1, background:'rgba(162,182,192,0.18)', margin:'18px 36px 18px 0', alignSelf:'stretch' }} />
                )}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div style={{ maxWidth:1100, margin:'0 auto', padding:'60px 40px 100px' }}>
        <div className="gwp-grid">

          {/* Left — story, features, gallery */}
          <div style={{ display:'flex', flexDirection:'column', gap:52 }}>

            {(description || subhead) && (
              <div ref={storyRef} className={`gwp-reveal${storyVis?' on':''}`}>
                <div style={{ display:'flex', alignItems:'center', gap:14, marginBottom:22 }}>
                  <div style={{ width:28, height:1, background:accent }} />
                  <span style={{ fontSize:9, letterSpacing:'0.2em', textTransform:'uppercase', color:B.bluegray, fontWeight:600 }}>The Property</span>
                </div>
                {description && (
                  <p style={{ fontSize:16, lineHeight:1.85, color:'#4a5060', fontWeight:300 }}>{description}</p>
                )}
              </div>
            )}

            {features.length > 0 && (
              <div ref={featRef} className={`gwp-reveal${featVis?' on':''}`}>
                <h3 style={{ fontFamily:`'Cormorant Garamond', Georgia, serif`, fontSize:22, fontWeight:600, marginBottom:22, color:B.deep, letterSpacing:'-0.02em' }}>
                  Property Highlights
                </h3>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'14px 36px' }}>
                  {features.map((f, i) => (
                    <div key={i} style={{ display:'flex', gap:12, alignItems:'flex-start', fontSize:14 }}>
                      <div style={{ width:4, height:4, borderRadius:'50%', background:accent, flexShrink:0, marginTop:8 }} />
                      <span style={{ color:'#4a5060', lineHeight:1.65, fontWeight:300 }}>{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {galleryImages.length > 0 && (
              <div ref={gallRef} className={`gwp-reveal${gallVis?' on':''}`}>
                <h3 style={{ fontFamily:`'Cormorant Garamond', Georgia, serif`, fontSize:22, fontWeight:600, marginBottom:22, color:B.deep, letterSpacing:'-0.02em' }}>
                  Gallery
                </h3>
                <div style={{ display:'grid', gap:6, ...mosaic.gridStyle }}>
                  {galleryImages.slice(0,5).map((img, i) => (
                    <div key={i} className="gwp-gimg" style={{ ...(mosaic.cells[i]||{}), borderRadius:4, overflow:'hidden', position:'relative' }}>
                      <div style={{ width:'100%', height:'100%', minHeight:mosaic.cells[i]?.minHeight, backgroundImage:`url(${img.url})`, backgroundSize:'cover', backgroundPosition:'center' }} />
                      {(img.caption || img.price) && (
                        <div style={{ position:'absolute', bottom:0, left:0, right:0, background:'linear-gradient(transparent,rgba(30,47,57,0.72))', padding:'22px 12px 10px' }}>
                          {img.caption && <div style={{ fontSize:11, color:B.cream, fontWeight:500 }}>{img.caption}</div>}
                          {img.price && <div style={{ fontSize:13, fontWeight:700, color:accent }}>{img.price}</div>}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Gateway Perspective */}
            <div style={{ borderTop:`1px solid ${B.cream}`, paddingTop:36 }}>
              <div style={{ fontSize:9, letterSpacing:'0.2em', textTransform:'uppercase', color:B.bluegray, fontWeight:600, marginBottom:16 }}>The Gateway Perspective</div>
              <blockquote style={{ fontFamily:`'Cormorant Garamond', Georgia, serif`, fontSize:17, lineHeight:1.78, color:'#4a5060', fontStyle:'italic', borderLeft:`2px solid ${accent}`, paddingLeft:20, margin:0 }}>
                "Gateway Real Estate Advisors offers the highest level of service in every aspect of real estate. This property was selected for our private clientele because it represents exceptional quality and lasting value in the Siouxland region."
              </blockquote>
              {agent && (
                <div style={{ marginTop:14, fontSize:13, color:B.bluegray, fontWeight:500, paddingLeft:22 }}>
                  — {agent.name}, {agent.role || 'Listing Advisor'}
                </div>
              )}
            </div>
          </div>

          {/* Right — sticky form + agent */}
          <div className="gwp-sticky">
            <div id="gwp-form" style={{ background:B.white, borderRadius:2, padding:32, boxShadow:'0 2px 4px rgba(30,47,57,0.05), 0 14px 44px rgba(30,47,57,0.1)', border:`1px solid ${B.cream}` }}>
              {submitted ? (
                <SuccessView accent={accent} agent={agent} />
              ) : (
                <>
                  <div style={{ width:24, height:1, background:accent, marginBottom:22 }} />
                  <h2 style={{ fontFamily:`'Cormorant Garamond', Georgia, serif`, fontSize:22, fontWeight:600, marginBottom:6, color:B.deep, letterSpacing:'-0.02em' }}>
                    {agent ? `A private note for ${agent.name.split(' ')[0]}` : ctaText}
                  </h2>
                  <p style={{ fontSize:13, color:B.bluegray, marginBottom:24, lineHeight:1.65 }}>
                    Leave your details — we'll respond confidentially within the business day.
                  </p>
                  <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:14 }}>
                    <LuxeInput label="Your name" required value={form.name} accent={accent} onChange={e=>setForm(f=>({...f,name:e.target.value}))} />
                    <LuxeInput label="Phone number" type="tel" required value={form.phone} accent={accent} placeholder="(555) 000-0000" onChange={e=>setForm(f=>({...f,phone:e.target.value}))} />
                    <LuxeInput label="Email address" type="email" value={form.email} accent={accent} onChange={e=>setForm(f=>({...f,email:e.target.value}))} />
                    <label style={{ display:'flex', flexDirection:'column', gap:6 }}>
                      <span style={{ fontSize:10, letterSpacing:'0.12em', textTransform:'uppercase', color:B.bluegray, fontWeight:600 }}>Your message (optional)</span>
                      <textarea rows={3} value={form.message} placeholder="Questions, timeline, or how you'd like to connect…" onChange={e=>setForm(f=>({...f,message:e.target.value}))}
                        style={{ width:'100%', padding:'12px 14px', background:B.offwhite, border:`1px solid ${B.cream}`, borderRadius:3, fontSize:14, fontFamily:'inherit', outline:'none', color:B.dark, resize:'vertical', lineHeight:1.6, transition:'border-color 200ms' }} />
                    </label>
                    {error && <div style={{ color:'#c0392b', fontSize:12, lineHeight:1.5 }}>{error}</div>}
                    <button type="submit" disabled={submitting} className="gwp-sub-btn"
                      style={{ background:B.deep, color:B.cream, padding:'15px 24px', border:'none', borderRadius:3, fontSize:12, fontWeight:600, letterSpacing:'0.1em', textTransform:'uppercase', opacity:submitting?0.65:1, marginTop:4 }}>
                      {submitting ? 'Sending…' : `${ctaText} →`}
                    </button>
                    <p style={{ fontSize:11, color:B.bluegray, textAlign:'center', letterSpacing:'0.02em' }}>Your information is strictly private.</p>
                  </form>
                </>
              )}
            </div>

            {agent && (
              <div style={{ marginTop:16, padding:'18px 22px', background:B.deep, borderRadius:2, display:'flex', alignItems:'center', gap:16 }}>
                <div style={{ width:46, height:46, borderRadius:'50%', background:agent.color||accent, color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:15, flexShrink:0 }}>
                  {agentInitials}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontWeight:600, fontSize:14, color:B.cream }}>{agent.name}</div>
                  <div style={{ fontSize:11, color:B.bluegray, marginTop:2 }}>{agent.role||'Listing Advisor'} · Gateway Advisors</div>
                </div>
                {agent.phone && (
                  <a href={`tel:${agent.phone}`} style={{ color:accent, fontSize:11, textDecoration:'none', fontWeight:600, padding:'7px 14px', border:`1px solid ${accent}55`, borderRadius:99, whiteSpace:'nowrap' }}>Call</a>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer style={{ borderTop:`1px solid ${B.cream}`, padding:'28px 40px 52px', textAlign:'center', background:B.white }}>
        <div style={{ fontFamily:`'Cormorant Garamond', Georgia, serif`, fontSize:16, color:B.deep, marginBottom:10, letterSpacing:'-0.01em' }}>Gateway Real Estate Advisors</div>
        <div style={{ fontSize:11, color:B.bluegray, letterSpacing:'0.05em', lineHeight:1.9 }}>
          Licensed in Iowa · South Dakota · Nebraska<br />
          <em>This page is confidential and intended for recipients of our private correspondence.</em>
        </div>
      </footer>

    </div>
  )
}
