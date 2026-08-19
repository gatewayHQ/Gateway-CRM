// ─────────────────────────────────────────────────────────────────────────────
// Microsoft Graph (Outlook) integration — shared helpers.
//
// Everything here is server-only (imported by api/email-send.js, never
// bundled into the browser build — Vercel does not route api/_lib/*). Covers:
//   • AES-256-GCM encryption for tokens at rest (ms_graph_connections)
//   • PKCE verifier/challenge generation
//   • the Authorization Code + PKCE exchange with Microsoft's v2.0 endpoint
//   • Graph calls: GET /me, POST /me/sendMail
//   • getValidAccessToken() — the single place that decides whether a stored
//     token needs refreshing before use, so every caller gets a live token
//     without duplicating the refresh dance.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto'

const TENANT   = process.env.MICROSOFT_TENANT_ID || 'common'
const CLIENT_ID     = process.env.MICROSOFT_CLIENT_ID
const CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET

const AUTHORITY   = `https://login.microsoftonline.com/${TENANT}`
export const AUTHORIZE_ENDPOINT = `${AUTHORITY}/oauth2/v2.0/authorize`
export const TOKEN_ENDPOINT     = `${AUTHORITY}/oauth2/v2.0/token`
export const GRAPH_BASE         = 'https://graph.microsoft.com/v1.0'

// Full delegated permission set the Azure App Registration already grants
// (admin consent not required). Requested up front so calendar/contacts sync
// can be built later without forcing every agent to reconnect.
const DEFAULT_SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Mail.ReadWrite',
  'https://graph.microsoft.com/Mail.ReadBasic',
  'https://graph.microsoft.com/Calendars.Read',
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'https://graph.microsoft.com/Contacts.Read',
].join(' ')
export const GRAPH_SCOPES = process.env.MICROSOFT_GRAPH_SCOPES || DEFAULT_SCOPES

export function assertMicrosoftConfigured() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    const e = new Error('Server misconfigured: MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET missing')
    e.status = 500
    throw e
  }
}

// The exact URI registered on the Azure app's "Web" platform. An explicit env
// var avoids a preview-deployment host ever being used in a token exchange;
// falls back to the current request's host for local dev / previews.
export function resolveRedirectUri(req) {
  if (process.env.MICROSOFT_REDIRECT_URI) return process.env.MICROSOFT_REDIRECT_URI
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host  = req.headers['x-forwarded-host'] || req.headers.host
  return `${proto}://${host}/api/email-send?action=outlook-callback`
}

// ─── PKCE ─────────────────────────────────────────────────────────────────────

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generateCodeVerifier() {
  return base64url(crypto.randomBytes(32))
}

export function codeChallengeFor(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest())
}

export function generateState() {
  return crypto.randomBytes(24).toString('hex')
}

// ─── Token encryption at rest ─────────────────────────────────────────────────
// AES-256-GCM, output = base64(iv[12] || authTag[16] || ciphertext).

const ALGO = 'aes-256-gcm'

function encryptionKey() {
  const raw = process.env.MS_TOKEN_ENCRYPTION_KEY
  if (!raw) {
    const e = new Error('Server misconfigured: MS_TOKEN_ENCRYPTION_KEY missing')
    e.status = 500
    throw e
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    const e = new Error('MS_TOKEN_ENCRYPTION_KEY must decode (base64) to 32 bytes — generate with: openssl rand -base64 32')
    e.status = 500
    throw e
  }
  return key
}

export function encryptToken(plaintext) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, encryptionKey(), iv)
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

export function decryptToken(encoded) {
  const buf = Buffer.from(encoded, 'base64')
  const iv  = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct  = buf.subarray(28)
  const decipher = crypto.createDecipheriv(ALGO, encryptionKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// ─── OAuth authorize URL ──────────────────────────────────────────────────────

export function buildAuthorizeUrl({ state, codeChallenge, redirectUri }) {
  assertMicrosoftConfigured()
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: GRAPH_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  })
  return `${AUTHORIZE_ENDPOINT}?${params.toString()}`
}

// ─── Token exchange / refresh ─────────────────────────────────────────────────

async function postToken(body) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(data.error_description || data.error || `Microsoft token endpoint error (HTTP ${res.status})`)
    e.status = 502
    throw e
  }
  return data
}

export async function exchangeCodeForTokens({ code, codeVerifier, redirectUri }) {
  assertMicrosoftConfigured()
  return postToken({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    scope: GRAPH_SCOPES,
  })
}

export async function refreshTokens(refreshToken) {
  assertMicrosoftConfigured()
  return postToken({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: GRAPH_SCOPES,
  })
}

// ─── Graph calls ──────────────────────────────────────────────────────────────

export async function fetchGraphProfile(accessToken) {
  const res = await fetch(`${GRAPH_BASE}/me?$select=id,displayName,mail,userPrincipalName`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(data?.error?.message || `Graph /me failed (HTTP ${res.status})`)
    e.status = res.status === 401 ? 401 : 502
    throw e
  }
  return {
    microsoftUserId: data.id,
    email: data.mail || data.userPrincipalName,
    displayName: data.displayName || null,
  }
}

function toRecipientList(list) {
  return (Array.isArray(list) ? list : [list]).filter(Boolean).map(addr => {
    const { name, email } = typeof addr === 'string' ? { email: addr } : addr
    return { emailAddress: { address: email, ...(name ? { name } : {}) } }
  })
}

// POST /me/sendMail. Graph returns 202 Accepted with no body on success — it
// does not hand back a message id (the sent message lands in Sent Items, but
// resolving it to an id would need a follow-up /me/mailFolders/sentitems
// lookup, deferred until reply-threading is built).
export async function sendGraphMail(accessToken, { subject, html, to, cc }) {
  const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject: subject || '(no subject)',
        body: { contentType: 'HTML', content: html || '' },
        toRecipients: toRecipientList(to),
        ...(cc && cc.length ? { ccRecipients: toRecipientList(cc) } : {}),
      },
      saveToSentItems: true,
    }),
  })
  if (res.status === 202) return
  const data = await res.json().catch(() => ({}))
  const e = new Error(data?.error?.message || `Graph sendMail failed (HTTP ${res.status})`)
  e.status = res.status === 401 ? 401 : 502
  throw e
}

// ─── Calendar events (deal key dates → agent's Outlook calendar) ─────────────
// Key dates are plain dates (no time), so every event is created ALL-DAY.
// Graph still requires a timeZone on the start/end even for all-day events —
// defaults to the brokerage's own (Iowa/Nebraska/South Dakota corridor is
// Central), overridable per-deployment since this is shared across every agent
// rather than a per-agent preference (v1 scope).
const CALENDAR_TIMEZONE = process.env.MS_CALENDAR_TIMEZONE || 'Central Standard Time'
// Single native Outlook reminder, fired this many minutes before the date
// (default 3 days — matches the CRM's own 72h reminder threshold). Graph
// events support exactly one reminder each, unlike the CRM's 72h/24h/today
// cadence, so this is deliberately the earliest of those three: it gives the
// agent a heads-up in their calendar app, while the CRM's own email/in-app
// reminders (api/cron.js ?task=reminders) still fire at 24h and today too.
const CALENDAR_REMINDER_MINUTES = Number(process.env.MS_CALENDAR_REMINDER_MINUTES || 4320)

function allDayBounds(dateStr) {
  const start = dateStr
  const end = new Date(`${dateStr}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 1)
  return { start, end: end.toISOString().slice(0, 10) }
}

function calendarEventBody({ subject, date, bodyHtml }) {
  const { start, end } = allDayBounds(date)
  return {
    subject,
    body: { contentType: 'HTML', content: bodyHtml || '' },
    start: { dateTime: `${start}T00:00:00`, timeZone: CALENDAR_TIMEZONE },
    end:   { dateTime: `${end}T00:00:00`,   timeZone: CALENDAR_TIMEZONE },
    isAllDay: true,
    isReminderOn: true,
    reminderMinutesBeforeStart: CALENDAR_REMINDER_MINUTES,
    categories: ['Gateway CRM'],
  }
}

async function graphEventRequest(method, url, accessToken, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (res.status === 204) return null                    // DELETE success
  const data = await res.json().catch(() => ({}))
  if (res.ok) return data
  const e = new Error(data?.error?.message || `Graph calendar ${method} failed (HTTP ${res.status})`)
  e.status = res.status
  throw e
}

export async function createCalendarEvent(accessToken, { subject, date, bodyHtml }) {
  return graphEventRequest('POST', `${GRAPH_BASE}/me/events`, accessToken, calendarEventBody({ subject, date, bodyHtml }))
}

export async function updateCalendarEvent(accessToken, eventId, { subject, date, bodyHtml }) {
  return graphEventRequest('PATCH', `${GRAPH_BASE}/me/events/${eventId}`, accessToken, calendarEventBody({ subject, date, bodyHtml }))
}

// Idempotent — an event already deleted by the agent themselves (in Outlook
// directly) 404s, which is treated as success by the caller (calendarSync.js),
// not surfaced as a sync failure.
export async function deleteCalendarEvent(accessToken, eventId) {
  return graphEventRequest('DELETE', `${GRAPH_BASE}/me/events/${eventId}`, accessToken)
}

// ─── Valid-token resolution (refresh-on-demand) ───────────────────────────────
// Called by every send/sync path. Refreshes when the stored token is within 2
// minutes of expiry (or already expired), persists the new pair, and marks the
// connection 'error' if the refresh itself fails (e.g. the agent revoked
// access in Microsoft 365) so the UI can prompt a reconnect instead of
// retrying a dead refresh token forever.
export async function getValidAccessToken(svc, agentId) {
  const { data: conn, error } = await svc
    .from('ms_graph_connections')
    .select('*')
    .eq('agent_id', agentId)
    .maybeSingle()
  if (error) { const e = new Error(error.message); e.status = 500; throw e }
  if (!conn) { const e = new Error('Outlook is not connected for this account'); e.status = 409; throw e }

  const msUntilExpiry = new Date(conn.token_expires_at).getTime() - Date.now()
  if (msUntilExpiry > 2 * 60 * 1000) {
    return { accessToken: decryptToken(conn.access_token_enc), connection: conn }
  }

  let refreshed
  try {
    refreshed = await refreshTokens(decryptToken(conn.refresh_token_enc))
  } catch (err) {
    await svc.from('ms_graph_connections')
      .update({ status: 'error', last_error: err.message })
      .eq('agent_id', agentId)
    const e = new Error('Microsoft account needs to be reconnected — refresh failed')
    e.status = 409
    throw e
  }

  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
  const update = {
    access_token_enc: encryptToken(refreshed.access_token),
    token_expires_at: newExpiresAt,
    status: 'connected',
    last_error: null,
  }
  // Microsoft rotates the refresh token on some but not all responses — keep
  // the existing one if a new one wasn't issued.
  if (refreshed.refresh_token) update.refresh_token_enc = encryptToken(refreshed.refresh_token)

  const { data: updated } = await svc
    .from('ms_graph_connections')
    .update(update)
    .eq('agent_id', agentId)
    .select('*')
    .single()

  return { accessToken: refreshed.access_token, connection: updated || { ...conn, ...update } }
}
