// ─────────────────────────────────────────────────────────────────────────────
// Deal announcements — the "Just Closed / Under Contract / New Listing / Price
// Reduced" mass email built from a property record, plus the two sends that are
// not about one property: a Market Update, and "Other" with a header the agent
// writes themselves.
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
import { fullAddress as composeFullAddress } from './address.js'
import { renderEmailFooterHtml, escapeHtml, COMPANY } from './emailFooter.js'

// ─── Deal statuses ────────────────────────────────────────────────────────────
// The announcement's headline. Distinct from `properties.status` and from
// `deals.stage`: an agent may announce "Just Closed" from a property whose CRM
// status was never moved, and a price reduction is not a status at all. Kept as
// its own vocabulary rather than derived, so the announcement says what the
// agent means it to say.
export const DEAL_ANNOUNCEMENT_STATUSES = [
  'closed', 'under-contract', 'new-listing', 'price-reduced', 'coming-soon',
  'market-update', 'other',
]

export const DEAL_ANNOUNCEMENT_STATUS_LABELS = {
  closed:           'Just Closed',
  'under-contract': 'Under Contract',
  'new-listing':    'New Listing',
  'price-reduced':  'Price Reduced',
  'coming-soon':    'Coming Soon',
  'market-update':  'Market Update',
  other:            'Other',
}

// Sends that are not about one property. A market update is the agent's read on
// the market — its picture is a graphic they designed, not a listing photo — so
// the property is optional rather than required, and without one the email
// drops the address headline and the detail table instead of printing blanks.
export const PROPERTY_OPTIONAL_STATUSES = ['market-update', 'other']
export const requiresProperty = (s) => !PROPERTY_OPTIONAL_STATUSES.includes(s)

// 'other' carries a header the agent types ("Q3 Multifamily Overview", "Open
// House Saturday"). Capped because it prints in a one-line ribbon.
export const CUSTOM_HEADER_MAX = 60
export const normalizeCustomHeader = (h) => String(h || '').replace(/\s+/g, ' ').trim().slice(0, CUSTOM_HEADER_MAX)

// Accent colour for the status ribbon in the email. Inline hex rather than the
// app's CSS variables — an email client has no stylesheet of ours.
export const DEAL_ANNOUNCEMENT_STATUS_COLORS = {
  closed:           '#0f766e',
  'under-contract': '#b45309',
  'new-listing':    '#1d4ed8',
  'price-reduced':  '#be123c',
  'coming-soon':    '#4338ca',
  'market-update':  '#6d28d9',
  other:            '#374151',
}

export const statusLabel = (s) => DEAL_ANNOUNCEMENT_STATUS_LABELS[s] || 'Announcement'

/**
 * The words in the email's ribbon (and {{dealStatus}}). The status label,
 * except for 'other', where it is the header the agent wrote — falling back to
 * a neutral word rather than printing "Other" to a client.
 */
export function announcementHeader(status, customHeader = '') {
  if (status === 'other') return normalizeCustomHeader(customHeader) || 'Announcement'
  return statusLabel(status)
}

// ─── Merge tokens ─────────────────────────────────────────────────────────────
// Surfaced in the template editor as clickable chips, and the contract the
// renderer implements. `{{customMessage}}` is the agent's free-text block —
// a template that omits it still gets the message appended, so the note an
// agent typed can never silently vanish because the template didn't mention it.
export const ANNOUNCEMENT_TOKENS = [
  { token: '{{firstName}}',       label: 'Recipient first name' },
  { token: '{{lastName}}',        label: 'Recipient last name'  },
  { token: '{{agentName}}',       label: 'Your name'            },
  { token: '{{propertyAddress}}', label: 'Property address', property: true },
  { token: '{{assetType}}',       label: 'Asset type',       property: true },
  { token: '{{unitCount}}',       label: 'Unit count',       property: true },
  { token: '{{price}}',           label: 'Price',            property: true },
  { token: '{{terms}}',           label: 'Price / terms note'   },
  { token: '{{dealStatus}}',      label: 'Header / deal status' },
  { token: '{{customMessage}}',   label: 'Your custom message'  },
]

// ─── Optional detail rows ─────────────────────────────────────────────────────
// The fact table under the photo is the part of an announcement an agent most
// often needs to trim. A property under contract is the clear case: the address,
// asset type and unit count are the pitch, but the number it went under
// contract at is the seller's business, and printing it in a mass email hands
// every other buyer in the market a reference point.
//
// So each row is a switch rather than a fixed field. `key` is what gets stored
// on the blast; `token` is the merge token that prints the same value in the
// body, named here so the wizard can warn an agent who hid the Price row but
// left {{price}} in their wording — hiding the row does not blank the token,
// because a token the agent typed themselves is a deliberate choice.
//
// There is no Address row: the address is the email's headline, and a tile
// repeating it directly underneath read as a mistake. (Blasts stored before
// this with 'address' in hidden_facts lose nothing — normalizeHiddenFacts drops
// the unknown key and the headline prints as it always did.)
export const ANNOUNCEMENT_FACT_FIELDS = [
  { key: 'assetType', label: 'Asset type', token: '{{assetType}}'       },
  { key: 'units',     label: 'Units',      token: '{{unitCount}}'       },
  { key: 'price',     label: 'Price',      token: '{{price}}'           },
  { key: 'terms',     label: 'Terms',      token: '{{terms}}'           },
]

export const ANNOUNCEMENT_FACT_KEYS = ANNOUNCEMENT_FACT_FIELDS.map(f => f.key)

/**
 * Which rows start switched off for a status.
 *
 * Only 'under-contract' has one: the contract price. It is the default an agent
 * would set by hand every time, and the one whose omission they would not
 * notice until after the send. Every other status shows everything the property
 * record has, exactly as before — a closing price and a list price are meant to
 * be announced.
 */
export function defaultHiddenFacts(status) {
  return status === 'under-contract' ? ['price'] : []
}

/** Keep only real field keys, in the canonical order — this comes off a jsonb column. */
export function normalizeHiddenFacts(hidden) {
  const list = Array.isArray(hidden) ? hidden.map(String) : []
  return ANNOUNCEMENT_FACT_KEYS.filter(k => list.includes(k))
}

/**
 * Merge tokens for hidden rows that the wording still prints. Not an error —
 * the body is the agent's — but the one thing they would want told to them
 * before the send goes out, since the preview's body is easy to skim past.
 */
export function hiddenFactTokensUsed(text, hiddenFacts) {
  const hidden = normalizeHiddenFacts(hiddenFacts)
  const haystack = String(text || '')
  return ANNOUNCEMENT_FACT_FIELDS
    .filter(f => hidden.includes(f.key) && haystack.includes(f.token))
    .map(f => f.token)
}

const money = (val) => {
  const n = Number(val)
  if (!Number.isFinite(n) || n <= 0) return ''
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

/**
 * Every photo the CRM already holds for a property, newest first in the order
 * the agent arranged them. Properties store uploads under details.photos[]
 * (public URLs in the `property-photos` bucket, see src/pages/properties/PhotoUploader.jsx).
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

// Re-exported rather than reimplemented: the suite/unit line (migration 0042)
// has to read the same in an announcement as it does everywhere else, so this
// is src/lib/address.js's composer under the name this module already published.
export const fullAddress = composeFullAddress

/**
 * Token values for one (property, status, recipient) triple.
 * `terms` and `customMessage` are per-send free text, not property fields.
 */
export function announcementTokens({ property, status, agent, contact, terms = '', customMessage = '', customHeader = '' }) {
  return {
    firstName:       contact?.first_name || 'there',
    lastName:        contact?.last_name  || '',
    agentName:       agent?.name || '',
    propertyAddress: fullAddress(property),
    assetType:       assetTypeLabel(property),
    unitCount:       unitCount(property),
    price:           announcementPrice(property, status),
    terms:           terms || '',
    dealStatus:      announcementHeader(status, customHeader),
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

  if (status === 'market-update') {
    return [
      'Hi {{firstName}},',
      'Here\'s my latest look at the market.',
      '{{customMessage}}',
      'If you\'d like to talk through what this means for your property or your next acquisition, just reply — happy to run the numbers with you.',
      'Best,\n{{agentName}}',
    ].join('\n\n')
  }
  if (status === 'other') {
    return ['Hi {{firstName}},', '{{customMessage}}', 'Best,\n{{agentName}}'].join('\n\n')
  }

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
  if (status === 'market-update') return 'Market Update from {{agentName}}'
  if (status === 'other') return '{{dealStatus}}'
  return `${statusLabel(status)} — {{propertyAddress}}`
}

/**
 * Build the HTML that actually gets sent to ONE recipient.
 *
 * Table-based and fully inline-styled because that is what survives Outlook's
 * rendering engine — the recipients here are on Outlook/365 as often as not.
 * Max-width 600px, images with explicit width, no external stylesheet. The one
 * <style> block is a mobile nicety (stacked tiles, tighter padding) that clients
 * without media-query support simply ignore — nothing depends on it.
 */
export function renderAnnouncementHtml({
  property, status, agent, contact, terms = '', customMessage = '', photoUrl, body,
  unsubscribeUrl = '', hiddenFacts = [], openPixelUrl = '', customHeader = '',
}) {
  const tokens = announcementTokens({ property, status, agent, contact, terms, customMessage, customHeader })
  const bodyText = renderTokens(body || defaultAnnouncementBody(status), tokens)
  const accent   = DEAL_ANNOUNCEMENT_STATUS_COLORS[status] || '#1f2937'
  const photo    = photoUrl || defaultPhotoUrl(property)

  // Two independent reasons a row doesn't print, and they mean different things.
  // A row with no value never existed — an office building has no unit count,
  // and an empty "Units: —" line reads as sloppy in a marketing email. A row in
  // `hiddenFacts` exists and the agent chose to keep it to themselves, which is
  // why it is stored on the blast rather than worked around in the wording.
  const hidden = normalizeHiddenFacts(hiddenFacts)
  const values = {
    assetType: tokens.assetType,
    units:     tokens.unitCount,
    price:     tokens.price,
    terms:     tokens.terms,
  }
  const facts = ANNOUNCEMENT_FACT_FIELDS
    .filter(f => !hidden.includes(f.key) && values[f.key])
    .map(f => [f.label, values[f.key]])

  // A send with no property (a market update) has no detail block at all — not
  // even a lone Terms row, which reads as a stray field without an address.
  //
  // The short facts (asset type, units, price) sit side by side as stat tiles —
  // the way a listing card reads — and the free-length terms note gets a
  // full-width tile, so "All cash, 30-day close" never squeezes a price into a
  // narrow column.
  // Gutters are right/bottom padding only, the last tile in a row carrying
  // none, so the block lines up with the text above and below it. (Negative
  // margins would be tidier and Outlook ignores them.)
  const tile = (label, value, width, last = true, span = 1) => `
                  <td class="gw-tile"${span > 1 ? ` colspan="${span}"` : ''} width="${width}" style="width:${width};padding:0 ${last ? 0 : 8}px 8px 0;vertical-align:top">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3;border:1px solid #ebe8e1;border-radius:8px">
                      <tr><td style="padding:12px 14px">
                        <div style="font-size:10.5px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:#8a8f9c;margin:0 0 4px 0">${escapeHtml(label)}</div>
                        <div style="font-size:16px;font-weight:700;color:#1a1a2e;line-height:1.35">${escapeHtml(value)}</div>
                      </td></tr>
                    </table>
                  </td>`
  const WIDE = ['Terms']
  const short = facts.filter(([label]) => !WIDE.includes(label))
  const wide  = facts.filter(([label]) => WIDE.includes(label))
  const tileRows = !property ? [] : [
    ...(short.length ? [`<tr>${short.map(([l, v], i) => tile(l, v, `${Math.floor(100 / short.length)}%`, i === short.length - 1)).join('')}
                </tr>`] : []),
    ...wide.map(([l, v]) => `<tr>${tile(l, v, '100%', true, Math.max(short.length, 1))}
                </tr>`),
  ]

  // Every row hidden means no block at all, rather than an empty one whose
  // margin leaves a visible gap between the headline and the message.
  const factsTable = tileRows.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px 0">
                ${tileRows.join('\n                ')}
              </table>`
    : ''

  // Open tracking. Last element in the body, 1×1, empty alt and aria-hidden so
  // a screen reader doesn't announce it and a client showing alt text doesn't
  // draw a broken-image box. Absent from the preview (no recipient row exists
  // to attribute an open to) and absent whenever the URL is blank, so a
  // misconfigured deployment sends a clean email rather than a broken image.
  //
  // What it cannot do is worth writing down next to what it does: Outlook and
  // Gmail block or proxy remote images by default, so a recorded open is real
  // but a missing one means nothing at all.
  const pixel = openPixelUrl ? `
      <tr>
        <td style="padding:0;line-height:0;font-size:0">
          <img src="${escapeHtml(openPixelUrl)}" width="1" height="1" alt="" aria-hidden="true"
               style="display:block;width:1px;height:1px;border:0;opacity:0" />
        </td>
      </tr>` : ''

  const photoBlock = photo ? `
          <tr>
            <td style="padding:0;line-height:0;font-size:0">
              <img src="${escapeHtml(photo)}" alt="${escapeHtml(tokens.propertyAddress || tokens.dealStatus)}"
                   width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0" />
            </td>
          </tr>` : ''

  const headline = tokens.propertyAddress
    ? `<h1 style="font-size:26px;line-height:1.25;font-weight:700;color:#1a1a2e;margin:0 0 20px 0;letter-spacing:-0.3px">${escapeHtml(tokens.propertyAddress)}</h1>`
    : ''

  // A reply is the whole point of an announcement, so it gets a button — a
  // "bulletproof" one (a filled table cell, not a CSS-only link) so Outlook
  // draws it too. mailto: rather than a tracked link: the message already comes
  // from the agent's own mailbox, and a reply thread is what they want back.
  const agentEmail = String(agent?.email || '').trim()
  const agentFirst = String(agent?.name || '').trim().split(/\s+/)[0]
  const cta = agentEmail ? `
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px 0">
                <tr>
                  <td style="background:#1a1a2e;border-radius:6px">
                    <a href="mailto:${escapeHtml(agentEmail)}?subject=${encodeURIComponent(`Re: ${tokens.propertyAddress || tokens.dealStatus}`)}"
                       style="display:inline-block;padding:13px 26px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.2px">
                      ${escapeHtml(agentFirst ? `Reply to ${agentFirst}` : 'Reply')} &rarr;
                    </a>
                  </td>
                </tr>
              </table>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<style>
  @media only screen and (max-width: 520px) {
    .gw-pad  { padding-left: 22px !important; padding-right: 22px !important; }
    .gw-tile { display: block !important; width: 100% !important; box-sizing: border-box; }
    .gw-h1 h1 { font-size: 22px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f5f3ef;-webkit-text-size-adjust:100%">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ef;padding:28px 12px">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0"
               style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e7e3da;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
          <tr>
            <td class="gw-pad" style="background:#1a1a2e;padding:18px 32px;border-bottom:3px solid #c9a84c">
              <div style="font-size:11px;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;color:#ffffff">${escapeHtml(COMPANY.name)}</div>
            </td>
          </tr>${photoBlock}
          <tr>
            <td class="gw-pad gw-h1" style="padding:30px 32px 30px 32px">
              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0">
                <tr>
                  <td style="background:${accent};border-radius:999px;padding:5px 12px;font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#ffffff">
                    ${escapeHtml(tokens.dealStatus)}
                  </td>
                </tr>
              </table>
              ${headline}
              ${factsTable}
              <div style="font-size:15px;line-height:1.7;color:#3a3f4b">${textToHtml(bodyText)}</div>${cta}
            </td>
          </tr>
${renderEmailFooterHtml({ agentName: tokens.agentName, unsubscribeUrl })}${pixel}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}
