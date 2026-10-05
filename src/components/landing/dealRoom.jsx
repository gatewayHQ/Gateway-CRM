/**
 * Landing kit — the Deal Room pieces.
 *
 *   DealHero      full-bleed listing hero: status label + Call for Offers
 *                 countdown, headline, location line, a hairline stat row and
 *                 the "Access OM & Deal Room" call to action.
 *
 * Style: still and quiet on purpose — no motion, no emoji. Thin-stroke line
 * icons, hairline rules, square-ish corners.
 *   AnchorNav     sticky in-page section links under the hero.
 *   DealRoomTeaser what is behind the wall, shown locked: the numbers' labels
 *                 with their values hidden, the document list, the photo and
 *                 update counts. Shown beside the registration form.
 *   DealRoomOpen  the same room, unlocked: numbers, documents, updates.
 *   MobileCtaBar  a bottom bar on phones so the call to action never scrolls away.
 */
import React from 'react'
import { Button } from './primitives.jsx'
import { daysUntil, formatLongDate } from '../../lib/dealRoomAccess.js'
import { formatBytes, DEAL_ROOM_DOC_KINDS } from '../../lib/om.js'

/** Thin-stroke line icons, drawn in currentColor. */
const ICON_PATHS = {
  lock:     'M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9.5h-13z',
  unlock:   'M7 11V8a5 5 0 0 1 9.6-2M5.5 11h13v9.5h-13z',
  file:     'M14 3H6.5v18h11V6.5L14 3zM14 3v3.5h3.5',
  sheet:    'M5 4h14v16H5zM5 9.5h14M5 15h14M10.5 4v16',
  image:    'M4 5h16v14H4zM4 15.5l4.5-4.5 4 4 2.5-2.5L20 17.5M15.5 9.5h.01',
  arrow:    'M5 12h14M13 6l6 6-6 6',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 20h14',
}
export function LineIcon({ name, size = 16, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
         style={{ flexShrink: 0, ...style }}>
      <path d={ICON_PATHS[name] || ICON_PATHS.file} />
    </svg>
  )
}

/** "Call for Offers · October 8 · 3 days left" — or null when no date is set. */
export function callForOffersLabel(isoDate, now = new Date()) {
  const days = daysUntil(isoDate, now)
  if (days == null) return null
  const date = formatLongDate(isoDate)
  if (days < 0)  return { date, left: 'Offers under review', urgent: false }
  if (days === 0) return { date, left: 'Due today', urgent: true }
  if (days === 1) return { date, left: '1 day left', urgent: true }
  return { date, left: `${days} days left`, urgent: days <= 7 }
}

export function DealHero({
  image, status = 'Exclusive Offering', assetLine, title, location, stats = [],
  callForOffers, primaryCta, unlocked = false,
}) {
  const cfo = callForOffersLabel(callForOffers)
  const bg = image
    ? { backgroundImage: `url(${image})` }
    : { background: 'linear-gradient(135deg, var(--lx-accent) 0%, #2c3a5e 100%)' }
  return (
    <section className="lx-dhero" aria-label={typeof title === 'string' ? title : 'Featured property'}>
      <div className="lx-hero__bg" style={bg} aria-hidden="true" />
      <div className="lx-dhero__scrim" aria-hidden="true" />
      <div className="lx-container lx-dhero__inner">
        <div className="lx-dhero__meta">
          <span>{status}</span>
          {cfo && (
            <span className="lx-dhero__cfo">
              Call for Offers {cfo.date} <span aria-hidden="true">/</span> <b>{cfo.left}</b>
            </span>
          )}
        </div>
        {assetLine && <div className="lx-dhero__asset">{assetLine}</div>}
        <h1 className="lx-serif lx-dhero__title">{title}</h1>
        {location && <div className="lx-dhero__loc">{location}</div>}
        {primaryCta && (
          <div className="lx-dhero__ctas">
            <a href={primaryCta.href} onClick={primaryCta.onClick} className="lx-btn lx-btn--gold">
              <LineIcon name={unlocked ? 'unlock' : 'lock'} />
              {primaryCta.label}
              <LineIcon name="arrow" />
            </a>
          </div>
        )}
      </div>
      {stats.length > 0 && (
        <div className="lx-container lx-dhero__barwrap">
          <div className="lx-dhero__bar" role="list">
            {stats.map((s, i) => (
              <div className="lx-dhero__stat" role="listitem" key={i}>
                <div className="lx-dhero__statl">{s.label}</div>
                <div className="lx-serif lx-dhero__statv">{s.value}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

export function AnchorNav({ items = [] }) {
  if (items.length < 2) return null
  return (
    <nav className="lx-anchors" aria-label="On this page">
      <div className="lx-container lx-anchors__row">
        {items.map(it => <a key={it.href} href={it.href} className="lx-anchors__a">{it.label}</a>)}
      </div>
    </nav>
  )
}

const FIELD_LABEL = {
  price: 'Asking Price', cap_rate: 'Cap Rate', noi: 'NOI', gross_income: 'Gross Income',
  price_per_unit: 'Price / Unit', occupancy: 'Occupancy',
}

/** Locked view: labels without values. Never receives the values — the server stripped them. */
export function DealRoomTeaser({ summary, priceGated = false }) {
  if (!summary?.available) return null
  const fields = [...(priceGated ? ['price'] : []), ...(summary.gated_fields || [])]
  return (
    <div className="lx-card lx-locked">
      <div className="lx-eyebrow" style={{ color: 'var(--lx-accent)' }}>Inside the Deal Room</div>
      {fields.length > 0 && (
        <div className="lx-locked__grid" aria-label="Financials, unlocked after registration">
          {fields.map(f => (
            <div key={f} className="lx-locked__tile">
              <div className="lx-detail__label">{FIELD_LABEL[f] || f}</div>
              <div className="lx-locked__val" aria-hidden="true"><LineIcon name="lock" size={14} /></div>
              <span className="lx-sr-only">Hidden until you register</span>
            </div>
          ))}
        </div>
      )}
      <ul className="lx-locked__list">
        {(summary.doc_titles || []).map((t, i) => (
          <li key={i}><LineIcon name="file" size={15} /> {t}</li>
        ))}
        {summary.gated_photo_count > 0 && (
          <li><LineIcon name="image" size={15} /> {summary.gated_photo_count} more photo{summary.gated_photo_count === 1 ? '' : 's'}</li>
        )}
        {summary.update_count > 0 && (
          <li><LineIcon name="sheet" size={15} /> {summary.update_count} deal update{summary.update_count === 1 ? '' : 's'}
            {summary.last_update_at ? ` · latest ${formatLongDate(summary.last_update_at)}` : ''}</li>
        )}
      </ul>
    </div>
  )
}

const KIND_ICON = { om: 'file', rent_roll: 'sheet', t12: 'sheet', financials: 'sheet', photos: 'image', survey: 'file', other: 'file' }
const KIND_LABEL = {
  om: 'Offering Memorandum',
  ...Object.fromEntries(DEAL_ROOM_DOC_KINDS.map(k => [k.value, k.label])),
}

function fmtMoney(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) && String(v).trim() !== '' ? `$${Math.round(n).toLocaleString()}` : String(v)
}
const pct = (v) => { const s = String(v).trim(); return s.endsWith('%') ? s : `${s}%` }

export function financialItems(financials = {}) {
  const f = financials
  return [
    f.price          != null && { label: 'Asking Price', value: fmtMoney(f.price) },
    f.cap_rate       != null && { label: 'Cap Rate',     value: pct(f.cap_rate) },
    f.noi            != null && { label: 'NOI',          value: fmtMoney(f.noi) },
    f.gross_income   != null && { label: 'Gross Income', value: fmtMoney(f.gross_income) },
    f.price_per_unit != null && { label: 'Price / Unit', value: fmtMoney(f.price_per_unit) },
    f.occupancy      != null && { label: 'Occupancy',    value: pct(f.occupancy) },
  ].filter(Boolean)
}

/** Unlocked view. `onDownload(doc)` fetches a fresh signed URL per click. */
export function DealRoomOpen({ room, visitorName, onDownload, downloading, error }) {
  if (!room) return null
  const fin = financialItems(room.financials)
  return (
    <div className="lx-card lx-open">
      <div className="lx-eyebrow" style={{ color: 'var(--lx-accent)' }}>
        Deal Room{visitorName ? ` · Welcome back, ${visitorName}` : ''}
      </div>
      {fin.length > 0 && (
        <div className="lx-details" style={{ margin: '12px 0 18px' }}>
          {fin.map((d, i) => (
            <div key={i}>
              <div className="lx-detail__label">{d.label}</div>
              <div className="lx-serif lx-detail__value">{d.value}</div>
            </div>
          ))}
        </div>
      )}
      {room.documents?.length > 0 && (
        <>
          <h3 className="lx-open__h">Documents</h3>
          <ul className="lx-docs">
            {room.documents.map(d => (
              <li key={d.id} className="lx-doc">
                <span className="lx-doc__icon"><LineIcon name={KIND_ICON[d.kind]} size={18} /></span>
                <span className="lx-doc__name">
                  <b>{d.title || KIND_LABEL[d.kind] || d.filename}</b>
                  <small>{[d.filename, formatBytes(d.size)].filter(Boolean).join(' · ')}</small>
                </span>
                <Button variant="ghost" onClick={() => onDownload?.(d)} loading={downloading === d.id}
                        style={{ padding: '7px 12px', fontSize: 12.5 }}>
                  <LineIcon name="download" size={14} /> Download
                </Button>
              </li>
            ))}
          </ul>
          {error && <div role="alert" className="lx-field__error" style={{ marginTop: 8 }}>{error}</div>}
        </>
      )}
      {room.updates?.length > 0 && (
        <>
          <h3 className="lx-open__h">Deal updates</h3>
          <ol className="lx-updates">
            {room.updates.map(u => (
              <li key={u.id} className="lx-update">
                {u.date && <div className="lx-update__date">{formatLongDate(u.date)}</div>}
                <div className="lx-update__title">{u.title}</div>
                {u.body && <p className="lx-update__body">{u.body}</p>}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

export function MobileCtaBar({ label, href, onClick, phone }) {
  return (
    <div className="lx-mbar" role="region" aria-label="Quick actions">
      <a href={href} onClick={onClick} className="lx-btn lx-btn--gold lx-mbar__main">{label}</a>
      {phone && <a href={`tel:${phone}`} className="lx-btn lx-btn--ghost lx-mbar__call" aria-label="Call the listing agent">Call</a>}
    </div>
  )
}

