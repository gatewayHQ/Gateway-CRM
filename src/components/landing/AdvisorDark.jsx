/**
 * AdvisorDark — "Meet your advisor" bio section for the dark valuation/
 * multifamily landing pages (LandingValuation, LandingMultifamily).
 *
 * The light landing pages use AgentTeam/Advisor from sections.jsx, which are
 * styled for the cream LandingShell theme. These dark pages need a section that
 * matches their palette, so this is the dark twin: same data shape
 * ({ name, role, bio, photo_url, color, phone, email }), dark styling.
 *
 * Renders nothing when there's no named advisor, so it's safe to always mount.
 * It sits below the hero/form so a visitor fills the form first, then scrolls
 * down to read about who they'll be working with.
 */

import React from 'react'

const initials = (name = '') =>
  name.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?'

export default function AdvisorDark({ agents = [], accent = '#c9a961' }) {
  const list = (agents || []).filter(a => a && a.name).slice(0, 2)
  if (!list.length) return null
  const heading = list.length > 1 ? 'Meet your advisors' : 'Meet your advisor'

  return (
    <section style={{ maxWidth: 1180, margin: '0 auto', padding: '0 24px 72px' }}>
      <div style={{ borderTop: '1px solid #2a2a2a', paddingTop: 40 }}>
        <div style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', color: accent, marginBottom: 18 }}>
          {heading}
        </div>
        <div className="adv-dark-grid"
             style={{ display: 'grid', gap: 32,
                      gridTemplateColumns: list.length > 1 ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)' }}>
          {list.map((a, i) => <AdvisorCard key={a.id || i} agent={a} accent={accent} />)}
        </div>
      </div>
      <style>{`@media (max-width: 760px) { .adv-dark-grid { grid-template-columns: 1fr !important; } }`}</style>
    </section>
  )
}

function AdvisorCard({ agent, accent }) {
  const { name, role, bio, photo_url, color, phone, email } = agent
  return (
    <article className="adv-dark-card"
             style={{ display: 'flex', gap: 20, alignItems: 'flex-start', background: '#141414',
                      border: '1px solid #262626', borderRadius: 12, padding: 22 }}>
      {photo_url ? (
        <img src={photo_url} alt={`${name}, real estate advisor`} loading="lazy" decoding="async"
             style={{ width: 96, height: 96, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }} />
      ) : (
        <div aria-hidden="true"
             style={{ width: 96, height: 96, borderRadius: 10, flexShrink: 0, background: color || accent,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#1a1a1a', fontWeight: 700, fontSize: 28 }}>
          {initials(name)}
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <h3 style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 24, fontWeight: 600,
                     color: '#f3f0e6', margin: '0 0 2px' }}>{name}</h3>
        <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, color: accent, marginBottom: 10 }}>
          {role || 'Real Estate Advisor'} · Gateway Real Estate
        </div>
        {bio && (
          <p style={{ fontSize: 14, lineHeight: 1.65, color: '#bdbcb4', margin: '0 0 14px' }}>{bio}</p>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {phone && <ContactBtn href={`tel:${phone}`}  accent={accent} filled>Call</ContactBtn>}
          {phone && <ContactBtn href={`sms:${phone}`}  accent={accent}>Text</ContactBtn>}
          {email && <ContactBtn href={`mailto:${email}`} accent={accent}>Email</ContactBtn>}
        </div>
      </div>
    </article>
  )
}

function ContactBtn({ href, accent, filled, children }) {
  return (
    <a href={href} style={{
      textDecoration: 'none', fontSize: 13, fontWeight: 600, padding: '8px 16px', borderRadius: 99,
      border: `1px solid ${accent}${filled ? '' : '55'}`,
      background: filled ? accent : 'transparent',
      color: filled ? '#1a1a1a' : accent,
    }}>{children}</a>
  )
}
