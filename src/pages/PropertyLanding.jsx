import React, { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase.js'

const fmt = (n) => n != null ? `$${Number(n).toLocaleString()}` : null
const COMMERCIAL = ['multifamily','office','land','retail','industrial','mixed-use','commercial']
const isCommercial = (type) => COMMERCIAL.includes(type)

const TYPE_LABELS = {
  residential: 'Residential', rental: 'Rental', multifamily: 'Multifamily',
  office: 'Office', land: 'Land', retail: 'Retail',
  industrial: 'Industrial', 'mixed-use': 'Mixed-Use', commercial: 'Commercial',
}

const STATUS_LABELS = {
  active: 'Active Listing', pending: 'Under Contract', sold: 'Sold',
  'off-market': 'Off Market', leased: 'Leased',
}

const STATUS_COLORS = {
  active: '#16a34a', pending: '#d97706', sold: '#6b7280',
  'off-market': '#6b7280', leased: '#2563eb',
}

// ─── Loading skeleton ────────────────────────────────────────────────────────
function LandingLoader() {
  return (
    <div className="lp lp--loading">
      <div className="lp__hero-skeleton lp__skeleton" />
      <div className="lp__main" style={{ paddingTop: 40 }}>
        <div className="lp__skeleton" style={{ height: 28, width: 220, borderRadius: 6, marginBottom: 12 }} />
        <div className="lp__skeleton" style={{ height: 48, width: 340, borderRadius: 6, marginBottom: 24 }} />
        <div style={{ display: 'flex', gap: 12, marginBottom: 40 }}>
          {[120, 90, 110].map((w, i) => (
            <div key={i} className="lp__skeleton" style={{ height: 20, width: w, borderRadius: 4 }} />
          ))}
        </div>
        <div className="lp__skeleton" style={{ height: 200, borderRadius: 12, marginBottom: 24 }} />
        <div className="lp__skeleton" style={{ height: 160, borderRadius: 12 }} />
      </div>
    </div>
  )
}

// ─── 404 ─────────────────────────────────────────────────────────────────────
function LandingNotFound() {
  return (
    <div className="lp lp--404">
      <div className="lp__404-inner">
        <div className="lp__404-icon">🏚️</div>
        <h1 className="lp__404-title">Listing Not Found</h1>
        <p className="lp__404-sub">This property may have been removed or the link is incorrect.</p>
        <a href="/" className="lp__cta-btn">← Go Back</a>
      </div>
    </div>
  )
}

// ─── Photo Gallery ───────────────────────────────────────────────────────────
function PhotoGallery({ photos, address }) {
  const [active, setActive] = useState(0)
  const [lightbox, setLightbox] = useState(false)

  useEffect(() => {
    if (!lightbox) return
    const handler = (e) => {
      if (e.key === 'Escape') setLightbox(false)
      if (e.key === 'ArrowRight') setActive(a => (a + 1) % photos.length)
      if (e.key === 'ArrowLeft')  setActive(a => (a - 1 + photos.length) % photos.length)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightbox, photos.length])

  if (photos.length === 0) {
    return (
      <div className="lp__hero lp__hero--placeholder">
        <div className="lp__hero-placeholder-content">
          <div className="lp__hero-placeholder-icon">🏢</div>
          <div className="lp__hero-placeholder-text">No photos available</div>
        </div>
        <div className="lp__hero-gradient" />
      </div>
    )
  }

  const hasThumbs = photos.length > 1

  return (
    <>
      <div className="lp__hero" onClick={() => setLightbox(true)} style={{ cursor: 'pointer' }}>
        <img src={photos[active]} alt={`${address} — photo ${active + 1}`} className="lp__hero-img" />
        <div className="lp__hero-gradient" />
        {hasThumbs && (
          <div className="lp__hero-count">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            {active + 1} / {photos.length}
          </div>
        )}
        {hasThumbs && (
          <>
            <button className="lp__hero-nav lp__hero-nav--prev" aria-label="Previous photo"
              onClick={e => { e.stopPropagation(); setActive(a => (a - 1 + photos.length) % photos.length) }}>
              ‹
            </button>
            <button className="lp__hero-nav lp__hero-nav--next" aria-label="Next photo"
              onClick={e => { e.stopPropagation(); setActive(a => (a + 1) % photos.length) }}>
              ›
            </button>
          </>
        )}
      </div>

      {hasThumbs && (
        <div className="lp__thumbs">
          {photos.map((url, i) => (
            <button key={i} className={`lp__thumb${i === active ? ' active' : ''}`}
              onClick={() => setActive(i)} aria-label={`Photo ${i + 1}`}>
              <img src={url} alt="" />
            </button>
          ))}
        </div>
      )}

      {lightbox && (
        <div className="lp__lightbox" role="dialog" aria-modal="true" aria-label="Photo viewer"
          onClick={() => setLightbox(false)}>
          <button className="lp__lightbox-close" aria-label="Close">✕</button>
          <img src={photos[active]} alt={`${address} — photo ${active + 1}`}
            className="lp__lightbox-img" onClick={e => e.stopPropagation()} />
          {hasThumbs && (
            <>
              <button className="lp__lightbox-nav lp__lightbox-nav--prev" aria-label="Previous"
                onClick={e => { e.stopPropagation(); setActive(a => (a - 1 + photos.length) % photos.length) }}>
                ‹
              </button>
              <button className="lp__lightbox-nav lp__lightbox-nav--next" aria-label="Next"
                onClick={e => { e.stopPropagation(); setActive(a => (a + 1) % photos.length) }}>
                ›
              </button>
              <div className="lp__lightbox-counter">{active + 1} / {photos.length}</div>
            </>
          )}
        </div>
      )}
    </>
  )
}

// ─── Property Specs (type-aware) ─────────────────────────────────────────────
function SpecGrid({ property }) {
  const d = property.details || {}
  const specs = []

  if (property.list_price) {
    specs.push({ label: 'Asking Price', value: fmt(property.list_price) })
  }

  const type = property.type
  if (type === 'residential' || type === 'rental') {
    if (property.beds)  specs.push({ label: 'Bedrooms', value: property.beds })
    if (property.baths) specs.push({ label: 'Bathrooms', value: property.baths })
    if (property.sqft)  specs.push({ label: 'Sq Ft', value: Number(property.sqft).toLocaleString() })
    if (property.garage > 0) specs.push({ label: 'Garage', value: `${property.garage}-car` })
    if (d.year_built)   specs.push({ label: 'Year Built', value: d.year_built })
    if (d.lot_size)     specs.push({ label: 'Lot Size', value: d.lot_size })
    if (d.stories)      specs.push({ label: 'Stories', value: d.stories })
    if (d.style)        specs.push({ label: 'Style', value: d.style })
  } else if (type === 'multifamily') {
    if (d.total_units)  specs.push({ label: 'Total Units', value: d.total_units })
    if (d.unit_mix)     specs.push({ label: 'Unit Mix', value: d.unit_mix })
    if (d.floors)       specs.push({ label: 'Floors', value: d.floors })
    if (d.year_built)   specs.push({ label: 'Year Built', value: d.year_built })
    if (property.sqft)  specs.push({ label: 'Total Sq Ft', value: Number(property.sqft).toLocaleString() })
    if (d.vacancy)      specs.push({ label: 'Vacancy Rate', value: `${d.vacancy}%` })
    if (d.noi)          specs.push({ label: 'NOI', value: fmt(d.noi) })
    if (d.cap_rate)     specs.push({ label: 'Cap Rate', value: `${d.cap_rate}%` })
  } else if (type === 'office') {
    if (property.sqft)  specs.push({ label: 'Sq Ft', value: Number(property.sqft).toLocaleString() })
    if (d.class)        specs.push({ label: 'Class', value: `Class ${d.class}` })
    if (d.floors)       specs.push({ label: 'Floors', value: d.floors })
    if (d.parking)      specs.push({ label: 'Parking', value: `${d.parking} spaces` })
    if (d.year_built)   specs.push({ label: 'Year Built', value: d.year_built })
    if (d.vacancy)      specs.push({ label: 'Vacancy', value: `${d.vacancy}%` })
  } else if (type === 'land') {
    if (d.acres)        specs.push({ label: 'Acres', value: d.acres })
    if (property.sqft)  specs.push({ label: 'Sq Ft', value: Number(property.sqft).toLocaleString() })
    if (d.land_status)  specs.push({ label: 'Status', value: d.land_status })
    if (d.zoning)       specs.push({ label: 'Zoning', value: d.zoning })
    if (d.utilities)    specs.push({ label: 'Utilities', value: d.utilities })
  } else if (type === 'retail') {
    if (property.sqft)  specs.push({ label: 'Sq Ft', value: Number(property.sqft).toLocaleString() })
    if (d.frontage)     specs.push({ label: 'Frontage', value: `${d.frontage} ft` })
    if (d.parking)      specs.push({ label: 'Parking', value: `${d.parking} spaces` })
    if (d.year_built)   specs.push({ label: 'Year Built', value: d.year_built })
    if (d.anchor_tenants) specs.push({ label: 'Anchor Tenants', value: d.anchor_tenants })
  } else if (type === 'industrial') {
    if (property.sqft)      specs.push({ label: 'Total Sq Ft', value: Number(property.sqft).toLocaleString() })
    if (d.office_sqft)      specs.push({ label: 'Office Sq Ft', value: Number(d.office_sqft).toLocaleString() })
    if (d.clear_height)     specs.push({ label: 'Clear Height', value: `${d.clear_height} ft` })
    if (d.loading_docks)    specs.push({ label: 'Loading Docks', value: d.loading_docks })
    if (d.drive_in_doors)   specs.push({ label: 'Drive-In Doors', value: d.drive_in_doors })
    if (d.year_built)       specs.push({ label: 'Year Built', value: d.year_built })
  } else if (type === 'mixed-use') {
    if (d.total_units)  specs.push({ label: 'Total Units', value: d.total_units })
    if (d.floors)       specs.push({ label: 'Floors', value: d.floors })
    if (d.res_sqft)     specs.push({ label: 'Residential Sq Ft', value: Number(d.res_sqft).toLocaleString() })
    if (d.comm_sqft)    specs.push({ label: 'Commercial Sq Ft', value: Number(d.comm_sqft).toLocaleString() })
    if (d.year_built)   specs.push({ label: 'Year Built', value: d.year_built })
    if (d.parking)      specs.push({ label: 'Parking', value: `${d.parking} spaces` })
  }

  if (property.mls_number) specs.push({ label: 'MLS #', value: property.mls_number })
  if (property.county)     specs.push({ label: 'County', value: property.county })

  if (specs.length === 0) return null

  return (
    <div className="lp__spec-grid">
      {specs.map((s, i) => (
        <div key={i} className="lp__spec-item">
          <div className="lp__spec-label">{s.label}</div>
          <div className="lp__spec-value">{s.value}</div>
        </div>
      ))}
    </div>
  )
}

// ─── Agent Card ───────────────────────────────────────────────────────────────
function AgentCard({ agent }) {
  if (!agent) return null
  const initials = agent.initials || agent.name?.split(' ').map(w => w[0]).join('').slice(0, 2) || '?'
  const color    = agent.color || '#2d3561'
  return (
    <div className="lp__agent-card">
      <div className="lp__agent-avatar" style={{ background: color }}>{initials}</div>
      <div className="lp__agent-info">
        <div className="lp__agent-name">{agent.name}</div>
        <div className="lp__agent-role">{agent.role || 'Agent'}</div>
        {agent.email && (
          <a href={`mailto:${agent.email}`} className="lp__agent-email">{agent.email}</a>
        )}
      </div>
    </div>
  )
}

// ─── Gate Form ───────────────────────────────────────────────────────────────
function GateForm({ propertyId, isCommercial, agentName }) {
  const [form, setForm]         = useState({ name: '', email: '', phone: '' })
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted]   = useState(false)
  const [error, setError]           = useState('')

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Please enter your name.'); return }
    if (!form.email.trim() || !form.email.includes('@')) { setError('Please enter a valid email.'); return }
    setError('')
    setSubmitting(true)
    try {
      const res = await fetch('/api/property-gate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId, ...form }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Request failed')
      }
      setSubmitted(true)
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="lp__gate-success">
        <div className="lp__gate-success-icon">✓</div>
        <h3 className="lp__gate-success-title">Request Received</h3>
        <p className="lp__gate-success-body">
          {agentName ? `${agentName} will` : 'Our team will'} be in touch within 24 hours with the{' '}
          {isCommercial ? 'offering memorandum and financials' : 'full property details'}.
        </p>
      </div>
    )
  }

  return (
    <form className="lp__gate-form" onSubmit={handleSubmit} noValidate>
      <div className="lp__gate-field">
        <label className="lp__gate-label" htmlFor="gate-name">Full Name <span aria-hidden>*</span></label>
        <input
          id="gate-name"
          className="lp__gate-input"
          type="text"
          autoComplete="name"
          placeholder="Jane Smith"
          value={form.name}
          onChange={e => set('name', e.target.value)}
          required
        />
      </div>
      <div className="lp__gate-field">
        <label className="lp__gate-label" htmlFor="gate-email">Email Address <span aria-hidden>*</span></label>
        <input
          id="gate-email"
          className="lp__gate-input"
          type="email"
          autoComplete="email"
          placeholder="jane@company.com"
          value={form.email}
          onChange={e => set('email', e.target.value)}
          required
        />
      </div>
      <div className="lp__gate-field">
        <label className="lp__gate-label" htmlFor="gate-phone">Phone Number</label>
        <input
          id="gate-phone"
          className="lp__gate-input"
          type="tel"
          autoComplete="tel"
          placeholder="(555) 000-0000"
          value={form.phone}
          onChange={e => set('phone', e.target.value)}
        />
      </div>
      {error && <div className="lp__gate-error" role="alert">{error}</div>}
      <button type="submit" className="lp__cta-btn" disabled={submitting}>
        {submitting ? 'Sending…' : isCommercial ? 'Request Financials & OM →' : 'Request More Information →'}
      </button>
      <p className="lp__gate-privacy">
        Your information is kept confidential and will only be used to send you property details.
      </p>
    </form>
  )
}

// ─── Main Landing Page ────────────────────────────────────────────────────────
export default function PropertyLandingPage({ propertyId }) {
  const [property, setProperty] = useState(null)
  const [agent,    setAgent]    = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from('properties')
        .select('*, agent:assigned_agent_id(id, name, email, role, color, initials)')
        .eq('id', propertyId)
        .single()
      setLoading(false)
      if (error || !data) { setNotFound(true); return }
      setProperty(data)
      if (data.agent) setAgent(data.agent)
    }
    load()
  }, [propertyId])

  useEffect(() => {
    if (property) {
      const title = [property.address, property.city, property.state].filter(Boolean).join(', ')
      document.title = `${title} — Gateway Real Estate`
    }
  }, [property])

  if (loading)  return <LandingLoader />
  if (notFound) return <LandingNotFound />

  const photos  = property.details?.photos || []
  const commercial = isCommercial(property.type)
  const fullAddress = [property.address, property.city, property.state, property.zip].filter(Boolean).join(', ')
  const statusColor = STATUS_COLORS[property.status] || '#6b7280'

  return (
    <div className="lp">
      {/* ── Brand Header ── */}
      <header className="lp__topbar">
        <div className="lp__topbar-brand">Gateway Real Estate</div>
        <a href={`mailto:${agent?.email || ''}`} className="lp__topbar-contact">
          {agent ? `Contact ${agent.name.split(' ')[0]}` : 'Contact Us'}
        </a>
      </header>

      {/* ── Photo Gallery ── */}
      <PhotoGallery photos={photos} address={property.address} />

      {/* ── Property Header ── */}
      <div className="lp__header-band">
        <div className="lp__main">
          <div className="lp__status-row">
            <span className="lp__status-badge" style={{ background: `${statusColor}20`, color: statusColor }}>
              {STATUS_LABELS[property.status] || property.status}
            </span>
            <span className="lp__type-badge">{TYPE_LABELS[property.type] || property.type}</span>
          </div>
          <h1 className="lp__address">{property.address}</h1>
          {(property.city || property.state) && (
            <p className="lp__subaddress">
              {[property.city, property.state, property.zip].filter(Boolean).join(', ')}
            </p>
          )}
          {property.list_price && (
            <div className="lp__price">{fmt(property.list_price)}</div>
          )}
        </div>
      </div>

      {/* ── Main Content ── */}
      <div className="lp__body">
        <div className="lp__main">

          {/* ── Two-column layout: content + sidebar ── */}
          <div className="lp__layout">

            {/* ─ Left column ─ */}
            <div className="lp__content">

              {/* Property Specs */}
              <section className="lp__card" aria-label="Property details">
                <h2 className="lp__card-title">Property Details</h2>
                <SpecGrid property={property} />
              </section>

              {/* Notes / Description */}
              {property.notes && (
                <section className="lp__card" aria-label="Property description">
                  <h2 className="lp__card-title">About This Property</h2>
                  <p className="lp__notes">{property.notes}</p>
                </section>
              )}

              {/* Location */}
              {fullAddress && (
                <section className="lp__card" aria-label="Location">
                  <h2 className="lp__card-title">Location</h2>
                  <p className="lp__location-address">{fullAddress}</p>
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="lp__map-link"
                  >
                    View on Google Maps →
                  </a>
                </section>
              )}
            </div>

            {/* ─ Right sidebar ─ */}
            <aside className="lp__sidebar">

              {/* Gate / Inquiry Form */}
              <div className="lp__gate-card" id="inquire">
                <h2 className="lp__gate-title">
                  {commercial ? '📋 Request Financials & OM' : '📬 Request More Information'}
                </h2>
                <p className="lp__gate-sub">
                  {commercial
                    ? 'Complete the form below to receive the offering memorandum, financials, and rent roll.'
                    : 'Fill out the form below and an agent will reach out with full details.'}
                </p>
                <GateForm
                  propertyId={propertyId}
                  isCommercial={commercial}
                  agentName={agent?.name?.split(' ')[0]}
                />
              </div>

              {/* Listing Agent */}
              {agent && (
                <div className="lp__card" style={{ marginTop: 16 }}>
                  <h2 className="lp__card-title">Listing Agent</h2>
                  <AgentCard agent={agent} />
                </div>
              )}
            </aside>
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <footer className="lp__footer">
        <div className="lp__main">
          <div className="lp__footer-brand">Gateway Real Estate Advisors</div>
          <div className="lp__footer-note">
            This listing is subject to change or withdrawal without notice. All information is deemed reliable but not guaranteed.
          </div>
        </div>
      </footer>
    </div>
  )
}
