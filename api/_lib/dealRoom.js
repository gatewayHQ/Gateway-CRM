/**
 * The Deal Room behind a QR landing page.
 *
 * A property landing page is a public TEASER — photo, headline, location, a few
 * size facts, the story — and a Deal Room behind one form: the underwriting
 * numbers, the full gallery, the OM and the other diligence documents, and a
 * dated list of updates the listing agent posts as the deal moves. The trade is
 * the same one the OM gate always made (name + phone + email for the file),
 * widened so that what an investor actually needs to price the deal is on the
 * paid side of it.
 *
 * Everything here is pure (no I/O), so the rules about what an anonymous
 * browser may see live in one testable place:
 *
 *   publicTeaserConfig(cfg)  what ?action=landing hands to anyone with the link
 *   privateDealRoom(cfg)     what ?action=deal_room hands to a registered visitor
 *   dealRoomDocs(cfg)        every document, keyed by a stable id
 *   mintAccess / readAccess  the signed token that keeps a visitor signed in
 *
 * landing_config keys this module reads (all optional — a campaign that sets
 * none of them renders exactly as before):
 *
 *   teaser_mode          bool  — default ON when the page has a Deal Room
 *   price_display        'public' (default) | 'unpriced' | 'call_for_offers' | 'gated'
 *   call_for_offers_date 'YYYY-MM-DD'
 *   public_photo_count   int   — photos shown before the wall (default 3)
 *   om                   { path, filename, title, size }      — see src/lib/om.js
 *   nda                  { path, filename, title, size }      — when set, the
 *                        visitor must e-sign it before anything behind the
 *                        wall is released (see ndaFromConfig below)
 *   deal_room: {
 *     documents: [{ id, path, filename, title, kind, size, uploaded_at }],
 *     updates:   [{ id, date, title, body }],
 *   }
 *   portfolio            [{ id, crm_property_id, name, asset_line, location_line,
 *                           description, images[], om, documents[], and the
 *                           same fact keys as the page (price, units, cap_rate…) }]
 *                        — one QR code for several properties. Each property's
 *                        numbers, photos and files follow the same public /
 *                        gated rules as a single-property page; its documents
 *                        join the room under ids prefixed with the property id.
 */
import crypto from 'crypto'

/** Underwriting numbers that move behind the wall in teaser mode. */
export const GATED_FIELDS = ['cap_rate', 'noi', 'gross_income', 'price_per_unit', 'occupancy']

export const PRICE_DISPLAY = ['public', 'unpriced', 'call_for_offers', 'gated']

export const DOC_KINDS = ['om', 'rent_roll', 't12', 'financials', 'photos', 'survey', 'other']

export const DEFAULT_PUBLIC_PHOTOS = 3

/** A registered visitor stays signed in on their device this long. */
export const ACCESS_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000

const OM_DOC_ID = 'om'

/** The most properties one portfolio page carries. */
export const MAX_PORTFOLIO = 12

function cleanDoc(d, fallbackId) {
  if (!d || typeof d !== 'object') return null
  const path = String(d.path || '').trim()
  if (!path) return null
  return {
    id:          String(d.id || fallbackId).slice(0, 64),
    path,
    filename:    String(d.filename || path.split('/').pop() || 'document').slice(0, 200),
    title:       String(d.title || '').slice(0, 160),
    kind:        DOC_KINDS.includes(d.kind) ? d.kind : 'other',
    size:        Number.isFinite(Number(d.size)) ? Number(d.size) : null,
    uploaded_at: d.uploaded_at || null,
  }
}

/**
 * Every Deal Room document, the legacy single `om` first (id 'om'), then the
 * `deal_room.documents` list. Ids are unique; a later duplicate is dropped.
 */
export function dealRoomDocs(cfg) {
  const out = []
  const seen = new Set()
  const push = (d) => { if (d && !seen.has(d.id)) { seen.add(d.id); out.push(d) } }
  const om = cfg?.om
  if (typeof om === 'string') push(cleanDoc({ path: om, kind: 'om' }, OM_DOC_ID))
  else if (om && typeof om === 'object') push(cleanDoc({ ...om, id: OM_DOC_ID, kind: 'om' }, OM_DOC_ID))
  const list = Array.isArray(cfg?.deal_room?.documents) ? cfg.deal_room.documents : []
  list.forEach((d, i) => push(cleanDoc(d, `doc-${i + 1}`)))
  // A portfolio's per-property files: `${propertyId}:om`, `${propertyId}:${docId}`.
  portfolioOf(cfg).forEach(p => {
    const tag = (d) => d && { ...d, property_id: p.id }
    if (typeof p.om === 'string') push(tag(cleanDoc({ path: p.om, kind: 'om', id: `${p.id}:${OM_DOC_ID}` })))
    else if (p.om && typeof p.om === 'object') push(tag(cleanDoc({ ...p.om, id: `${p.id}:${OM_DOC_ID}`, kind: 'om' })))
    const docs = Array.isArray(p.documents) ? p.documents : []
    docs.forEach((d, i) => push(tag(cleanDoc({ ...d, id: `${p.id}:${d?.id || `doc-${i + 1}`}` }))))
  })
  return out
}

/**
 * The portfolio's properties, each with a stable id (`p-1`, `p-2`… when the
 * builder did not set one). Empty for an ordinary single-property page.
 */
export function portfolioOf(cfg) {
  const list = Array.isArray(cfg?.portfolio) ? cfg.portfolio : []
  const seen = new Set()
  return list
    .filter(p => p && typeof p === 'object')
    .slice(0, MAX_PORTFOLIO)
    .map((p, i) => {
      let id = String(p.id || `p-${i + 1}`).replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || `p-${i + 1}`
      if (seen.has(id)) id = `p-${i + 1}`
      seen.add(id)
      return { ...p, id }
    })
}

export function dealRoomUpdates(cfg) {
  const list = Array.isArray(cfg?.deal_room?.updates) ? cfg.deal_room.updates : []
  return list
    .filter(u => u && (u.title || u.body))
    .map((u, i) => ({
      id:    String(u.id || `upd-${i + 1}`).slice(0, 64),
      date:  /^\d{4}-\d{2}-\d{2}/.test(String(u.date || '')) ? String(u.date).slice(0, 10) : null,
      title: String(u.title || '').slice(0, 200),
      body:  String(u.body || '').slice(0, 4000),
    }))
    // Newest first; undated updates sink.
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
}

/** True when the page has anything behind the wall at all. */
export function hasDealRoom(cfg) {
  return dealRoomDocs(cfg).length > 0
}

/**
 * Teaser mode is on by default whenever there is a Deal Room to send people to,
 * and cannot be turned off while an NDA is attached: the numbers and photos are
 * part of what the NDA protects.
 */
export function isTeaser(cfg) {
  return hasDealRoom(cfg) && (cfg?.teaser_mode !== false || !!ndaFromConfig(cfg))
}

export function priceDisplay(cfg) {
  return PRICE_DISPLAY.includes(cfg?.price_display) ? cfg.price_display : 'public'
}

function imagesOf(cfg) {
  return Array.isArray(cfg?.images) ? cfg.images.filter(Boolean) : []
}

function publicPhotoCount(cfg) {
  const n = Number(cfg?.public_photo_count)
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : DEFAULT_PUBLIC_PHOTOS
}

/** A document as a browser may see it: never the storage path. */
function docSummary(d) {
  const { path, ...rest } = d
  return rest
}

/**
 * The config ?action=landing returns to anyone holding the link.
 *
 * Storage paths are always removed. In teaser mode the gated numbers, the
 * photos past the public count, a hidden price and every update's body are
 * removed too — stripped on the server, because a field the page merely
 * declines to render is still sitting in the JSON for anyone who looks.
 */
export function publicTeaserConfig(cfg) {
  const base = cfg && typeof cfg === 'object' ? { ...cfg } : {}
  const docs    = dealRoomDocs(base)
  const updates = dealRoomUpdates(base)
  const teaser  = isTeaser(base)
  const price   = priceDisplay(base)

  // The OM descriptor the existing OmGate understands (src/lib/om.js).
  const om = docs.find(d => d.id === OM_DOC_ID)
  if (om) base.om = { filename: om.filename, title: om.title, size: om.size, available: true }
  else delete base.om

  delete base.deal_room
  delete base.followup_sequence_id
  delete base.nda

  const images = imagesOf(base)
  if (teaser) {
    GATED_FIELDS.forEach(k => { delete base[k] })
    base.images = images.slice(0, publicPhotoCount(base))
  }
  if (price !== 'public') delete base.price

  // Each property in a portfolio follows the page's rules, on its own photos.
  const portfolio = portfolioOf(base)
  let gatedPortfolioPhotos = 0
  const gatedPortfolioFields = new Set()
  if (portfolio.length) {
    base.portfolio = portfolio.map(p => {
      const pub = { ...p }
      const own = docs.filter(d => d.property_id === p.id)
      const pom = own.find(d => d.id === `${p.id}:${OM_DOC_ID}`)
      if (pom) pub.om = { filename: pom.filename, title: pom.title, size: pom.size, available: true }
      else delete pub.om
      delete pub.documents
      delete pub.crm_property_id
      const pics = imagesOf(p)
      if (teaser) {
        GATED_FIELDS.forEach(k => {
          if (pub[k] != null && pub[k] !== '') gatedPortfolioFields.add(k)
          delete pub[k]
        })
        pub.images = pics.slice(0, publicPhotoCount(base))
        gatedPortfolioPhotos += pics.length - pub.images.length
      }
      if (price !== 'public') delete pub.price
      pub.doc_titles = own.map(d => d.title || kindLabel(d.kind))
      pub.gated_photo_count = teaser ? pics.length - pub.images.length : 0
      return pub
    })
  } else {
    delete base.portfolio
  }

  if (docs.length) {
    base.deal_room = {
      available:      true,
      teaser,
      doc_count:      docs.length,
      doc_titles:     docs.map(d => {
        const t = d.title || kindLabel(d.kind)
        const owner = d.property_id && portfolio.find(p => p.id === d.property_id)
        return owner?.name ? `${owner.name} · ${t}` : t
      }),
      update_count:   updates.length,
      last_update_at: updates[0]?.date || null,
      gated_photo_count: teaser ? Math.max(0, images.length - base.images.length) + gatedPortfolioPhotos : 0,
      gated_fields:   teaser ? GATED_FIELDS.filter(k => (cfg?.[k] != null && cfg[k] !== '') || gatedPortfolioFields.has(k)) : [],
      nda_required:   !!ndaFromConfig(cfg),
    }
  }
  return base
}

/** What a registered visitor gets: the numbers, the photos, the documents, the updates. */
function financialsOf(c, gatedPrice) {
  const financials = {}
  GATED_FIELDS.forEach(k => { if (c[k] != null && c[k] !== '') financials[k] = c[k] })
  if (c.price != null && c.price !== '' && gatedPrice) financials.price = c.price
  return financials
}

export function privateDealRoom(cfg) {
  const c = cfg || {}
  const gatedPrice = priceDisplay(c) === 'gated'
  const docs = dealRoomDocs(c).map(docSummary)
  const room = {
    financials: financialsOf(c, gatedPrice),
    images:     imagesOf(c),
    // A portfolio's per-property files are listed under their property.
    documents:  docs.filter(d => !d.property_id),
    updates:    dealRoomUpdates(c),
  }
  const portfolio = portfolioOf(c)
  if (portfolio.length) {
    room.properties = portfolio.map(p => ({
      id:         p.id,
      financials: financialsOf(p, gatedPrice),
      images:     imagesOf(p),
      documents:  docs.filter(d => d.property_id === p.id),
    }))
  }
  return room
}

// ─── NDA ─────────────────────────────────────────────────────────────────────
// An agent may attach a Confidentiality Agreement to the page. While one is
// attached, registering still records the lead, but nothing behind the wall —
// OM, numbers, photos, documents, updates — is released until the visitor has
// e-signed it. The server enforces that on every Deal Room action; the page
// only follows.

/** The NDA descriptor on landing_config.nda, or null when none is attached. */
export function ndaFromConfig(cfg) {
  const n = cfg?.nda
  if (!n || typeof n !== 'object') return null
  const path = String(n.path || '').trim()
  if (!path) return null
  return {
    path,
    filename: String(n.filename || 'confidentiality-agreement.pdf').slice(0, 200),
    title:    String(n.title || '').slice(0, 160) || 'Confidentiality Agreement',
    size:     Number.isFinite(Number(n.size)) ? Number(n.size) : null,
  }
}

/** An NDA only gates anything when there is a Deal Room behind it. */
export function ndaRequired(cfg) {
  return hasDealRoom(cfg) && !!ndaFromConfig(cfg)
}

/** The NDA as a browser may see it: never the storage path. */
export function publicNda(cfg) {
  const n = ndaFromConfig(cfg)
  if (!n) return null
  const { path, ...rest } = n
  return rest
}

/**
 * Validate what the visitor typed to sign. The typed name IS the signature, so
 * it must look like a name; the agreement box must be ticked. Returns
 * { error } or { name, company }.
 */
export function cleanNdaSignature({ signer_name, company, agree } = {}) {
  const name = String(signer_name || '').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (name.length < 2 || !/[a-z]/i.test(name)) return { error: 'Type your full legal name to sign' }
  if (agree !== true) return { error: 'Please confirm you agree to the Confidentiality Agreement' }
  const co = String(company || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  return { name, company: co || null }
}

export function kindLabel(kind) {
  return ({
    om: 'Offering Memorandum', rent_roll: 'Rent Roll', t12: 'T-12 Operating Statement',
    financials: 'Financials', photos: 'Photo Package', survey: 'Survey / Site Plan', other: 'Document',
  })[kind] || 'Document'
}

// ─── Access tokens ───────────────────────────────────────────────────────────
// Issued once a visitor registers, kept in their browser, and minted per
// recipient into "New in the Deal Room" emails so a click lands signed in. It
// names the mailing and the registration row, so it opens one Deal Room only.

function secret() {
  return process.env.SCAN_SIGNING_SECRET
      || process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || ''
}

const mac = (body) => crypto.createHmac('sha256', `deal-room:${secret()}`).update(body).digest('base64url').slice(0, 32)

export function mintAccess({ mailingId, email, now = Date.now() }) {
  if (!secret()) throw new Error('Server misconfigured: no signing secret for Deal Room access')
  const body = Buffer.from(JSON.stringify({
    m: String(mailingId), e: String(email || '').trim().toLowerCase(), t: now,
  })).toString('base64url')
  return `${body}.${mac(body)}`
}

/** Returns { mailingId, email } or null for a forged, expired or other-mailing token. */
export function readAccess(token, mailingId, now = Date.now()) {
  try {
    if (!secret()) return null
    const [body, sig] = String(token || '').split('.')
    if (!body || !sig) return null
    const want = mac(body)
    const a = Buffer.from(sig), b = Buffer.from(want)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!obj?.t || now - obj.t > ACCESS_MAX_AGE_MS) return null
    if (mailingId && String(obj.m) !== String(mailingId)) return null
    if (!obj.e) return null
    return { mailingId: String(obj.m), email: String(obj.e) }
  } catch { return null }
}

// ─── Registration fields ─────────────────────────────────────────────────────

export const BUYER_ROLES = ['principal', 'broker', 'lender', 'other']

/** Normalise the optional qualifiers the gate collects. Never throws. */
export function cleanQualifiers({ mailing_address, buyer_role, is_1031 } = {}) {
  const addr = String(mailing_address || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  return {
    mailing_address: addr || null,
    buyer_role:      BUYER_ROLES.includes(buyer_role) ? buyer_role : null,
    is_1031:         is_1031 === true || is_1031 === 'yes' ? true
                   : is_1031 === false || is_1031 === 'no' ? false : null,
  }
}
