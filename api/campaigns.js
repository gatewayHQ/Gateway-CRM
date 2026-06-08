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
 *   GET  ?action=scans&mailing_id=X            → recent scan events
 *   GET  ?action=leads&mailing_id=X            → captured leads
 *   GET  ?action=analytics&mailing_id=X        → per-mailing rollups
 *   GET  ?action=dashboard                     → org-wide stats
 *   GET  ?action=scan&token=X                  → public QR endpoint, 302 → landing
 *   GET  ?action=health                        → uptime probe (no DB)
 *   POST {action:'create',...}                 → new mailing (mints qr_token)
 *   POST {action:'update',id,...}              → patch mailing
 *   POST {action:'delete',id}                  → delete mailing (cascades)
 *   POST {action:'add_recipients',...}         → bulk insert recipients
 *   POST {action:'remove_recipient',id}        → delete one recipient
 *   POST {action:'update_recipient',id,...}    → patch response status
 *   POST {action:'capture_lead',...}           → public landing-page form submit
 *
 * Auth: service role key bypasses RLS for server-side writes. The 'scan' and
 *       'capture_lead' actions are intentionally unauthenticated (public).
 */

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'

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

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
         req.socket?.remoteAddress || null
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

// ─── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()

  const action = req.body?.action || req.query?.action
  if (!action) return json(res, 400, { error: 'action is required' })

  try {
    // ── Public: QR scan tracking + redirect ─────────────────────────────────
    if (action === 'scan') {
      const { token } = req.query
      if (!token) return res.status(400).send('Missing token')

      const { data: m } = await db()
        .from('mailings')
        .select('id, name, landing_type, landing_custom_url, landing_config, property_id, status, scan_count')
        .eq('qr_token', token)
        .single()
      if (!m) return res.status(404).send('Mailing not found')

      // Compute redirect destination
      let dest
      if (m.landing_type === 'custom' && m.landing_custom_url) {
        dest = m.landing_custom_url
      } else if (m.landing_type === 'valuation') {
        dest = `/lp/valuation/${m.id}`
      } else if (m.landing_type === 'multifamily') {
        dest = `/lp/multifamily/${m.id}`
      } else {
        dest = `/lp/property/${m.id}`
      }

      // Social/link-preview crawlers: serve Open Graph tags built from the
      // mailing so Facebook/iMessage/etc. show the property (not "Gateway CRM").
      // These hits are NOT counted as scans, and external custom URLs are left
      // to redirect so the destination provides its own preview.
      const isExternalCustom = m.landing_type === 'custom' && m.landing_custom_url
      if (isCrawler(req) && !isExternalCustom) {
        const { title, description, image } = mailingOgFields(m)
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400')
        return res.status(200).send(ogHtml({ url: `${baseUrl(req)}${dest}`, title, description, image }))
      }

      // Real visitor — log the scan + bump counter. Fire-and-forget; never block
      // the redirect. (Counter race is acceptable at our scale.)
      const ip = clientIp(req)
      db().from('mailing_scans').insert({
        mailing_id:  m.id,
        ip_hash:     hashIp(ip),
        user_agent:  (req.headers['user-agent'] || '').slice(0, 500),
        referrer:    (req.headers.referer || req.headers.referrer || '').slice(0, 500),
        country:     req.headers['x-vercel-ip-country'] || null,
      }).then(() => {})

      db().from('mailings')
        .update({ scan_count: (m.scan_count || 0) + 1 })
        .eq('id', m.id)
        .then(() => {})

      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Location', dest)
      return res.status(302).end()
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

      const type = lt === 'valuation' ? 'valuation' : lt === 'multifamily' ? 'multifamily' : 'property'
      const dest = `/lp/${type}/${m.id}`
      const { title, description, image } = mailingOgFields(m)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400')
      return res.status(200).send(ogHtml({ url: `${baseUrl(req)}${dest}`, title, description, image }))
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
    if (action === 'scans') {
      const { mailing_id, limit = 100 } = req.query
      if (!mailing_id) return json(res, 400, { error: 'mailing_id required' })
      const { data, error } = await db()
        .from('mailing_scans')
        .select('*')
        .eq('mailing_id', mailing_id)
        .order('scanned_at', { ascending: false })
        .limit(Number(limit))
      if (error) throw error
      return json(res, 200, { scans: data })
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

    // ── Per-mailing analytics rollup ────────────────────────────────────────
    if (action === 'analytics') {
      const { mailing_id } = req.query
      if (!mailing_id) return json(res, 400, { error: 'mailing_id required' })

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

      return json(res, 200, {
        recipients_total:    recipients.length,
        recipients_scanned:  recipientsScanned,
        recipients_responded: recipients.filter(r => r.responded).length,
        total_scans:         scans.length,
        unique_scanners:     uniqueScanners,
        total_leads:         leads.length,
        scan_rate:           recipients.length > 0 ? recipientsScanned / recipients.length : 0,
        response_rate:       recipients.length > 0 ? recipients.filter(r => r.responded).length / recipients.length : 0,
        timeline,
        by_response:         byResponse,
      })
    }

    // ── Org-wide dashboard ──────────────────────────────────────────────────
    if (action === 'dashboard') {
      const [mailingsRes, scansRes, leadsRes] = await Promise.all([
        db().from('mailings').select('id, name, status, agent_id, recipient_count, scan_count, lead_count, created_at'),
        db().from('mailing_scans').select('scanned_at').gte('scanned_at', new Date(Date.now() - 30 * 86400000).toISOString()),
        db().from('mailing_leads').select('id, created_at').gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString()),
      ])
      const mailings = mailingsRes.data || []
      const scans    = scansRes.data || []
      const leads    = leadsRes.data || []

      // Daily scan trend over 30d
      const byDay = {}
      for (let i = 0; i < 30; i++) {
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
      const { mailing_id, name, email, phone, message, property_address, property_type, source_landing } = req.body
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

      // Upsert into contacts (best-effort — don't fail the lead capture if this errors)
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
          }
        }
      } catch { /* swallow — lead is already saved */ }

      // Bump denormalized lead counter
      await db().from('mailings').update({
        lead_count: (await db().from('mailing_leads').select('*', { count: 'exact', head: true }).eq('mailing_id', mailing_id)).count || 0,
      }).eq('id', mailing_id)

      return json(res, 200, { ok: true, lead_id: lead.id })
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
