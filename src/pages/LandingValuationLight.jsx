/**
 * Home Valuation Landing — LIGHT (current) variant.
 *
 * URL: /lp/valuation/:mailingId (demo: /lp/demo/valuation)
 *
 * Light, personalized, and interactive: the agent's uploaded photo (e.g. a
 * house with a pool) leads the page under a tailored headline, and the request
 * flows through a two-step form — property first, contact second — so it feels
 * like starting a valuation, not filling out a form.
 *
 * This is the default for every NEW valuation campaign. Campaigns that
 * existed before this design shipped keep rendering LandingValuationDark
 * instead (see the dispatcher in LandingValuation.jsx) so nothing already
 * live changes appearance underneath an agent.
 *
 * landing_config: { headline, subheadline, images[{url,caption}], highlights[],
 *                   cta_text, accent }
 */
import React, { useState } from 'react'
import {
  LandingShell, Section, DetailGrid, AgentTeam,
  Reveal, Button, Field,
} from '../components/landing'
import { submitCampaignLead } from '../components/landing/data.js'
import '../components/landing/landing.css'

const PROPERTY_TYPES = [
  { value: 'single-family', label: 'Single-Family Home' },
  { value: 'condo',         label: 'Condo / Townhome' },
  { value: 'multifamily',   label: 'Multifamily (2–4 units)' },
  { value: 'multifamily-5', label: 'Apartment Bldg (5+ units)' },
  { value: 'commercial',    label: 'Commercial Property' },
  { value: 'land',          label: 'Land / Lot' },
  { value: 'other',         label: 'Other' },
]

const DEFAULT_HIGHLIGHTS = [
  { label: 'Homeowners served', value: '120+' },
  { label: 'Avg days to close', value: '18' },
  { label: 'Neighborhoods',     value: '12' },
]

const HOW_IT_WORKS = [
  { title: 'Tell us about your home',   copy: 'Address and property type — that\'s all we need to start. No contact info required for step one.' },
  { title: 'We pull the real comps',    copy: 'A licensed broker reviews recent nearby sales — not a software estimate.' },
  { title: 'Your number, in one day',   copy: 'A private valuation with the comps behind it, delivered within one business day.' },
]

/* Two-step capture: property first (low commitment), contact second. */
function ValuationForm({ ctaText, agentName, onSubmit }) {
  const [step, setStep]     = useState(1)
  const [form, setForm]     = useState({ property_address: '', property_type: 'single-family', name: '', phone: '', email: '', message: '' })
  const [errors, setErrors] = useState({})
  const [status, setStatus] = useState('idle') // idle | submitting | done | error
  const [topError, setTopError] = useState(null)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const next = (e) => {
    e.preventDefault()
    if (!form.property_address.trim()) { setErrors({ property_address: 'Please enter the property address' }); return }
    setErrors({}); setStep(2)
  }

  const submit = async (e) => {
    e.preventDefault()
    const errs = {}
    if (!form.name.trim())  errs.name  = 'Please enter your name'
    if (!form.phone.trim()) errs.phone = 'Please enter a phone number'
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
        <h2 className="lx-serif" style={{ fontSize: 26, margin: '14px 0 8px' }}>Got it — we're on it.</h2>
        <p style={{ color: 'var(--lx-mist)', lineHeight: 1.6, margin: 0 }}>
          We're pulling recent comps for {form.property_address.trim() || 'your property'} now.
          {agentName ? ` ${agentName} will reach out within one business day.` : ' We\'ll reach out within one business day.'}
        </p>
      </div>
    )
  }

  return (
    <div className="lx-card" style={{ boxShadow: 'var(--lx-shadow-md)' }}>
      <span className="lx-eyebrow" style={{ color: 'var(--lx-gold)' }}>Free · Private · No obligation</span>
      <h2 className="lx-serif" style={{ fontSize: 24, fontWeight: 600, margin: '12px 0 4px' }}>
        {step === 1 ? 'Start your valuation' : 'Where should we send it?'}
      </h2>
      {/* Step progress */}
      <div aria-hidden="true" style={{ display: 'flex', gap: 6, margin: '10px 0 4px' }}>
        {[1, 2].map(s => (
          <span key={s} style={{
            height: 4, flex: 1, borderRadius: 2,
            background: s <= step ? 'var(--lx-accent)' : 'var(--lx-line)',
            transition: 'background .3s',
          }} />
        ))}
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--lx-mist)', margin: '0 0 16px' }}>
        Step {step} of 2 · {step === 1 ? 'No contact info needed yet' : 'Takes 30 seconds'}
      </p>

      {step === 1 ? (
        <form onSubmit={next} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Property address" required value={form.property_address} onChange={set('property_address')}
                 error={errors.property_address} autoComplete="street-address" placeholder="123 Main St, Springfield" />
          <div className="lx-field">
            <label className="lx-field__label" htmlFor="val-ptype">Property type</label>
            <select id="val-ptype" className="lx-input" value={form.property_type} onChange={set('property_type')}>
              {PROPERTY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <Button type="submit" block>Continue →</Button>
        </form>
      ) : (
        <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Your name" required value={form.name} onChange={set('name')}
                 error={errors.name} autoComplete="name" placeholder="Your name" />
          <Field label="Phone number" required type="tel" value={form.phone} onChange={set('phone')}
                 error={errors.phone} autoComplete="tel" placeholder="(555) 555-5555" />
          <Field label="Email (optional)" type="email" value={form.email} onChange={set('email')}
                 autoComplete="email" placeholder="Email (optional)" />
          <Field label="Anything we should know? (optional)" multiline rows={2} value={form.message}
                 onChange={set('message')} placeholder="Renovations, timeline, reason for selling…" />
          <div aria-live="polite">
            {topError && <div className="lx-field__error" style={{ marginBottom: 4 }}>{topError}</div>}
          </div>
          <Button type="submit" block loading={status === 'submitting'}>
            {status === 'submitting' ? 'Sending…' : `${ctaText} →`}
          </Button>
          <button type="button" onClick={() => setStep(1)}
                  style={{ background: 'none', border: 0, color: 'var(--lx-mist)', fontSize: 12, cursor: 'pointer', padding: 4 }}>
            ← Back to property details
          </button>
          <p style={{ fontSize: 11, color: 'var(--lx-mist)', textAlign: 'center', margin: 0 }}>
            Your information is private. We don't sell data.
          </p>
        </form>
      )}
    </div>
  )
}

export default function LandingValuationLight({ cfg, agents, mailingId, preview }) {
  const agent = agents[0] || null

  const accent   = cfg.accent      || '#1e2642'
  const headline = cfg.headline    || "What's your home worth today?"
  const subhead  = cfg.subheadline || 'Get a private, no-obligation valuation from a licensed broker who actually knows your neighborhood — not a software estimate.'
  const ctaText  = cfg.cta_text    || 'Get my free valuation'
  const images   = (Array.isArray(cfg.images) ? cfg.images : [])
    .map(v => (typeof v === 'string' ? { url: v } : v))
    .filter(v => v?.url)
  const heroImg    = images[0] || null
  const highlights = (Array.isArray(cfg.highlights) && cfg.highlights.length ? cfg.highlights : DEFAULT_HIGHLIGHTS)
    .slice(0, 4)
    .map(h => ({ label: h.label, value: h.value }))

  const submit = (form) => submitCampaignLead(mailingId, 'valuation', form, { preview })

  return (
    <LandingShell
      accent={accent}
      headerCta={agent?.phone && <Button href={`tel:${agent.phone}`} variant="ghost" style={{ padding: '9px 16px', fontSize: 13 }}>Call {agent.name.split(' ')[0]}</Button>}
      footer="Gateway Real Estate Advisors · Licensed Brokerage · This valuation is an opinion of value, not an appraisal."
    >
      <div className="lx-container" style={{ paddingTop: 'clamp(20px,4vw,44px)', paddingBottom: 40 }}>
        {/* Split hero: personalized photo + headline left, two-step form right */}
        <div className="lx-grid-2" style={{ alignItems: 'start' }}>
          <div>
            <Reveal as="span" className="lx-eyebrow" style={{ color: 'var(--lx-gold)' }}>Home Valuation</Reveal>
            <Reveal as="h1" delay={70} className="lx-serif"
                    style={{ fontSize: 'clamp(34px,5vw,56px)', fontWeight: 600, lineHeight: 1.07, margin: '14px 0 12px', maxWidth: '18ch' }}>
              {headline}
            </Reveal>
            <Reveal as="p" delay={130} style={{ fontSize: 17, lineHeight: 1.6, color: 'var(--lx-ink-2)', maxWidth: '52ch', margin: 0 }}>
              {subhead}
            </Reveal>

            {heroImg && (
              <Reveal delay={190} style={{ position: 'relative', marginTop: 26 }}>
                <img src={heroImg.url} alt={heroImg.caption || 'The property'}
                     style={{ width: '100%', maxHeight: 420, objectFit: 'cover', borderRadius: 'var(--lx-radius)', boxShadow: 'var(--lx-shadow-md)', display: 'block' }} />
                {heroImg.caption && (
                  <span style={{
                    position: 'absolute', left: 14, bottom: 14, padding: '6px 12px', borderRadius: 99,
                    background: 'rgba(255,255,255,.92)', fontSize: 12.5, fontWeight: 600, color: 'var(--lx-ink)',
                    boxShadow: 'var(--lx-shadow-sm)',
                  }}>{heroImg.caption}</span>
                )}
              </Reveal>
            )}

            <Reveal delay={240} style={{ marginTop: 28, borderTop: '1px solid var(--lx-line)', paddingTop: 22 }}>
              <DetailGrid items={highlights} />
            </Reveal>
          </div>

          <div className="lx-sticky">
            <ValuationForm ctaText={ctaText} agentName={agent?.name} onSubmit={submit} />
            {agent && (
              <p style={{ fontSize: 12.5, color: 'var(--lx-mist)', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
                Prepared personally by {agent.name}{agent.role ? `, ${agent.role}` : ''} — not an algorithm.
              </p>
            )}
          </div>
        </div>

        {/* How it works */}
        <Section title="How it works" style={{ marginTop: 'clamp(36px,6vw,64px)' }}>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {HOW_IT_WORKS.map((s, i) => (
              <li key={i} className="lx-card" style={{ padding: '18px 20px' }}>
                <div className="lx-serif" style={{ fontSize: 30, color: 'var(--lx-gold)', fontWeight: 600, lineHeight: 1 }}>{i + 1}</div>
                <div style={{ fontWeight: 700, fontSize: 15, margin: '10px 0 6px' }}>{s.title}</div>
                <div style={{ fontSize: 13.5, color: 'var(--lx-ink-2)', lineHeight: 1.6 }}>{s.copy}</div>
              </li>
            ))}
          </ol>
        </Section>

        <div style={{ marginTop: 'clamp(30px,5vw,52px)' }}>
          <AgentTeam agents={agents} accent={accent} />
        </div>
      </div>
    </LandingShell>
  )
}
