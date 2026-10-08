/**
 * Landing kit — a portfolio page's properties.
 *
 * One QR code, several properties. Each property gets its own card: cover
 * photo, name, asset and location lines, its facts, its story, its gallery and
 * — once the visitor is inside the Deal Room — its own numbers and documents.
 *
 * `property` is the public entry from landing_config.portfolio (the server has
 * already stripped what is gated, see api/_lib/dealRoom.js); `open` is the same
 * property from the unlocked room ({ financials, images, documents }), or null
 * while the visitor has not registered.
 */
import React from 'react'
import { DetailGrid, Gallery } from './sections.jsx'
import { DocList, LineIcon, financialItems } from './dealRoom.jsx'

const toNum = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && String(v).trim() !== '' ? n : null
}
const asPct = (v) => { const s = String(v).trim(); return s.endsWith('%') ? s : `${s}%` }

/** Photos as `{ url, caption, price }`, whatever shape the builder stored. */
export function normalizeImages(list) {
  return (Array.isArray(list) ? list : [])
    .map(v => (typeof v === 'string'
      ? { url: v, caption: '', price: '' }
      : { url: v?.url, caption: v?.caption || v?.units || '', price: v?.price || '' }))
    .filter(v => v?.url)
}

/**
 * The public facts a portfolio property shows on its card. Only a public price
 * is repeated per property — "Call for Offers" / "Unpriced" is said once, in
 * the hero, rather than on every card.
 */
export function propertyFacts(p, priceMode = 'public') {
  const price = priceMode === 'public' && p.price != null && p.price !== ''
    ? { label: 'Price', value: toNum(p.price), prefix: '$' } : null
  return [
    price,
    p.units          != null && { label: 'Units',        value: toNum(p.units) },
    p.price_per_unit != null && { label: 'Price / Unit', value: toNum(p.price_per_unit), prefix: '$' },
    p.cap_rate       != null && { label: 'Cap Rate',     value: asPct(p.cap_rate) },
    p.noi            != null && { label: 'NOI',          value: toNum(p.noi), prefix: '$' },
    p.gross_income   != null && { label: 'Gross Income', value: toNum(p.gross_income), prefix: '$' },
    p.building_sqft  != null && { label: 'Building SF',  value: toNum(p.building_sqft) },
    p.occupancy      != null && { label: 'Occupancy',    value: asPct(p.occupancy) },
    p.year_built     != null && { label: 'Year Built',   value: String(p.year_built) },
  ].filter(Boolean).filter(d => d.value !== null && d.value !== '' && d.value !== 'NaN' && d.value !== '%')
}

export function PortfolioProperty({ property, open, index, priceMode, onOpenPhoto, onDownload, downloading, error }) {
  const p = property
  const images = normalizeImages(open?.images?.length ? open.images : p.images)
  const cover = images[0]?.url
  const facts = [
    ...propertyFacts(p, priceMode),
    // Numbers that arrive with the room, formatted the same way the room does.
    ...financialItems(open?.financials || {}),
  ].filter((d, i, all) => all.findIndex(x => x.label === d.label) === i)   // public when teaser mode is off
  const lockedDocs = p.doc_titles || []
  return (
    <article className="lx-card" style={{ padding: 0, overflow: 'hidden' }} aria-labelledby={`pf-${p.id}`}>
      {cover && (
        <button type="button" onClick={() => onOpenPhoto?.(images, 0)} aria-label={`View photos of ${p.name || 'this property'}`}
                style={{ display: 'block', width: '100%', padding: 0, border: 0, cursor: 'zoom-in', background: 'none' }}>
          <img src={cover} alt={images[0].caption || p.name || ''} loading="lazy" decoding="async"
               style={{ display: 'block', width: '100%', aspectRatio: '16 / 9', objectFit: 'cover' }} />
        </button>
      )}
      <div style={{ padding: 'clamp(18px, 3vw, 26px)', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <header>
          <div className="lx-eyebrow" style={{ color: 'var(--lx-accent)' }}>
            {[`Property ${String(index + 1).padStart(2, '0')}`, p.asset_line].filter(Boolean).join(' · ')}
          </div>
          <h3 id={`pf-${p.id}`} className="lx-serif" style={{ fontSize: 24, fontWeight: 600, margin: '4px 0 2px', lineHeight: 1.2 }}>
            {p.name || `Property ${index + 1}`}
          </h3>
          {p.location_line && <div style={{ fontSize: 13, color: 'var(--lx-mist)' }}>{p.location_line}</div>}
        </header>

        {facts.length > 0 && <DetailGrid items={facts} still />}

        {p.description && (
          <p style={{ lineHeight: 1.75, color: 'var(--lx-ink-2)', margin: 0, fontSize: 14.5 }}>{p.description}</p>
        )}

        {images.length > 1 && (
          <Gallery images={images.slice(1)} onOpen={(i) => onOpenPhoto?.(images, i + 1)} />
        )}

        {open ? (
          open.documents?.length > 0 && (
            <div>
              <h4 className="lx-open__h" style={{ marginTop: 0 }}>Documents</h4>
              <DocList docs={open.documents} onDownload={onDownload} downloading={downloading} error={error} />
            </div>
          )
        ) : (lockedDocs.length > 0 || p.gated_photo_count > 0) && (
          <p style={{ fontSize: 13, color: 'var(--lx-mist)', margin: 0 }}>
            <LineIcon name="lock" size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            In the <a href="#deal-room" style={{ color: 'var(--lx-accent)' }}>Deal Room</a>:{' '}
            {[
              ...lockedDocs,
              p.gated_photo_count > 0 && `${p.gated_photo_count} more photo${p.gated_photo_count === 1 ? '' : 's'}`,
            ].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>
    </article>
  )
}
