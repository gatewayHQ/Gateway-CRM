/**
 * Landing kit — the Deal Room pieces.
 *
 *   DealHero      full-bleed listing hero: status pill + Call for Offers
 *                 countdown, headline, location line, a glass stat bar and the
 *                 "Access OM & Deal Room" call to action.
 *   AnchorNav     sticky in-page section links under the hero.
 *   DealRoomTeaser what is behind the wall, shown locked: the numbers' labels
 *                 with their values hidden, the document list, the photo and
 *                 update counts. Shown beside the registration form.
 *   DealRoomOpen  the same room, unlocked: numbers, documents, updates.
 *   MobileCtaBar  a bottom bar on phones so the call to action never scrolls away.
 */
import React from 'react'
import { Reveal, Button } from './primitives.jsx'
import { useParallax } from './hooks.js'
import { daysUntil, formatLongDate } from '../../lib/dealRoomAccess.js'
import { formatBytes, DEAL_ROOM_DOC_KINDS } from '../../lib/om.js'

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
  callForOffers, primaryCta, secondaryCta, unlocked = false,
}) {
  const parallaxRef = useParallax(0.12)
  const cfo = callForOffersLabel(callForOffers)
  const bg = image
    ? { backgroundImage: `url(${image})` }
    : { background: 'linear-gradient(135deg, var(--lx-accent) 0%, #2c3a5e 100%)' }
  return (
    <section className="lx-dhero" aria-label={typeof title === 'string' ? title : 'Featured property'}>
      <div ref={image ? parallaxRef : null} className={`lx-hero__bg${image ? ' lx-hero__bg--zoom' : ''}`}
           style={bg} aria-hidden="true" />
      <div className="lx-dhero__scrim" aria-hidden="true" />
      <div className="lx-container lx-dhero__inner">
        <Reveal className="lx-dhero__pills">
          <span className="lx-pill">{status}</span>
          {cfo && (
            <span className={`lx-pill lx-pill--gold${cfo.urgent ? ' lx-pill--pulse' : ''}`}>
              Call for Offers · {cfo.date} · <b>{cfo.left}</b>
            </span>
          )}
        </Reveal>
        {assetLine && <Reveal as="div" delay={40} className="lx-dhero__asset">{assetLine}</Reveal>}
        <Reveal as="h1" delay={80} className="lx-serif lx-dhero__title">{title}</Reveal>
        {location && <Reveal as="div" delay={120} className="lx-dhero__loc">{location}</Reveal>}
        <Reveal delay={170} className="lx-dhero__ctas">
          {primaryCta && (
            <a href={primaryCta.href} onClick={primaryCta.onClick} className="lx-btn lx-btn--gold">
              {unlocked ? '✓ ' : '🔒 '}{primaryCta.label}
            </a>
          )}
          {secondaryCta && (
            <a href={secondaryCta.href} className="lx-btn lx-btn--glass">{secondaryCta.label}</a>
          )}
        </Reveal>
      </div>
      {stats.length > 0 && (
        <div className="lx-container lx-dhero__barwrap">
          <Reveal delay={220} className="lx-dhero__bar" role="list">
            {stats.map((s, i) => (
              <div className="lx-dhero__stat" role="listitem" key={i}>
                <div className="lx-serif lx-dhero__statv">{s.value}</div>
                <div className="lx-dhero__statl">{s.label}</div>
              </div>
            ))}
          </Reveal>
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
              <div className="lx-locked__val" aria-hidden="true">●●●●</div>
              <span className="lx-sr-only">Hidden until you register</span>
            </div>
          ))}
        </div>
      )}
      <ul className="lx-locked__list">
        {(summary.doc_titles || []).map((t, i) => (
          <li key={i}><span aria-hidden="true">🔒</span> {t}</li>
        ))}
        {summary.gated_photo_count > 0 && (
          <li><span aria-hidden="true">🔒</span> {summary.gated_photo_count} more photo{summary.gated_photo_count === 1 ? '' : 's'}</li>
        )}
        {summary.update_count > 0 && (
          <li><span aria-hidden="true">🔒</span> {summary.update_count} deal update{summary.update_count === 1 ? '' : 's'}
            {summary.last_update_at ? ` · latest ${formatLongDate(summary.last_update_at)}` : ''}</li>
        )}
      </ul>
    </div>
  )
}

const KIND_ICON = { om: '📘', rent_roll: '📊', t12: '📈', financials: '💵', photos: '🖼️', survey: '📐', other: '📄' }
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
                <span className="lx-doc__icon" aria-hidden="true">{KIND_ICON[d.kind] || '📄'}</span>
                <span className="lx-doc__name">
                  <b>{d.title || KIND_LABEL[d.kind] || d.filename}</b>
                  <small>{[d.filename, formatBytes(d.size)].filter(Boolean).join(' · ')}</small>
                </span>
                <Button variant="ghost" onClick={() => onDownload?.(d)} loading={downloading === d.id}
                        style={{ padding: '8px 14px', fontSize: 13 }}>
                  Download
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

