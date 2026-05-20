/**
 * Multifamily Valuation Landing — public-facing, premium dark page for "what's
 * your multifamily worth?" mailers. Used when a property doesn't have a clean
 * record in /properties OR for general lead-gen at the asset class level.
 *
 * URL: /lp/multifamily/:mailingId
 *
 * Renders from mailings.landing_config:
 *   {
 *     headline:    "What's your multifamily really worth?",
 *     subheadline: "Get a real cap-rate-driven valuation from a broker who closes deals in your submarket.",
 *     images:      ["url1","url2",...],     // up to 6, rendered as a mosaic
 *     highlights:  [{label:"Avg Cap Rate", value:"6.1%"}, ...],
 *     cta_text:    "Get my free valuation",
 *     accent:      "#c9a961"                 // optional gold/brand accent
 *   }
 *
 * Required form fields: name, phone, property address.
 */

import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const UNIT_RANGES = [
  { value: '2-4',     label: '2–4 units' },
  { value: '5-20',    label: '5–20 units' },
  { value: '21-50',   label: '21–50 units' },
  { value: '51-100',  label: '51–100 units' },
  { value: '100+',    label: '100+ units' },
  { value: 'unknown', label: 'Not sure yet' },
]

const DEFAULT_HIGHLIGHTS = [
  { label: 'Closed deals',  value: '$240M+' },
  { label: 'Avg sale time', value: '38 days' },
  { label: 'Submarkets',    value: '14' },
]

export default function LandingMultifamily({ mailingId }) {
  const [mailing,    setMailing]    = useState(null)
  const [agent,      setAgent]      = useState(null)
  const [loading,    setLoading]    = useState(true)
  const [submitted,  setSubmitted]  = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState(null)

  const [form, setForm] = useState({
    name:             '',
    phone:            '',
    email:            '',
    property_address: '',
    units:            '5-20',
    message:          '',
  })

  useEffect(() => {
    (async () => {
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

  const cfg = mailing?.landing_config || {}
  const headline    = cfg.headline    || "What's your multifamily really worth?"
  const subheadline = cfg.subheadline || "Get a private, cap-rate-driven valuation from a broker who actually closes deals in your submarket — not a software guess."
  const ctaText     = cfg.cta_text    || 'Get my free valuation'
  const accent      = cfg.accent      || '#c9a961'
  const images      = Array.isArray(cfg.images) ? cfg.images.filter(Boolean).slice(0, 6) : []
  const highlights  = Array.isArray(cfg.highlights) && cfg.highlights.length > 0
    ? cfg.highlights.slice(0, 4)
    : DEFAULT_HIGHLIGHTS

  // Hook must run on every render — call before any early returns
  const mosaic = useMosaicLayout(images.length)

  const submit = async (e) => {
    e.preventDefault()
    if (!form.name.trim())              { setError('Please enter your name'); return }
    if (!form.phone.trim())             { setError('Please enter a phone number so we can reach you'); return }
    if (!form.property_address.trim())  { setError('Please enter the property address'); return }
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
      message: form.units && form.units !== 'unknown' ? `Size: ${form.units} units. ${form.message}`.trim() : form.message,
    }
    const res = await fetch('/api/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    setSubmitting(false)
    if (!res.ok || data.error) { setError(data.error || 'Could not submit — please try again'); return }
    setSubmitted(true)
  }

  if (loading) return (
    <div style={{ ...pageStyle, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ color:'#a8a8a8', fontSize:14 }}>Loading…</div>
    </div>
  )
  if (error && !mailing) return (
    <div style={{ ...pageStyle, padding:60, textAlign:'center' }}>
      <div style={{ fontSize:18, fontFamily:'Cormorant Garamond, serif', color:'#f3f0e6' }}>Gateway Real Estate</div>
      <div style={{ marginTop:8, color:'#e57373' }}>{error}</div>
    </div>
  )

  return (
    <div style={pageStyle}>
      {/* Top bar */}
      <header style={{ padding:'18px 24px', maxWidth:1180, margin:'0 auto', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:20, color:'#f3f0e6' }}>
          Gateway <span style={{ color: accent }}>Real Estate Advisors</span>
        </div>
        {agent?.phone && (
          <a href={`tel:${agent.phone}`} style={{ color:'#f3f0e6', textDecoration:'none', fontSize:13, opacity:0.85 }}>
            <span style={{ color: accent, marginRight:6 }}>●</span> {agent.phone}
          </a>
        )}
      </header>

      {/* Hero */}
      <section style={{ maxWidth:1180, margin:'0 auto', padding:'24px 24px 48px' }}>
        <div style={{ display:'grid', gridTemplateColumns:'minmax(0, 1.05fr) minmax(0, 0.95fr)', gap:48, alignItems:'start' }}
             className="mf-hero-grid">
          {/* Left — headline + collage + highlights */}
          <div>
            <div style={{ display:'inline-block', fontSize:11, letterSpacing:2, textTransform:'uppercase',
                          color:accent, padding:'4px 10px', border:`1px solid ${accent}55`, borderRadius:99 }}>
              Multifamily · Valuation
            </div>
            <h1 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:'clamp(38px, 5.4vw, 64px)',
                         fontWeight:500, lineHeight:1.05, margin:'18px 0 14px', color:'#f3f0e6', letterSpacing:'-0.01em' }}>
              {headline}
            </h1>
            <p style={{ fontSize:17, lineHeight:1.55, color:'#bdbcb4', maxWidth:540, margin:0 }}>
              {subheadline}
            </p>

            {/* Collage */}
            {images.length > 0 && (
              <div style={{ marginTop:32, display:'grid', gap:6, ...mosaic.gridStyle }}>
                {images.map((src, i) => (
                  <div key={i} style={{
                    ...mosaic.cells[i],
                    backgroundImage: `url(${src})`, backgroundSize:'cover', backgroundPosition:'center',
                    borderRadius:6, overflow:'hidden',
                    boxShadow:'0 8px 24px rgba(0,0,0,0.35)',
                  }} />
                ))}
              </div>
            )}

            {/* Highlights strip */}
            <div style={{ marginTop:36, display:'grid', gridTemplateColumns:`repeat(${highlights.length}, 1fr)`, gap:24,
                          padding:'24px 0', borderTop:'1px solid #2a2a2a', borderBottom:'1px solid #2a2a2a' }}>
              {highlights.map((h, i) => (
                <div key={i}>
                  <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:30, fontWeight:600, color:'#f3f0e6', lineHeight:1 }}>
                    {h.value || '—'}
                  </div>
                  <div style={{ fontSize:11, textTransform:'uppercase', letterSpacing:1.2, color:'#8c8c84', marginTop:6 }}>
                    {h.label}
                  </div>
                </div>
              ))}
            </div>

            {/* Trust band */}
            <ul style={{ listStyle:'none', padding:0, margin:'24px 0 0', display:'grid', gap:10, color:'#d6d4c8', fontSize:14 }}>
              {[
                'Cap-rate analysis pulled from active comps — not Zillow estimates.',
                "Confidential. We won't list, market, or share your property without your green light.",
                'Reply in one business day, or your time back. We mean it.',
              ].map((line, i) => (
                <li key={i} style={{ display:'flex', gap:10, lineHeight:1.5 }}>
                  <span style={{ color: accent, flexShrink:0, marginTop:2 }}>✓</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Right — form card */}
          <div style={{ position:'sticky', top:24 }}>
            <div style={{
              background:'#1a1a1a',
              border:`1px solid #2f2f2f`,
              borderRadius:12,
              padding:28,
              boxShadow:'0 24px 64px rgba(0,0,0,0.45)',
            }}>
              {submitted ? (
                <div style={{ textAlign:'center', padding:'18px 0' }}>
                  <div style={{ width:56, height:56, borderRadius:'50%', background:`${accent}22`, color:accent,
                                display:'flex', alignItems:'center', justifyContent:'center', margin:'0 auto', fontSize:28 }}>✓</div>
                  <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:28, color:'#f3f0e6', margin:'14px 0 8px' }}>
                    Got it — we're on it.
                  </h2>
                  <p style={{ color:'#bdbcb4', fontSize:14, lineHeight:1.6 }}>
                    We're pulling cap-rate comps and recent sales in your submarket now.
                    {agent && <><br /><br /><span style={{ color:'#f3f0e6' }}>{agent.name}</span> will reach out within one business day.</>}
                  </p>
                </div>
              ) : (
                <>
                  <div style={{ fontSize:11, textTransform:'uppercase', letterSpacing:1.5, color:accent, marginBottom:6 }}>
                    Free · Private · No obligation
                  </div>
                  <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:26, color:'#f3f0e6', margin:'0 0 4px', fontWeight:500 }}>
                    Request your valuation
                  </h2>
                  <p style={{ fontSize:13, color:'#8c8c84', margin:'0 0 18px' }}>
                    Takes 30 seconds. Reply in one business day.
                  </p>

                  <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:11 }}>
                    <FieldDark label="Your name *" required>
                      <input required autoComplete="name" value={form.name}
                             onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                             style={inputDark} />
                    </FieldDark>
                    <FieldDark label="Phone number *" required>
                      <input required type="tel" autoComplete="tel" placeholder="(555) 555-5555" value={form.phone}
                             onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                             style={inputDark} />
                    </FieldDark>
                    <FieldDark label="Email (optional)">
                      <input type="email" autoComplete="email" value={form.email}
                             onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                             style={inputDark} />
                    </FieldDark>
                    <FieldDark label="Property address *" required>
                      <input required placeholder="123 Oak Ave, City, ST" value={form.property_address}
                             onChange={e => setForm(f => ({ ...f, property_address: e.target.value }))}
                             style={inputDark} />
                    </FieldDark>
                    <FieldDark label="How many units?">
                      <select value={form.units} onChange={e => setForm(f => ({ ...f, units: e.target.value }))}
                              style={{ ...inputDark, appearance:'none', paddingRight:32,
                                       backgroundImage:`url("data:image/svg+xml;utf8,<svg fill='%23bdbcb4' xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='M7 10l5 5 5-5z'/></svg>")`,
                                       backgroundRepeat:'no-repeat', backgroundPosition:'right 8px center' }}>
                        {UNIT_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </FieldDark>
                    <FieldDark label="Anything we should know? (optional)">
                      <textarea rows={2} value={form.message}
                                onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                                placeholder="Recent renovations, T12, considering 1031, etc."
                                style={{ ...inputDark, resize:'vertical', fontFamily:'inherit' }} />
                    </FieldDark>

                    {error && (
                      <div style={{ color:'#e57373', fontSize:12, background:'#3a1f1f', padding:'8px 10px', borderRadius:4 }}>
                        {error}
                      </div>
                    )}

                    <button type="submit" disabled={submitting}
                            style={{ background:accent, color:'#1a1a1a', padding:'14px 16px', border:'none',
                                     borderRadius:6, fontSize:15, fontWeight:700, letterSpacing:0.3, cursor:'pointer',
                                     marginTop:6, opacity: submitting ? 0.6 : 1 }}>
                      {submitting ? 'Sending…' : ctaText} →
                    </button>

                    <p style={{ fontSize:11, color:'#8c8c84', textAlign:'center', margin:'4px 0 0', lineHeight:1.5 }}>
                      Your information stays private. We don't sell data or send junk mail — just your valuation.
                    </p>
                  </form>
                </>
              )}
            </div>

            {/* Agent badge */}
            {agent && (
              <div style={{ marginTop:16, padding:'14px 18px', background:'#141414', border:'1px solid #262626',
                            borderRadius:10, display:'flex', alignItems:'center', gap:14 }}>
                <div style={{ width:44, height:44, borderRadius:'50%',
                              background: agent.color || accent,
                              display:'flex', alignItems:'center', justifyContent:'center',
                              fontWeight:700, color:'#1a1a1a', fontSize:16 }}>
                  {(agent.name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ color:'#f3f0e6', fontSize:14, fontWeight:600 }}>{agent.name}</div>
                  <div style={{ color:'#8c8c84', fontSize:11.5 }}>{agent.role || 'Commercial Advisor'} · Gateway Real Estate</div>
                </div>
                {agent.phone && (
                  <a href={`tel:${agent.phone}`} style={{ color: accent, fontSize:12, textDecoration:'none',
                                                          padding:'6px 10px', border:`1px solid ${accent}55`, borderRadius:99 }}>
                    Call
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <footer style={{ borderTop:'1px solid #1f1f1f', padding:'20px 24px 40px', textAlign:'center', fontSize:12, color:'#6c6c66' }}>
        Gateway Real Estate Advisors · Licensed Brokerage · This valuation is an opinion of value, not an appraisal.
      </footer>

      <style>{`
        @media (max-width: 880px) {
          .mf-hero-grid { grid-template-columns: 1fr !important; gap: 28px !important; }
        }
        input::placeholder, textarea::placeholder { color: #6c6c66; }
        input:focus, textarea:focus, select:focus { outline: none; border-color: ${accent} !important; }
      `}</style>
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function FieldDark({ label, children }) {
  return (
    <label style={{ display:'flex', flexDirection:'column', gap:5 }}>
      <span style={{ fontSize:11, textTransform:'uppercase', letterSpacing:0.8, color:'#a8a8a8', fontWeight:600 }}>
        {label}
      </span>
      {children}
    </label>
  )
}

/**
 * Returns a grid layout for 1–6 images that looks like a real magazine collage,
 * not a uniform thumb strip. Uses CSS grid-area placement.
 */
function useMosaicLayout(n) {
  return useMemo(() => {
    const layouts = {
      1: { cols: 1, rows: 1, areas: [['a a','a a']] },
      2: { cols: 2, rows: 2, areas: [['a','b'],['a','b']] },
      3: { cols: 3, rows: 2, areas: [['a','a','b'],['a','a','c']] },
      4: { cols: 3, rows: 2, areas: [['a','a','b'],['c','d','b']] },
      5: { cols: 4, rows: 2, areas: [['a','a','b','c'],['a','a','d','e']] },
      6: { cols: 4, rows: 2, areas: [['a','a','b','c'],['a','a','d','e'],['f','f','d','e']] },
    }
    const L = layouts[n] || layouts[1]
    const flat = L.areas.flat()
    const unique = [...new Set(flat)]
    const cells = unique.map(letter => ({ gridArea: letter, minHeight: n === 1 ? 280 : (n === 2 ? 200 : 130) }))
    return {
      gridStyle: {
        gridTemplateColumns: `repeat(${L.cols}, 1fr)`,
        gridTemplateAreas: L.areas.map(r => `"${r.join(' ')}"`).join(' '),
      },
      cells,
    }
  }, [n])
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const pageStyle = {
  minHeight: '100vh',
  background: 'radial-gradient(1200px 600px at 20% -10%, #1a1f2e 0%, #0f0f0f 55%, #0a0a0a 100%)',
  color: '#f3f0e6',
  fontFamily: 'DM Sans, system-ui, sans-serif',
}

const inputDark = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 12px',
  background: '#0f0f0f',
  border: '1px solid #2a2a2a',
  borderRadius: 5,
  color: '#f3f0e6',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
  transition: 'border-color 150ms',
}

