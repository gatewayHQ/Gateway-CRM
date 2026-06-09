/**
 * AdvisorProfile — standalone, public "About the Advisor" page.
 *
 * URL: /advisor/:agentId
 *
 * Purpose: a single, shareable page per advisor that lives outside any one
 * mailing — drop it in an email signature, a text, a business-card QR, or link
 * to it from the "Meet your advisor" section on a property/valuation landing
 * page. Premium dark theme, matching LandingValuation / LandingMultifamily so a
 * visitor who clicks through from a landing page feels continuity.
 *
 * Renders entirely from the agents row (anonymous read is allowed by the
 * `allow_all` RLS policy on agents). Stats and tagline come from the agent's
 * own profile (Team → edit agent); none of it touches private commission data.
 */

import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'

const ACCENT = '#c9a961'

const initials = (name = '') =>
  name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?'

export default function AdvisorProfile({ agentId }) {
  const [agent,   setAgent]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      // Try the full column set; fall back if migrations 0004/0006 haven't run.
      let { data, error: e } = await supabase.from('agents')
        .select('id, name, role, tagline, bio, photo_url, color, phone, email, stats')
        .eq('id', agentId).maybeSingle()
      if (e) {
        ;({ data } = await supabase.from('agents')
          .select('id, name, role, photo_url, color, phone, email')
          .eq('id', agentId).maybeSingle())
      }
      if (!active) return
      if (!data) { setError('Advisor not found'); setLoading(false); return }
      setAgent(data)
      setLoading(false)
    })()
    return () => { active = false }
  }, [agentId])

  if (loading) return (
    <div style={{ ...pageStyle, display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ color:'#a8a8a8', fontSize:14 }}>Loading…</div>
    </div>
  )
  if (error || !agent) return (
    <div style={{ ...pageStyle, padding:60, textAlign:'center' }}>
      <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:18, color:'#f3f0e6' }}>Gateway Real Estate Advisors</div>
      <div style={{ marginTop:8, color:'#e57373' }}>{error || 'Advisor not found'}</div>
    </div>
  )

  const stats = Array.isArray(agent.stats)
    ? agent.stats.filter(s => s && (s.label || s.value)).slice(0, 4)
    : []

  return (
    <div className="adv-page" style={pageStyle}>
      {/* Header */}
      <header style={{ padding:'18px 24px', maxWidth:920, margin:'0 auto', display:'flex',
                       justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:20, color:'#f3f0e6' }}>
          Gateway <span style={{ color:ACCENT }}>Real Estate Advisors</span>
        </div>
        {agent.phone && (
          <a href={`tel:${agent.phone}`} style={{ color:'#f3f0e6', textDecoration:'none', fontSize:13, opacity:0.85 }}>
            <span style={{ color:ACCENT, marginRight:6 }}>●</span>{agent.phone}
          </a>
        )}
      </header>

      <main style={{ maxWidth:920, margin:'0 auto', padding:'24px 24px 64px' }}>
        {/* Identity block */}
        <div className="adv-identity" style={{ display:'flex', gap:28, alignItems:'center', marginBottom:36 }}>
          {agent.photo_url ? (
            <img src={agent.photo_url} alt={agent.name} loading="lazy"
                 style={{ width:148, height:148, borderRadius:16, objectFit:'cover', flexShrink:0,
                          boxShadow:'0 16px 40px rgba(0,0,0,0.45)' }} />
          ) : (
            <div aria-hidden="true"
                 style={{ width:148, height:148, borderRadius:16, flexShrink:0, background:agent.color || ACCENT,
                          display:'flex', alignItems:'center', justifyContent:'center',
                          color:'#1a1a1a', fontWeight:700, fontSize:46 }}>
              {initials(agent.name)}
            </div>
          )}
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:11, letterSpacing:2, textTransform:'uppercase', color:ACCENT, marginBottom:8 }}>
              Your Advisor
            </div>
            <h1 style={{ fontFamily:'Cormorant Garamond, serif', fontSize:'clamp(34px, 6vw, 52px)', fontWeight:500,
                         lineHeight:1.05, margin:'0 0 8px', color:'#f3f0e6' }}>
              {agent.name}
            </h1>
            <div style={{ fontSize:15, color:'#d6d4c8' }}>
              {agent.role || 'Real Estate Advisor'} · Gateway Real Estate
            </div>
            {agent.tagline && (
              <div style={{ fontSize:15, color:'#bdbcb4', marginTop:6, lineHeight:1.5 }}>{agent.tagline}</div>
            )}
          </div>
        </div>

        {/* Stats */}
        {stats.length > 0 && (
          <div className="adv-stats"
               style={{ display:'grid', gridTemplateColumns:`repeat(${stats.length}, minmax(0, 1fr))`, gap:24,
                        padding:'24px 0', borderTop:'1px solid #2a2a2a', borderBottom:'1px solid #2a2a2a', marginBottom:36 }}>
            {stats.map((s, i) => (
              <div key={i} style={{ minWidth:0 }}>
                <div style={{ fontFamily:'Cormorant Garamond, serif', fontSize:'clamp(24px, 4.5vw, 34px)', fontWeight:600,
                              color:'#f3f0e6', lineHeight:1.05 }}>
                  {s.value || '—'}
                </div>
                <div style={{ fontSize:11, textTransform:'uppercase', letterSpacing:1.2, color:'#8c8c84', marginTop:6, lineHeight:1.3 }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Bio */}
        {agent.bio && (
          <div style={{ maxWidth:680, marginBottom:40 }}>
            <p style={{ fontSize:17, lineHeight:1.7, color:'#d6d4c8', margin:0, whiteSpace:'pre-line' }}>
              {agent.bio}
            </p>
          </div>
        )}

        {/* Contact CTA */}
        <div style={{ display:'flex', flexWrap:'wrap', gap:12 }}>
          {agent.phone && <CTA href={`tel:${agent.phone}`}  filled>Call {agent.name.split(/\s+/)[0]}</CTA>}
          {agent.phone && <CTA href={`sms:${agent.phone}`}>Text</CTA>}
          {agent.email && <CTA href={`mailto:${agent.email}`}>Email</CTA>}
        </div>
      </main>

      <footer style={{ borderTop:'1px solid #1f1f1f', padding:'20px 24px 40px', textAlign:'center',
                       fontSize:12, color:'#6c6c66' }}>
        Gateway Real Estate Advisors · Licensed Brokerage
      </footer>

      <style>{`
        html, body { margin: 0; background: #0a0a0a; }
        #root { overflow-x: hidden; }
        .adv-page, .adv-page * { box-sizing: border-box; }
        @media (max-width: 620px) {
          .adv-identity { flex-direction: column; align-items: flex-start !important; gap: 18px !important; }
          .adv-stats { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 18px !important; }
        }
      `}</style>
    </div>
  )
}

function CTA({ href, filled, children }) {
  return (
    <a href={href} style={{
      textDecoration:'none', fontSize:15, fontWeight:700, letterSpacing:0.3, padding:'13px 26px', borderRadius:8,
      border:`1px solid ${ACCENT}${filled ? '' : '55'}`,
      background: filled ? ACCENT : 'transparent',
      color: filled ? '#1a1a1a' : ACCENT,
    }}>{children}</a>
  )
}

const pageStyle = {
  minHeight:'100vh',
  width:'100%',
  overflowX:'hidden',
  background:'radial-gradient(1200px 600px at 20% -10%, #1a1f2e 0%, #0f0f0f 55%, #0a0a0a 100%)',
  color:'#f3f0e6',
  fontFamily:'DM Sans, system-ui, sans-serif',
}
