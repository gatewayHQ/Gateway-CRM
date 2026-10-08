/**
 * Property Showcase Landing — public-facing, served at /lp/property/:mailingId
 *
 * Renders entirely from mailings.landing_config — no private CRM notes ever shown.
 * landing_config shape:
 *   { headline, subheadline, price, beds, baths, sqft, lot_size, year_built,
 *     description, features[], images[{url,caption,price}], cta_text, accent,
 *     detail_mode, units, price_per_unit, cap_rate, noi, gross_income,
 *     building_sqft, occupancy,
 *     eyebrow, asset_line, location_line, call_for_offers_date, price_display,
 *     om: { filename, title, size, available },     ← gated OM download
 *     deal_room: { available, teaser, doc_titles, gated_fields, … } }
 *
 * DEAL ROOM. When the campaign has an OM or other Deal Room documents, the page
 * is a public teaser (hero, story, highlights, a few photos) and ONE
 * registration form opens the rest: the underwriting numbers, the full gallery,
 * every document and the dated updates. What is public and what is gated is
 * decided on the server (api/_lib/dealRoom.js) — the gated numbers are not in
 * this page's data until the visitor registers. A registered visitor, or one
 * arriving from a "New in the Deal Room" email (?dr=…), walks straight back in.
 *
 * UI is composed from the reusable luxury landing kit in components/landing.
 */
import React, { useEffect, useState } from 'react'
import { fetchPublicAgents, fetchPublicAgentsLegacy } from '../lib/services/publicPages.js'
import { initScanTracking, withVisitId } from '../lib/scanTracking.js'
import { fetchPublicMailing } from '../lib/publicMailing.js'
import '../components/landing/landing.css'
import {
  LandingShell, Section, DetailGrid, Gallery, Lightbox, LeadForm, AgentCard, AgentTeam, Button, Skeleton, StatePanel, OmGate,
  DealHero, AnchorNav, DealRoomTeaser, DealRoomOpen, MobileCtaBar, openDownload, LineIcon,
} from '../components/landing'
import { normalizeOm, requestOm } from '../lib/om.js'
import { loadAccessToken, saveAccessToken, takeTokenFromUrl, fetchDealRoom, requestDocument } from '../lib/dealRoomAccess.js'

const toNum = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && String(v).trim() !== '' ? n : null
}
const asPct = (v) => { const s = String(v).trim(); return s.endsWith('%') ? s : `${s}%` }

export default function LandingProperty({ mailingId, preview = null }) {
  // Preview mode: render the production page from injected sample data with no
  // database fetch (used by the /lp/demo route for design review).
  const [mailing, setMailing] = useState(
    preview ? { id: 'demo', name: preview.name, agent_id: null, landing_config: preview.config } : null
  )
  // `agents` holds 1–2 advisors (primary first); `agent` is the primary, used
  // for the header CTA + sidebar card.
  const previewAgents = preview ? (preview.agents || (preview.agent ? [preview.agent] : [])) : []
  const [agents, setAgents] = useState(previewAgents)
  const [agent, setAgent] = useState(previewAgents[0] || null)
  const [loading, setLoading] = useState(!preview)
  const [error, setError] = useState(null)
  const [lightbox, setLightbox] = useState(-1) // -1 = closed
  // Deal Room: the unlocked contents, the visitor's access token, and the
  // document currently being fetched.
  const [dealRoom, setDealRoom] = useState(null)
  const [accessToken, setAccessToken] = useState(null)
  const [docBusy, setDocBusy] = useState(null)
  const [docError, setDocError] = useState(null)
  // Registered, but the page's NDA is not signed yet: the gate opens on that step.
  const [ndaPending, setNdaPending] = useState(null)

  // A visitor who registered before (or clicked a "New in the Deal Room" email)
  // walks straight back in.
  useEffect(() => {
    if (preview || !mailingId) return
    const token = takeTokenFromUrl(mailingId) || loadAccessToken(mailingId)
    if (!token) return
    let active = true
    fetchDealRoom(mailingId, token)
      .then(room => {
        if (!active || !room) return
        setAccessToken(token)
        if (room.ndaPending) setNdaPending(room.ndaPending)
        else setDealRoom(room)
      })
      .catch(() => { /* stay on the public page; the form still works */ })
    return () => { active = false }
  }, [mailingId, preview])

  // Capture the QR scan's visit id (and replay the scan if the server could not
  // confirm the write) before anything else — see src/lib/scanTracking.js.
  useEffect(() => { initScanTracking() }, [])

  useEffect(() => {
    if (preview) return // skip fetch in demo mode
    let active = true
    ;(async () => {
      try {
        // Service-key read, not `supabase.from('mailings')` — this page is
        // anonymous and 0027 closed that table to anon. See lib/publicMailing.js.
        const m = await fetchPublicMailing(mailingId)
        if (!active) return
        if (!m) { setError('notfound'); setLoading(false); return }
        setMailing(m)

        // Build the advisor list: the mailing's primary agent first, then any
        // co-agents named in landing_config.agent_ids. Per-mailing overrides in
        // landing_config.agent_overrides (bio/photo/role/name) win over the
        // agent's stored profile — that's how the builder customizes a mailing.
        const cfg = m.landing_config || {}
        const ids = [...new Set(
          [m.agent_id, ...(Array.isArray(cfg.agent_ids) ? cfg.agent_ids : [])].filter(Boolean)
        )]
        if (ids.length) {
          // Include bio; fall back to the pre-0004 column set if that migration
          // hasn't run yet (selecting a missing column would otherwise error).
          let { data: rows, error: agErr } = await fetchPublicAgents(ids)
          if (agErr) {
            ;({ data: rows } = await fetchPublicAgentsLegacy(ids))
          }
          const overrides = cfg.agent_overrides || {}
          const ordered = ids
            .map(id => (rows || []).find(r => r.id === id))
            .filter(Boolean)
            .map(r => ({ ...r, ...(overrides[r.id] || {}) }))
          if (active) { setAgents(ordered); setAgent(ordered[0] || null) }
        }
      } catch {
        if (active) setError('network')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [mailingId, preview])

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
  const normImages = (list) => (Array.isArray(list) ? list : [])
    .map(v => (typeof v === 'string'
      ? { url: v, caption: '', price: '' }
      // Existing mailings store a `units` field used as a caption fallback —
      // preserve that so already-created campaigns render unchanged.
      : { url: v.url, caption: v.caption || v.units || '', price: v.price || '' }))
    .filter(v => v?.url)
  // Once the visitor is inside the Deal Room they get the full photo set; the
  // public page only ever received the first few (api/_lib/dealRoom.js).
  const images = normImages(dealRoom?.images?.length ? dealRoom.images : cfg.images)
  const heroImage = images[0]?.url
  const galleryImages = images.slice(1)

  const isCommercial = cfg.detail_mode === 'commercial'
  const priceMode = ['unpriced', 'call_for_offers', 'gated'].includes(cfg.price_display) ? cfg.price_display : 'public'
  const priceDetail =
    priceMode === 'call_for_offers' ? { label: 'Price', value: 'Call for Offers' }
    : priceMode === 'unpriced'      ? { label: 'Price', value: 'Unpriced' }
    : priceMode === 'gated'         ? null
    : cfg.price != null             ? { label: 'Price', value: toNum(cfg.price), prefix: '$' } : null
  // Whatever the server left in the public config. In teaser mode the
  // underwriting numbers are simply absent here — they arrive with the room.
  const details = (isCommercial ? [
    priceDetail,
    cfg.units          != null && { label: 'Units',        value: toNum(cfg.units) },
    cfg.price_per_unit != null && { label: 'Price / Unit', value: toNum(cfg.price_per_unit), prefix: '$' },
    cfg.cap_rate       != null && { label: 'Cap Rate',     value: asPct(cfg.cap_rate) },
    cfg.noi            != null && { label: 'NOI',          value: toNum(cfg.noi), prefix: '$' },
    cfg.gross_income   != null && { label: 'Gross Income', value: toNum(cfg.gross_income), prefix: '$' },
    cfg.building_sqft  != null && { label: 'Building SF',  value: toNum(cfg.building_sqft) },
    cfg.occupancy      != null && { label: 'Occupancy',    value: asPct(cfg.occupancy) },
    cfg.year_built     != null && { label: 'Year Built',   value: String(cfg.year_built) },
  ] : [
    priceDetail,
    cfg.beds       != null && { label: 'Bedrooms',  value: toNum(cfg.beds) },
    cfg.baths      != null && { label: 'Bathrooms', value: toNum(cfg.baths) },
    cfg.sqft       != null && { label: 'Sq Ft',     value: toNum(cfg.sqft) },
    cfg.lot_size   != null && { label: 'Lot',       value: toNum(cfg.lot_size), suffix: ' sqft' },
    cfg.year_built != null && { label: 'Year Built', value: String(cfg.year_built) },
  ]).filter(Boolean).filter(d => d.value !== null && d.value !== '' && d.value !== 'NaN')

  // Hero stat bar: the first four public facts, formatted as text.
  const heroStats = details.slice(0, 4).map(d => ({
    label: d.label,
    value: typeof d.value === 'number' ? `${d.prefix || ''}${d.value.toLocaleString()}${d.suffix || ''}` : d.value,
  }))

  // The Deal Room. `room` is the public summary (what is behind the wall);
  // `dealRoom` is the unlocked contents once this visitor has registered.
  const om = normalizeOm(cfg.om)
  const room = cfg.deal_room?.available
    ? cfg.deal_room
    : om ? { available: true, teaser: false, doc_titles: [om.title || 'Offering Memorandum'], gated_fields: [], gated_photo_count: 0, update_count: 0 } : null
  const hasRoom = !!room
  const unlocked = !!dealRoom

  const unlockOm = async (fields) => {
    if (preview) {
      await new Promise(r => setTimeout(r, 700))
      setDealRoom({ financials: {}, images: cfg.images || [], documents: om ? [{ id: 'om', kind: 'om', title: om.title, filename: om.filename, size: om.size }] : [], updates: [] })
      return { url: '', filename: om?.filename }
    }
    const res = await requestOm(withVisitId({ mailing_id: mailingId, source_landing: 'property', ...fields }))
    if (res.access_token) { saveAccessToken(mailingId, res.access_token); setAccessToken(res.access_token) }
    if (res.deal_room) setDealRoom(res.deal_room)
    return res
  }

  const downloadDoc = async (doc) => {
    if (preview) return
    setDocBusy(doc.id); setDocError(null)
    try {
      const grant = await requestDocument(mailingId, accessToken, doc.id)
      openDownload(grant)
    } catch (err) {
      setDocError(err.message)
    } finally {
      setDocBusy(null)
    }
  }

  const submitLead = async (form) => {
    if (preview) { await new Promise(r => setTimeout(r, 700)); return } // demo: simulate send
    const res = await fetch('/api/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withVisitId({ action: 'capture_lead', mailing_id: mailingId, source_landing: 'property', ...form })),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) throw new Error(data.error || 'Could not submit — please try again.')
  }

  const firstName = agent?.name?.split(' ')[0]
  const primaryCta = hasRoom
    ? { label: unlocked ? 'Open the Deal Room' : 'Access OM & Deal Room', href: '#deal-room' }
    : { label: ctaText, href: '#contact' }
  const anchors = [
    { href: '#overview', label: 'Overview' },
    features.length > 0 && { href: '#highlights', label: 'Highlights' },
    galleryImages.length > 0 && { href: '#gallery', label: 'Gallery' },
    hasRoom ? { href: '#deal-room', label: 'Deal Room' } : { href: '#contact', label: 'Contact' },
    agents.length > 0 && { href: '#advisors', label: agents.length > 1 ? 'Advisors' : 'Advisor' },
  ].filter(Boolean)

  return (
    <LandingShell
      accent={accent}
      className="lx-root--mbar lx-root--still"
      headerCta={agent?.phone && (
        <Button href={`tel:${agent.phone}`} variant="ghost" style={{ padding: '8px 16px', fontSize: 13 }}>
          Call {firstName || 'Us'}
        </Button>
      )}
    >
      <DealHero
        image={heroImage}
        status={cfg.eyebrow || (isCommercial ? 'Exclusive Offering' : 'Property For Sale')}
        assetLine={cfg.asset_line}
        title={headline}
        location={cfg.location_line}
        stats={heroStats}
        callForOffers={cfg.call_for_offers_date}
        primaryCta={primaryCta}
        unlocked={unlocked}
      />
      <AnchorNav items={anchors} />

      <div className="lx-container" style={{ padding: '28px 0 72px' }}>
        <div className="lx-grid-2">
          {/* Left column */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {unlocked && (
              <div id="deal-room">
                <DealRoomOpen room={dealRoom} visitorName={dealRoom.visitor?.first_name}
                              onDownload={downloadDoc} downloading={docBusy} error={docError} />
              </div>
            )}

            <div id="overview" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              {details.length > 0 && (
                <Section className="lx-card"><DetailGrid items={details} still /></Section>
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
            </div>

            {features.length > 0 && (
              <Section title="Investment Highlights" delay={80} id="highlights">
                <ul className="lx-hl">
                  {features.map((f, i) => (
                    <li className="lx-hl__item" key={i}>
                      <span className="lx-hl__n">{String(i + 1).padStart(2, '0')}</span>
                      {f}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {galleryImages.length > 0 && (
              <Section title="Gallery" delay={100} id="gallery">
                <Gallery images={galleryImages} onOpen={(i) => setLightbox(i + 1)} />
                {!unlocked && room?.gated_photo_count > 0 && (
                  <p style={{ fontSize: 13, color: 'var(--lx-mist)', margin: '10px 0 0' }}>
                    <LineIcon name="lock" size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                    {room.gated_photo_count} more photo{room.gated_photo_count === 1 ? '' : 's'} in the{' '}
                    <a href="#deal-room" style={{ color: 'var(--lx-accent)' }}>Deal Room</a>
                  </p>
                )}
              </Section>
            )}
          </div>

          {/* Right column — sticky call to action */}
          <aside className="lx-sticky">
            {hasRoom && !unlocked && (
              <>
                {/* One form, not two: the Deal Room registration is the only
                    ask. A plain "call me" form beside it used to win the
                    easier half of every visitor and lose the email. */}
                <OmGate id="deal-room" om={om} forceShow autoDownload={false} onUnlock={unlockOm} accent={accent} qualifiers
                        ndaPending={ndaPending}
                        onNdaSigned={(res) => { setNdaPending(null); if (res?.deal_room) setDealRoom(res.deal_room) }}
                        title={room.teaser ? 'Offering Memorandum & Deal Room' : (om?.title || 'Offering Memorandum')}
                        subtext={room.nda_required
                          ? 'Financials, rent roll, photos, the OM and every update as the deal moves. Register and sign the NDA — it opens instantly.'
                          : room.teaser
                          ? 'Financials, rent roll, the OM and every update as the deal moves. Register once — it opens instantly.'
                          : undefined}
                        ctaLabel="Enter the Deal Room" />
                <DealRoomTeaser summary={room} priceGated={priceMode === 'gated'} />
                {agent?.phone && (
                  <p style={{ fontSize: 13, color: 'var(--lx-mist)', textAlign: 'center', margin: 0 }}>
                    Prefer to talk? <a href={`tel:${agent.phone}`} style={{ color: 'var(--lx-accent)', fontWeight: 600 }}>Call {firstName}</a>
                  </p>
                )}
              </>
            )}
            {!hasRoom && (
              <div id="contact">
                <LeadForm title={ctaText} cta={ctaText} onSubmit={submitLead} agentName={agent?.name} />
              </div>
            )}
            <AgentCard agent={agent} accent={accent} />
          </aside>
        </div>

        {/* Meet your advisor(s) — full width, below the listing details */}
        <div id="advisors" style={{ marginTop: 'clamp(36px, 7vw, 72px)' }}>
          <AgentTeam agents={agents} accent={accent} />
        </div>
      </div>

      <MobileCtaBar label={primaryCta.label} href={primaryCta.href} phone={agent?.phone} />

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
