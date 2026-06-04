/**
 * Property Showcase Landing — public-facing, served at /lp/property/:mailingId
 *
 * Renders entirely from mailings.landing_config — no private CRM notes ever shown.
 * landing_config shape:
 *   { headline, subheadline, price, beds, baths, sqft, lot_size, year_built,
 *     description, features[], images[{url,caption,price}], cta_text, accent,
 *     detail_mode, units, price_per_unit, cap_rate, noi, gross_income,
 *     building_sqft, occupancy }
 *
 * UI is composed from the reusable luxury landing kit in components/landing.
 */
import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import '../components/landing/landing.css'
import {
  LandingShell, Hero, Section, DetailGrid, Gallery, Lightbox,
  LeadForm, AgentCard, Button, Reveal, Skeleton, StatePanel,
} from '../components/landing'

const toNum = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && String(v).trim() !== '' ? n : null
}
const asPct = (v) => { const s = String(v).trim(); return s.endsWith('%') ? s : `${s}%` }

export default function LandingProperty({ mailingId }) {
  const [mailing, setMailing] = useState(null)
  const [agent, setAgent] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lightbox, setLightbox] = useState(-1) // -1 = closed

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const { data: m, error: mErr } = await supabase
          .from('mailings')
          .select('id, name, agent_id, landing_config')
          .eq('id', mailingId).maybeSingle()
        if (!active) return
        if (mErr) throw mErr
        if (!m) { setError('notfound'); setLoading(false); return }
        setMailing(m)
        if (m.agent_id) {
          const { data: a } = await supabase.from('agents')
            .select('id, name, phone, email, photo_url, color, role')
            .eq('id', m.agent_id).maybeSingle()
          if (active) setAgent(a || null)
        }
      } catch {
        if (active) setError('network')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [mailingId])

  // ── Loading / error / empty states ────────────────────────────────────────
  if (loading) return <LandingSkeleton />
  if (error === 'notfound')
    return <StatePanel icon="🔑" title="Listing not available"
             message="This property page may have been moved or is no longer active." />
  if (error)
    return <StatePanel icon="📡" title="Something went wrong"
             message="We couldn't load this page. Please check your connection and try again."
             action={<Button onClick={() => location.reload()}>Try again</Button>} />

  // ── Derive view model from landing_config ─────────────────────────────────
  const cfg = mailing.landing_config || {}
  const accent = cfg.accent || '#1e2642'
  const headline = cfg.headline || mailing.name || 'Property For Sale'
  const ctaText = cfg.cta_text || 'Get more info'
  const features = (Array.isArray(cfg.features) ? cfg.features : []).filter(Boolean)
  const images = (Array.isArray(cfg.images) ? cfg.images : [])
    .map(v => (typeof v === 'string'
      ? { url: v, caption: '', price: '' }
      // Existing mailings store a `units` field used as a caption fallback —
      // preserve that so already-created campaigns render unchanged.
      : { url: v.url, caption: v.caption || v.units || '', price: v.price || '' }))
    .filter(v => v?.url)
  const heroImage = images[0]?.url
  const galleryImages = images.slice(1)

  const isCommercial = cfg.detail_mode === 'commercial'
  const details = (isCommercial ? [
    cfg.price          != null && { label: 'Price',        value: toNum(cfg.price), prefix: '$' },
    cfg.units          != null && { label: 'Units',        value: toNum(cfg.units) },
    cfg.price_per_unit != null && { label: 'Price / Unit', value: toNum(cfg.price_per_unit), prefix: '$' },
    cfg.cap_rate       != null && { label: 'Cap Rate',     value: asPct(cfg.cap_rate) },
    cfg.noi            != null && { label: 'NOI',          value: toNum(cfg.noi), prefix: '$' },
    cfg.gross_income   != null && { label: 'Gross Income', value: toNum(cfg.gross_income), prefix: '$' },
    cfg.building_sqft  != null && { label: 'Building SF',  value: toNum(cfg.building_sqft) },
    cfg.occupancy      != null && { label: 'Occupancy',    value: asPct(cfg.occupancy) },
    cfg.year_built     != null && { label: 'Year Built',   value: String(cfg.year_built) },
  ] : [
    cfg.price      != null && { label: 'Price',     value: toNum(cfg.price), prefix: '$' },
    cfg.beds       != null && { label: 'Bedrooms',  value: toNum(cfg.beds) },
    cfg.baths      != null && { label: 'Bathrooms', value: toNum(cfg.baths) },
    cfg.sqft       != null && { label: 'Sq Ft',     value: toNum(cfg.sqft) },
    cfg.lot_size   != null && { label: 'Lot',       value: toNum(cfg.lot_size), suffix: ' sqft' },
    cfg.year_built != null && { label: 'Year Built', value: String(cfg.year_built) },
  ]).filter(Boolean).filter(d => d.value !== null && d.value !== '' && d.value !== 'NaN')

  // Compact, non-animated stat strip for the hero
  const heroStats = details.slice(0, 4).map(d => ({
    label: d.label,
    value: typeof d.value === 'number'
      ? `${d.prefix || ''}${d.value.toLocaleString()}${d.suffix || ''}`
      : d.value,
  }))

  const submitLead = async (form) => {
    const res = await fetch('/api/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'capture_lead', mailing_id: mailingId, source_landing: 'property', ...form }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) throw new Error(data.error || 'Could not submit — please try again.')
  }

  return (
    <LandingShell
      accent={accent}
      headerCta={agent?.phone && (
        <Button href={`tel:${agent.phone}`} variant="ghost" style={{ padding: '8px 16px', fontSize: 13 }}>
          Call {agent.name?.split(' ')[0] || 'Us'}
        </Button>
      )}
    >
      <Hero image={heroImage} eyebrow="Property For Sale" title={headline} stats={heroStats} />

      <div className="lx-container" style={{ padding: '28px 0 72px' }}>
        <div className="lx-grid-2">
          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {details.length > 0 && (
              <Section className="lx-card"><DetailGrid items={details} /></Section>
            )}

            {(cfg.subheadline || cfg.description) && (
              <Section className="lx-card" delay={60}>
                {cfg.subheadline && (
                  <p className="lx-serif" style={{ fontSize: 19, lineHeight: 1.6, fontWeight: 500, margin: '0 0 10px' }}>
                    {cfg.subheadline}
                  </p>
                )}
                {cfg.description && (
                  <p style={{ lineHeight: 1.75, color: 'var(--lx-ink-2)', margin: 0, fontSize: 14.5 }}>{cfg.description}</p>
                )}
              </Section>
            )}

            {features.length > 0 && (
              <Section title="Property Highlights" className="lx-card" delay={80}>
                <ul className="lx-features" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {features.map((f, i) => (
                    <li className="lx-feature" key={i}>
                      <span className="lx-feature__tick" aria-hidden="true">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {galleryImages.length > 0 && (
              <Section title="Gallery" delay={100}>
                <Gallery images={galleryImages} onOpen={(i) => setLightbox(i + 1)} />
              </Section>
            )}
          </div>

          {/* Right column — sticky CTA */}
          <aside className="lx-sticky">
            <LeadForm title={ctaText} cta={ctaText} onSubmit={submitLead} agentName={agent?.name} />
            <AgentCard agent={agent} accent={accent} />
          </aside>
        </div>
      </div>

      {lightbox >= 0 && (
        <Lightbox images={images} index={lightbox} onClose={() => setLightbox(-1)} onIndex={setLightbox} />
      )}
    </LandingShell>
  )
}

/* Page-level loading skeleton that mirrors the real layout (no spinner flash). */
function LandingSkeleton() {
  return (
    <div className="lx-root" aria-busy="true" aria-label="Loading property">
      <div className="lx-header"><Skeleton w={220} h={20} /></div>
      <div style={{ height: '42vh', minHeight: 280, background: '#e9ebf0' }} className="lx-skel" />
      <div className="lx-container" style={{ padding: '28px 0 72px' }}>
        <div className="lx-grid-2">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            <div className="lx-card" style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 20 }}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i}><Skeleton w={60} h={10} style={{ marginBottom: 8 }} /><Skeleton w={90} h={24} /></div>
              ))}
            </div>
            <div className="lx-card"><Skeleton h={14} style={{ marginBottom: 10 }} /><Skeleton w="80%" h={14} /></div>
            <div className="lx-card" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} h={14} />)}
            </div>
          </div>
          <div><div className="lx-card"><Skeleton h={220} /></div></div>
        </div>
      </div>
    </div>
  )
}
