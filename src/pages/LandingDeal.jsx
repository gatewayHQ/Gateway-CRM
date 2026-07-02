/**
 * Off-Market Deal Landing — confidential teaser for an off-market opportunity.
 *
 * URL: /lp/deal/:mailingId (demo: /lp/demo/deal)
 *
 * Deliberately restrained: a narrow dossier-style column, the hero photo
 * blurred behind a "details on request" badge, three teaser metrics, a short
 * bullet list — and a gated form to request the full offering memorandum.
 * Email is required here (the OM gets sent to it).
 *
 * landing_config: { headline, subheadline, teaser_points[], highlights[],
 *                   images[{url}], reveal_photo (bool), cta_text, accent }
 */
import React, { useState } from 'react'
import {
  LandingShell, AgentTeam, StatePanel,
  Reveal, Button, Field, DetailGrid, Skeleton,
} from '../components/landing'
import { useMailingLanding, submitCampaignLead } from '../components/landing/data.js'
import '../components/landing/landing.css'

const DEFAULT_POINTS = [
  'Not listed on the open market — shared selectively with qualified parties.',
  'Full financials, rent roll, and pricing guidance in the offering memorandum.',
  'Principals and buyer-broker inquiries welcome.',
]

/* Gated OM request — email required (the OM is delivered to it). */
function OmRequestForm({ ctaText, agentName, onSubmit }) {
  const [form, setForm]     = useState({ name: '', email: '', phone: '', message: '' })
  const [errors, setErrors] = useState({})
  const [status, setStatus] = useState('idle')
  const [topError, setTopError] = useState(null)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    const errs = {}
    if (!form.name.trim()) errs.name = 'Please enter your name'
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) errs.email = 'A valid email is required — the OM is sent there'
    setErrors(errs)
    if (Object.keys(errs).length) return
    setStatus('submitting'); setTopError(null)
    try {
      await onSubmit(form)
      setStatus('done')
    } catch (err) {
      setStatus('error')
      setTopError(err?.message || 'Could not submit — please try again.')
    }
  }

  if (status === 'done') {
    return (
      <div className="lx-card" style={{ textAlign: 'center', boxShadow: 'var(--lx-shadow-md)' }} role="status">
        <div style={{
          width: 56, height: 56, borderRadius: '50%', margin: '4px auto 0', fontSize: 26,
          display: 'grid', placeItems: 'center',
          background: 'color-mix(in srgb, var(--lx-accent) 14%, transparent)', color: 'var(--lx-accent)',
        }} aria-hidden="true">✓</div>
        <h2 className="lx-serif" style={{ fontSize: 26, margin: '14px 0 8px' }}>Request received.</h2>
        <p style={{ color: 'var(--lx-mist)', lineHeight: 1.6, margin: 0 }}>
          {agentName ? `${agentName} will review and send the full offering memorandum shortly.` : 'We\'ll review and send the full offering memorandum shortly.'}
        </p>
      </div>
    )
  }

  return (
    <div className="lx-card" style={{ boxShadow: 'var(--lx-shadow-md)', borderTop: '3px solid var(--lx-accent)' }}>
      <h2 className="lx-serif" style={{ fontSize: 23, fontWeight: 600, margin: '0 0 4px' }}>Request the full offering memorandum</h2>
      <p style={{ fontSize: 12.5, color: 'var(--lx-mist)', margin: '0 0 16px', lineHeight: 1.5 }}>
        Pricing, financials, rent roll, and photos — sent directly to your inbox after a quick review.
      </p>
      <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Your name" required value={form.name} onChange={set('name')}
               error={errors.name} autoComplete="name" placeholder="Your name" />
        <Field label="Email" required type="email" value={form.email} onChange={set('email')}
               error={errors.email} autoComplete="email" placeholder="you@company.com"
               hint="The OM is delivered to this address" />
        <Field label="Phone (optional)" type="tel" value={form.phone} onChange={set('phone')}
               autoComplete="tel" placeholder="Phone (optional)" />
        <Field label="Anything specific you're underwriting for? (optional)" multiline rows={2}
               value={form.message} onChange={set('message')} placeholder="1031 timeline, target cap rate, financing…" />
        <div aria-live="polite">
          {topError && <div className="lx-field__error" style={{ marginBottom: 4 }}>{topError}</div>}
        </div>
        <Button type="submit" block loading={status === 'submitting'}>
          {status === 'submitting' ? 'Sending…' : `${ctaText} →`}
        </Button>
        <p style={{ fontSize: 11, color: 'var(--lx-mist)', textAlign: 'center', margin: 0 }}>
          Kept confidential. We verify every request before sharing details.
        </p>
      </form>
    </div>
  )
}

export default function LandingDeal({ mailingId, preview }) {
  const { loading, notFound, cfg, agents } = useMailingLanding(mailingId, preview)
  const agent = agents[0] || null

  if (loading) return (
    <div className="lx-root" style={{ minHeight: '100vh', padding: 'clamp(18px,5vw,40px)', display: 'grid', justifyItems: 'center' }}>
      <Skeleton h={30} w={220} style={{ margin: '30px 0 16px' }} />
      <Skeleton h={48} w="min(620px, 92%)" style={{ marginBottom: 18 }} />
      <Skeleton h={280} w="min(680px, 100%)" />
    </div>
  )
  if (notFound) return (
    <div className="lx-root" style={{ minHeight: '100vh' }}>
      <StatePanel title="Opportunity unavailable" message="This opportunity is no longer being shared. Reach out to Gateway Real Estate Advisors to hear what's currently available off market." />
    </div>
  )

  const accent   = cfg.accent      || '#1e2642'
  const headline = cfg.headline    || 'An off-market opportunity, shared quietly.'
  const subhead  = cfg.subheadline || 'A select mailing — this property is not publicly listed.'
  const ctaText  = cfg.cta_text    || 'Request the OM'
  const heroImg  = (Array.isArray(cfg.images) ? cfg.images : [])
    .map(v => (typeof v === 'string' ? { url: v } : v))
    .find(v => v?.url) || null
  const reveal   = Boolean(cfg.reveal_photo)
  const points   = (Array.isArray(cfg.teaser_points) && cfg.teaser_points.length ? cfg.teaser_points : DEFAULT_POINTS)
    .map(p => String(p).trim()).filter(Boolean)
  const highlights = (Array.isArray(cfg.highlights) ? cfg.highlights : [])
    .slice(0, 4)
    .map(h => ({ label: h.label, value: h.value }))

  const submit = (form) => submitCampaignLead(mailingId, 'deal', form, { preview })

  return (
    <LandingShell
      accent={accent}
      headerCta={agent?.phone && <Button href={`tel:${agent.phone}`} variant="ghost" style={{ padding: '9px 16px', fontSize: 13 }}>Direct line</Button>}
      footer="Gateway Real Estate Advisors · Licensed Brokerage · Details are confidential and subject to verification of interest."
    >
      {/* Narrow dossier column */}
      <div style={{ maxWidth: 700, margin: '0 auto', padding: 'clamp(28px,6vw,56px) var(--lx-gutter) 40px' }}>
        <div style={{ textAlign: 'center' }}>
          <Reveal as="span" className="lx-eyebrow" style={{ color: 'var(--lx-accent)' }}>
            Off-Market Opportunity · Confidential
          </Reveal>
          <Reveal as="h1" delay={70} className="lx-serif"
                  style={{ fontSize: 'clamp(32px,4.8vw,50px)', fontWeight: 600, lineHeight: 1.08, margin: '16px 0 10px' }}>
            {headline}
          </Reveal>
          <Reveal as="p" delay={120} style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--lx-ink-2)', margin: 0 }}>
            {subhead}
          </Reveal>
        </div>

        {/* Hero — blurred until the OM is requested (unless reveal_photo) */}
        {heroImg && (
          <Reveal delay={150} style={{ position: 'relative', marginTop: 26, borderRadius: 'var(--lx-radius)', overflow: 'hidden', boxShadow: 'var(--lx-shadow-md)' }}>
            <img src={heroImg.url} alt="The property (details on request)" loading="lazy" decoding="async"
                 style={{
                   width: '100%', maxHeight: 380, objectFit: 'cover', display: 'block',
                   ...(reveal ? {} : { filter: 'blur(14px) saturate(.9)', transform: 'scale(1.08)' }),
                 }} />
            {!reveal && (
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: 'rgba(30,38,66,.18)' }}>
                <span style={{
                  padding: '10px 18px', borderRadius: 99, background: 'rgba(255,255,255,.94)',
                  fontSize: 13, fontWeight: 700, color: 'var(--lx-ink)', boxShadow: 'var(--lx-shadow-sm)',
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                }}>
                  <span aria-hidden="true">🔒</span> Photos & address shared with the OM
                </span>
              </div>
            )}
          </Reveal>
        )}

        {/* Teaser metrics */}
        {highlights.length > 0 && (
          <Reveal delay={180}>
            <div className="lx-card" style={{ marginTop: 24, textAlign: 'center' }}>
              <DetailGrid items={highlights} />
            </div>
          </Reveal>
        )}

        {/* What we can say */}
        <Reveal delay={210} style={{ marginTop: 26 }}>
          <h2 className="lx-serif" style={{ fontSize: 21, fontWeight: 600, margin: '0 0 12px' }}>What we can share here</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
            {points.map((p, i) => (
              <li key={i} style={{ display: 'flex', gap: 10, fontSize: 14.5, color: 'var(--lx-ink-2)', lineHeight: 1.6 }}>
                <span style={{ color: 'var(--lx-gold)', fontWeight: 700, flexShrink: 0 }}>—</span>
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </Reveal>

        <div style={{ marginTop: 28 }}>
          <OmRequestForm ctaText={ctaText} agentName={agent?.name} onSubmit={submit} />
        </div>

        <div style={{ marginTop: 'clamp(30px,5vw,48px)' }}>
          <AgentTeam agents={agents} accent={accent} heading="Your point of contact" />
        </div>
      </div>
    </LandingShell>
  )
}
