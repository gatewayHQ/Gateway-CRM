// ─────────────────────────────────────────────────────────────────────────────
// Drip sequence personalization — the {{tokens}} an agent writes into a step,
// and the email each step becomes.
//
// Pure: strings and plain objects in, strings out. Imported by BOTH the browser
// (the step editor's live preview) and the server (api/_lib/dripRunner.js, the
// actual send), so what an agent previews is exactly what the contact receives.
//
// A token can carry its own fallback for when the CRM does not know the value:
//
//     "I pulled a few {{searchSummary|homes}} for you"
//
// reads "I pulled a few 3+ bed, 2+ bath homes up to $250,000 in Sioux City for
// you" for a lead that set a search on the website, and "I pulled a few homes
// for you" for one that did not. A token with no value and no fallback renders
// as nothing — a literal "{{beds}}" in a client's inbox is worse than a gap.
// ─────────────────────────────────────────────────────────────────────────────

import { escapeHtml, renderEmailFooterHtml } from './emailFooter.js'

/** The tokens the editor offers, in the order it offers them. */
export const DRIP_TOKENS = [
  { key: 'firstName',        label: 'First name',          sample: 'Jordan' },
  { key: 'lastName',         label: 'Last name',           sample: 'Miller' },
  { key: 'searchSummary',    label: 'Their search',        sample: '3+ bed, 2+ bath homes up to $250,000 in Sioux City' },
  { key: 'beds',             label: 'Beds',                sample: '3' },
  { key: 'baths',            label: 'Baths',               sample: '2' },
  { key: 'maxPrice',         label: 'Top budget',          sample: '$250,000' },
  { key: 'minPrice',         label: 'Min price',           sample: '$150,000' },
  { key: 'area',             label: 'Area',                sample: 'Sioux City' },
  { key: 'propertyViewed',   label: 'Home they viewed',    sample: '1234 Jackson St, Sioux City, IA' },
  { key: 'matchingListings', label: 'Matching listings',   sample: '' },
  { key: 'agentName',        label: 'Your name',           sample: 'Alex Agent' },
  { key: 'agentFirstName',   label: 'Your first name',     sample: 'Alex' },
  { key: 'agentPhone',       label: 'Your phone',          sample: '(712) 555-0100' },
  { key: 'agentEmail',       label: 'Your email',          sample: 'alex@gatewayreadvisors.com' },
]

// A line holding only this token is replaced by listing cards in the HTML.
const LISTINGS_TOKEN_RE = /\{\{\s*matchingListings\s*(?:\|[^}]*)?\}\}/gi
const TOKEN_RE = /\{\{\s*([a-zA-Z]+)\s*(?:\|([^}]*))?\}\}/g

const firstWord = (s) => String(s || '').trim().split(/\s+/)[0] || ''

/** "$250,000". Empty for anything that is not a positive number. */
export function formatMoney(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return ''
  return `$${Math.round(v).toLocaleString('en-US')}`
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}
// 2.5 baths prints as 2.5; 2 prints as 2, not 2.0.
const trimNum = (n) => (n === null ? '' : String(Math.round(n * 10) / 10))

/** A contact's home search, from the contact row's columns. */
export function searchCriteria(contact = {}) {
  return {
    bedsMin:  num(contact.search_beds_min),
    bathsMin: num(contact.search_baths_min),
    priceMin: num(contact.search_price_min),
    priceMax: num(contact.search_price_max),
    area:     String(contact.submarket || '').trim() || null,
  }
}

/**
 * "3+ bed, 2+ bath homes up to $250,000 in Sioux City" — only the parts the
 * CRM knows. Empty when it knows none of them, so the token's fallback shows.
 */
export function searchSummary(criteria = {}) {
  const { bedsMin, bathsMin, priceMin, priceMax, area } = criteria
  if (!bedsMin && !bathsMin && !priceMin && !priceMax && !area) return ''
  const rooms = [
    bedsMin  ? `${trimNum(bedsMin)}+ bed`   : '',
    bathsMin ? `${trimNum(bathsMin)}+ bath` : '',
  ].filter(Boolean).join(', ')
  let price = ''
  if (priceMin && priceMax) price = `between ${formatMoney(priceMin)} and ${formatMoney(priceMax)}`
  else if (priceMax)        price = `up to ${formatMoney(priceMax)}`
  else if (priceMin)        price = `from ${formatMoney(priceMin)}`
  return [rooms ? `${rooms} homes` : 'homes', price, area ? `in ${area}` : '']
    .filter(Boolean).join(' ')
}

/**
 * The token → value map for one contact, one agent, and (optionally) the home
 * they looked at on the website.
 */
export function dripTokens({ contact = {}, agent = {}, propertyViewed = '' } = {}) {
  const c = searchCriteria(contact)
  return {
    firstName:      String(contact.first_name || '').trim(),
    lastName:       String(contact.last_name || '').replace(/^—$/, '').trim(),
    email:          String(contact.email || '').trim(),
    searchSummary:  searchSummary(c),
    beds:           c.bedsMin  ? trimNum(c.bedsMin)  : '',
    baths:          c.bathsMin ? trimNum(c.bathsMin) : '',
    maxPrice:       formatMoney(c.priceMax),
    minPrice:       formatMoney(c.priceMin),
    area:           c.area || '',
    propertyViewed: String(propertyViewed || '').trim(),
    agentName:      String(agent.name || '').trim(),
    agentFirstName: firstWord(agent.name),
    agentPhone:     String(agent.phone || '').trim(),
    agentEmail:     String(agent.email || '').trim(),
    // Legacy tokens from the pre-0060 runner, so an old step still renders.
    propertyAddress: String(propertyViewed || contact.owner_address || '').trim(),
    dealValue:       '',
  }
}

/** The sample map the editor previews with before a contact is picked. */
export const SAMPLE_TOKENS = Object.fromEntries(DRIP_TOKENS.map(t => [t.key, t.sample]))

/**
 * Replace every {{token}} / {{token|fallback}}. Token names are matched without
 * regard to case, so {{FirstName}} works too. {{matchingListings}} is removed
 * here: it is not text, and renderDripEmailHtml() handles it.
 */
export function renderDripText(text, tokens = {}) {
  const lower = Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k.toLowerCase(), v]))
  return String(text || '')
    .replace(LISTINGS_TOKEN_RE, '')
    .replace(TOKEN_RE, (_, key, fallback) => {
      const v = lower[key.toLowerCase()]
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v)
      return fallback !== undefined ? fallback.trim() : ''
    })
    // A dropped token can leave "Hi ," or a doubled space behind.
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
}

/** True when the body asks for listing cards. */
export const wantsListings = (text) => new RegExp(LISTINGS_TOKEN_RE.source, 'i').test(String(text || ''))

// ── Matching listings ────────────────────────────────────────────────────────

const RESIDENTIAL_TYPES = new Set(['residential', null, undefined, ''])

/**
 * Up to `limit` active residential listings that fit the contact's search.
 * Every criterion the contact has is a hard filter; one they have not set is
 * ignored. With no criteria at all there is nothing to match on, and the
 * answer is none — mailing someone three random houses reads as spam.
 *
 * Today the pool is the CRM's own `properties`. Once IDX is on the website this
 * is the one function that needs a second source.
 */
export function matchListings(properties = [], criteria = {}, { limit = 3 } = {}) {
  const { bedsMin, bathsMin, priceMin, priceMax, area } = criteria
  if (!bedsMin && !bathsMin && !priceMin && !priceMax && !area) return []
  const needle = area ? area.toLowerCase() : ''

  return properties
    .filter(p => (p.status || 'active') === 'active' && RESIDENTIAL_TYPES.has(p.type))
    .filter(p => {
      const price = num(p.list_price)
      if (priceMax && (!price || price > priceMax)) return false
      if (priceMin && (!price || price < priceMin)) return false
      if (bedsMin  && !(num(p.beds)  >= bedsMin))  return false
      if (bathsMin && !(num(p.baths) >= bathsMin)) return false
      if (needle) {
        const hay = [p.city, p.county, p.zip, p.address, p.details?.submarket]
          .filter(Boolean).join(' ').toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
    // Closest to the top of their budget first: that is the house they can
    // afford that they will like most.
    .sort((a, b) => (num(b.list_price) || 0) - (num(a.list_price) || 0))
    .slice(0, limit)
}

function listingCardsHtml(listings, baseUrl) {
  if (!listings.length) return ''
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const rows = listings.map(p => {
    const street = [p.address, p.unit].filter(Boolean).join(', ')
    const place  = [p.city, p.state].filter(Boolean).join(', ')
    const facts  = [
      p.beds  ? `${p.beds} bd`  : '',
      p.baths ? `${trimNum(Number(p.baths))} ba` : '',
      p.sqft  ? `${Number(p.sqft).toLocaleString('en-US')} sqft` : '',
    ].filter(Boolean).join(' · ')
    const href = base ? `${base}/listing/${p.id}` : ''
    const title = href
      ? `<a href="${escapeHtml(href)}" style="color:#1d4ed8;text-decoration:none;font-weight:600">${escapeHtml(street)}</a>`
      : `<span style="font-weight:600">${escapeHtml(street)}</span>`
    return `
      <tr><td style="padding:10px 12px;border:1px solid #e5e7eb;border-radius:6px">
        <div>${title}${p.list_price ? ` <span style="float:right;font-weight:700;color:#111827">${formatMoney(p.list_price)}</span>` : ''}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:2px">${escapeHtml([place, facts].filter(Boolean).join(' — '))}</div>
      </td></tr>
      <tr><td style="height:8px;line-height:8px;font-size:0">&nbsp;</td></tr>`
  }).join('')
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;margin:4px 0 16px 0;border-collapse:separate">${rows}</table>`
}

function listingsText(listings, baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  return listings.map(p => {
    const bits = [[p.address, p.unit].filter(Boolean).join(', '), formatMoney(p.list_price),
      p.beds ? `${p.beds} bd` : '', p.baths ? `${p.baths} ba` : ''].filter(Boolean).join(' · ')
    return `• ${bits}${base ? ` — ${base}/listing/${p.id}` : ''}`
  }).join('\n')
}

// ── The email ────────────────────────────────────────────────────────────────

const linkify = (escaped) =>
  escaped.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g, url => `<a href="${url}" style="color:#1d4ed8">${url}</a>`)

/**
 * One drip step as the email the contact receives.
 *
 * Deliberately plain: it goes out from the agent's own mailbox, one person at a
 * time, and should read like a note the agent typed — which is also what keeps
 * it out of the promotions tab. A small footer carries the opt-out and the
 * office's postal address, which a commercial email needs whatever it looks
 * like.
 */
export function renderDripEmail({
  subject = '', body = '', tokens = {}, listings = [], agent = {},
  baseUrl = '', unsubscribeUrl = '',
} = {}) {
  const renderedSubject = renderDripText(subject, tokens).trim() || '(no subject)'

  // Split on the listings token BEFORE token rendering removes it, so the cards
  // land where the agent put them.
  const SENTINEL = '\u0000LISTINGS\u0000'
  const withSentinel = String(body || '').replace(LISTINGS_TOKEN_RE, SENTINEL)
  const text = renderDripText(withSentinel, tokens)

  const cards = listingCardsHtml(listings, baseUrl)
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => {
    if (p === SENTINEL) return cards
    const parts = p.split(SENTINEL)
    const html = parts.map(part => linkify(escapeHtml(part.trim())).replace(/\n/g, '<br>')).filter(Boolean)
    const para = html.length ? `<p style="margin:0 0 16px 0">${html.join('<br>')}</p>` : ''
    return parts.length > 1 ? para + cards : para
  }).join('')

  const sig = [agent.name, agent.phone, agent.email].filter(Boolean).map(escapeHtml).join('<br>')

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">
  <tr><td style="padding:16px 20px;font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111827">
    ${paragraphs}
    ${sig ? `<p style="margin:16px 0 0 0;color:#374151">${sig}</p>` : ''}
  </td></tr>
  ${renderEmailFooterHtml({
    agentName: agent.name || '',
    unsubscribeUrl,
    reason: 'You are receiving this because you asked about homes with us.',
  })}
</table></body></html>`

  const plain = [
    text.replace(SENTINEL, listingsText(listings, baseUrl)).trim(),
    [agent.name, agent.phone, agent.email].filter(Boolean).join('\n'),
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : '',
  ].filter(Boolean).join('\n\n')

  return { subject: renderedSubject, html, text: plain }
}

// ── A starting point ─────────────────────────────────────────────────────────

/**
 * A ready-made buyer-lead drip an agent can load and edit. Mixes emails with
 * call steps on purpose: the point of the drip is a phone conversation, and a
 * call step puts one on the agent's task list on the right day.
 */
export const STARTER_BUYER_SEQUENCE = {
  name: 'New Website Buyer Lead',
  description: 'Starts the moment a website lead is assigned to you.',
  steps: [
    {
      step_type: 'email', delay_days: 0,
      subject: 'Your home search with Gateway',
      body:
`Hi {{firstName|there}},

Thanks for reaching out! I'm {{agentFirstName}} with Gateway Real Estate Advisors, and I'll be your point of contact.

I saw you're looking at {{searchSummary|homes in the area}}. Here are a few that fit right now:

{{matchingListings}}

What's the best time for a quick 10-minute call this week? I can walk you through what's selling, what's coming soon, and what it takes to win in this price range.

Talk soon,`,
    },
    {
      step_type: 'call', delay_days: 1,
      subject: 'Intro call — {{firstName}}',
      body: 'Call {{firstName}} about their search: {{searchSummary|ask what they are looking for}}. Viewed: {{propertyViewed|—}}. Goal: set a time to tour or a buyer consult.',
    },
    {
      step_type: 'email', delay_days: 2,
      subject: 'Did you see {{propertyViewed|these}}?',
      body:
`Hi {{firstName|there}},

Following up — did any of the homes I sent stand out? If {{propertyViewed|one of them}} caught your eye, I can get you in for a showing this week.

It also helps to know: are you pre-approved yet? If not, I work with a couple of great local lenders and can make an introduction.

Just reply here or call/text me at {{agentPhone|the number below}}.`,
    },
    {
      step_type: 'email', delay_days: 4,
      subject: 'New listings in {{area|your price range}}',
      body:
`Hi {{firstName|there}},

A few more that match {{searchSummary|what you're looking for}}:

{{matchingListings}}

Homes in this range tend to move fast. Want me to set up instant alerts so you see new ones the day they hit the market?`,
    },
    {
      step_type: 'call', delay_days: 3,
      subject: 'Second call — {{firstName}}',
      body: 'Check in with {{firstName}}: still looking? Pre-approved? Any homes they want to see this weekend?',
    },
    {
      step_type: 'email', delay_days: 7,
      subject: 'Still looking, {{firstName}}?',
      body:
`Hi {{firstName|there}},

I don't want to fill up your inbox, so this is my last check-in for now. If your plans have changed, no problem at all.

If you're still looking at {{searchSummary|homes}}, just reply "yes" and I'll send you the best new options each week — or give me a call at {{agentPhone|the number below}}.`,
    },
  ],
}
