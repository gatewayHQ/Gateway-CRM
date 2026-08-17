/**
 * Gateway CRM — Mailings API (v2)
 *
 * Single-endpoint controller for the Campaigns/Mailings feature.
 * Folded into one Vercel function to stay within the 12-function Hobby limit.
 *
 * Action map:
 *   GET  ?action=list                          → list mailings + stats
 *   GET  ?action=get&id=X                      → one mailing + recipient/scan counts
 *   GET  ?action=recipients&mailing_id=X       → recipients list
 *   GET  ?action=scans&mailing_id=X            → recent scan events (&include_bots=1)
 *   GET  ?action=leads&mailing_id=X            → captured leads
 *   GET  ?action=analytics&mailing_id=X        → per-mailing rollups (&days=N)
 *   GET  ?action=dashboard&agent_id=X|all=1    → scoped rollup + trend
 *   GET  ?action=live&since=ISO                → near-real-time scan/lead feed
 *   GET  ?action=scan&token=X                  → public QR endpoint, 302 → landing
 *   POST {action:'scan_replay',replay}         → public; re-report an unconfirmed scan
 *   GET  ?action=landing&id=X                  → public; the 4 fields /lp/* renders
 *   GET  ?action=health                        → uptime probe (no DB)
 *   POST {action:'create',...}                 → new mailing (mints qr_token)
 *   POST {action:'update',id,...}              → patch mailing
 *   POST {action:'delete',id}                  → delete mailing (cascades)
 *   POST {action:'add_recipients',...}         → bulk insert recipients
 *   POST {action:'remove_recipient',id}        → delete one recipient
 *   POST {action:'update_recipient',id,...}    → patch response status
 *   POST {action:'capture_lead',...}           → public landing-page form submit
 *
 * Auth: service role key bypasses RLS for server-side writes. The 'scan',
 *       'scan_replay', 'landing', 'og', 'capture_lead', 'capture_subscriber' and
 *       'unsubscribe' actions are intentionally unauthenticated (public).
 *       'landing' returns a fixed four-column projection and nothing else — see
 *       the comment on the action for why that list is load-bearing.
 *       'scan_replay' is
 *       safe to expose because it only accepts HMAC-signed payloads this server
 *       issued — see signPayload/verifyPayload.
 *
 * The QR scan pipeline (scan / scan_replay and the reporting RPCs behind list,
 * analytics and dashboard) is documented in docs/qr-scan-tracking.md, including
 * the reliability guarantees each step makes and how to debug a scan-count
 * discrepancy. Read that before changing anything on the scan path.
 */

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { log } from './_lib/observability.js'

// ─── Supabase client (lazy singleton — avoids cold-start env-var crashes) ───
let _supabase = null
function db() {
  if (_supabase) return _supabase
  const url = (
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    'https://twgwemkihpwlgliftagg.supabase.co'
  ).trim().replace(/\/+$/, '')
  const key = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!key) throw new Error('Server misconfigured: SUPABASE_SERVICE_KEY missing — add it to Vercel Environment Variables')
  _supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInBrowser: false } })
  return _supabase
}

// ─── Helpers ────────────────────────────────────────────────────────────────

// URL-safe base62 token, 8 chars = 218 trillion combos — collision-proof for our scale
const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789' // omits 0/O/1/I/l for legibility
function mintToken(length = 8) {
  const bytes = crypto.randomBytes(length * 2)
  let out = ''
  for (let i = 0; i < length; i++) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length]
  return out
}

function hashIp(ip) {
  if (!ip) return null
  // Daily-rotating salt → privacy-preserving uniqueness (can't track person across days)
  const day = new Date().toISOString().slice(0, 10)
  return crypto.createHash('sha256').update(`${ip}|${day}|gateway-crm`).digest('hex').slice(0, 32)
}

// Visitor fingerprint for unique-scanner counts. Deliberately coarser than
// hashIp's daily salt: a month-long salt means one person scanning on the 3rd
// and again on the 20th counts as ONE unique visitor instead of two, which is
// what an agent means when they ask "how many people scanned this?". Still
// rotates, so it can't be used to follow someone indefinitely.
export function visitorHash(ip, ua) {
  if (!ip && !ua) return null
  const month = new Date().toISOString().slice(0, 7)
  return crypto.createHash('sha256')
    .update(`${ip || ''}|${(ua || '').slice(0, 200)}|${month}|gateway-crm`)
    .digest('hex').slice(0, 32)
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket?.remoteAddress || null
}

// ─── Scan capture primitives ────────────────────────────────────────────────

// Automated traffic that is NOT a social preview: link scanners, security
// crawlers, uptime monitors, prefetchers. These still get recorded (a scan row
// is never thrown away) but are flagged so they can't inflate the headline
// count. See migration 0031 — record everything, filter on read.
const GENERIC_BOTS = /bot\b|crawler|crawling|spider|scrape|headless|phantomjs|puppeteer|playwright|lighthouse|curl\/|wget\/|python-requests|python-urllib|go-http-client|java\/|okhttp|axios\/|node-fetch|got\/|libwww|httpclient|monitor|uptime|pingdom|statuscake|newrelic|datadog|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|censys|masscan|zgrab|expanse|dataprovider|proofpoint|barracuda|mimecast|symantec|forcepoint|urlscan|virustotal|safebrowsing/i

export function classifyBot(req, ua) {
  if (!ua)                                 return { isBot: true, reason: 'no-user-agent' }
  if (req.method === 'HEAD')               return { isBot: true, reason: 'head-request' }
  // Browser prefetch/prerender hints — the user has not actually opened the link.
  const purpose = String(
    req.headers['sec-purpose'] || req.headers['purpose'] || req.headers['x-purpose'] || req.headers['x-moz'] || ''
  ).toLowerCase()
  if (/prefetch|prerender|preview/.test(purpose)) return { isBot: true, reason: `prefetch:${purpose.slice(0, 30)}` }
  if (SOCIAL_CRAWLERS.test(ua))            return { isBot: true, reason: 'social-crawler' }
  if (GENERIC_BOTS.test(ua))               return { isBot: true, reason: 'automated-agent' }
  return { isBot: false, reason: null }
}

// Compact UA parse. Deliberately small: this runs on the critical path of every
// scan, and "iPhone / iOS / Safari" is all the analytics actually reports.
export function parseUa(ua = '') {
  const s = String(ua)
  let device = 'desktop'
  if (/\b(ipad|tablet|playbook|silk)\b|android(?!.*mobile)/i.test(s)) device = 'tablet'
  else if (/mobile|iphone|ipod|android|blackberry|iemobile|opera mini/i.test(s)) device = 'mobile'

  let os = null
  if      (/iphone|ipad|ipod|ios/i.test(s))    os = 'iOS'
  else if (/android/i.test(s))                 os = 'Android'
  else if (/windows nt/i.test(s))              os = 'Windows'
  else if (/mac os x|macintosh/i.test(s))      os = 'macOS'
  else if (/cros/i.test(s))                    os = 'ChromeOS'
  else if (/linux/i.test(s))                   os = 'Linux'

  // In-app browsers first — on a QR scan these are extremely common and would
  // otherwise all be misreported as Safari or Chrome.
  let browser = null
  if      (/instagram/i.test(s))                       browser = 'Instagram'
  else if (/fbav|fban|fb_iab/i.test(s))                browser = 'Facebook'
  else if (/line\//i.test(s))                          browser = 'LINE'
  else if (/edg[ea]?\//i.test(s))                      browser = 'Edge'
  else if (/samsungbrowser/i.test(s))                  browser = 'Samsung'
  else if (/opr\/|opera/i.test(s))                     browser = 'Opera'
  else if (/firefox|fxios/i.test(s))                   browser = 'Firefox'
  else if (/crios|chrome/i.test(s))                    browser = 'Chrome'
  else if (/safari/i.test(s))                          browser = 'Safari'

  return { device, os, browser }
}

// Vercel's geo headers. Present on every plan for country; region/city/lat/long
// are filled in where the edge can resolve them. Absent → null, never invented.
function geoFrom(req) {
  const h = k => { const v = req.headers[k]; return v ? decodeURIComponent(String(v)).slice(0, 120) : null }
  return {
    country:   h('x-vercel-ip-country'),
    region:    h('x-vercel-ip-country-region'),
    city:      h('x-vercel-ip-city'),
    latitude:  h('x-vercel-ip-latitude'),
    longitude: h('x-vercel-ip-longitude'),
    timezone:  h('x-vercel-ip-timezone'),
  }
}

// Bounds any promise so a slow or hung database can never hold a scanner on a
// blank screen. Resolves to TIMEOUT rather than rejecting, so the caller can
// tell "took too long" apart from "genuinely failed".
export const TIMEOUT = Symbol('timeout')
export function withTimeout(promise, ms) {
  let timer
  return Promise.race([
    Promise.resolve(promise).catch(err => ({ error: err })),
    new Promise(resolve => { timer = setTimeout(() => resolve(TIMEOUT), ms) }),
  ]).finally(() => clearTimeout(timer))
}

// ─── Signed replay tokens ───────────────────────────────────────────────────
// If the scan write can't be confirmed before we have to answer the scanner,
// the redirect carries a signed record of the scan so the landing page can
// re-report it. The signature is what stops anyone from minting fake scans:
// the payload is only ever issued by this server.

function signingSecret() {
  return process.env.SCAN_SIGNING_SECRET
      || process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || ''
}

const b64u = {
  enc: obj => Buffer.from(JSON.stringify(obj)).toString('base64url'),
  dec: str => JSON.parse(Buffer.from(String(str), 'base64url').toString('utf8')),
}

export function signPayload(obj) {
  const body = b64u.enc(obj)
  const mac  = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url').slice(0, 32)
  return `${body}.${mac}`
}

// Returns the payload, or null if the signature doesn't verify or it has aged
// out. Uses a timing-safe compare so the MAC can't be probed byte by byte.
export function verifyPayload(token, maxAgeMs = 30 * 60 * 1000) {
  try {
    const [body, mac] = String(token || '').split('.')
    if (!body || !mac) return null
    const want = crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url').slice(0, 32)
    const a = Buffer.from(mac), b = Buffer.from(want)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    const obj = b64u.dec(body)
    if (!obj?.t || Date.now() - obj.t > maxAgeMs) return null
    return obj
  } catch { return null }
}

// ─── Hot token cache ────────────────────────────────────────────────────────
// A warm instance serving a burst of scans on the same campaign (exactly what
// happens the morning after a drop) resolves the destination from memory and
// spends its whole latency budget on the write instead of the lookup.
const TOKEN_TTL_MS = 60_000
const tokenCache = new Map()
function cacheGet(token) {
  const hit = tokenCache.get(token)
  if (!hit) return null
  if (Date.now() > hit.exp) { tokenCache.delete(token); return null }
  return hit.value
}
function cacheSet(token, value) {
  // Bounded so a token-scanning flood can't grow this without limit.
  if (tokenCache.size > 500) tokenCache.clear()
  tokenCache.set(token, { value, exp: Date.now() + TOKEN_TTL_MS })
}

// Where a scan should land, given the mailing.
export function destinationFor(m) {
  if (m.landing_type === 'custom' && m.landing_custom_url) return m.landing_custom_url
  if (m.landing_type === 'valuation')    return `/lp/valuation/${m.mailing_id || m.id}`
  if (m.landing_type === 'multifamily')  return `/lp/multifamily/${m.mailing_id || m.id}`
  if (m.landing_type === 'mailing')      return `/lp/mailing/${m.mailing_id || m.id}`
  return `/lp/property/${m.mailing_id || m.id}`
}

// Carry the visit id onto internal landing pages so a lead captured there can
// be tied back to the scan that produced it. External custom URLs are left
// exactly as the agent entered them — we don't append tracking to someone
// else's link, and there is nothing of ours to stitch on the far side.
export function withVisit(dest, visitId) {
  if (!visitId || /^https?:\/\//i.test(dest)) return dest
  return `${dest}${dest.includes('?') ? '&' : '?'}v=${encodeURIComponent(visitId)}`
}

// Every response on a scan path must be uncacheable. A cached /m/{token}
// response is a campaign whose scans silently stop being recorded for the
// lifetime of the cache entry — see the header note on the scan action.
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.setHeader('CDN-Cache-Control', 'no-store')
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store')
  res.setHeader('Vary', 'User-Agent')
}

// Last-resort page: shown only when the database could not be reached in time
// to resolve the destination. It retries the resolve and reports the scan, so
// the scan survives an outage that started before we knew where to send them.
function retryHtml({ replay, siteName = 'Gateway Real Estate' }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Opening…</title></head>
<body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#1e2642">
<div style="font-size:20px;font-weight:600;margin-bottom:6px">${escHtml(siteName)}</div>
<div id="msg" style="font-size:14px;color:#5b6478">Opening your page…</div>
<noscript><div style="font-size:14px;color:#5b6478">Please refresh to continue.</div></noscript>
<script>
(function () {
  var replay = ${JSON.stringify(replay)}, tries = 0;
  function go() {
    tries++;
    fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'scan_replay', replay: replay }),
      cache: 'no-store'
    }).then(function (r) { return r.json() }).then(function (d) {
      if (d && d.dest) { window.location.replace(d.dest); return }
      throw new Error('no destination');
    }).catch(function () {
      if (tries < 6) { setTimeout(go, Math.min(8000, 500 * Math.pow(2, tries))); }
      else { document.getElementById('msg').textContent =
        'We recorded your scan, but could not open the page. Please try again in a moment.'; }
    });
  }
  go();
})();
</script>
</body></html>`
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https'
  return `${proto}://${req.headers.host}`
}

// Link-preview / social crawlers don't run the SPA's JS, so they need server
// rendered Open Graph tags. Matches the major ones (Facebook, iMessage, X,
// LinkedIn, Slack, WhatsApp, Telegram, Discord, Pinterest, Reddit, Google…).
const SOCIAL_CRAWLERS = /facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|slack-imgproxy|whatsapp|telegrambot|discordbot|pinterest|redditbot|embedly|quora link preview|skypeuripreview|nuzzel|vkshare|w3c_validator|bitlybot|applebot|googlebot|bingbot|developers\.google\.com\/\+\/web\/snippet|iframely/i
function isCrawler(req) {
  return SOCIAL_CRAWLERS.test(req.headers['user-agent'] || '')
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Minimal HTML page carrying Open Graph + Twitter tags, then redirecting real
// browsers to the actual landing page (in case a human's UA is misdetected).
function ogHtml({ url, title, description, image, siteName = 'Gateway Real Estate' }) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<meta name="description" content="${escHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${escHtml(url)}">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(description)}">
<meta property="og:site_name" content="${escHtml(siteName)}">
${image ? `<meta property="og:image" content="${escHtml(image)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escHtml(title)}">` : ''}
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${escHtml(title)}">
<meta name="twitter:description" content="${escHtml(description)}">
${image ? `<meta name="twitter:image" content="${escHtml(image)}">` : ''}
<meta http-equiv="refresh" content="0;url=${escHtml(url)}">
<script>window.location.replace(${JSON.stringify(url)})</script>
</head><body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#1e2642">
<div style="font-size:24px;font-weight:600;margin-bottom:8px">${escHtml(siteName)}</div>
<div style="font-size:16px;margin-bottom:24px">${escHtml(title)}</div>
<a href="${escHtml(url)}" style="color:#4a6fa5">View listing →</a>
</body></html>`
}

// Build Open Graph fields (title/description/image) from a mailing's
// landing_config. Shared by the /m crawler branch and the og action.
function mailingOgFields(m) {
  const cfg = m.landing_config || {}
  const num = v => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return v && isFinite(n) ? n.toLocaleString() : '' }
  const price = num(cfg.price) ? `$${num(cfg.price)}` : ''
  const specs = [
    price,
    cfg.beds  ? `${cfg.beds} bd`  : '',
    cfg.baths ? `${cfg.baths} ba` : '',
    cfg.sqft  ? `${num(cfg.sqft)} sqft` : '',
    cfg.units ? `${cfg.units} units` : '',
  ].filter(Boolean).join(' · ')
  const imgs  = Array.isArray(cfg.images) ? cfg.images : []
  const image = imgs.map(v => (typeof v === 'string' ? v : v?.url)).find(Boolean) || ''
  const title = cfg.headline || m.name || 'Property For Sale'
  const description = String(cfg.subheadline || specs || 'View this listing from Gateway Real Estate.').slice(0, 280)
  return { title, description, image }
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function json(res, status, body, headers = {}) {
  Object.entries({ ...CORS, ...headers }).forEach(([k, v]) => res.setHeader(k, v))
  return res.status(status).json(body)
}

// Pre-0031 path, kept only so a database that hasn't had the migration applied
// still captures scans instead of dropping them on the floor. Everything is
// awaited (the original bug) and the counter is left to the nightly reconcile
// rather than being bumped from a stale read (the other original bug).
// Returns the mailing, the string 'notfound', or null if it could not resolve.
async function legacyScanFallback(token, ctx) {
  const m = await resolveMailingByToken(token)
  if (!m) return 'notfound'
  await directInsertScan(m.id, ctx)
  return m
}

// ─── Destination resolve, independent of the tracking write ──────────────────
//
// THE POINT OF SEPARATING THESE:
// record_mailing_scan() resolves the token AND stores the event AND bumps the
// counter in one atomic round trip. That is right for correctness of the count,
// but it fused the redirect to the write: any failure inside that function — a
// constraint, a column a partially-applied migration never added, a slow cold
// start blowing the latency budget — left the handler with no destination, and
// the scanner got the "Opening your page…" retry page instead of the landing
// page. On a QR code printed on a few thousand mailed postcards that is the
// worst possible failure mode, and it is not recoverable by reprinting.
//
// So resolving the destination now has its own path that shares nothing with the
// write. It is a single indexed lookup on a UNIQUE column, with no insert and no
// update, so essentially the only way it fails is the database being unreachable
// — in which case the retry page is genuinely the right answer.
//
// Returns the mailing, or null when the token does not exist.
async function resolveMailingByToken(token) {
  const { data: m, error } = await db()
    .from('mailings')
    .select('id, name, landing_type, landing_custom_url, landing_config, property_id, status')
    .eq('qr_token', token)
    .maybeSingle()
  if (error) throw error
  if (!m) return null
  return { ...m, mailing_id: m.id }
}

// Records a scan with a plain INSERT — no RPC. This is what keeps the scan when
// record_mailing_scan itself is the broken part. The counter is deliberately NOT
// bumped from here: it is left to reconcile_mailing_counters() nightly rather
// than incremented from a stale read, which is how counts used to drift.
// Returns true only if the row is known to be stored.
async function directInsertScan(mailingId, ctx) {
  const { error } = await db().from('mailing_scans').insert({
    id:         ctx.scanId,
    mailing_id: mailingId,
    ip_hash:    hashIp(ctx.ip),
    user_agent: ctx.ua.slice(0, 500),
    referrer:   (ctx.req.headers.referer || '').slice(0, 500),
    country:    ctx.geo.country,
  })
  if (!error) return true
  // A primary-key collision means the RPC's write DID land after all — the scan
  // is stored, which is exactly what this returns.
  if (/duplicate key/i.test(error.message || '')) return true
  log.error('direct scan insert failed', {
    handler: 'campaigns', action: 'scan', mailing_id: mailingId,
    err_message: String(error.message).slice(0, 200),
  })
  return false
}

// Calls a 0031 RPC, returning null (instead of throwing) when the function
// isn't in the database yet, so every reporting endpoint can degrade to its
// pre-migration query path instead of erroring the whole page.
async function tryRpc(fn, args) {
  const { data, error } = await db().rpc(fn, args)
  if (!error) return data
  if (/does not exist|PGRST202|schema cache/i.test(String(error.message || error.hint || ''))) return null
  throw error
}

// ─── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()

  const action = req.body?.action || req.query?.action
  if (!action) return json(res, 400, { error: 'action is required' })

  try {
    // ── Public: QR scan tracking + redirect ─────────────────────────────────
    //
    // Reliability contract (see migrations/0031_qr_scan_reliability.sql):
    //
    //  1. NOTHING ON THIS PATH IS EVER CACHED. The previous version answered
    //     social crawlers with `Cache-Control: public, s-maxage=3600` on the
    //     /m/{token} URL itself, with no Vary. Vercel's edge caches by URL, so
    //     ONE link-preview fetch (someone texting the short link is enough)
    //     poisoned the cache and every real scan for the next hour was served
    //     from the edge without ever reaching this function. Silent, total scan
    //     loss on the campaign's busiest links. Hence noStore() first, before
    //     any branch can return.
    //
    //  2. The write is AWAITED, not fired-and-forgotten. The old code kicked off
    //     the insert after res.end(), racing the runtime freezing the instance.
    //
    //  3. Resolve + record + counter increment are ONE atomic round trip, so
    //     concurrent scans cannot lose updates against each other.
    //
    //  4. If the write can't be confirmed inside the latency budget, the
    //     scanner is still redirected immediately and the scan rides along as a
    //     signed replay payload the landing page re-reports. The scan id is
    //     minted here, so a replay of a write that actually landed collides on
    //     the primary key and is absorbed — at-least-once delivery, exactly-once
    //     storage.
    if (action === 'scan') {
      const t0 = Date.now()
      const { token } = req.query
      noStore(res)
      if (!token) return res.status(400).send('Missing token')

      const ua      = req.headers['user-agent'] || ''
      const bot     = classifyBot(req, ua)
      const crawler = isCrawler(req)
      const ip      = clientIp(req)
      const geo     = geoFrom(req)
      const { device, os, browser } = parseUa(ua)
      const scanId  = crypto.randomUUID()
      const visitId = crypto.randomUUID().replace(/-/g, '').slice(0, 20)

      const rpcArgs = {
        p_token:        token,
        p_scan_id:      scanId,
        p_visit_id:     visitId,
        p_ip_hash:      hashIp(ip),
        p_visitor_hash: visitorHash(ip, ua),
        p_user_agent:   ua.slice(0, 500),
        p_referrer:     (req.headers.referer || req.headers.referrer || '').slice(0, 500),
        p_country:      geo.country,
        p_region:       geo.region,
        p_city:         geo.city,
        p_latitude:     geo.latitude,
        p_longitude:    geo.longitude,
        p_timezone:     geo.timezone,
        p_device_type:  device,
        p_os:           os,
        p_browser:      browser,
        p_is_bot:       bot.isBot,
        p_bot_reason:   bot.reason,
        p_source:       crawler ? 'crawler' : 'qr',
        p_latency_ms:   null,
        p_record:       true,
      }

      const budget = Number(process.env.SCAN_WRITE_BUDGET_MS || 1500)
      const cached = cacheGet(token)
      const settled = await withTimeout(db().rpc('record_mailing_scan', rpcArgs), budget)

      let mailing = null
      let confirmed = false

      if (settled !== TIMEOUT && !settled?.error && Array.isArray(settled?.data)) {
        // Zero rows means the token doesn't exist — a 404 with no second trip.
        if (settled.data.length === 0) return res.status(404).send('Mailing not found')
        mailing = settled.data[0]
        confirmed = true
        cacheSet(token, mailing)
      } else {
        // The write is unconfirmed. Fall back to a cached destination if this
        // instance has one; otherwise the retry page below resolves it.
        mailing = cached
        const why = settled === TIMEOUT ? 'timeout' : (settled?.error?.message || settled?.error || 'unknown')
        log.error('scan write unconfirmed', {
          handler: 'campaigns', action: 'scan', token: String(token).slice(0, 16),
          scan_id: scanId, err_message: String(why).slice(0, 200), duration_ms: Date.now() - t0,
        })
      }

      // Older databases (0031 not yet applied) have no record_mailing_scan.
      // Rather than lose every scan until the migration is run, fall back to
      // the direct insert — awaited, so it still can't be lost to a freeze.
      const rpcMissing = settled !== TIMEOUT &&
        /function .*record_mailing_scan.* does not exist|PGRST202|schema cache/i.test(
          String(settled?.error?.message || settled?.error?.hint || ''))
      if (rpcMissing) {
        const legacy = await legacyScanFallback(token, { scanId, visitId, ip, ua, geo, device, os, browser, bot, req })
        if (legacy === 'notfound') return res.status(404).send('Mailing not found')
        if (legacy) { mailing = legacy; confirmed = true; cacheSet(token, legacy) }
      }

      // ── The redirect does not depend on the tracking write ──────────────────
      //
      // Reached whenever the RPC gave us no destination for ANY reason — it timed
      // out, or it errored for something other than "the function isn't there"
      // (a constraint inside it, a column a partially-applied 0031 never added).
      // Previously only the missing-function case had a fallback, so every other
      // failure fell through to the retry page: a printed QR code that recorded
      // nothing and rendered a spinner that never resolved.
      //
      // Resolving is a single indexed lookup that shares nothing with the write,
      // so it survives a broken record_mailing_scan. The scan is then stored with
      // a plain INSERT, which also does not depend on the RPC.
      if (!mailing) {
        const fallbackBudget = Number(process.env.SCAN_FALLBACK_BUDGET_MS || 1200)
        const resolved = await withTimeout(resolveMailingByToken(token), fallbackBudget)

        // withTimeout resolves a rejection to { error }, so a database failure
        // here is an object with `error` — not a throw, and not null.
        if (resolved !== TIMEOUT && !resolved?.error) {
          // A definitive "no such token" is a 404, exactly as on the RPC path.
          if (resolved === null) return res.status(404).send('Mailing not found')
          mailing = resolved
          cacheSet(token, resolved)

          // Store the scan directly. If this confirms, no replay is needed; if it
          // cannot, the replay token below lets the landing page re-report it.
          const stored = await withTimeout(directInsertScan(resolved.id, {
            scanId, ip, ua, geo, req,
          }), fallbackBudget)
          if (stored === true) confirmed = true

          // warn, not error: the scanner got their page. The paired 'scan write
          // unconfirmed' error above carries WHY the RPC failed — that is the
          // line to search for when tracking looks light but pages load fine.
          log.warn('scan resolved by fallback', {
            handler: 'campaigns', action: 'scan', token: String(token).slice(0, 16),
            scan_id: scanId, recorded: stored === true, duration_ms: Date.now() - t0,
          })
        }
      }

      const replay = confirmed ? null : signPayload({ k: token, s: scanId, v: visitId, t: Date.now() })

      // No destination even from the independent lookup — the database is not
      // reachable at all. Hand back a page that keeps retrying rather than an
      // error, so the scan is still captured once the database recovers.
      if (!mailing) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        return res.status(200).send(retryHtml({ replay }))
      }

      const dest = destinationFor(mailing)

      // Social/link-preview crawlers: serve Open Graph tags built from the
      // mailing so Facebook/iMessage/etc. show the property (not "Gateway CRM").
      // The hit is still RECORDED (flagged is_bot, so it never inflates the
      // count) — an agent can see that their link was previewed. External
      // custom URLs are left to redirect so the destination previews itself.
      const isExternalCustom = mailing.landing_type === 'custom' && mailing.landing_custom_url
      if (crawler && !isExternalCustom) {
        const { title, description, image } = mailingOgFields(mailing)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        return res.status(200).send(ogHtml({ url: `${baseUrl(req)}${dest}`, title, description, image }))
      }

      let target = withVisit(dest, visitId)
      if (replay && !/^https?:\/\//i.test(target)) {
        // Unconfirmed write on an internal landing page — the page re-reports it.
        target += `${target.includes('?') ? '&' : '?'}sr=${encodeURIComponent(replay)}`
      }

      res.setHeader('Location', target)
      return res.status(302).end()
    }

    // ── Public: re-report a scan whose write could not be confirmed ──────────
    // Only ever accepts payloads this server signed, so it cannot be used to
    // manufacture scans. Replaying a scan that did land is a no-op: the payload
    // carries the original scan id and collides on the primary key.
    if (action === 'scan_replay') {
      const payload = verifyPayload(req.body?.replay || req.query?.replay)
      if (!payload) return json(res, 400, { error: 'Invalid or expired replay token' })

      const ua  = req.headers['user-agent'] || ''
      const ip  = clientIp(req)
      const geo = geoFrom(req)
      const { device, os, browser } = parseUa(ua)

      const { data, error } = await db().rpc('record_mailing_scan', {
        p_token:        payload.k,
        p_scan_id:      payload.s,
        p_visit_id:     payload.v,
        p_ip_hash:      hashIp(ip),
        p_visitor_hash: visitorHash(ip, ua),
        p_user_agent:   ua.slice(0, 500),
        p_referrer:     (req.headers.referer || '').slice(0, 500),
        p_country:      geo.country,
        p_region:       geo.region,
        p_city:         geo.city,
        p_latitude:     geo.latitude,
        p_longitude:    geo.longitude,
        p_timezone:     geo.timezone,
        p_device_type:  device,
        p_os:           os,
        p_browser:      browser,
        p_is_bot:       false,
        p_bot_reason:   null,
        p_source:       'replay',
        p_record:       true,
      })
      if (error) throw error
      if (!data?.length) return json(res, 404, { error: 'Mailing not found' })

      const m = data[0]
      return json(res, 200, {
        ok: true,
        recorded: m.recorded,          // false = the original write had landed
        dest: withVisit(destinationFor(m), payload.v),
      })
    }

    // ── Public: Open Graph for landing URLs pasted directly ──────────────────
    // When a social crawler fetches /lp/{type}/{id} (the long landing link, not
    // the /m QR link), vercel.json rewrites it here by user-agent. Returns OG
    // tags built from the mailing so the share preview shows the property.
    if (action === 'og') {
      const { id, lt } = req.query
      if (!id) return res.status(400).send('Missing id')

      const { data: m } = await db()
        .from('mailings')
        .select('id, name, landing_type, landing_config')
        .eq('id', id)
        .single()
      if (!m) return res.status(404).send('Mailing not found')

      const type = ['valuation','multifamily','mailing'].includes(lt) ? lt : 'property'
      const dest = `/lp/${type}/${m.id}`
      const { title, description, image } = mailingOgFields(m)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      // Vary is load-bearing: this route is only reached via a user-agent
      // condition in vercel.json, so without it the edge could serve a crawler's
      // cached Open Graph stub to a real visitor. Caching stays on — crawlers
      // refetch these aggressively and no scan is recorded on /lp/ URLs.
      res.setHeader('Vary', 'User-Agent')
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400')
      return res.status(200).send(ogHtml({ url: `${baseUrl(req)}${dest}`, title, description, image }))
    }

    // ── Public: the mailing behind a /lp/{type}/{id} landing page ────────────
    //
    // This is the other half of a QR scan. /m/{token} records the scan and 302s
    // to /lp/{type}/{id}, which vercel.json serves as the SPA — so the landing
    // page renders in the BROWSER, with the anon key, not on the service key.
    //
    // Migration 0027 closed `mailings` to anonymous callers (it holds qr_token,
    // description and the denormalized recipient/scan/lead counters), on the
    // stated assumption that "/lp/* → api/campaigns.js (SUPABASE_SERVICE_KEY)".
    // That was true only for the crawler branch above; every real visitor hit
    // `supabase.from('mailings')` from the client and, post-0027, RLS filtered
    // it to zero rows — the scan was counted and the page then rendered
    // "Listing not available". This action is the service-key read those pages
    // needed all along.
    //
    // The projection is deliberately explicit and minimal — exactly the four
    // fields the Landing* components render, the same discipline as the
    // agents_public view. Never widen it to `*`: that would hand qr_token to
    // anyone who can open a landing page, which is every scanner of every QR
    // code, and a token is all you need to forge scans against a campaign.
    if (action === 'landing') {
      const { id } = req.query
      // Reject non-UUIDs here rather than letting Postgres 500 on the cast.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''))) {
        return json(res, 400, { error: 'A valid mailing id is required' })
      }

      const { data: m, error } = await db()
        .from('mailings')
        .select('id, name, agent_id, landing_config')
        .eq('id', id)
        .maybeSingle()
      if (error) throw error
      if (!m) return json(res, 404, { error: 'Mailing not found' })

      return json(res, 200, { mailing: m })
    }

    // ── Health check ────────────────────────────────────────────────────────
    if (action === 'health') {
      return json(res, 200, { ok: true, ts: new Date().toISOString() })
    }

    // ── List mailings (scoped) ──────────────────────────────────────────────
    // Each agent sees ONLY their own campaigns, plus any they collaborate on
    // (their id is the primary agent_id OR appears in landing_config.agent_ids).
    // Admins pass all=1 to see every campaign. The client supplies agent_id/all;
    // this endpoint runs on the service key, so DB-level RLS (migration 0002,
    // deferred) is the eventual hard guarantee — this filter is the product rule.
    if (action === 'list') {
      const agentId = req.query.agent_id || null
      const all = req.query.all === '1' || req.query.all === 'true'

      const { data, error } = await db()
        .from('mailings')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error

      let mailings = data || []
      if (!all) {
        // Non-admin with no resolved identity yet → return nothing rather than
        // leaking the whole list during the first-paint window.
        if (!agentId) return json(res, 200, { mailings: [] })
        mailings = mailings.filter(m => {
          if (m.agent_id === agentId) return true
          const ids = m.landing_config?.agent_ids
          return Array.isArray(ids) && ids.includes(agentId)
        })
      }

      // Accurate counts, computed in SQL. The previous version fetched EVERY
      // scan row for EVERY campaign and tallied them in JavaScript, which meant
      // (a) the whole scan table crossed the wire on every page load and
      // (b) totals silently stopped growing once the result hit PostgREST's
      // row cap (1,000 by default on Supabase) — a campaign's counts would just
      // quietly plateau. mailing_stats() aggregates server-side, so it is both
      // correct at any volume and a single small response.
      const ids = mailings.map(m => m.id)
      if (ids.length) {
        const stats = await tryRpc('mailing_stats', { p_ids: ids })
        if (stats) {
          const by = Object.fromEntries(stats.map(s => [s.mailing_id, s]))
          mailings = mailings.map(m => {
            const s = by[m.id]
            return {
              ...m,
              scan_count:      s?.scans           ?? 0,
              raw_scan_count:  s?.raw_scans       ?? 0,
              bot_scan_count:  s?.bot_scans       ?? 0,
              unique_scanners: s?.unique_visitors ?? 0,
              lead_count:      s?.leads           ?? 0,
              converted_count: s?.converted       ?? 0,
              recipient_count: s?.recipients      ?? m.recipient_count ?? 0,
              last_scan_at:    s?.last_scan_at    ?? m.last_scan_at ?? null,
            }
          })
        } else {
          // 0031 not applied yet — degrade to the old tally rather than fail.
          const [scanRes, leadRes] = await Promise.all([
            db().from('mailing_scans').select('mailing_id').in('mailing_id', ids),
            db().from('mailing_leads').select('mailing_id').in('mailing_id', ids),
          ])
          const tally = rows => (rows || []).reduce((acc, r) => { acc[r.mailing_id] = (acc[r.mailing_id] || 0) + 1; return acc }, {})
          const scanBy = tally(scanRes.data)
          const leadBy = tally(leadRes.data)
          mailings = mailings.map(m => ({ ...m, scan_count: scanBy[m.id] || 0, lead_count: leadBy[m.id] || 0 }))
        }
      }

      return json(res, 200, { mailings })
    }

    // ── Get one mailing ─────────────────────────────────────────────────────
    if (action === 'get') {
      const { id } = req.query
      if (!id) return json(res, 400, { error: 'id required' })
      const { data, error } = await db().from('mailings').select('*').eq('id', id).single()
      if (error) throw error
      return json(res, 200, { mailing: data })
    }

    // ── List recipients ─────────────────────────────────────────────────────
    if (action === 'recipients') {
      const { mailing_id } = req.query
      if (!mailing_id) return json(res, 400, { error: 'mailing_id required' })
      const { data, error } = await db()
        .from('mailing_recipients')
        .select('*')
        .eq('mailing_id', mailing_id)
        .order('created_at', { ascending: false })
      if (error) throw error
      return json(res, 200, { recipients: data })
    }

    // ── List scans ──────────────────────────────────────────────────────────
    // `include_bots=1` surfaces the flagged rows (crawler previews, prefetches,
    // rapid repeats). They are always stored; this is the switch that shows them.
    if (action === 'scans') {
      const { mailing_id, limit = 200, before } = req.query
      if (!mailing_id) return json(res, 400, { error: 'mailing_id required' })
      const includeBots = req.query.include_bots === '1' || req.query.include_bots === 'true'

      let q = db()
        .from('mailing_scans')
        .select('*')
        .eq('mailing_id', mailing_id)
        .order('scanned_at', { ascending: false })
        .limit(Math.min(1000, Math.max(1, Number(limit) || 200)))
      if (before) q = q.lt('scanned_at', before)

      const { data, error } = await q
      if (error) throw error

      // is_bot is absent pre-0031; treat missing as "not a bot" so the filter
      // never hides legitimate historical scans.
      const rows = includeBots ? (data || []) : (data || []).filter(s => !s.is_bot)
      return json(res, 200, { scans: rows, has_more: (data || []).length >= Number(limit) })
    }

    // ── Live scan feed (near-real-time) ─────────────────────────────────────
    // Small, cheap and pollable: everything newer than `since` for the campaigns
    // the caller can see. Backs the live activity ticker without holding a
    // socket open — the whole API is serverless, so polling a narrow window is
    // both simpler and cheaper than a realtime subscription here.
    if (action === 'live') {
      const since = req.query.since || new Date(Date.now() - 5 * 60_000).toISOString()
      const agentId = req.query.agent_id || null
      const all = req.query.all === '1' || req.query.all === 'true'
      if (!all && !agentId) return json(res, 200, { scans: [], leads: [], now: new Date().toISOString() })

      const { data: mine } = await db().from('mailings').select('id, name, agent_id, landing_config')
      const visible = (mine || []).filter(m => {
        if (all) return true
        if (m.agent_id === agentId) return true
        const ids = m.landing_config?.agent_ids
        return Array.isArray(ids) && ids.includes(agentId)
      })
      const nameById = Object.fromEntries(visible.map(m => [m.id, m.name]))
      const visibleIds = visible.map(m => m.id)
      if (!visibleIds.length) return json(res, 200, { scans: [], leads: [], now: new Date().toISOString() })

      const [scanRes, leadRes] = await Promise.all([
        db().from('mailing_scans')
          .select('id, mailing_id, scanned_at, city, region, country, device_type, os, is_bot, is_duplicate')
          .in('mailing_id', visibleIds).gt('scanned_at', since)
          .order('scanned_at', { ascending: false }).limit(100),
        db().from('mailing_leads')
          .select('id, mailing_id, name, email, created_at')
          .in('mailing_id', visibleIds).gt('created_at', since)
          .order('created_at', { ascending: false }).limit(50),
      ])

      return json(res, 200, {
        scans: (scanRes.data || []).filter(s => !s.is_bot && !s.is_duplicate)
          .map(s => ({ ...s, mailing_name: nameById[s.mailing_id] || null })),
        leads: (leadRes.data || []).map(l => ({ ...l, mailing_name: nameById[l.mailing_id] || null })),
        now: new Date().toISOString(),
      })
    }

    // ── List leads ──────────────────────────────────────────────────────────
    if (action === 'leads') {
      const { mailing_id } = req.query
      if (!mailing_id) return json(res, 400, { error: 'mailing_id required' })
      const { data, error } = await db()
        .from('mailing_leads')
        .select('*')
        .eq('mailing_id', mailing_id)
        .order('created_at', { ascending: false })
      if (error) throw error
      return json(res, 200, { leads: data })
    }

    // ── List subscribers (mailing-list campaigns) ───────────────────────────
    if (action === 'subscribers') {
      const { mailing_id } = req.query
      if (!mailing_id) return json(res, 400, { error: 'mailing_id required' })
      const { data, error } = await db()
        .from('mailing_subscribers')
        .select('*')
        .eq('mailing_id', mailing_id)
        .order('subscribed_at', { ascending: false })
      if (error) throw error
      const subs = data || []
      return json(res, 200, {
        subscribers: subs,
        active: subs.filter(s => s.status === 'subscribed').length,
        unsubscribed: subs.filter(s => s.status === 'unsubscribed').length,
      })
    }

    // ── Per-mailing analytics rollup ────────────────────────────────────────
    if (action === 'analytics') {
      const { mailing_id, days } = req.query
      if (!mailing_id) return json(res, 400, { error: 'mailing_id required' })

      // Computed in SQL — timeline, device/OS/geo splits, unique vs returning
      // scanners, bot and duplicate counts, and scan→lead conversion, in one
      // round trip that does not depend on how many scans exist.
      const rich = await tryRpc('mailing_analytics', {
        p_mailing_id: mailing_id,
        p_days: Math.min(730, Math.max(1, Number(days) || 90)),
      })
      if (rich) return json(res, 200, rich)

      // ── Pre-0031 fallback ────────────────────────────────────────────────
      const [recRes, scanRes, leadRes] = await Promise.all([
        db().from('mailing_recipients').select('id, responded, scan_count, response_type').eq('mailing_id', mailing_id),
        db().from('mailing_scans').select('scanned_at, ip_hash').eq('mailing_id', mailing_id),
        db().from('mailing_leads').select('id').eq('mailing_id', mailing_id),
      ])

      const recipients = recRes.data || []
      const scans      = scanRes.data || []
      const leads      = leadRes.data || []

      const recipientsScanned = recipients.filter(r => (r.scan_count || 0) > 0).length
      const uniqueScanners    = new Set(scans.map(s => s.ip_hash).filter(Boolean)).size

      // Scan timeline (by day)
      const byDay = {}
      for (const s of scans) {
        const d = s.scanned_at?.slice(0, 10)
        if (d) byDay[d] = (byDay[d] || 0) + 1
      }
      const timeline = Object.entries(byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, count]) => ({ date, count }))

      // Response breakdown
      const byResponse = {}
      for (const r of recipients) {
        if (r.response_type) byResponse[r.response_type] = (byResponse[r.response_type] || 0) + 1
      }

      // Same field names as mailing_analytics() so the UI renders identically
      // whether or not 0031 has been applied. The richer splits (device, OS,
      // geo, bot/duplicate counts) simply aren't available here, and the UI
      // hides those sections when they're absent rather than showing zeroes.
      return json(res, 200, {
        recipients_total:    recipients.length,
        recipients_scanned:  recipientsScanned,
        recipients_responded: recipients.filter(r => r.responded).length,
        total_scans:         scans.length,
        raw_scans:           scans.length,
        unique_scanners:     uniqueScanners,
        total_leads:         leads.length,
        attributed_leads:    0,
        response_index:      recipients.length > 0
                               ? Math.round((scans.length / recipients.length) * 1000) / 10
                               : null,
        conversion_rate:     scans.length > 0 ? leads.length / scans.length : 0,
        scan_rate:           recipients.length > 0 ? recipientsScanned / recipients.length : 0,
        response_rate:       recipients.length > 0 ? recipients.filter(r => r.responded).length / recipients.length : 0,
        timeline,
        by_response:         byResponse,
      })
    }

    // ── Org-wide dashboard ──────────────────────────────────────────────────
    // Now SCOPED. The previous version aggregated every mailing, scan and lead
    // in the org regardless of who asked, so a non-admin agent's header tiles
    // reported the whole brokerage's numbers — inconsistent with the campaign
    // list right below them, which has always been scoped.
    if (action === 'dashboard') {
      const dashAgentId = req.query.agent_id || null
      const dashAll     = req.query.all === '1' || req.query.all === 'true'
      const dashDays    = Math.min(365, Math.max(1, Number(req.query.days) || 30))

      const rich = await tryRpc('mailing_dashboard', {
        p_agent_id: dashAgentId,
        p_all:      dashAll,
        p_days:     dashDays,
      })
      if (rich) return json(res, 200, rich)

      // ── Pre-0031 fallback ────────────────────────────────────────────────
      // Scoped the same way as the RPC above, so the numbers don't change
      // meaning depending on whether the migration has been applied.
      if (!dashAll && !dashAgentId) {
        return json(res, 200, {
          total_mailings: 0, active_mailings: 0, total_recipients: 0,
          total_scans_30d: 0, total_leads_30d: 0, trend: [], top_mailings: [],
        })
      }
      const sinceIso = new Date(Date.now() - dashDays * 86400000).toISOString()
      const { data: allMailings } = await db()
        .from('mailings')
        .select('id, name, status, agent_id, landing_config, recipient_count, scan_count, lead_count, created_at')

      const mailings = (allMailings || []).filter(m => {
        if (dashAll) return true
        if (m.agent_id === dashAgentId) return true
        const ids = m.landing_config?.agent_ids
        return Array.isArray(ids) && ids.includes(dashAgentId)
      })
      const scopedIds = mailings.map(m => m.id)
      if (!scopedIds.length) {
        return json(res, 200, {
          total_mailings: 0, active_mailings: 0, total_recipients: 0,
          total_scans_30d: 0, total_leads_30d: 0, trend: [], top_mailings: [],
        })
      }

      const [scansRes, leadsRes] = await Promise.all([
        db().from('mailing_scans').select('scanned_at').in('mailing_id', scopedIds).gte('scanned_at', sinceIso),
        db().from('mailing_leads').select('id, created_at').in('mailing_id', scopedIds).gte('created_at', sinceIso),
      ])
      const scans = scansRes.data || []
      const leads = leadsRes.data || []

      // Daily scan trend over the window
      const byDay = {}
      for (let i = 0; i < dashDays; i++) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
        byDay[d] = 0
      }
      for (const s of scans) {
        const d = s.scanned_at?.slice(0, 10)
        if (d in byDay) byDay[d]++
      }
      const trend = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }))

      const topMailings = [...mailings]
        .sort((a, b) => (b.scan_count || 0) - (a.scan_count || 0))
        .slice(0, 5)

      return json(res, 200, {
        total_mailings:    mailings.length,
        active_mailings:   mailings.filter(m => m.status === 'active' || m.status === 'sent').length,
        total_recipients:  mailings.reduce((n, m) => n + (m.recipient_count || 0), 0),
        total_scans_30d:   scans.length,
        total_leads_30d:   leads.length,
        trend,
        top_mailings:      topMailings,
      })
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WRITE actions below — POST only
    // ─────────────────────────────────────────────────────────────────────────
    if (req.method !== 'POST') return json(res, 405, { error: 'POST required for write actions' })

    // ── Create a mailing ────────────────────────────────────────────────────
    if (action === 'create') {
      const {
        name, description, agent_id, property_id,
        mailing_type, landing_type, landing_custom_url, landing_config, send_date, status,
      } = req.body
      if (!name?.trim()) return json(res, 400, { error: 'name is required' })

      // Mint a unique token (retry on the astronomically unlikely collision)
      let token, attempts = 0
      while (attempts++ < 5) {
        token = mintToken(8)
        const { data: existing } = await db().from('mailings').select('id').eq('qr_token', token).limit(1)
        if (!existing?.length) break
      }

      const payload = {
        name:               name.trim(),
        description:        description?.trim() || null,
        agent_id:           agent_id || null,
        property_id:        property_id || null,
        mailing_type:       mailing_type || 'postcard',
        landing_type:       landing_type || 'property',
        landing_custom_url: landing_custom_url?.trim() || null,
        landing_config:     landing_config && typeof landing_config === 'object' ? landing_config : {},
        send_date:          send_date || null,
        status:             status || 'draft',
        qr_token:           token,
      }

      const { data, error } = await db().from('mailings').insert([payload]).select().single()
      if (error) throw error
      return json(res, 200, { mailing: data })
    }

    // ── Update mailing ──────────────────────────────────────────────────────
    if (action === 'update') {
      const { id } = req.body
      if (!id) return json(res, 400, { error: 'id required' })
      const ALLOWED = ['name','description','agent_id','property_id','mailing_type','status','landing_type','landing_custom_url','landing_config','send_date']
      const patch = {}
      for (const k of ALLOWED) if (k in req.body) patch[k] = req.body[k]
      if (Object.keys(patch).length === 0) return json(res, 400, { error: 'no updatable fields' })

      const { data, error } = await db().from('mailings').update(patch).eq('id', id).select().single()
      if (error) throw error
      return json(res, 200, { mailing: data })
    }

    // ── Delete mailing ──────────────────────────────────────────────────────
    if (action === 'delete') {
      const { id } = req.body
      if (!id) return json(res, 400, { error: 'id required' })
      const { error } = await db().from('mailings').delete().eq('id', id)
      if (error) throw error
      return json(res, 200, { ok: true })
    }

    // ── Add recipients (bulk) ───────────────────────────────────────────────
    if (action === 'add_recipients') {
      const { mailing_id, recipients } = req.body
      if (!mailing_id || !Array.isArray(recipients) || recipients.length === 0) {
        return json(res, 400, { error: 'mailing_id and recipients[] required' })
      }
      const rows = recipients.slice(0, 5000).map(r => ({
        mailing_id,
        contact_id:     r.contact_id     || null,
        recipient_name: r.recipient_name || r.name || null,
        address_line1:  r.address_line1  || r.address || null,
        address_line2:  r.address_line2  || null,
        city:           r.city           || null,
        state:          r.state          || null,
        zip:            r.zip            || null,
        source:         r.source         || (r.contact_id ? 'database' : 'csv_import'),
      }))
      const { data, error } = await db().from('mailing_recipients').insert(rows).select()
      if (error) throw error

      // Update denormalized counter
      const { count } = await db()
        .from('mailing_recipients')
        .select('*', { count: 'exact', head: true })
        .eq('mailing_id', mailing_id)
      await db().from('mailings').update({ recipient_count: count || 0 }).eq('id', mailing_id)

      return json(res, 200, { recipients: data, count: data.length })
    }

    // ── Remove a recipient ──────────────────────────────────────────────────
    if (action === 'remove_recipient') {
      const { id } = req.body
      if (!id) return json(res, 400, { error: 'id required' })
      const { data: removed } = await db().from('mailing_recipients').select('mailing_id').eq('id', id).single()
      const { error } = await db().from('mailing_recipients').delete().eq('id', id)
      if (error) throw error
      if (removed?.mailing_id) {
        const { count } = await db()
          .from('mailing_recipients')
          .select('*', { count: 'exact', head: true })
          .eq('mailing_id', removed.mailing_id)
        await db().from('mailings').update({ recipient_count: count || 0 }).eq('id', removed.mailing_id)
      }
      return json(res, 200, { ok: true })
    }

    // ── Update recipient response ───────────────────────────────────────────
    if (action === 'update_recipient') {
      const { id, response_type, response_notes, responded } = req.body
      if (!id) return json(res, 400, { error: 'id required' })
      const patch = {}
      if (response_type !== undefined) {
        patch.response_type = response_type
        patch.responded     = responded ?? true
        patch.responded_at  = new Date().toISOString()
      }
      if (response_notes !== undefined) patch.response_notes = response_notes
      if (responded !== undefined && !('responded' in patch)) patch.responded = responded
      const { data, error } = await db().from('mailing_recipients').update(patch).eq('id', id).select().single()
      if (error) throw error
      return json(res, 200, { recipient: data })
    }

    // ── Public: capture lead from landing page ──────────────────────────────
    if (action === 'capture_lead') {
      const { mailing_id, name, email, phone, message, property_address, property_type, source_landing, visit_id } = req.body
      if (!mailing_id) return json(res, 400, { error: 'mailing_id required' })
      if (!name && !email && !phone) return json(res, 400, { error: 'Provide at least name, email, or phone' })

      const ip = clientIp(req)
      const ipHash = hashIp(ip)

      // Insert the lead
      const { data: lead, error: leadErr } = await db().from('mailing_leads').insert([{
        mailing_id,
        name:             name?.trim() || null,
        email:            email?.trim()?.toLowerCase() || null,
        phone:            phone?.trim() || null,
        message:          message?.trim() || null,
        property_address: property_address?.trim() || null,
        property_type:    property_type || null,
        source_landing:   ['property','valuation','custom','multifamily'].includes(source_landing) ? source_landing : 'property',
        ip_hash:          ipHash,
      }]).select().single()
      if (leadErr) throw leadErr

      // Stamp the visit id separately rather than inline in the insert: on a
      // database where 0031 hasn't been applied the column doesn't exist, and
      // an inline value would fail the whole insert and lose the lead. A lead is
      // worth far more than its attribution.
      const cleanVisit = visit_id ? String(visit_id).slice(0, 40) : null
      if (cleanVisit) {
        try { await db().from('mailing_leads').update({ visit_id: cleanVisit }).eq('id', lead.id) } catch { /* attribution only */ }
      }

      // Upsert into contacts (best-effort — don't fail the lead capture if this errors)
      let capturedContactId = null
      try {
        if (email || phone) {
          const parts = (name || '').trim().split(/\s+/)
          const first = parts[0] || ''
          const last  = parts.slice(1).join(' ') || ''
          let contactId = null
          if (email) {
            const { data: existing } = await db()
              .from('contacts').select('id').eq('email', email.trim().toLowerCase()).limit(1)
            if (existing?.length) contactId = existing[0].id
          }
          if (!contactId) {
            const { data: created } = await db().from('contacts').insert([{
              first_name: first || '—',
              last_name:  last  || '—',
              email:      email?.trim()?.toLowerCase() || null,
              phone:      phone?.trim() || null,
              source:     'mailing-landing',
              type:       source_landing === 'valuation' ? 'seller' : 'buyer',
              status:     'active',
            }]).select('id').single()
            contactId = created?.id || null
          }
          if (contactId) {
            await db().from('mailing_leads').update({ contact_id: contactId }).eq('id', lead.id)
            capturedContactId = contactId
          }
        }
      } catch { /* swallow — lead is already saved */ }

      // Close the attribution loop: tie this lead back to the scan that brought
      // them here. With one QR code per campaign the visit id is the only hard
      // evidence linking a conversion to a specific scan, and — when the person
      // matches a contact already on the recipient list — to a specific piece of
      // mail. Best-effort: a lead is never failed for want of attribution.
      try {
        if (cleanVisit) {
          await db().rpc('link_visit_conversion', {
            p_visit_id:   cleanVisit,
            p_mailing_id: mailing_id,
            p_lead_id:    lead.id,
            p_sub_id:     null,
            p_contact_id: capturedContactId,
          })
        }
      } catch { /* pre-0031 database, or nothing to link */ }

      // Bump denormalized lead counter
      await db().from('mailings').update({
        lead_count: (await db().from('mailing_leads').select('*', { count: 'exact', head: true }).eq('mailing_id', mailing_id)).count || 0,
      }).eq('id', mailing_id)

      return json(res, 200, { ok: true, lead_id: lead.id })
    }

    // ── Public: subscribe to a mailing-list landing page ─────────────────────
    // Adds (or reactivates) an opt-in subscriber on the mailing's list. Email is
    // lower-cased and deduped by the (mailing_id, email) unique index so
    // re-submits never create a second row. Also best-effort upserts a CRM
    // contact tagged as a newsletter subscriber.
    if (action === 'capture_subscriber') {
      const { mailing_id, email, name, phone, message, consent } = req.body
      if (!mailing_id) return json(res, 400, { error: 'mailing_id required' })
      const cleanEmail = (email || '').trim().toLowerCase()
      // Basic shape check — the real gate is the DB, but fail fast on junk.
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
        return json(res, 400, { error: 'A valid email address is required' })
      }

      const ipHash = hashIp(clientIp(req))
      const cleanName    = (name    || '').trim() || null
      const cleanPhone   = (phone   || '').trim() || null
      const cleanMessage = (message || '').trim().slice(0, 2000) || null

      // Upsert on the unique (mailing_id, email) index. On conflict we
      // re-subscribe (in case they'd unsubscribed) and refresh name/phone.
      const { data: sub, error: subErr } = await db()
        .from('mailing_subscribers')
        .upsert({
          mailing_id,
          email:           cleanEmail,
          name:            cleanName,
          phone:           cleanPhone,
          message:         cleanMessage,
          status:          'subscribed',
          consent:         consent !== false,
          source:          'landing',
          ip_hash:         ipHash,
          subscribed_at:   new Date().toISOString(),
          unsubscribed_at: null,
        }, { onConflict: 'mailing_id,email', ignoreDuplicates: false })
        .select()
        .single()

      // If the upsert can't run (e.g. the unique index isn't present yet on an
      // older DB), fall back to find-then-update, and insert when brand new — so
      // a subscriber is never lost.
      let subscriber = sub
      if (subErr) {
        const { data: existing } = await db()
          .from('mailing_subscribers')
          .select('id').eq('mailing_id', mailing_id).ilike('email', cleanEmail).limit(1)
        if (existing?.length) {
          const { data: upd } = await db().from('mailing_subscribers')
            .update({ status: 'subscribed', name: cleanName, phone: cleanPhone, message: cleanMessage, unsubscribed_at: null })
            .eq('id', existing[0].id).select().single()
          subscriber = upd
        } else {
          const { data: ins, error: insErr } = await db().from('mailing_subscribers').insert([{
            mailing_id, email: cleanEmail, name: cleanName, phone: cleanPhone, message: cleanMessage,
            status: 'subscribed', consent: consent !== false, source: 'landing', ip_hash: ipHash,
          }]).select().single()
          if (insErr) throw insErr
          subscriber = ins
        }
      }

      // Best-effort: mirror into contacts as a newsletter subscriber. Never fail
      // the subscribe if this errors.
      try {
        const parts = (cleanName || '').split(/\s+/)
        const first = parts[0] || '—'
        const last  = parts.slice(1).join(' ') || '—'
        const { data: existing } = await db()
          .from('contacts').select('id, tags').eq('email', cleanEmail).limit(1)
        if (existing?.length) {
          const tags = Array.isArray(existing[0].tags) ? existing[0].tags : []
          if (!tags.includes('newsletter')) {
            await db().from('contacts').update({ tags: [...tags, 'newsletter'] }).eq('id', existing[0].id)
          }
          if (subscriber) await db().from('mailing_subscribers').update({ contact_id: existing[0].id }).eq('id', subscriber.id)
        } else {
          const { data: created } = await db().from('contacts').insert([{
            first_name: first, last_name: last,
            email: cleanEmail, phone: cleanPhone,
            source: 'mailing-landing', type: 'buyer', status: 'lead',
            tags: ['newsletter'],
          }]).select('id').single()
          if (created && subscriber) await db().from('mailing_subscribers').update({ contact_id: created.id }).eq('id', subscriber.id)
        }
      } catch { /* swallow — subscriber is already saved */ }

      // Same attribution loop as capture_lead — best-effort, never fatal.
      try {
        const cleanVisit = req.body?.visit_id ? String(req.body.visit_id).slice(0, 40) : null
        if (cleanVisit && subscriber?.id) {
          await db().from('mailing_subscribers').update({ visit_id: cleanVisit }).eq('id', subscriber.id)
          await db().rpc('link_visit_conversion', {
            p_visit_id:   cleanVisit,
            p_mailing_id: mailing_id,
            p_lead_id:    null,
            p_sub_id:     subscriber.id,
            p_contact_id: subscriber.contact_id || null,
          })
        }
      } catch { /* pre-0031 database, or nothing to link */ }

      return json(res, 200, { ok: true, subscriber_id: subscriber?.id || null })
    }

    // ── Public: one-click unsubscribe (no login) ─────────────────────────────
    if (action === 'unsubscribe') {
      const token = (req.body?.token || req.query?.token || '').trim()
      if (!token) return json(res, 400, { error: 'token required' })
      const { data, error } = await db()
        .from('mailing_subscribers')
        .update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() })
        .eq('unsubscribe_token', token)
        .select('id, email')
        .maybeSingle()
      if (error) throw error
      if (!data) return json(res, 404, { error: 'This unsubscribe link is no longer valid.' })
      return json(res, 200, { ok: true, email: data.email })
    }

    // ── Deal Machine neighbor lookup ────────────────────────────────────────
    // Proxies a property-search request to Deal Machine so the API key never
    // touches the browser. Folded into campaigns.js to stay under the 12-fn
    // Vercel Hobby limit.
    if (action === 'deal_machine') {
      const apiKey = (process.env.DEAL_MACHINE_API_KEY || '').trim()
      if (!apiKey) return json(res, 200, { setup: true, error: 'DEAL_MACHINE_API_KEY is not configured.' })

      const { address, radius = 500 } = req.body || {}
      if (!address?.trim()) return json(res, 400, { error: 'address is required' })
      const radiusNum = Math.min(5280, Math.max(100, Number(radius) || 500))

      const dmRes = await fetch('https://app.dealmachine.com/api/v2/property_list', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
          'Accept':        'application/json',
        },
        body: JSON.stringify({ address, radius: radiusNum, limit: 500, include_owner_info: true }),
      })

      if (!dmRes.ok) {
        const ct = dmRes.headers.get('content-type') || ''
        const body = ct.includes('json') ? await dmRes.json() : await dmRes.text()
        const msg = typeof body === 'object'
          ? (body.message || body.error || JSON.stringify(body))
          : String(body).slice(0, 300)
        return json(res, dmRes.status, { error: `Deal Machine error: ${msg}` })
      }

      const data = await dmRes.json()
      const raw  = data.properties || data.results || data.data || data.items || []

      const properties = raw.map(p => {
        const ownerFirst = p.owner_first_name || p.mailing_first_name || ''
        const ownerLast  = p.owner_last_name  || p.mailing_last_name  || ''
        const ownerFull  = p.owner_name || p.mailing_name || [ownerFirst, ownerLast].filter(Boolean).join(' ') || null
        return {
          owner_name:       ownerFull,
          address_line1:    p.mailing_street  || p.mailing_address || p.property_street  || p.address || null,
          city:             p.mailing_city    || p.property_city   || p.city    || null,
          state:            p.mailing_state   || p.property_state  || p.state   || null,
          zip:              p.mailing_zip     || p.property_zip    || p.zip     || null,
          property_address: p.property_street || p.property_address || p.address || null,
          property_type:    p.property_type   || p.type            || null,
          estimated_value:  p.estimated_value || p.avm             || p.value   || null,
        }
      }).filter(p => p.owner_name || p.address_line1)

      return json(res, 200, { properties, count: properties.length })
    }

    return json(res, 400, { error: `Unknown action: ${action}` })
  } catch (err) {
    console.error('[api/campaigns]', err)
    return json(res, 500, { error: err.message || 'Internal error' })
  }
}
