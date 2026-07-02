/**
 * Home Valuation Landing — DARK (legacy) variant.
 *
 * This is the original dark design, kept byte-for-byte in visual behavior.
 * It only renders for mailings created before the light redesign shipped —
 * migration 0018 stamped every pre-existing valuation mailing with
 * landing_config.theme:"dark" so nothing already live changes appearance.
 * New valuation campaigns get LandingValuationLight instead. See the
 * dispatcher in LandingValuation.jsx.
 *
 * Data now arrives as props (cfg/agents/mailingId) instead of fetching here —
 * the dispatcher already loaded the mailing once.
 */
import React, { useMemo, useState } from 'react'
import AdvisorDark from '../components/landing/AdvisorDark.jsx'

const PROPERTY_TYPES = [
  { value:'single-family',  label:'Single-Family Home'       },
  { value:'condo',          label:'Condo / Townhome'         },
  { value:'multifamily',    label:'Multifamily (2–4 units)'  },
  { value:'multifamily-5',  label:'Apartment Bldg (5+ units)'},
  { value:'commercial',     label:'Commercial Property'      },
  { value:'land',           label:'Land / Lot'               },
  { value:'other',          label:'Other'                    },
]

const DEFAULT_HIGHLIGHTS = [
  { label:'Homeowners served',  value:'120+' },
  { label:'Avg days to close',  value:'18'   },
  { label:'Neighborhoods',      value:'12'   },
]

function useMosaicLayout(n) {
  return useMemo(() => {
    const L = {
      1: { cols:1, rows:1, areas:[['a','a'],['a','a']] },
      2: { cols:2, rows:2, areas:[['a','b'],['a','b']] },
      3: { cols:3, rows:2, areas:[['a','a','b'],['a','a','c']] },
      4: { cols:3, rows:2, areas:[['a','a','b'],['c','d','b']] },
      5: { cols:4, rows:2, areas:[['a','a','b','c'],['a','a','d','e']] },
      6: { cols:4, rows:3, areas:[['a','a','b','c'],['a','a','d','e'],['f','f','d','e']] },
    }[Math.min(n, 6)] || {cols:1,rows:1,areas:[['a','a'],['a','a']]}
    const unique = [...new Set(L.areas.flat())]
    return {
      gridStyle:{
        gridTemplateColumns:`repeat(${L.cols},1fr)`,
        gridTemplateAreas:L.areas.map(r=>`"${r.join(' ')}"`).join(' '),
      },
      cells: unique.map(letter => ({ gridArea:letter, minHeight: n===1?280:n<=2?200:130 })),
    }
  }, [n])
}

export default function LandingValuationDark({ cfg, agents, mailingId }) {
  const agent = agents?.[0] || null
  const [submitted,  setSubmitted]  = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState(null)
  const [form, setForm] = useState({
    property_address:'', property_type:'single-family', name:'', phone:'', email:'', message:'',
  })

  const accent     = cfg.accent      || '#c9a961'
  const headline   = cfg.headline    || "What's your home worth today?"
  const subhead    = cfg.subheadline || "Get a private, no-obligation valuation from a licensed broker who actually knows your neighborhood — not a software estimate."
  const ctaText    = cfg.cta_text    || 'Get my free valuation'
  const rawImages  = Array.isArray(cfg.images) ? cfg.images : []
  const images     = rawImages
    .map(v => typeof v === 'string' ? {url:v, units:'', price:''} : v)
    .filter(v => v?.url)
  const highlights = Array.isArray(cfg.highlights) && cfg.highlights.length > 0
    ? cfg.highlights.slice(0, 4)
    : DEFAULT_HIGHLIGHTS

  const mosaic = useMosaicLayout(images.length)

  const submit = async (e) => {
    e.preventDefault()
    if (!form.property_address.trim()) { setError('Please enter the property address'); return }
    if (!form.name.trim())             { setError('Please enter your name'); return }
    if (!form.phone.trim())            { setError('Please enter a phone number'); return }
    setError(null); setSubmitting(true)
    const res = await fetch('/api/campaigns', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'capture_lead', mailing_id:mailingId, source_landing:'valuation', ...form }),
    })
    const data = await res.json()
    setSubmitting(false)
    if (!res.ok || data.error) { setError(data.error || 'Could not submit — please try again'); return }
    setSubmitted(true)
  }

  return (
    <div className="val-page" style={pageSt}>
      {/* Header */}
      <header style={{ padding:'18px 24px', maxWidth:1180, margin:'0 auto',
                       display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:20, color:'#f3f0e6' }}>
          Gateway <span style={{ color:accent }}>Real Estate Advisors</span>
        </div>
        {agent?.phone && (
          <a href={`tel:${agent.phone}`}
             style={{ color:'#f3f0e6', textDecoration:'none', fontSize:13, opacity:0.85 }}>
            <span style={{ color:accent, marginRight:6 }}>●</span>{agent.phone}
          </a>
        )}
      </header>

      {/* Hero */}
      <section style={{ maxWidth:1180, margin:'0 auto', padding:'16px 24px 56px' }}>
        <div style={{ display:'grid', gridTemplateColumns:'minmax(0,1.05fr) minmax(0,0.95fr)', gap:48, alignItems:'start' }}
             className="val-hero-grid">

          {/* Left */}
          <div>
            <div style={{ display:'inline-block', fontSize:11, letterSpacing:2, textTransform:'uppercase',
                          color:accent, padding:'4px 10px', border:`1px solid ${accent}55`, borderRadius:99 }}>
              Home · Valuation
            </div>
            <h1 style={{ fontFamily:'Cormorant Garamond, serif',
                         fontSize:'clamp(36px,5.2vw,62px)', fontWeight:500, lineHeight:1.06,
                         margin:'16px 0 14px', color:'#f3f0e6', letterSpacing:'-0.01em' }}>
              {headline}
            </h1>
            <p style={{ fontSize:17, lineHeight:1.55, color:'#bdbcb4', maxWidth:540, margin:0 }}>
              {subhead}
            </p>

            {/* Image collage */}
            {images.length > 0 && (
              <div style={{ marginTop:32, display:'grid', gap:6, ...mosaic.gridStyle }}>
                {images.map((img, i) => (
                  <div key={i} style={{
                    ...mosaic.cells[i],
                    backgroundImage:`url(${img.url})`, backgroundSize:'cover', backgroundPosition:'center',
                    borderRadius:6, overflow:'hidden', boxShadow:'0 8px 24px rgba(0,0,0,0.35)',
                    position:'relative',
                  }}>
                    {(img.units || img.price) && (
                      <div style={{ position:'absolute', bottom:0, left:0, right:0,
                                    background:'linear-gradient(transparent, rgba(0,0,0,0.6))',
                                    padding:'20px 10px 8px', color:'#fff' }}>
                        {img.units && <div style={{ fontSize:11, fontWeight:600 }}>{img.units}</div>}
                        {img.price && <div style={{ fontSize:13, fontWeight:700, color:accent }}>{img.price}</div>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Highlights — minmax(0,1fr) prevents overflow; 2-up on phones. */}
            <div className="val-highlights"
                 style={{ marginTop:36, display:'grid', gridTemplateColumns:`repeat(${highlights.length}, minmax(0, 1fr))`,
                          gap:24, padding:'24px 0',
                          borderTop:'1px solid #2a2a2a', borderBottom:'1px solid #2a2a2a' }}>
              {highlights.map((h, i) => (
                <div key={i} style={{ minWidth:0 }}>
                  <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:'clamp(22px, 4vw, 30px)', fontWeight:600,
                                color:'#f3f0e6', lineHeight:1.05 }}>
                    {h.value}
                  </div>
                  <div style={{ fontSize:11, textTransform:'uppercase', letterSpacing:1.2, color:'#8c8c84', marginTop:6, lineHeight:1.3 }}>
                    {h.label}
                  </div>
                </div>
              ))}
            </div>

            {/* Trust items */}
            <ul style={{ listStyle:'none', padding:0, margin:'24px 0 0', display:'grid', gap:10, color:'#d6d4c8', fontSize:14 }}>
              {[
                'Valuation based on real comps — not automated estimates.',
                "Confidential. We won't share your property without your permission.",
                'Response within one business day, guaranteed.',
              ].map((line, i) => (
                <li key={i} style={{ display:'flex', gap:10, lineHeight:1.5 }}>
                  <span style={{ color:accent, flexShrink:0, marginTop:2 }}>✓</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Right — form */}
          <div style={{ position:'sticky', top:24 }}>
            <div style={{ background:'#1a1a1a', border:'1px solid #2f2f2f', borderRadius:12,
                          padding:28, boxShadow:'0 24px 64px rgba(0,0,0,0.45)' }}>
              {submitted ? (
                <div style={{ textAlign:'center', padding:'18px 0' }}>
                  <div style={{ width:56, height:56, borderRadius:'50%', background:`${accent}22`, color:accent,
                                display:'flex', alignItems:'center', justifyContent:'center',
                                margin:'0 auto', fontSize:28 }}>✓</div>
                  <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:28, color:'#f3f0e6', margin:'14px 0 8px' }}>
                    Got it — we're on it.
                  </h2>
                  <p style={{ color:'#bdbcb4', fontSize:14, lineHeight:1.6 }}>
                    We're pulling recent comps in your area now.
                    {agent && <><br /><br /><span style={{ color:'#f3f0e6' }}>{agent.name}</span> will reach out within one business day.</>}
                  </p>
                </div>
              ) : (
                <>
                  <div style={{ fontSize:11, textTransform:'uppercase', letterSpacing:1.5, color:accent, marginBottom:6 }}>
                    Free · Private · No obligation
                  </div>
                  <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:26, color:'#f3f0e6',
                               margin:'0 0 4px', fontWeight:500 }}>
                    Request your valuation
                  </h2>
                  <p style={{ fontSize:13, color:'#8c8c84', margin:'0 0 18px' }}>
                    Takes 30 seconds. Reply in one business day.
                  </p>
                  <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:11 }}>
                    {[
                      { key:'property_address', label:'Property address *', type:'text', ph:'123 Main St, Springfield', req:true },
                    ].map(f => (
                      <Field key={f.key} label={f.label} accent={accent}>
                        <input required={f.req} type={f.type || 'text'} value={form[f.key]}
                               placeholder={f.ph} style={inpDark}
                               onChange={e => setForm(p => ({...p, [f.key]: e.target.value}))} />
                      </Field>
                    ))}

                    <Field label="Property type" accent={accent}>
                      <select value={form.property_type}
                              onChange={e => setForm(p => ({...p, property_type:e.target.value}))}
                              style={{ ...inpDark, appearance:'none',
                                backgroundImage:`url("data:image/svg+xml;utf8,<svg fill='%23bdbcb4' xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M7 10l5 5 5-5z'/></svg>")`,
                                backgroundRepeat:'no-repeat', backgroundPosition:'right 8px center', paddingRight:32 }}>
                        {PROPERTY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                    </Field>

                    <Field label="Your name *" accent={accent}>
                      <input required value={form.name} autoComplete="name" style={inpDark}
                             onChange={e => setForm(p => ({...p, name:e.target.value}))} />
                    </Field>

                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                      <Field label="Phone *" accent={accent}>
                        <input required type="tel" value={form.phone} placeholder="(555) 555-5555"
                               style={inpDark} onChange={e => setForm(p => ({...p, phone:e.target.value}))} />
                      </Field>
                      <Field label="Email (optional)" accent={accent}>
                        <input type="email" value={form.email} style={inpDark}
                               onChange={e => setForm(p => ({...p, email:e.target.value}))} />
                      </Field>
                    </div>

                    <Field label="Anything we should know? (optional)" accent={accent}>
                      <textarea rows={2} value={form.message}
                                placeholder="Renovations, timeline, reason for selling, etc."
                                style={{ ...inpDark, resize:'vertical', fontFamily:'inherit' }}
                                onChange={e => setForm(p => ({...p, message:e.target.value}))} />
                    </Field>

                    {error && (
                      <div style={{ color:'#e57373', fontSize:12, background:'#3a1f1f',
                                    padding:'8px 10px', borderRadius:4 }}>
                        {error}
                      </div>
                    )}

                    <button type="submit" disabled={submitting}
                            style={{ background:accent, color:'#1a1a1a', padding:'14px 16px', border:'none',
                                     borderRadius:6, fontSize:15, fontWeight:700, letterSpacing:0.3,
                                     cursor:'pointer', marginTop:4, opacity: submitting ? 0.6 : 1 }}>
                      {submitting ? 'Sending…' : ctaText + ' →'}
                    </button>
                    <p style={{ fontSize:11, color:'#8c8c84', textAlign:'center', margin:'4px 0 0', lineHeight:1.5 }}>
                      Your information is private. We don't sell data.
                    </p>
                  </form>
                </>
              )}
            </div>

            {agent && (
              <div style={{ marginTop:16, padding:'14px 18px', background:'#141414',
                            border:'1px solid #262626', borderRadius:10,
                            display:'flex', alignItems:'center', gap:14 }}>
                <div style={{ width:44, height:44, borderRadius:'50%', background: agent.color || accent,
                              display:'flex', alignItems:'center', justifyContent:'center',
                              fontWeight:700, color:'#1a1a1a', fontSize:16 }}>
                  {(agent.name || '?').split(/\s+/).map(w => w[0]).slice(0,2).join('').toUpperCase()}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color:'#f3f0e6', fontSize:14, fontWeight:600 }}>{agent.name}</div>
                  <div style={{ color:'#8c8c84', fontSize:11.5 }}>
                    {agent.role || 'Residential Advisor'} · Gateway Real Estate
                  </div>
                </div>
                {agent.phone && (
                  <a href={`tel:${agent.phone}`}
                     style={{ color:accent, fontSize:12, textDecoration:'none',
                              padding:'6px 10px', border:`1px solid ${accent}55`, borderRadius:99 }}>
                    Call
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Meet your advisor(s) — below the form so visitors read, request a
          valuation, then scroll to learn who they'll be working with. */}
      <AdvisorDark agents={agents} accent={accent} />

      <footer style={{ borderTop:'1px solid #1f1f1f', padding:'20px 24px 40px',
                       textAlign:'center', fontSize:12, color:'#6c6c66' }}>
        Gateway Real Estate Advisors · Licensed Brokerage · This valuation is an opinion of value, not an appraisal.
      </footer>

      <style>{`
        /* Kill horizontal overflow + the cream body bleed behind the dark page. */
        html, body { margin: 0; background: #0a0a0a; }
        #root { overflow-x: hidden; }
        .val-page, .val-page * { box-sizing: border-box; }
        @media (max-width: 880px) { .val-hero-grid { grid-template-columns: 1fr !important; gap: 28px !important; } }
        @media (max-width: 560px) { .val-highlights { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 18px !important; } }
        input::placeholder, textarea::placeholder { color: #6c6c66; }
        input:focus, textarea:focus, select:focus { outline:none; border-color: ${accent} !important; }
      `}</style>
    </div>
  )
}

function Field({ label, children, accent }) {
  return (
    <label style={{ display:'flex', flexDirection:'column', gap:5 }}>
      <span style={{ fontSize:11, textTransform:'uppercase', letterSpacing:0.8, color:'#a8a8a8', fontWeight:600 }}>
        {label}
      </span>
      {children}
    </label>
  )
}

const pageSt = {
  minHeight:'100vh',
  width:'100%',
  overflowX:'hidden',
  background:'radial-gradient(1200px 600px at 20% -10%, #1a1f2e 0%, #0f0f0f 55%, #0a0a0a 100%)',
  color:'#f3f0e6',
  fontFamily:'DM Sans, system-ui, sans-serif',
}

const inpDark = {
  width:'100%', boxSizing:'border-box', padding:'10px 12px',
  background:'#0f0f0f', border:'1px solid #2a2a2a', borderRadius:5,
  color:'#f3f0e6', fontSize:14, fontFamily:'inherit', outline:'none', transition:'border-color 150ms',
}
