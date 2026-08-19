/**
 * Gateway CRM — Email Send API
 *
 * Default (no ?action): POST /api/email-send — sends via Resend.
 * Body:
 *   {
 *     to:        string | string[]   - recipient address(es)
 *     subject:   string                - email subject
 *     html:      string                - HTML body (preferred)
 *     text:      string                - plaintext fallback
 *     from?:     string                - "Name <email@domain>" (defaults to RESEND_FROM env)
 *     replyTo?:  string                - reply-to address
 *     tags?:     {name, value}[]       - Resend tags for tracking
 *     idempotencyKey?: string          - prevents duplicate sends on retry
 *   }
 * Headers (optional):
 *   x-resend-key                       - per-user/agent override of API key
 *
 * Why this exists:
 *  • Keeps the Resend API key out of the browser (security)
 *  • Provides a server-side audit point for compliance / logging
 *  • Enables sequence automation (a cron worker can call this internally)
 *  • Centralized rate limiting + retry logic
 *
 * Microsoft Graph (Outlook) actions — folded into this same function rather
 * than a new api/*.js file: Vercel Hobby caps a project at 12 serverless
 * functions and this project is already at that limit (see api/campaigns.js).
 * Both providers live under the one "send email" surface.
 *
 *   POST ?action=outlook-connect      (auth) → { authUrl } to redirect the browser to
 *   GET  ?action=outlook-callback     Microsoft's redirect target; exchanges the
 *                                     code, stores the encrypted token pair, 302s
 *                                     back into the app
 *   POST ?action=outlook-send         (auth) → send via Graph /me/sendMail, logs
 *                                     email_messages + a companion activities row.
 *                                     Body { draft: true } creates a DRAFT in the
 *                                     agent's own mailbox instead of sending —
 *                                     for review/personalization in Outlook itself.
 *   POST ?action=outlook-disconnect   (auth) → removes the stored connection
 *   POST ?action=outlook-calendar-sync (auth) → push one deal's key dates to
 *                                     the ASSIGNED agent's Outlook calendar
 *                                     (create/update/delete Graph events to
 *                                     match deals.comp_data.key_dates); fired
 *                                     right after an edit in Pipeline's Key
 *                                     Dates tab. api/cron.js?task=calendar-sync
 *                                     is the nightly sweep over every deal.
 *   POST ?action=outlook-contact-lookup (auth) → { email } -> matching contact
 *                                     from the agent's OWN Outlook contacts
 *                                     (name/phone/company), or null. Read-only;
 *                                     never written back to the CRM automatically.
 *   POST ?action=outlook-freebusy     (auth) → { date } -> the agent's OWN
 *                                     busy blocks that day (self-check only —
 *                                     see api/_lib/msGraph.js#getFreeBusy for
 *                                     why this doesn't check OTHER agents).
 *
 * Auth for the outlook-* actions (except the callback, which cannot carry a
 * Bearer token — it's a bare browser redirect from Microsoft) is the normal
 * Supabase JWT via requireAgent() (api/_lib/auth.js). The callback instead
 * resolves identity from the one-time ms_oauth_states row created at connect time.
 */

import { requireAgent, getServiceClient, errorResponse } from './_lib/auth.js'
import { wrap } from './_lib/observability.js'
import {
  generateState, generateCodeVerifier, codeChallengeFor, buildAuthorizeUrl,
  resolveRedirectUri, exchangeCodeForTokens, fetchGraphProfile,
  encryptToken, getValidAccessToken, sendGraphMail,
  lookupGraphContact, createDraftMessage, getFreeBusy,
} from './_lib/msGraph.js'
import { syncDealCalendar } from './_lib/calendarSync.js'

const SHARED_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-resend-key, x-gateway-secret',
}

// In-memory rate limit (per cold-start). Resets when the function reloads.
// For multi-instance enforcement, swap this for Upstash/Redis later.
const rateMap = new Map()
const RATE_WINDOW_MS = 60_000   // 1 minute
const RATE_LIMIT     = 30       // 30 emails/min/IP

function checkRateLimit(ip) {
  const now = Date.now()
  const entry = rateMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS }
  if (now > entry.resetAt) {
    entry.count = 0
    entry.resetAt = now + RATE_WINDOW_MS
  }
  entry.count++
  rateMap.set(ip, entry)
  return entry.count <= RATE_LIMIT
}

function applyCors(res) {
  for (const [k, v] of Object.entries(SHARED_HEADERS)) res.setHeader(k, v)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function appBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/+$/, '')
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host  = req.headers['x-forwarded-host'] || req.headers.host
  return `${proto}://${host}`
}

// ─── Microsoft Graph: connect ────────────────────────────────────────────────
// Returns an authUrl for the client to navigate to (rather than redirecting
// this response directly), so the initiating call can carry the normal
// Authorization: Bearer header like every other authenticated fetch in the app.
async function handleOutlookConnect(req, res) {
  const { agent } = await requireAgent(req)
  const svc = getServiceClient()
  const redirectUri  = resolveRedirectUri(req)
  const state        = generateState()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = codeChallengeFor(codeVerifier)
  const returnPath   = typeof req.body?.returnPath === 'string' ? req.body.returnPath.slice(0, 200) : '/'

  // No cron sweep for this table — opportunistic cleanup on every connect attempt.
  await svc.from('ms_oauth_states').delete().lt('expires_at', new Date().toISOString())

  const { error } = await svc.from('ms_oauth_states').insert([{
    state, agent_id: agent.id, code_verifier: codeVerifier, redirect_uri: redirectUri, return_path: returnPath,
  }])
  if (error) return errorResponse(res, Object.assign(new Error(error.message), { status: 500 }))

  const authUrl = buildAuthorizeUrl({ state, codeChallenge, redirectUri })
  return res.status(200).json({ authUrl })
}

// ─── Microsoft Graph: OAuth callback ─────────────────────────────────────────
// Unauthenticated by necessity (Microsoft's redirect carries no Bearer token).
// Identity comes from the one-time ms_oauth_states row created by connect.
async function handleOutlookCallback(req, res) {
  const svc = getServiceClient()
  const { code, state, error: oauthError, error_description: oauthErrorDesc } = req.query || {}
  const base = appBaseUrl(req)

  const redirectTo = (path, params) => {
    const qs = new URLSearchParams(params).toString()
    res.setHeader('Location', `${base}${path}${qs ? `?${qs}` : ''}`)
    return res.status(302).end()
  }

  if (oauthError) return redirectTo('/', { outlook: 'error', message: oauthErrorDesc || oauthError })
  if (!code || !state) return redirectTo('/', { outlook: 'error', message: 'Missing code or state' })

  const { data: pending } = await svc.from('ms_oauth_states').select('*').eq('state', state).maybeSingle()
  if (pending) await svc.from('ms_oauth_states').delete().eq('state', state)  // one-time use either way

  if (!pending || new Date(pending.expires_at) < new Date()) {
    return redirectTo('/', { outlook: 'error', message: 'This connection attempt expired — please try again' })
  }

  try {
    const tokens  = await exchangeCodeForTokens({ code, codeVerifier: pending.code_verifier, redirectUri: pending.redirect_uri })
    const profile = await fetchGraphProfile(tokens.access_token)

    const { error } = await svc.from('ms_graph_connections').upsert([{
      agent_id:          pending.agent_id,
      microsoft_user_id: profile.microsoftUserId,
      email:             profile.email,
      display_name:      profile.displayName,
      access_token_enc:  encryptToken(tokens.access_token),
      refresh_token_enc: encryptToken(tokens.refresh_token),
      token_expires_at:  new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      scopes:            String(tokens.scope || '').split(' ').filter(Boolean),
      status:            'connected',
      last_error:        null,
      connected_at:      new Date().toISOString(),
    }], { onConflict: 'agent_id' })
    if (error) throw new Error(error.message)

    return redirectTo(pending.return_path || '/', { outlook: 'connected' })
  } catch (err) {
    console.error('[email-send] outlook-callback failed:', err.message)
    return redirectTo(pending.return_path || '/', { outlook: 'error', message: err.message })
  }
}

// ─── Microsoft Graph: send ───────────────────────────────────────────────────
async function handleOutlookSend(req, res) {
  const { agent } = await requireAgent(req)
  const svc = getServiceClient()
  const { to, cc, subject, html, text, contactId, dealId, draft } = req.body || {}

  if (!to || (Array.isArray(to) && to.length === 0)) {
    return res.status(400).json({ error: 'Missing "to" recipient' })
  }
  const bodyHtml = html || (text ? `<p style="white-space:pre-wrap">${escapeHtml(text)}</p>` : '')
  if (!bodyHtml) return res.status(400).json({ error: 'Provide "html" or "text" body' })

  const { accessToken, connection } = await getValidAccessToken(svc, agent.id)

  const toList = Array.isArray(to) ? to : [to]
  const ccList = cc ? (Array.isArray(cc) ? cc : [cc]) : []

  // draft: true creates the message in the agent's own Outlook drafts instead
  // of sending — for an agent who wants to review/personalize before it goes
  // out. Not logged as an activity (nothing was actually sent to the contact
  // yet), but still recorded in email_messages so it isn't lost from the CRM's
  // own view of what's in flight.
  let sendError = null
  let draftWebLink = null
  try {
    if (draft) {
      const created = await createDraftMessage(accessToken, { subject, html: bodyHtml, to: toList, cc: ccList })
      draftWebLink = created?.webLink || null
    } else {
      await sendGraphMail(accessToken, { subject, html: bodyHtml, to: toList, cc: ccList })
    }
  } catch (err) {
    sendError = err.message
  }

  const preview = String(text || html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280)

  // Companion activities row so a SENT email shows up in the existing
  // contact/deal timeline (src/pages/Contacts/ActivityTab.jsx, DealPage.jsx).
  // Best-effort — never let a logging failure look like the send itself failed.
  let activityId = null
  if (!sendError && !draft && (contactId || dealId)) {
    const { data: activity } = await svc.from('activities').insert([{
      contact_id: contactId || null,
      deal_id:    dealId || null,
      agent_id:   agent.id,
      type:       'email',
      body:       `Sent: "${subject || '(no subject)'}"${preview ? `\n\n${preview}` : ''}`,
    }]).select('id').single()
    activityId = activity?.id || null
  }

  const { data: emailRow, error: logError } = await svc.from('email_messages').insert([{
    agent_id:      agent.id,
    contact_id:    contactId || null,
    deal_id:       dealId || null,
    activity_id:   activityId,
    subject:       subject || null,
    body_preview:  preview || null,
    body_html:     bodyHtml,
    to_recipients: toList.map(email => ({ email })),
    cc_recipients: ccList.map(email => ({ email })),
    status:        sendError ? 'failed' : draft ? 'draft' : 'sent',
    error_message: sendError,
  }]).select('id').single()

  if (logError) {
    console.error('[email-send] outlook-send: email_messages insert failed:', logError.message)
  }
  if (sendError) {
    return res.status(502).json({ error: sendError, emailId: emailRow?.id })
  }
  return res.status(200).json({ ok: true, from: connection.email, emailId: emailRow?.id, draftWebLink })
}

// ─── Microsoft Graph: disconnect ─────────────────────────────────────────────
async function handleOutlookDisconnect(req, res) {
  const { agent } = await requireAgent(req)
  const svc = getServiceClient()
  const { error } = await svc.from('ms_graph_connections').delete().eq('agent_id', agent.id)
  if (error) return errorResponse(res, Object.assign(new Error(error.message), { status: 500 }))
  return res.status(200).json({ ok: true })
}

// ─── Microsoft Graph: on-demand calendar sync (one deal) ─────────────────────
// Fired right after an agent edits a key date (src/pages/Pipeline.jsx). Only
// the deal's ASSIGNED agent may trigger this — it writes to THEIR Outlook
// calendar, so a co-agent (who can otherwise see/edit the deal) has no
// business pushing events onto someone else's personal calendar.
async function handleOutlookCalendarSync(req, res) {
  const { agent } = await requireAgent(req)
  const svc = getServiceClient()
  const { dealId } = req.body || {}
  if (!dealId) return res.status(400).json({ error: 'Missing dealId' })

  const { data: deal, error } = await svc.from('deals')
    .select('id, title, agent_id, stage, comp_data, property_id')
    .eq('id', dealId).maybeSingle()
  if (error) return errorResponse(res, Object.assign(new Error(error.message), { status: 500 }))
  if (!deal) return res.status(404).json({ error: 'Deal not found' })
  if (deal.agent_id !== agent.id) {
    return res.status(403).json({ error: "Only this deal's assigned agent can sync it to their calendar" })
  }

  let property = null
  if (deal.property_id) {
    const { data: p } = await svc.from('properties').select('address').eq('id', deal.property_id).maybeSingle()
    property = p
  }

  const result = await syncDealCalendar(svc, deal, { property })
  return res.status(200).json({ ok: true, ...result })
}

// ─── Microsoft Graph: contact enrichment ─────────────────────────────────────
// Read-only lookup against the AGENT'S OWN Outlook contacts — never written
// back to the CRM automatically. The caller (ContactDrawer.jsx) decides
// what, if anything, to fill in, and never overwrites a field that already
// has a value.
async function handleOutlookContactLookup(req, res) {
  const { agent } = await requireAgent(req)
  const svc = getServiceClient()
  const { email } = req.body || {}
  if (!email) return res.status(400).json({ error: 'Missing email' })

  const { accessToken } = await getValidAccessToken(svc, agent.id)
  const match = await lookupGraphContact(accessToken, email)
  return res.status(200).json({ ok: true, match })
}

// ─── Microsoft Graph: free/busy (self-check) ─────────────────────────────────
async function handleOutlookFreeBusy(req, res) {
  const { agent } = await requireAgent(req)
  const svc = getServiceClient()
  const { date } = req.body || {}
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Missing or invalid "date" (expected YYYY-MM-DD)' })
  }

  const { accessToken, connection } = await getValidAccessToken(svc, agent.id)
  const result = await getFreeBusy(accessToken, {
    email: connection.email,
    startISO: `${date}T00:00:00Z`,
    endISO:   `${date}T23:59:59Z`,
    intervalMinutes: 30,
  })
  return res.status(200).json({ ok: true, ...result })
}

// ─── Resend (legacy default path — unchanged) ────────────────────────────────
async function handleResendSend(req, res) {
  // ── Rate limit ────────────────────────────────────────────────────────────
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.socket?.remoteAddress || 'unknown'
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' })
  }

  // ── Resolve API key ───────────────────────────────────────────────────────
  // Priority: per-request header (for power users with their own Resend account)
  //           → server env var (for default workspace key)
  const apiKey = req.headers['x-resend-key'] || process.env.RESEND_API_KEY
  if (!apiKey) {
    return res.status(500).json({
      error: 'No Resend API key configured. Set RESEND_API_KEY in Vercel env vars or pass x-resend-key header.',
    })
  }

  // ── Validate payload ──────────────────────────────────────────────────────
  const { to, subject, html, text, from, replyTo, tags, idempotencyKey } = req.body || {}

  if (!to || (Array.isArray(to) && to.length === 0)) {
    return res.status(400).json({ error: 'Missing "to" recipient' })
  }
  if (!subject || typeof subject !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "subject"' })
  }
  if (!html && !text) {
    return res.status(400).json({ error: 'Provide either "html" or "text" body' })
  }

  const fromAddr = from || process.env.RESEND_FROM
  if (!fromAddr) {
    return res.status(400).json({
      error: 'No "from" address. Pass `from` in the request body or set RESEND_FROM env var.',
    })
  }

  // Basic email sanity check — catches obvious typos before hitting Resend
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const toList = Array.isArray(to) ? to : [to]
  for (const addr of toList) {
    if (!emailRegex.test(addr)) {
      return res.status(400).json({ error: `Invalid recipient address: ${addr}` })
    }
  }

  // ── Build Resend payload ──────────────────────────────────────────────────
  const payload = {
    from:    fromAddr,
    to:      toList,
    subject,
    ...(html    ? { html }    : {}),
    ...(text    ? { text }    : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(tags    ? { tags }    : {}),
  }

  // ── Send via Resend with retry on transient errors ────────────────────────
  const maxAttempts = 3
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const headers = {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      }
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })

      const data = await response.json().catch(() => ({}))

      if (response.ok) {
        // Success — return Resend's response (includes message ID)
        return res.status(200).json({
          ok: true,
          id: data.id,
          attempt,
        })
      }

      // 4xx: don't retry, return immediately with normalized error
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return res.status(response.status).json({
          error:   data?.message || data?.error || `Resend API error (HTTP ${response.status})`,
          details: data,
        })
      }

      // 5xx or 429: retry with backoff
      lastError = data?.message || `HTTP ${response.status}`
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt - 1)))
      }
    } catch (err) {
      lastError = err.message
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt - 1)))
      }
    }
  }

  return res.status(502).json({
    error: `Email send failed after ${maxAttempts} attempts: ${lastError}`,
  })
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function handler(req, res) {
  applyCors(res)
  if (req.method === 'OPTIONS') return res.status(200).end()

  const action = req.body?.action || req.query?.action

  try {
    if (action === 'outlook-callback') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
      return await handleOutlookCallback(req, res)
    }
    if (action === 'outlook-connect') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleOutlookConnect(req, res)
    }
    if (action === 'outlook-send') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleOutlookSend(req, res)
    }
    if (action === 'outlook-disconnect') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleOutlookDisconnect(req, res)
    }
    if (action === 'outlook-calendar-sync') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleOutlookCalendarSync(req, res)
    }
    if (action === 'outlook-contact-lookup') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleOutlookContactLookup(req, res)
    }
    if (action === 'outlook-freebusy') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleOutlookFreeBusy(req, res)
    }
  } catch (err) {
    return errorResponse(res, err)
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  return handleResendSend(req, res)
}

export default wrap('email-send', handler)
