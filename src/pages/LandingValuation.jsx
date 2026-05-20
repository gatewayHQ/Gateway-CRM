/**
 * Home Valuation Landing — public-facing, for "what's your home worth?" mailers.
 *
 * URL: /lp/valuation/:mailingId
 * Mounted directly from main.jsx (bypasses auth shell).
 *
 * Form captures: property address + type + owner contact info → mailing_leads row.
 * Useful follow-up signal: paired with "Just Sold" postcards to neighbors.
 */

import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const PROPERTY_TYPES = [
  { value: 'single-family', label: 'Single-Family Home' },
  { value: 'condo',         label: 'Condo / Townhome' },
  { value: 'multifamily',   label: 'Multifamily (2-4 units)' },
  { value: 'multifamily-5', label: 'Apartment Building (5+ units)' },
  { value: 'commercial',    label: 'Commercial Property' },
  { value: 'land',          label: 'Land / Lot' },
  { value: 'other',         label: 'Other' },
]

export default function LandingValuation({ mailingId }) {
  const [mailing, setMailing] = useState(null)
  const [agent,   setAgent]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  const [form, setForm] = useState({
    property_address: '',
    property_type:    'single-family',
    name:             '',
    email:            '',
    phone:            '',
    message:          '',
  })

  useEffect(() => {
    (async () => {
      const { data: m } = await supabase.from('mailings').select('id, name, agent_id').eq('id', mailingId).single()
      if (!m) { setError('Mailing not found'); setLoading(false); return }
      setMailing(m)
      if (m.agent_id) {
        const { data: a } = await supabase.from('agents').select('id, name, phone, email').eq('id', m.agent_id).single()
        setAgent(a || null)
      }
      setLoading(false)
    })()
  }, [mailingId])

  const submit = async (e) => {
    e.preventDefault()
    if (!form.property_address.trim()) { setError('Please enter the property address'); return }
    if (!form.name.trim()) { setError('Please enter your name'); return }
    if (!form.phone.trim()) { setError('Please enter a phone number so we can reach you'); return }
    setError(null)
    setSubmitting(true)
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'capture_lead', mailing_id: mailingId, source_landing: 'valuation', ...form }),
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

  return (
    <div style={{ minHeight:'100vh', fontFamily:'DM Sans, sans-serif', background:'#fafaf7', color:'#1e2642' }}>
      {/* Hero */}
      <div style={{ background:'linear-gradient(135deg, #1e2642 0%, #2c3a5e 60%, #3d4f7a 100%)',
                    color:'#fff', padding:'72px 24px 56px', textAlign:'center' }}>
        <div style={{ maxWidth:680, margin:'0 auto' }}>
          <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:22, opacity:0.85 }}>Gateway Real Estate Advisors</div>
          <h1 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:48, fontWeight:600, lineHeight:1.15, margin:'16px 0 12px' }}>
            What's your home worth today?
          </h1>
          <p style={{ fontSize:16, opacity:0.88, maxWidth:520, margin:'0 auto', lineHeight:1.5 }}>
            Get a private, no-obligation valuation from a licensed broker who actually knows your neighborhood.
            We'll pull recent comps and send you a real number — not a Zestimate.
          </p>
        </div>
      </div>

      {/* Form card */}
      <div style={{ maxWidth:560, margin:'-32px auto 0', padding:'0 24px 64px' }}>
        <div style={{ background:'#fff', borderRadius:12, padding:32, boxShadow:'0 8px 32px rgba(30,38,66,0.1)' }}>
          {submitted ? (
            <div style={{ textAlign:'center', padding:'20px 0' }}>
              <div style={{ fontSize:56, color:'#10b981' }}>✓</div>
              <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:28, margin:'12px 0 8px' }}>Got it.</h2>
              <p style={{ color:'#4a5263', fontSize:15, lineHeight:1.6 }}>
                We'll review recent comparable sales in your area and reach out within one business day with a market estimate.
                {agent && <span><br /><br />Your contact will be <strong>{agent.name}</strong>.</span>}
              </p>
            </div>
          ) : (
            <>
              <h2 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:24, fontWeight:600, marginTop:0 }}>Tell us about the property</h2>
              <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:12, marginTop:12 }}>
                <label style={labelStyle}>
                  Property address *
                  <input required value={form.property_address}
                         onChange={e => setForm(f => ({ ...f, property_address: e.target.value }))}
                         placeholder="123 Main St, Springfield"
                         style={inputStyle} />
                </label>

                <label style={labelStyle}>
                  Property type
                  <select value={form.property_type} onChange={e => setForm(f => ({ ...f, property_type: e.target.value }))} style={inputStyle}>
                    {PROPERTY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </label>

                <div style={{ height:1, background:'#eaecf0', margin:'4px 0' }} />

                <label style={labelStyle}>
                  Your name *
                  <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} />
                </label>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                  <label style={labelStyle}>
                    Phone *
                    <input required type="tel" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={inputStyle} placeholder="(555) 555-5555" />
                  </label>
                  <label style={labelStyle}>
                    Email (optional)
                    <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inputStyle} placeholder="you@example.com" />
                  </label>
                </div>

                <label style={labelStyle}>
                  Anything we should know? (optional)
                  <textarea rows={3} value={form.message} onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
                            placeholder="Recent renovations, considering selling soon, etc."
                            style={{ ...inputStyle, resize:'vertical', fontFamily:'inherit' }} />
                </label>

                {error && <div style={{ color:'#c0392b', fontSize:13 }}>{error}</div>}

                <button type="submit" disabled={submitting}
                        style={{ background:'#1e2642', color:'#fff', padding:'14px', border:'none', borderRadius:6,
                                 fontSize:15, fontWeight:600, cursor:'pointer', marginTop:6 }}>
                  {submitting ? 'Sending…' : 'Send my valuation request'}
                </button>

                <p style={{ fontSize:11, color:'#9aa3b2', textAlign:'center', margin:'8px 0 0' }}>
                  Your information is private. We won't sell it or send marketing emails — just your valuation.
                </p>
              </form>
            </>
          )}
        </div>

        {agent && !submitted && (
          <div style={{ textAlign:'center', marginTop:16, fontSize:13, color:'#4a5263' }}>
            Prefer to talk? Call <strong>{agent.name}</strong>{' '}
            {agent.phone && <a href={`tel:${agent.phone}`} style={{ color:'#1e2642' }}>{agent.phone}</a>}
          </div>
        )}
      </div>

      <footer style={{ textAlign:'center', padding:'24px 16px 48px', fontSize:12, color:'#9aa3b2' }}>
        Gateway Real Estate Advisors · Licensed Brokerage
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
  marginTop: 4,
}

const labelStyle = {
  display: 'flex',
  flexDirection: 'column',
  fontSize: 12,
  fontWeight: 600,
  color: '#1e2642',
}
