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

// Throttle-aware Graph request. Microsoft Graph throttles per-mailbox and
// answers 429 with a Retry-After header; a lifetime-history pull is the one
// call in this integration that can realistically walk into that wall, since
// it pages until the mailbox runs out of matches. Honoring Retry-After (rather
// than a fixed backoff) is what Microsoft asks for, and 503/504 get the same
// treatment because both mean "not processed".
//
// GET-only by design: every retry here is on a read. The write paths above
// (sendMail, event create/update) deliberately do NOT retry — a resent mail or
// a duplicate calendar event is worse than a surfaced error.
const GRAPH_RETRY_STATUS = new Set([429, 503, 504])
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export function graphBackoffMs(attempt, retryAfterSec) {
  if (retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 20000)
  return 500 * (2 ** attempt) + Math.floor(Math.random() * 250)   // 500/1000/2000ms (+jitter)
}

export async function graphFetch(url, { accessToken, maxRetries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok && GRAPH_RETRY_STATUS.has(res.status) && attempt < maxRetries) {
      const delay = graphBackoffMs(attempt, Number(res.headers.get('retry-after')) || 0)
      console.warn(`[msGraph] ${res.status} on GET — retry ${attempt + 1}/${maxRetries} in ${delay}ms`)
      await sleep(delay)
      continue
    }
    const data = await res.json().catch(() => ({}))
    if (res.ok) return data
    const e = new Error(data?.error?.message || `Graph GET failed (HTTP ${res.status})`)
    e.status = res.status
    e.graphCode = data?.error?.code || null
    throw e
  }
}

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

// ─── Calendar events (deal key dates / task due dates → agent's calendar) ────
// Deal key dates are plain dates (no time), so those events are ALL-DAY, as is
// a task due "on the 14th" with no time of day. Graph still requires a timeZone
// on the start/end for an all-day event: it defaults to the brokerage's own
// (the Iowa/Nebraska/South Dakota corridor is Central), overridable
// per-deployment since this is shared across every agent rather than being a
// per-agent preference (v1 scope). A task WITH a time of day becomes a timed
// event pinned in UTC instead — see calendarEventBody below.
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

// Two shapes of Gateway calendar event, both written here so the two callers
// (deal key dates, task due dates — api/_lib/calendarSync.js) produce events
// that look and behave the same in Outlook:
//
//   • ALL-DAY  — pass `date` as a plain 'YYYY-MM-DD'. A deal key date has no
//     time of day, and neither does a task whose due date landed on midnight.
//   • TIMED    — pass `startsAt` as an ISO instant (tasks.due_date is a
//     timestamptz, and the Add Task drawer collects an actual time). Sent in
//     UTC so Outlook renders it in whatever zone the agent's client is in,
//     rather than being re-floated into MS_CALENDAR_TIMEZONE and drifting.
//     `durationMinutes` defaults to 30 — long enough to be visible in a day
//     view, short enough not to look like it blocks the afternoon.
//
// `reminderMinutes` overrides the default lead time: a deal key date wants
// three days' warning, a task due at 2pm wants thirty minutes.
export function calendarEventBody({ subject, date, startsAt, durationMinutes = 30, bodyHtml, reminderMinutes }) {
  const common = {
    subject,
    body: { contentType: 'HTML', content: bodyHtml || '' },
    isReminderOn: true,
    reminderMinutesBeforeStart: Number.isFinite(reminderMinutes) ? reminderMinutes : CALENDAR_REMINDER_MINUTES,
    categories: ['Gateway CRM'],
  }

  if (startsAt) {
    const startMs = new Date(startsAt).getTime()
    const iso = ms => new Date(ms).toISOString().slice(0, 19)   // drop the trailing 'Z' — Graph wants a naive dateTime + timeZone
    return {
      ...common,
      start: { dateTime: iso(startMs), timeZone: 'UTC' },
      end:   { dateTime: iso(startMs + durationMinutes * 60000), timeZone: 'UTC' },
      isAllDay: false,
    }
  }

  const { start, end } = allDayBounds(date)
  return {
    ...common,
    start: { dateTime: `${start}T00:00:00`, timeZone: CALENDAR_TIMEZONE },
    end:   { dateTime: `${end}T00:00:00`,   timeZone: CALENDAR_TIMEZONE },
    isAllDay: true,
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

export async function createCalendarEvent(accessToken, fields) {
  return graphEventRequest('POST', `${GRAPH_BASE}/me/events`, accessToken, calendarEventBody(fields))
}

export async function updateCalendarEvent(accessToken, eventId, fields) {
  return graphEventRequest('PATCH', `${GRAPH_BASE}/me/events/${eventId}`, accessToken, calendarEventBody(fields))
}

// Idempotent — an event already deleted by the agent themselves (in Outlook
// directly) 404s, which is treated as success by the caller (calendarSync.js),
// not surfaced as a sync failure.
export async function deleteCalendarEvent(accessToken, eventId) {
  return graphEventRequest('DELETE', `${GRAPH_BASE}/me/events/${eventId}`, accessToken)
}

// ─── Inbound mail (delta query) ───────────────────────────────────────────────
// One page of the inbox delta feed. Pass the previous response's
// `@odata.nextLink` to page through a large batch, or its `@odata.deltaLink`
// (stored as ms_graph_connections.mail_delta_link) on the next sync run to
// get only what changed since. With neither (an agent's first sync), starts
// a fresh delta session bounded to the last `sinceDays` — otherwise the very
// first sync would try to enumerate an agent's entire mail history.
export async function fetchInboxDelta(accessToken, { link, sinceDays = 30 } = {}) {
  let url = link
  if (!url) {
    const since = new Date(Date.now() - sinceDays * 86400000).toISOString()
    const params = new URLSearchParams({
      '$select': 'id,subject,from,receivedDateTime,bodyPreview,conversationId',
      '$filter': `receivedDateTime ge ${since}`,
    })
    url = `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?${params.toString()}`
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(data?.error?.message || `Graph inbox delta failed (HTTP ${res.status})`)
    e.status = res.status
    throw e
  }
  return data   // { value: [...], '@odata.nextLink'?, '@odata.deltaLink'? }
}

// ─── Contact enrichment (agent's own Outlook contacts) ────────────────────────
// Delegated /me/contacts only — never another agent's contacts, and never
// written back to Outlook, just read to help fill in blank CRM fields.
export async function lookupGraphContact(accessToken, email) {
  const filter = `emailAddresses/any(a:a/address eq '${String(email).replace(/'/g, "''")}')`
  const params = new URLSearchParams({
    '$filter': filter,
    '$select': 'displayName,mobilePhone,businessPhones,companyName,jobTitle',
    '$top': '1',
  })
  const res = await fetch(`${GRAPH_BASE}/me/contacts?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(data?.error?.message || `Graph contact lookup failed (HTTP ${res.status})`)
    e.status = res.status
    throw e
  }
  const match = data?.value?.[0]
  if (!match) return null
  return {
    displayName: match.displayName || null,
    phone:       match.mobilePhone || match.businessPhones?.[0] || null,
    companyName: match.companyName || null,
    jobTitle:    match.jobTitle || null,
  }
}

// ─── Draft-mode send ──────────────────────────────────────────────────────────
// POST /me/messages creates the message as a DRAFT in the agent's own
// mailbox (never sent) — for an agent who wants to review/personalize in
// Outlook itself before sending, rather than sending immediately from the CRM.
export async function createDraftMessage(accessToken, { subject, html, to, cc }) {
  const res = await fetch(`${GRAPH_BASE}/me/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: subject || '(no subject)',
      body: { contentType: 'HTML', content: html || '' },
      toRecipients: toRecipientList(to),
      ...(cc && cc.length ? { ccRecipients: toRecipientList(cc) } : {}),
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(data?.error?.message || `Graph draft create failed (HTTP ${res.status})`)
    e.status = res.status === 401 ? 401 : 502
    throw e
  }
  return data   // includes the new draft's `id`, `webLink`
}

// ─── Free/busy (agent's own calendar only) ────────────────────────────────────
// Delegated Calendars.Read covers checking the AGENT'S OWN schedule — checking
// a COLLEAGUE's free/busy through the same delegated grant depends on the
// org's Exchange sharing policy and isn't guaranteed, so v1 deliberately scopes
// this to self-check only (e.g. "am I free to book this showing on my own
// calendar?") rather than assuming cross-agent visibility that may not exist.
export async function getFreeBusy(accessToken, { email, startISO, endISO, intervalMinutes = 30 }) {
  const res = await fetch(`${GRAPH_BASE}/me/calendar/getSchedule`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schedules: [email],
      startTime: { dateTime: startISO, timeZone: 'UTC' },
      endTime:   { dateTime: endISO,   timeZone: 'UTC' },
      availabilityViewInterval: intervalMinutes,
    }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = new Error(data?.error?.message || `Graph getSchedule failed (HTTP ${res.status})`)
    e.status = res.status
    throw e
  }
  const schedule = data?.value?.[0]
  return {
    // availabilityView: one char per interval — '0' free, '1' tentative, '2' busy, '3' oof
    availabilityView: schedule?.availabilityView || '',
    busyBlocks: (schedule?.scheduleItems || []).filter(i => i.status !== 'free'),
  }
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

// ─── Mail correspondence (contact email panel) ────────────────────────────────
// Distinct from fetchInboxDelta() above, which is the nightly "did anyone in
// the CRM email me" sweep over the INBOX only. This is the on-demand,
// per-contact question: "show me everything I've ever exchanged with this
// address" — which has to cover Sent Items too, and has to work whether or not
// the address is a saved Outlook Contact.
//
// WHY $search AND NOT $filter. Graph does not support a lambda $filter over
// toRecipients/ccRecipients on /me/messages, so "emails where the contact is a
// recipient" is not expressible as a filter. The KQL `participants:` property
// covers from + to + cc + bcc in one query across every folder, which is
// exactly the mailbox-wide, both-directions view the panel needs. $search and
// $orderby are mutually exclusive on Graph, so callers sort by date themselves
// (normalizeGraphMessage() surfaces sentAt for that).

// Mail.ReadBasic deliberately withholds body/bodyPreview, so asking for
// bodyPreview under that scope alone 403s the whole request. Two select lists,
// picked by what the connection actually granted.
const MAIL_SELECT_FULL  = 'id,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,conversationId,webLink,hasAttachments,isDraft'
const MAIL_SELECT_BASIC = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,conversationId,webLink,hasAttachments,isDraft'

// Graph caps a $search page at 25 regardless of a larger $top, so this is the
// real page size, not an arbitrary choice.
export const MAIL_PAGE_SIZE = 25

// Which mail-read capability a stored connection has. Scope strings come back
// from Microsoft either bare ('Mail.ReadWrite') or fully qualified
// ('https://graph.microsoft.com/Mail.ReadWrite'), so match on the suffix.
//   'full'  — Mail.Read / Mail.ReadWrite: subject + snippet + body
//   'basic' — Mail.ReadBasic only: metadata, no snippet
//   null    — no mail-read scope at all; the agent must reconnect
export function mailReadLevel(connection) {
  const scopes = (connection?.scopes || []).map(s => String(s).split('/').pop().toLowerCase())
  if (scopes.includes('mail.read') || scopes.includes('mail.readwrite')) return 'full'
  if (scopes.includes('mail.readbasic')) return 'basic'
  return null
}

export function canSendMail(connection) {
  const scopes = (connection?.scopes || []).map(s => String(s).split('/').pop().toLowerCase())
  return scopes.includes('mail.send') || scopes.includes('mail.readwrite')
}

export function buildMailSearchUrl(email, { level = 'full', top = MAIL_PAGE_SIZE } = {}) {
  // KQL string inside a quoted $search value — a double quote in an address
  // would break out of it, so drop them (they are not legal in an address).
  const term = String(email).replace(/"/g, '')
  const params = new URLSearchParams({
    '$search': `"participants:${term}"`,
    '$select': level === 'basic' ? MAIL_SELECT_BASIC : MAIL_SELECT_FULL,
    '$top': String(top),
  })
  return `${GRAPH_BASE}/me/messages?${params.toString()}`
}

// Fallback for a mailbox where $search is unavailable (search unindexed, or a
// tenant that blocks it). Only expressible direction is "from the contact", so
// a caller using this must tell the UI the result is partial.
export function buildMailFilterUrl(email, { level = 'full', top = MAIL_PAGE_SIZE } = {}) {
  const addr = String(email).replace(/'/g, "''")
  const params = new URLSearchParams({
    '$filter': `from/emailAddress/address eq '${addr}'`,
    '$orderby': 'receivedDateTime desc',
    '$select': level === 'basic' ? MAIL_SELECT_BASIC : MAIL_SELECT_FULL,
    '$top': String(top),
  })
  return `${GRAPH_BASE}/me/messages?${params.toString()}`
}

// One page of correspondence with `email`. Pass the previous page's `nextLink`
// to continue; the link already carries the search/select/skip state, so no
// other option matters on a continuation call.
//
// `mode` reports which query actually answered:
//   'search' — both directions (sent + received), mailbox-wide
//   'filter' — received only, because $search was refused for this mailbox
export async function fetchMailWithParticipant(accessToken, { email, link, level = 'full', top = MAIL_PAGE_SIZE } = {}) {
  if (link) {
    const data = await graphFetch(link, { accessToken })
    return { messages: data.value || [], nextLink: data['@odata.nextLink'] || null, mode: 'continued' }
  }
  try {
    const data = await graphFetch(buildMailSearchUrl(email, { level, top }), { accessToken })
    return { messages: data.value || [], nextLink: data['@odata.nextLink'] || null, mode: 'search' }
  } catch (err) {
    // 400/501 from Graph here means "this mailbox can't answer a $search",
    // not "no results" — fall back rather than showing the agent an error for
    // a question that has a partial answer available. Auth/throttle failures
    // (401/403/429) are real and must surface.
    if (err.status !== 400 && err.status !== 501) throw err
    console.warn(`[msGraph] $search refused for this mailbox (${err.message}) — falling back to from-address filter`)
    const data = await graphFetch(buildMailFilterUrl(email, { level, top }), { accessToken })
    return { messages: data.value || [], nextLink: data['@odata.nextLink'] || null, mode: 'filter' }
  }
}

// Graph message → the shape the CRM stores and the panel renders. Direction is
// decided by comparing the sender to the connected mailbox rather than by which
// folder the message came from: a $search result set spans every folder and
// carries no folder hint.
export function normalizeGraphMessage(m, mailboxEmail) {
  const fromAddress = m.from?.emailAddress?.address || null
  const mine = fromAddress && mailboxEmail &&
    fromAddress.toLowerCase() === String(mailboxEmail).toLowerCase()
  const people = list => (list || [])
    .map(r => ({ name: r.emailAddress?.name || null, email: r.emailAddress?.address || null }))
    .filter(p => p.email)
  return {
    graphMessageId: m.id,
    subject:        m.subject || null,
    preview:        (m.bodyPreview || '').replace(/\s+/g, ' ').trim().slice(0, 280) || null,
    direction:      mine ? 'outbound' : 'inbound',
    fromAddress,
    fromName:       m.from?.emailAddress?.name || null,
    to:             people(m.toRecipients),
    cc:             people(m.ccRecipients),
    // Sent Items entries carry sentDateTime; received mail is ordered by when
    // it arrived. Prefer whichever describes the message's own moment.
    sentAt:         m.sentDateTime || m.receivedDateTime || null,
    conversationId: m.conversationId || null,
    webLink:        m.webLink || null,
    hasAttachments: Boolean(m.hasAttachments),
    isDraft:        Boolean(m.isDraft),
  }
}
