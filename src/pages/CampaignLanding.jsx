import React, { useState, useEffect } from 'react'

const TEMPLATE_CONFIG = {
  just_listed:     { badge: 'Just Listed',    emoji: '🏠', color: '#16a34a', bg: '#dcfce7', dark: '#14532d' },
  just_sold:       { badge: 'Just Sold',      emoji: '✅', color: '#2563eb', bg: '#dbeafe', dark: '#1e3a8a' },
  buyers_waiting:  { badge: 'Buyers Wanted',  emoji: '🔍', color: '#7c3aed', bg: '#ede9fe', dark: '#4c1d95' },
  exclusive_offer: { badge: 'Exclusive',      emoji: '⭐', color: '#b45309', bg: '#fef3c7', dark: '#78350f' },
  market_update:   { badge: 'Market Update',  emoji: '📊', color: '#0891b2', bg: '#cffafe', dark: '#164e63' },
  sellers_wanted:  { badge: "We're Buying",   emoji: '🎯', color: '#dc2626', bg: '#fee2e2', dark: '#7f1d1d' },
}

const DEFAULT_TEMPLATE = { badge: 'Connect', emoji: '🏡', color: '#2d3561', bg: '#e8ecf8', dark: '#1e2642' }

function Loader() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#f3f4f6', fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{ textAlign: 'center', color: '#6b7280' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🏡</div>
        <div style={{ fontSize: 14 }}>Loading…</div>
      </div>
    </div>
  )
}

function NotFound() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#f3f4f6', fontFamily: 'system-ui, sans-serif', padding: 24,
    }}>
      <div style={{ textAlign: 'center', maxWidth: 360 }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>🔍</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#1e2642', margin: '0 0 8px' }}>Page Not Found</h1>
        <p style={{ color: '#6b7280', fontSize: 14, lineHeight: 1.6 }}>
          This campaign link is no longer active or could not be found.
        </p>
      </div>
    </div>
  )
}

export default function CampaignLandingPage({ code }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(false)

  useEffect(() => {
    if (!code) { setError(true); setLoading(false); return }
    fetch(`/api/campaign-landing?c=${encodeURIComponent(code)}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then(json => {
        setData(json)
        setLoading(false)
      })
      .catch(() => {
        setError(true)
        setLoading(false)
      })
  }, [code])

  if (loading) return <Loader />
  if (error || !data?.campaign) return <NotFound />

  const { campaign, agent } = data
  const tmpl      = TEMPLATE_CONFIG[campaign.flyer_template] || DEFAULT_TEMPLATE
  const agentColor = agent?.color || tmpl.color
  const headline   = campaign.landing_headline || campaign.name
  const tagline    = campaign.landing_tagline  || campaign.description || ''
  const ctaText    = campaign.landing_cta      || 'Schedule a Call'
  const phone      = agent?.phone || ''
  const email      = agent?.email || ''
  const agentName  = agent?.name  || 'Our Team'
  const agentRole  = agent?.role  || 'Real Estate Professional'
  const initials   = agent?.initials || agentName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

  // Light gradient background using agent color
  const bgGradient = `linear-gradient(160deg, ${agentColor}18 0%, #f8f9fa 60%)`

  const cardStyle = {
    background: '#fff',
    borderRadius: 20,
    boxShadow: '0 4px 32px rgba(0,0,0,0.10), 0 1px 4px rgba(0,0,0,0.06)',
    maxWidth: 420,
    width: '100%',
    overflow: 'hidden',
    margin: '0 auto',
  }

  const btnBase = {
    display: 'block',
    width: '100%',
    padding: '13px 20px',
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    textDecoration: 'none',
    textAlign: 'center',
    boxSizing: 'border-box',
    border: 'none',
    fontFamily: 'system-ui, sans-serif',
    letterSpacing: '0.01em',
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: bgGradient,
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'center',
      padding: '24px 16px 40px',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      boxSizing: 'border-box',
    }}>
      <div style={cardStyle}>
        {/* Top color bar */}
        <div style={{ height: 6, background: agentColor }} />

        {/* Card body */}
        <div style={{ padding: '24px 24px 28px' }}>

          {/* Agent section */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
            <div style={{
              width: 60, height: 60, borderRadius: 14,
              background: agentColor,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 20, fontWeight: 800,
              flexShrink: 0, letterSpacing: '-0.5px',
            }}>
              {initials}
            </div>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700, color: '#111827', lineHeight: 1.2 }}>{agentName}</div>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{agentRole}</div>
            </div>
          </div>

          {/* Template badge */}
          <div style={{ marginBottom: 18 }}>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: tmpl.bg, color: tmpl.dark,
              padding: '5px 12px', borderRadius: 20,
              fontSize: 11, fontWeight: 800, letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
              <span>{tmpl.emoji}</span>
              <span>{tmpl.badge}</span>
            </span>
          </div>

          {/* Headline */}
          <h1 style={{
            fontSize: 26, fontWeight: 700,
            fontFamily: 'Georgia, "Times New Roman", serif',
            color: '#111827',
            lineHeight: 1.2,
            margin: '0 0 14px',
          }}>
            {headline}
          </h1>

          {/* Property type chips */}
          {campaign.property_types?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {campaign.property_types.map(t => (
                <span key={t} style={{
                  padding: '3px 10px', borderRadius: 10,
                  background: '#f1f5f9', color: '#475569',
                  fontSize: 11, fontWeight: 600,
                  textTransform: 'capitalize',
                }}>
                  {t}
                </span>
              ))}
            </div>
          )}

          {/* Tagline */}
          {tagline && (
            <p style={{
              fontSize: 14, color: '#4b5563', lineHeight: 1.7,
              margin: '0 0 24px',
            }}>
              {tagline}
            </p>
          )}

          {/* CTA buttons */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Primary: Call */}
            {phone && (
              <a href={`tel:${phone.replace(/\D/g, '')}`} style={{
                ...btnBase,
                background: agentColor,
                color: '#fff',
              }}>
                📞 {ctaText}
              </a>
            )}

            {/* Secondary: Text */}
            {phone && (
              <a href={`sms:${phone.replace(/\D/g, '')}`} style={{
                ...btnBase,
                background: '#f1f5f9',
                color: '#1e293b',
              }}>
                💬 Send a Text
              </a>
            )}

            {/* Tertiary: Email */}
            {email && (
              <a href={`mailto:${email}`} style={{
                ...btnBase,
                background: 'transparent',
                color: agentColor,
                border: `2px solid ${agentColor}`,
                padding: '11px 20px',
              }}>
                ✉️ Email Me
              </a>
            )}

            {/* If no phone at all, show generic CTA */}
            {!phone && !email && (
              <div style={{
                ...btnBase,
                background: agentColor,
                color: '#fff',
                cursor: 'default',
              }}>
                {tmpl.emoji} {ctaText}
              </div>
            )}

            {/* Visit website (only if external landing_url set) */}
            {campaign.landing_url && (
              <a href={campaign.landing_url} target="_blank" rel="noopener noreferrer" style={{
                ...btnBase,
                background: 'transparent',
                color: '#6b7280',
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'underline',
                padding: '8px 20px',
              }}>
                Visit Our Website →
              </a>
            )}
          </div>
        </div>

        {/* Footer */}
        <div style={{
          borderTop: '1px solid #f1f5f9',
          padding: '12px 24px',
          textAlign: 'center',
          fontSize: 11,
          color: '#9ca3af',
          letterSpacing: '0.02em',
        }}>
          Powered by Gateway CRM
        </div>
      </div>
    </div>
  )
}
