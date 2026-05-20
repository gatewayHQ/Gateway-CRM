/**
 * Property Showcase Landing — public-facing, served when a QR scan lands here.
 *
 * URL: /lp/property/:mailingId
 * Mounted directly from main.jsx (bypasses auth shell).
 *
 * Renders:
 *   • Hero photo + property details (address, beds/baths/sqft/price)
 *   • Soft lead-capture form (name OPTIONAL, contact info OPTIONAL)
 *   • CTAs to view full listing or contact the agent
 */

import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const TYPE_LABEL = {
  residential: 'Home for Sale',  rental: 'Rental',     multifamily: 'Multifamily Investment',
  office: 'Office Space',        land: 'Land',         retail: 'Retail Property',
  industrial: 'Industrial',      'mixed-use': 'Mixed-Use', commercial: 'Commercial',
}

export default function LandingProperty({ mailingId }) {
  const [mailing,  setMailing]  = useState(null)
  const [property, setProperty] = useState(null)
  const [agent,    setAgent]    = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error,    setError]    = useState(null)

  const [form, setForm] = useState({ name:'', email:'', phone:'', message:'' })

  useEffect(() => {
    (async () => {
      // Public reads via anon key
      const { data: m } = await supabase.from('mailings').select('id, name, property_id, agent_id').eq('id', mailingId).single()
      if (!m) { setError('Mailing not found'); setLoading(false); return }
      setMailing(m)
      if (m.property_id) {
        const { data: p } = await supabase.from('properties')
          .select('id, address, city, state, zip, type, status, list_price, beds, baths, sqft, details, notes')
          .eq('id', m.property_id).single()
        setProperty(p || null)
      }
      if (m.agent_id) {
        const { data: a } = await supabase.from('agents').select('id, name, phone, email, photo_url, color').eq('id', m.agent_id).single()
        setAgent(a || null)
      }
      setLoading(false)
    })()
  }, [mailingId])

  const submit = async (e) => {
    e.preventDefault()
    if (!form.name.trim() && !form.email.trim() && !form.phone.trim()) {
      setError('Please share at least your name, email, or phone so we can follow up.')
      return
    }
    setError(null)
    setSubmitting(true)
    const res = await fetch('/api/campaigns', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ action:'capture_lead', mailing_id: mailingId, source_landing:'property', ...form }),
    })
    const data = await res.json()
    setSubmitting(false)
    if (!res.ok || data.error) { setError(data.error || 'Could not submit — please try again'); return }
    setSubmitted(true)
  }

  if (loading) return <div style={{ padding:60, textAlign:'center', fontFamily:'DM Sans, sans-serif', color:'#9aa3b2' }}>Loading…</div>
  if (error && !mailing) return (
    <div style={{ padding:60, textAlign:'center', fontFamily:'DM Sans, sans-serif' }}>
      <div style={{ fontSize:18, fontFamily:'Cormorant Garamond, serif', color:'#1e2642' }}>Gateway Real Estate</div>
      <div style={{ marginTop:8, color:'#c0392b' }}>{error}</div>
    </div>
  )

  const photos    = property?.details?.photos || []
  const hero      = photos[0] || null
  const title     = property ? [property.address, property.city, property.state].filter(Boolean).join(', ') : (mailing?.name || '')
  const subtitle  = property?.type ? TYPE_LABEL[property.type] || property.type : ''
  const priceText = property?.list_price ? `$${Number(property.list_price).toLocaleString()}` : null

  return (
    <div style={{ minHeight:'100vh', fontFamily:'DM Sans, sans-serif', background:'#fafaf7', color:'#1e2642' }}>
      {/* Hero */}
      <div style={{
        background: hero ? `linear-gradient(rgba(30,38,66,0.35), rgba(30,38,66,0.65)), url(${hero})` : 'linear-gradient(135deg, #1e2642, #2c3a5e)',
        backgroundSize:'cover', backgroundPosition:'center',
        color:'#fff', padding:'80px 24px 64px',
      }}>
        <div style={{ maxWidth:880, margin:'0 auto' }}>
          <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:22, opacity:0.85, marginBottom:8 }}>Gateway Real Estate Advisors</div>
          {subtitle && <div style={{ fontSize:13, letterSpacing:1.5, textTransform:'uppercase', opacity:0.8 }}>{subtitle}</div>}
          <h1 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:48, fontWeight:600, margin:'8px 0 12px', lineHeight:1.1 }}>{title}</h1>
          {priceText && <div style={{ fontSize:28, fontWeight:600 }}>{priceText}</div>}
          {property && (
            <div style={{ marginTop:16, display:'flex', gap:24, fontSize:14, flexWrap:'wrap', opacity:0.95 }}>
              {property.beds  ? <span><strong>{property.beds}</strong> bd</span>  : null}
              {property.baths ? <span><strong>{property.baths}</strong> ba</span> : null}
              {property.sqft  ? <span><strong>{Number(property.sqft).toLocaleString()}</strong> sqft</span> : null}
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth:880, margin:'-40px auto 0', padding:'0 24px 80px' }}>
        <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', gap:32 }}>
          {/* Left: details + photos */}
          <div style={{ background:'#fff', borderRadius:12, padding:28, boxShadow:'0 8px 32px rgba(30,38,66,0.08)' }}>
            {property?.notes && (
              <>
                <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:24, fontWeight:600, marginTop:0 }}>About this property</h2>
                <p style={{ lineHeight:1.7, color:'#4a5263' }}>{property.notes}</p>
              </>
            )}

            {photos.length > 1 && (
              <div style={{ marginTop:24 }}>
                <h3 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:18, fontWeight:600 }}>Gallery</h3>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(150px, 1fr))', gap:8, marginTop:12 }}>
                  {photos.slice(1, 9).map((p, i) => (
                    <img key={i} src={p} alt="" style={{ width:'100%', aspectRatio:'4/3', objectFit:'cover', borderRadius:6 }} />
                  ))}
                </div>
              </div>
            )}

            {property && (
              <div style={{ marginTop:24, display:'flex', gap:10, flexWrap:'wrap' }}>
                <a href={`/listing/${property.id}`}
                   style={{ background:'#1e2642', color:'#fff', padding:'10px 20px', borderRadius:6, textDecoration:'none', fontSize:14, fontWeight:600 }}>
                  View Full Listing →
                </a>
              </div>
            )}
          </div>

          {/* Right: lead capture */}
          <div style={{ background:'#fff', borderRadius:12, padding:28, boxShadow:'0 8px 32px rgba(30,38,66,0.08)', alignSelf:'start', position:'sticky', top:24 }}>
            {submitted ? (
              <div style={{ textAlign:'center', padding:'20px 0' }}>
                <div style={{ fontSize:48, marginBottom:8 }}>✓</div>
                <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:24, margin:0 }}>Thank you!</h2>
                <p style={{ color:'#4a5263' }}>We'll be in touch shortly.</p>
              </div>
            ) : (
              <>
                <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:22, fontWeight:600, marginTop:0 }}>Want to know more?</h2>
                <p style={{ fontSize:13, color:'#9aa3b2', margin:'4px 0 16px' }}>
                  Share what's most convenient — name only, phone, or email. No spam.
                </p>
                <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:10 }}>
                  <input className="input" placeholder="Your name (optional)"
                         value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                         style={inputStyle} />
                  <input className="input" type="email" placeholder="Email (optional)"
                         value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                         style={inputStyle} />
                  <input className="input" type="tel" placeholder="Phone (optional)"
                         value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                         style={inputStyle} />
                  <textarea placeholder="Anything specific you'd like to know? (optional)"
                            rows={3} value={form.message} onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                            style={{ ...inputStyle, resize:'vertical', fontFamily:'inherit' }} />
                  {error && <div style={{ color:'#c0392b', fontSize:12 }}>{error}</div>}
                  <button type="submit" disabled={submitting}
                          style={{ background:'#1e2642', color:'#fff', padding:'12px', border:'none', borderRadius:6,
                                   fontSize:14, fontWeight:600, cursor:'pointer', marginTop:4 }}>
                    {submitting ? 'Sending…' : 'Get more info'}
                  </button>
                </form>
              </>
            )}

            {agent && (
              <div style={{ marginTop:24, paddingTop:20, borderTop:'1px solid #eaecf0', fontSize:13 }}>
                <div style={{ fontSize:11, textTransform:'uppercase', letterSpacing:1, color:'#9aa3b2' }}>Listed by</div>
                <div style={{ fontWeight:700, marginTop:4 }}>{agent.name}</div>
                {agent.phone && <a href={`tel:${agent.phone}`} style={{ display:'block', color:'#1e2642', textDecoration:'none', marginTop:2 }}>{agent.phone}</a>}
                {agent.email && <a href={`mailto:${agent.email}`} style={{ display:'block', color:'#1e2642', textDecoration:'none' }}>{agent.email}</a>}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer style={{ textAlign:'center', padding:'24px 16px 48px', fontSize:12, color:'#9aa3b2' }}>
        Gateway Real Estate Advisors · This information is believed to be accurate but is not guaranteed.
      </footer>
    </div>
  )
}

const inputStyle = {
  padding: '10px 12px',
  border: '1px solid #d6d9e0',
  borderRadius: 6,
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}
