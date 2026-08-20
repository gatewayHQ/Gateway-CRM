// ─────────────────────────────────────────────────────────────────────────────
// Deal announcements — the "Just Closed / Under Contract / New Listing / Price
// Reduced" mass email built from a property record.
//
// Pure module (no React, no Supabase), imported by BOTH the browser wizard and
// the server-side send handler (api/_lib/massEmail.js). That sharing is the
// point: the preview an agent approves and the HTML that actually reaches the
// recipient are produced by the same function, so "it looked different in the
// preview" can't happen.
//
// Merge tokens follow the existing {{camelCase}} convention already used by
// src/pages/Templates.jsx and api/cron.js.
// ─────────────────────────────────────────────────────────────────────────────

import { PROPERTY_TYPE_LABELS } from './enums.js'

// ─── Deal statuses ────────────────────────────────────────────────────────────
// The announcement's headline. Distinct from `properties.status` and from
// `deals.stage`: an agent may announce "Just Closed" from a property whose CRM
// status was never moved, and a price reduction is not a status at all. Kept as
// its own vocabulary rather than derived, so the announcement says what the
// agent means it to say.
export const DEAL_ANNOUNCEMENT_STATUSES = ['closed', 'under-contract', 'new-listing', 'price-reduced', 'coming-soon']

export const DEAL_ANNOUNCEMENT_STATUS_LABELS = {
  closed:           'Just Closed',
  'under-contract': 'Under Contract',
  'new-listing':    'New Listing',
  'price-reduced':  'Price Reduced',
  'coming-soon':    'Coming Soon',
}

// Accent colour for the status ribbon in the email. Inline hex rather than the
// app's CSS variables — an email client has no stylesheet of ours.
export const DEAL_ANNOUNCEMENT_STATUS_COLORS = {
  closed:           '#0f766e',
  'under-contract': '#b45309',
  'new-listing':    '#1d4ed8',
  'price-reduced':  '#be123c',
  'coming-soon':    '#4338ca',
}

export const statusLabel = (s) => DEAL_ANNOUNCEMENT_STATUS_LABELS[s] || 'Announcement'

// ─── Merge tokens ─────────────────────────────────────────────────────────────
// Surfaced in the template editor as clickable chips, and the contract the
// renderer implements. `{{customMessage}}` is the agent's free-text block —
// a template that omits it still gets the message appended, so the note an
// agent typed can never silently vanish because the template didn't mention it.
export const ANNOUNCEMENT_TOKENS = [
  { token: '{{firstName}}',       label: 'Recipient first name' },
  { token: '{{lastName}}',        label: 'Recipient last name'  },
  { token: '{{agentName}}',       label: 'Your name'            },
  { token: '{{propertyAddress}}', label: 'Property address'     },
  { token: '{{assetType}}',       label: 'Asset type'           },
  { token: '{{unitCount}}',       label: 'Unit count'           },
  { token: '{{price}}',           label: 'Price'                },
  { token: '{{terms}}',           label: 'Price / terms note'   },
  { token: '{{dealStatus}}',      label: 'Deal status'          },
  { token: '{{customMessage}}',   label: 'Your custom message'  },
]

const money = (val) => {
  const n = Number(val)
  if (!Number.isFinite(n) || n <= 0) return ''
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

/**
 * Every photo the CRM already holds for a property, newest first in the order
 * the agent arranged them. Properties store uploads under details.photos[]
 * (public URLs in the `property-photos` bucket, see src/pages/Properties.jsx).
 */
export function propertyPhotos(property) {
  const photos = property?.details?.photos
  return Array.isArray(photos) ? photos.filter(Boolean) : []
}

/** The photo an announcement defaults to — the property's first image. */
export function defaultPhotoUrl(property) {
  return propertyPhotos(property)[0] || null
}

/**
 * Unit count for a property. Multifamily records carry it under
 * details.total_units (the field the property form writes); anything else has
 * no unit count and renders blank rather than "0".
 */
export function unitCount(property) {
  const raw = property?.details?.total_units
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? String(n) : ''
}

/**
 * The price to announce. A closed deal announces what it SOLD for; everything
 * else announces the list price. Falling back to list price on a closing that
 * has no recorded sale price is deliberate — better a real list price than a
 * blank line in a "Just Closed" email.
 */
export function announcementPrice(property, status) {
  const sold = property?.details?.sold_price
  if (status === 'closed' && money(sold)) return money(sold)
  return money(property?.list_price) || money(sold) || ''
}

/** Asset type as a human label ("Multifamily"), not the raw enum token. */
export function assetTypeLabel(property) {
  const t = property?.type
  if (!t) return ''
  return PROPERTY_TYPE_LABELS[t] || t.charAt(0).toUpperCase() + t.slice(1)
}

export function fullAddress(property) {
  if (!property) return ''
  const cityState = [property.city, property.state].filter(Boolean).join(', ')
  return [property.address, cityState, property.zip].filter(Boolean).join(', ')
}

/**
 * Token values for one (property, status, recipient) triple.
 * `terms` and `customMessage` are per-send free text, not property fields.
 */
export function announcementTokens({ property, status, agent, contact, terms = '', customMessage = '' }) {
  return {
    firstName:       contact?.first_name || 'there',
    lastName:        contact?.last_name  || '',
    agentName:       agent?.name || '',
    propertyAddress: fullAddress(property),
    assetType:       assetTypeLabel(property),
    unitCount:       unitCount(property),
    price:           announcementPrice(property, status),
    terms:           terms || '',
    dealStatus:      statusLabel(status),
    customMessage:   customMessage || '',
  }
}

/**
 * Substitute {{tokens}} in a string. Unknown tokens are left intact rather than
 * blanked: a typo showing as `{{propertyAdress}}` in the preview is a bug the
 * agent can see and fix, where a silent empty string is one they cannot.
 */
export function renderTokens(text, tokens) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (match, key) =>
    (Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match))
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** Plain text → HTML paragraphs, matching how ComposeModal sends a typed body. */
export function textToHtml(text) {
  return String(text || '')
    .split(/\n\n+/)
    .filter(p => p.trim())
    .map(p => `<p style="margin:0 0 16px 0">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/**
 * The default announcement body an agent gets when they haven't picked a saved
 * template. Plain text with tokens — editable in the wizard, and the same thing
 * "Save as template" stores.
 */
export function defaultAnnouncementBody(status) {
  const opener = {
    closed:           'I\'m pleased to share that we just closed on {{propertyAddress}}.',
    'under-contract': '{{propertyAddress}} is now under contract.',
    'new-listing':    'We\'ve just brought {{propertyAddress}} to market.',
    'price-reduced':  'The price on {{propertyAddress}} has been reduced.',
    'coming-soon':    '{{propertyAddress}} is coming to market soon.',
  }[status] || 'Sharing an update on {{propertyAddress}}.'

  return [
    'Hi {{firstName}},',
    opener,
    '{{customMessage}}',
    'If this fits what you\'re looking for — or you know someone it would — reply and I\'ll send over the details.',
    'Best,\n{{agentName}}',
  ].join('\n\n')
}

/** The default subject line for a status. */
export function defaultAnnouncementSubject(status) {
  return `${statusLabel(status)} — {{propertyAddress}}`
}

/**
 * Build the HTML that actually gets sent to ONE recipient.
 *
 * Table-based and fully inline-styled because that is what survives Outlook's
 * rendering engine — the recipients here are on Outlook/365 as often as not.
 * Max-width 600px, images with explicit width, no external stylesheet.
 */
export function renderAnnouncementHtml({
  property, status, agent, contact, terms = '', customMessage = '', photoUrl, body,
}) {
  const tokens = announcementTokens({ property, status, agent, contact, terms, customMessage })
  const bodyText = renderTokens(body || defaultAnnouncementBody(status), tokens)
  const accent   = DEAL_ANNOUNCEMENT_STATUS_COLORS[status] || '#1f2937'
  const photo    = photoUrl || defaultPhotoUrl(property)

  // Only the facts that exist get a row — an office building has no unit count,
  // and an empty "Units: —" line reads as sloppy in a marketing email.
  const facts = [
    ['Address',    tokens.propertyAddress],
    ['Asset type', tokens.assetType],
    ['Units',      tokens.unitCount],
    ['Price',      tokens.price],
    ['Terms',      tokens.terms],
  ].filter(([, v]) => v)

  const factRows = facts.map(([label, value]) => `
          <tr>
            <td style="padding:6px 0;font-size:13px;color:#6b7280;width:110px;vertical-align:top">${escapeHtml(label)}</td>
            <td style="padding:6px 0;font-size:14px;color:#111827;font-weight:600">${escapeHtml(value)}</td>
          </tr>`).join('')

  const photoBlock = photo ? `
      <tr>
        <td style="padding:0">
          <img src="${escapeHtml(photo)}" alt="${escapeHtml(tokens.propertyAddress || 'Property')}"
               width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0" />
        </td>
      </tr>` : ''

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f4f5">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0"
               style="width:100%;max-width:600px;background:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
          <tr>
            <td style="background:${accent};padding:12px 24px;color:#ffffff;font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase">
              ${escapeHtml(tokens.dealStatus)}
            </td>
          </tr>${photoBlock}
          <tr>
            <td style="padding:24px">
              <div style="font-size:20px;font-weight:700;color:#111827;margin:0 0 16px 0">${escapeHtml(tokens.propertyAddress)}</div>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px 0">${factRows}
              </table>
              <div style="font-size:14px;line-height:1.65;color:#374151">${textToHtml(bodyText)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">
              ${escapeHtml(tokens.agentName)} · Gateway Real Estate Advisors
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
