/**
 * Multifamily Valuation Landing — public-facing, for owner-farm mailers.
 *
 * URL: /lp/multifamily/:mailingId (demo: /lp/demo/multifamily)
 *
 * Light "investor brief" treatment — photo mosaic up top like a deal book,
 * a track-record stats band, then a single centered valuation request. Reads
 * as a private brokerage memo rather than a lead-gen page.
 *
 * landing_config: { headline, subheadline, images[{url,units,price,caption}],
 *                   highlights[], cta_text, accent }
 */
import React, { useState } from 'react'
import {
  LandingShell, Section, Gallery, Lightbox, DetailGrid, AgentTeam, StatePanel,
  Reveal, Button, Field, Skeleton,
} from '../components/landing'
import { useMailingLanding, submitCampaignLead } from '../components/landing/data.js'
import '../components/landing/landing.css'

const UNIT_RANGES = ['2–4 units', '5–9 units', '10–19 units', '20–49 units', '50+ units']

const DEFAULT_HIGHLIGHTS = [
  { label: 'Closed volume',      value: '$240M+' },
  { label: 'Avg days on market', value: '38' },
  { label: 'Owners served',      value: '120+' },
]

const TRUST_LINES = [
  'Cap-rate-driven analysis built from closed comps — not automated estimates.',
  "Confidential. We won't market your property or contact your tenants.",
  'Response from a licensed broker within one business day.',
]

function MultifamilyForm({ ctaText, agentName, onSubmit }) {
  const [form, setForm]     = useState({ property_address: '', units: UNIT_RANGES[0], name: '', phone: '', email: '', message: '' })
  const [errors, setErrors] = useState({})
  const [status, setStatus] = useState('idle')
  const [topError, setTopError] = useState(null)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    const errs = {}
    if (!form.property_address.trim()) errs.property_address = 'Please enter the property address'
    if (!form.name.trim())  errs.name  = 'Please enter your name'
    if (!form.phone.trim()) errs.phone = 'Please enter a phone number'
    setErrors(errs)
    if (Object.keys(errs).length) return
    setStatus('submitting'); setTopError(null)
    try {
      await onSubmit({
        property_address: form.property_address,
        property_type:    'multifamily',
        name:  form.name,
        phone: form.phone,
        email: form.email,
        message: `Size: ${form.units}.${form.message ? ` ${form.message}` : ''}`,
      })
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
        <h2 className="lx-serif" style={{ fontSize: 26, margin: '14px 0 8px' }}>Got it — we're on it.</h2>
        <p style={{ color: 'var(--lx-mist)', lineHeight: 1.6, margin: 0 }}>
          We're running the numbers now.{agentName ? ` ${agentName} will reach out within one business day.` : ''}
        </p>
      </div>
    )
  }

  return (
    <div className="lx-card" style={{ boxShadow: 'var(--lx-shadow-md)' }}>
      <span className="lx-eyebrow" style={{ color: 'var(--lx-gold)' }}>Free · Confidential · No obligation</span>
      <h2 className="lx-serif" style={{ fontSize: 24, fontWeight: 600, margin: '12px 0 4px' }}>Request your valuation</h2>
      <p style={{ fontSize: 12.5, color: 'var(--lx-mist)', margin: '0 0 16px' }}>Takes 30 seconds. Reply in one business day.</p>
      <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Property address" required value={form.property_address} onChange={set('property_address')}
               error={errors.property_address} autoComplete="street-address" placeholder="123 Main St, Springfield" />
        <div className="lx-field">
          <label className="lx-field__label" htmlFor="mf-units">Property size</label>
          <select id="mf-units" className="lx-input" value={form.units} onChange={set('units')}>
            {UNIT_RANGES.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Your name" required value={form.name} onChange={set('name')}
                 error={errors.name} autoComplete="name" placeholder="Your name" />
          <Field label="Phone" required type="tel" value={form.phone} onChange={set('phone')}
                 error={errors.phone} autoComplete="tel" placeholder="(555) 555-5555" />
        </div>
        <Field label="Email (optional)" type="email" value={form.email} onChange={set('email')}
               autoComplete="email" placeholder="Email (optional)" />
        <Field label="Anything we should know? (optional)" multiline rows={2} value={form.message}
               onChange={set('message')} placeholder="Occupancy, recent capex, timeline…" />
        <div aria-live="polite">
          {topError && <div className="lx-field__error" style={{ marginBottom: 4 }}>{topError}</div>}
        </div>
        <Button type="submit" block loading={status === 'submitting'}>
          {status === 'submitting' ? 'Sending…' : `${ctaText} →`}
        </Button>
        <p style={{ fontSize: 11, color: 'var(--lx-mist)', textAlign: 'center', margin: 0 }}>
          Your information is private. We don't sell data.
        </p>
      </form>
    </div>
  )
}

export default function LandingMultifamily({ mailingId, preview }) {
  const { loading, notFound, cfg, agents } = useMailingLanding(mailingId, preview)
  const [lightbox, setLightbox] = useState(null)
  const agent = agents[0] || null

  if (loading) return (
    <div className="lx-root" style={{ minHeight: '100vh', padding: 'clamp(18px,5vw,40px)' }}>
      <Skeleton h={300} style={{ marginBottom: 20 }} />
      <Skeleton h={40} w={340} style={{ marginBottom: 12 }} />
      <Skeleton h={140} w="70%" />
    </div>
  )
  if (notFound) return (
    <div className="lx-root" style={{ minHeight: '100vh' }}>
      <StatePanel title="Page not found" message="This valuation page is no longer available. Reach out to Gateway Real Estate Advisors directly and we'll take care of you." />
    </div>
  )

  const accent   = cfg.accent      || '#1e2642'
  const headline = cfg.headline    || "What's your multifamily really worth in today's market?"
  const subhead  = cfg.subheadline || 'Rates moved. Comps moved. Get a fresh cap-rate-driven number from a broker who actually closes deals here.'
  const ctaText  = cfg.cta_text    || 'Get my free valuation'
  const images   = (Array.isArray(cfg.images) ? cfg.images : [])
    .map(v => (typeof v === 'string' ? { url: v } : v))
    .filter(v => v?.url)
    .map(v => ({ url: v.url, caption: v.caption || v.units || '', price: v.price || '' }))
  const highlights = (Array.isArray(cfg.highlights) && cfg.highlights.length ? cfg.highlights : DEFAULT_HIGHLIGHTS)
    .slice(0, 4)
    .map(h => ({ label: h.label, value: h.value }))

  const submit = (form) => submitCampaignLead(mailingId, 'multifamily', form, { preview })

  return (
    <LandingShell
      accent={accent}
      headerCta={agent?.phone && <Button href={`tel:${agent.phone}`} variant="ghost" style={{ padding: '9px 16px', fontSize: 13 }}>Call {agent.name.split(' ')[0]}</Button>}
      footer="Gateway Real Estate Advisors · Licensed Brokerage · This valuation is an opinion of value, not an appraisal."
    >
      <div className="lx-container" style={{ paddingTop: 'clamp(20px,4vw,40px)', paddingBottom: 40 }}>
        {/* Deal-book mosaic leads the page */}
        {images.length > 0 && (
          <Reveal>
            <Gallery images={images} onOpen={setLightbox} />
          </Reveal>
        )}

        {/* Centered memo headline */}
        <div style={{ maxWidth: 720, margin: '0 auto', textAlign: 'center', paddingTop: 'clamp(28px,5vw,48px)' }}>
          <Reveal as="span" className="lx-eyebrow" style={{ color: 'var(--lx-gold)' }}>Multifamily · Owner Brief</Reveal>
          <Reveal as="h1" delay={70} className="lx-serif"
                  style={{ fontSize: 'clamp(32px,4.6vw,52px)', fontWeight: 600, lineHeight: 1.08, margin: '14px auto 12px' }}>
            {headline}
          </Reveal>
          <Reveal as="p" delay={130} style={{ fontSize: 16.5, lineHeight: 1.65, color: 'var(--lx-ink-2)', margin: 0 }}>
            {subhead}
          </Reveal>
        </div>

        {/* Track-record band */}
        <Reveal delay={160}>
          <div className="lx-card" style={{ maxWidth: 820, margin: 'clamp(26px,4vw,40px) auto 0', borderTop: '3px solid var(--lx-gold)' }}>
            <DetailGrid items={highlights} />
          </div>
        </Reveal>

        {/* Centered request + trust lines */}
        <div style={{ maxWidth: 640, margin: 'clamp(26px,4vw,44px) auto 0' }}>
          <MultifamilyForm ctaText={ctaText} agentName={agent?.name} onSubmit={submit} />
          <ul style={{ listStyle: 'none', padding: 0, margin: '18px 4px 0', display: 'grid', gap: 9 }}>
            {TRUST_LINES.map((line, i) => (
              <li key={i} style={{ display: 'flex', gap: 10, fontSize: 13.5, color: 'var(--lx-ink-2)', lineHeight: 1.55 }}>
                <span style={{ color: 'var(--lx-gold)', fontWeight: 700, flexShrink: 0 }}>✓</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <div style={{ marginTop: 'clamp(34px,5vw,56px)' }}>
          <AgentTeam agents={agents} accent={accent} />
        </div>
      </div>

      {lightbox != null && (
        <Lightbox images={images} index={lightbox} onIndex={setLightbox} onClose={() => setLightbox(null)} />
      )}
    </LandingShell>
  )
}
