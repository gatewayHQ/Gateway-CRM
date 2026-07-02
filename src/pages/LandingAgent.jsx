/**
 * Agent Profile Landing — public-facing personal-brand page for an advisor.
 *
 * URL: /lp/agent/:mailingId (demo: /lp/demo/agent)
 *
 * Editorial magazine treatment — big centered headshot, serif name, tagline,
 * track-record stats, active listings, bio, then a "work with me" form. The
 * advisor comes from the mailing's primary agent (headshot/bio/phone from the
 * agents table, overridable per mailing via landing_config.agent_overrides).
 *
 * landing_config: { headline (tagline), subheadline, highlights[], cta_text,
 *                   accent, listings[{image,title,price,status,link}],
 *                   socials{instagram,linkedin,facebook,website} }
 */
import React from 'react'
import {
  LandingShell, Section, LeadForm, AgentTeam, StatePanel,
  Reveal, Button, DetailGrid, Skeleton,
} from '../components/landing'
import { useMailingLanding, submitCampaignLead } from '../components/landing/data.js'
import '../components/landing/landing.css'

const SOCIAL_LABELS = { instagram: 'Instagram', linkedin: 'LinkedIn', facebook: 'Facebook', website: 'Website' }

const STATUS_COLORS = {
  'for sale':   { bg: '#e7f0e9', color: '#2e7d5e' },
  'in escrow':  { bg: '#fdf3df', color: '#b07a1a' },
  'just sold':  { bg: '#e9edf6', color: '#3a5488' },
  'off market': { bg: '#f0f0ee', color: '#6a7180' },
}

function ListingCard({ listing }) {
  const status = (listing.status || '').toLowerCase()
  const sc = STATUS_COLORS[status] || STATUS_COLORS['for sale']
  const body = (
    <>
      <div style={{ position: 'relative', aspectRatio: '4 / 3', background: '#e9ebf0' }}>
        {listing.image && (
          <img src={listing.image} alt={listing.title || 'Listing'} loading="lazy" decoding="async"
               style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        )}
        {listing.status && (
          <span style={{
            position: 'absolute', top: 10, left: 10, padding: '4px 10px', borderRadius: 99,
            fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
            background: sc.bg, color: sc.color,
          }}>{listing.status}</span>
        )}
      </div>
      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontWeight: 700, fontSize: 14.5, lineHeight: 1.35 }}>{listing.title}</div>
        {listing.price && <div className="lx-serif" style={{ fontSize: 19, fontWeight: 700, color: 'var(--lx-accent)', marginTop: 4 }}>{listing.price}</div>}
      </div>
    </>
  )
  const cardStyle = {
    display: 'block', overflow: 'hidden', borderRadius: 'var(--lx-radius-sm)',
    border: '1px solid var(--lx-line)', background: 'var(--lx-paper)',
    boxShadow: 'var(--lx-shadow-sm)', textDecoration: 'none', color: 'inherit',
  }
  return listing.link
    ? <a href={listing.link} target="_blank" rel="noopener noreferrer" style={cardStyle}>{body}</a>
    : <div style={cardStyle}>{body}</div>
}

export default function LandingAgent({ mailingId, preview }) {
  const { loading, notFound, cfg, agents } = useMailingLanding(mailingId, preview)
  const agent = agents[0] || null

  if (loading) return (
    <div className="lx-root" style={{ minHeight: '100vh', padding: 'clamp(18px,5vw,40px)', display: 'grid', justifyItems: 'center' }}>
      <Skeleton h={180} w={180} radius="24px" style={{ margin: '40px 0 20px' }} />
      <Skeleton h={36} w={280} style={{ marginBottom: 12 }} />
      <Skeleton h={100} w="min(560px, 90%)" />
    </div>
  )
  if (notFound || !agent) return (
    <div className="lx-root" style={{ minHeight: '100vh' }}>
      <StatePanel title="Page not found" message="This advisor page is no longer available. Reach out to Gateway Real Estate Advisors directly and we'll take care of you." />
    </div>
  )

  const accent    = cfg.accent      || '#1e2642'
  const firstName = (agent.name || '').split(/\s+/)[0] || 'me'
  const tagline   = cfg.headline    || `Real estate, handled personally.`
  const subhead   = cfg.subheadline || ''
  const ctaText   = cfg.cta_text    || `Work with ${firstName}`
  const listings  = (Array.isArray(cfg.listings) ? cfg.listings : []).filter(l => l?.title || l?.image)
  const highlights = (Array.isArray(cfg.highlights) ? cfg.highlights : [])
    .slice(0, 4)
    .map(h => ({ label: h.label, value: h.value }))
  const socials = Object.entries(cfg.socials || {}).filter(([k, v]) => SOCIAL_LABELS[k] && v)

  const submit = (form) => submitCampaignLead(mailingId, 'agent', form, { preview })

  return (
    <LandingShell
      accent={accent}
      headerCta={agent.phone && <Button href={`tel:${agent.phone}`} variant="ghost" style={{ padding: '9px 16px', fontSize: 13 }}>Call {firstName}</Button>}
    >
      <div className="lx-container" style={{ paddingTop: 'clamp(30px,6vw,64px)', paddingBottom: 40 }}>
        {/* Editorial masthead */}
        <div style={{ maxWidth: 680, margin: '0 auto', textAlign: 'center' }}>
          {agent.photo_url ? (
            <Reveal>
              <img src={agent.photo_url} alt={agent.name}
                   style={{ width: 'clamp(140px, 30vw, 190px)', aspectRatio: '1 / 1', objectFit: 'cover',
                            borderRadius: 28, boxShadow: 'var(--lx-shadow-md)' }} />
            </Reveal>
          ) : (
            <Reveal>
              <div aria-hidden="true" className="lx-serif" style={{
                width: 'clamp(140px, 30vw, 190px)', aspectRatio: '1 / 1', borderRadius: 28, margin: '0 auto',
                display: 'grid', placeItems: 'center', fontSize: 56, fontWeight: 600, color: '#fff',
                background: agent.color || accent, boxShadow: 'var(--lx-shadow-md)',
              }}>{(agent.name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()}</div>
            </Reveal>
          )}
          <Reveal as="h1" delay={70} className="lx-serif"
                  style={{ fontSize: 'clamp(34px,5vw,54px)', fontWeight: 600, lineHeight: 1.06, margin: '22px 0 6px' }}>
            {agent.name}
          </Reveal>
          <Reveal as="p" delay={110} style={{ fontSize: 12.5, letterSpacing: '.14em', textTransform: 'uppercase', fontWeight: 600, color: 'var(--lx-mist)', margin: 0 }}>
            {agent.role || 'Real Estate Advisor'} · Gateway Real Estate Advisors
          </Reveal>
          <Reveal delay={140}><hr style={{ width: 44, height: 2, background: 'var(--lx-gold)', border: 0, margin: '18px auto' }} /></Reveal>
          <Reveal as="p" delay={170} className="lx-serif" style={{ fontSize: 'clamp(19px,2.6vw,24px)', fontStyle: 'italic', color: 'var(--lx-ink-2)', lineHeight: 1.45, margin: '0 0 8px' }}>
            “{tagline}”
          </Reveal>
          {subhead && (
            <Reveal as="p" delay={200} style={{ fontSize: 15.5, lineHeight: 1.65, color: 'var(--lx-ink-2)', margin: '10px 0 0' }}>
              {subhead}
            </Reveal>
          )}
          <Reveal delay={230} style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 22 }}>
            {agent.phone && <Button href={`tel:${agent.phone}`}>Call</Button>}
            {agent.phone && <Button href={`sms:${agent.phone}`} variant="ghost">Text</Button>}
            {agent.email && <Button href={`mailto:${agent.email}`} variant="ghost">Email</Button>}
          </Reveal>
          {socials.length > 0 && (
            <Reveal delay={260} style={{ display: 'flex', gap: 16, justifyContent: 'center', flexWrap: 'wrap', marginTop: 16 }}>
              {socials.map(([k, url]) => (
                <a key={k} href={url} target="_blank" rel="noopener noreferrer"
                   style={{ fontSize: 12.5, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--lx-accent)', textDecoration: 'none', borderBottom: '1px solid var(--lx-gold)', paddingBottom: 2 }}>
                  {SOCIAL_LABELS[k]}
                </a>
              ))}
            </Reveal>
          )}
        </div>

        {/* Track record */}
        {highlights.length > 0 && (
          <Reveal delay={100}>
            <div className="lx-card" style={{ maxWidth: 820, margin: 'clamp(34px,5vw,56px) auto 0', textAlign: 'center' }}>
              <DetailGrid items={highlights} />
            </div>
          </Reveal>
        )}

        {/* Listings */}
        {listings.length > 0 && (
          <Section title="Active & recent listings" style={{ marginTop: 'clamp(34px,5vw,56px)' }}>
            <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
              {listings.map((l, i) => <ListingCard key={i} listing={l} />)}
            </div>
          </Section>
        )}

        {/* Bio */}
        {agent.bio && (
          <Section title={`About ${firstName}`} style={{ marginTop: 'clamp(34px,5vw,56px)', maxWidth: 720, marginInline: 'auto' }}>
            <p style={{ fontSize: 15.5, lineHeight: 1.8, color: 'var(--lx-ink-2)', margin: 0, whiteSpace: 'pre-line' }}>{agent.bio}</p>
          </Section>
        )}

        {/* Capture */}
        <div style={{ maxWidth: 560, margin: 'clamp(34px,5vw,56px) auto 0' }}>
          <LeadForm
            title={ctaText}
            cta={ctaText}
            subtext={`Tell ${firstName} what you're looking to do — buy, sell, or just talk strategy.`}
            agentName={agent.name}
            onSubmit={submit}
          />
        </div>

        {/* Co-advisors, if the mailing lists more than one */}
        {agents.length > 1 && (
          <div style={{ marginTop: 'clamp(34px,5vw,56px)' }}>
            <AgentTeam agents={agents.slice(1)} accent={accent} heading="Also on the team" />
          </div>
        )}
      </div>
    </LandingShell>
  )
}
