import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'

export default function LeadCapturePage() {
  const params = new URLSearchParams(window.location.search)
  const agentId = params.get('agent')
  const propertyAddress = params.get('property') || ''

  const [agent, setAgent] = useState(null)
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', phone: '', message: '' })
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (agentId) {
      supabase.from('agents').select('*').eq('id', agentId).single()
        .then(({ data }) => { if (data) setAgent(data) })
    }
  }, [agentId])

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const submit = async (e) => {
    e.preventDefault()
    const e2 = {}
    if (!form.first_name.trim()) e2.first_name = true
    if (!form.last_name.trim()) e2.last_name = true
    if (!form.email.trim() || !/\S+@\S+\.\S+/.test(form.email)) e2.email = true
    setErrors(e2)
    if (Object.keys(e2).length) return

    setSubmitting(true)
    const sessionKey = (() => {
      let s = localStorage.getItem('_gwsid')
      if (!s) { s = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('_gwsid', s) }
      return s
    })()

    await supabase.from('lead_captures').insert([{
      session_key: sessionKey,
      agent_id: agentId || null,
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      property_address: propertyAddress || null,
      message: form.message.trim(),
    }])

    setSubmitting(false)
    setDone(true)
  }

  const inputStyle = (field) => ({
    width: '100%', padding: '10px 12px',
    border: `1px solid ${errors[field] ? '#c0392b' : '#e2e0db'}`,
    borderRadius: 6, fontSize: 14, fontFamily: 'DM Sans, sans-serif',
    outline: 'none', color: '#1a1a2e', background: '#fff',
  })
  const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: '#1a1a2e', marginBottom: 5 }

  if (done) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f3ef', padding: 24 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: '48px 40px', maxWidth: 420, width: '100%', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.12)' }}>
        <div style={{ width: 56, height: 56, background: '#d4ede5', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 28 }}>✓</div>
        <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 26, fontWeight: 600, color: '#1e2642', marginBottom: 10 }}>Thank you!</div>
        <div style={{ fontSize: 14, color: '#9aa3b2', lineHeight: 1.6 }}>
          {agent ? `${agent.name} will be in touch with you shortly.` : 'An agent will be in touch with you shortly.'}
        </div>
        {propertyAddress && <div style={{ marginTop: 16, padding: '10px 14px', background: '#f5f3ef', borderRadius: 6, fontSize: 13, color: '#1a1a2e' }}>{propertyAddress}</div>}
      </div>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: '#f5f3ef', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'DM Sans, sans-serif' }}>
      <div style={{ width: '100%', maxWidth: 460 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <div style={{ width: 40, height: 40, background: '#1e2642', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Cormorant Garamond, serif', fontSize: 22, fontWeight: 700, color: '#c9a84c', flexShrink: 0 }}>G</div>
          <div>
            <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 20, fontWeight: 600, color: '#1e2642' }}>Gateway Real Estate Advisors</div>
            <div style={{ fontSize: 11, color: '#9aa3b2', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Contact an Agent</div>
          </div>
        </div>

        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.12)', padding: '32px 32px 28px', border: '1px solid #e2e0db' }}>
          {/* Agent info */}
          {agent && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: '#f5f3ef', borderRadius: 8, marginBottom: 24 }}>
              <div style={{ width: 42, height: 42, borderRadius: 8, background: agent.color || '#1e2642', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16, flexShrink: 0 }}>
                {agent.initials || agent.name?.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{agent.name}</div>
                <div style={{ fontSize: 12, color: '#9aa3b2' }}>{agent.role}</div>
              </div>
            </div>
          )}

          {/* Property */}
          {propertyAddress && (
            <div style={{ marginBottom: 22, paddingBottom: 18, borderBottom: '1px solid #e2e0db' }}>
              <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#9aa3b2', marginBottom: 4 }}>Interested in</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: '#1a1a2e' }}>{propertyAddress}</div>
            </div>
          )}

          <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 22, fontWeight: 600, marginBottom: 20, color: '#1a1a2e' }}>Get in touch</div>

          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={labelStyle}>First Name <span style={{ color: '#c0392b' }}>*</span></label>
                <input style={inputStyle('first_name')} value={form.first_name} onChange={e => set('first_name', e.target.value)} placeholder="Jane" />
              </div>
              <div>
                <label style={labelStyle}>Last Name <span style={{ color: '#c0392b' }}>*</span></label>
                <input style={inputStyle('last_name')} value={form.last_name} onChange={e => set('last_name', e.target.value)} placeholder="Smith" />
              </div>
            </div>

            <div>
              <label style={labelStyle}>Email <span style={{ color: '#c0392b' }}>*</span></label>
              <input style={inputStyle('email')} type="email" value={form.email} onChange={e => set('email', e.target.value)} placeholder="jane@example.com" />
            </div>

            <div>
              <label style={labelStyle}>Phone</label>
              <input style={inputStyle('phone')} type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="(555) 000-0000" />
            </div>

            <div>
              <label style={labelStyle}>Message</label>
              <textarea style={{ ...inputStyle('message'), resize: 'vertical', minHeight: 80, lineHeight: 1.5 }}
                value={form.message} onChange={e => set('message', e.target.value)}
                placeholder="I'd love to schedule a showing…" />
            </div>

            <button type="submit" disabled={submitting} style={{
              width: '100%', padding: '12px 0', marginTop: 4,
              background: '#2d3561', color: '#fff', border: 'none', borderRadius: 6,
              fontSize: 14, fontWeight: 600, fontFamily: 'DM Sans, sans-serif',
              cursor: submitting ? 'default' : 'pointer', opacity: submitting ? 0.7 : 1,
            }}>
              {submitting ? 'Sending…' : 'Send Message'}
            </button>
          </form>
        </div>

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 11, color: '#9aa3b2' }}>
          Your information is kept private and only shared with your agent.
        </div>
      </div>
    </div>
  )
}
