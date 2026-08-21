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
 *   POST ?action=outlook-task-calendar-sync (auth) → push ONE task's due date
 *                                     to the assigned agent's Outlook calendar
 *                                     (create/update/delete the single Graph
 *                                     event that mirrors tasks.due_date); fired
 *                                     right after a task is created, edited,
 *                                     completed or (with { purge: true }) just
 *                                     before it is deleted — see
 *                                     src/lib/services/tasks.js. The nightly
 *                                     api/cron.js?task=calendar-sync sweeps
 *                                     tasks as well as deals.
 *   POST ?action=outlook-messages     (auth) → { contactId } -> the email
 *                                     correspondence between the agent's mailbox
 *                                     and that contact's address, newest first,
 *                                     BOTH directions. Queries Graph's message
 *                                     store, NOT Outlook Contacts — see
 *                                     api/_lib/contactMail.js for why that
 *                                     distinction is the whole point.
 *   POST ?action=outlook-contact-lookup (auth) → { email } -> matching contact
 *                                     from the agent's OWN Outlook contacts
 *                                     (name/phone/company), or null. Read-only;
 *                                     never written back to the CRM automatically.
 *   POST ?action=blast-create         (auth) → create a mass send (deal
 *                                     announcement) plus one row per recipient,
 *                                     then return it. Does NOT send.
 *   POST ?action=blast-send           (auth) → send ONE BATCH of a blast and
 *                                     report progress. The client calls this in
 *                                     a loop until { done: true } — a send of a
 *                                     few hundred recipients is paced far past
 *                                     any single function's time limit. See
 *                                     api/_lib/massEmail.js for why the batch
 *                                     cursor lives in the recipient rows.
 *   POST ?action=blast-status         (auth) → progress for one blast
 *   POST ?action=blast-cancel         (auth) → stop a running blast; already
 *                                     sent messages are already gone, the rest
 *                                     are left unsent
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

import { requireAgent, getServiceClient, getUserClient, errorResponse } from './_lib/auth.js'
import { wrap } from './_lib/observability.js'
import {
  generateState, generateCodeVerifier, codeChallengeFor, buildAuthorizeUrl,
  resolveRedirectUri, exchangeCodeForTokens, fetchGraphProfile,
  encryptToken, getValidAccessToken, sendGraphMail,
  lookupGraphContact, createDraftMessage, getFreeBusy,
  mailReadLevel, canSendMail,
} from './_lib/msGraph.js'
import { syncDealCalendar, syncTaskCalendar } from './_lib/calendarSync.js'
import { syncContactMail, readMirroredThread, readSyncState } from './_lib/contactMail.js'
import {
  createBlast, loadSendableBlast, sendBlastBatch, blastProgress,
} from './_lib/massEmail.js'

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

// ─── Microsoft Graph: task due date → the assigned agent's calendar ─────────
// The task-side twin of handleOutlookCalendarSync above. Called right after a
// task is saved, ticked off, or (with { purge: true }) immediately BEFORE it is
// deleted — the ledger row cascades away with the task, so the Graph event has
// to be removed while the row still points at it.
//
// Tasks are strictly personal under RLS (tasks_agent_scope — admins included),
// so the caller can only ever sync their own task, and the event only ever
// lands on their own calendar. Every field of the event comes from the stored
// row, never from the request body.
async function handleOutlookTaskCalendarSync(req, res) {
  const { agent } = await requireAgent(req)
  const svc = getServiceClient()
  const { taskId, purge = false } = req.body || {}
  if (!taskId) return res.status(400).json({ error: 'Missing taskId' })

  const { data: task, error } = await svc.from('tasks')
    .select('id, title, type, priority, due_date, completed, notes, agent_id, contact_id, deal_id')
    .eq('id', taskId).maybeSingle()
  if (error) return errorResponse(res, Object.assign(new Error(error.message), { status: 500 }))

  // A missing task is the normal case for a delete whose purge call lost the
  // race with the row itself — clean up anything the ledger still holds for
  // the caller rather than 404ing.
  if (!task) {
    const result = await syncTaskCalendar(svc, { id: taskId }, { purge: true, onlyAgentId: agent.id })
    return res.status(200).json({ ok: true, ...result })
  }
  if (task.agent_id && task.agent_id !== agent.id) {
    return res.status(403).json({ error: "Only this task's assigned agent can sync it to their calendar" })
  }

  let contact = null
  if (task.contact_id) {
    const { data: c } = await svc.from('contacts').select('first_name, last_name').eq('id', task.contact_id).maybeSingle()
    contact = c
  }
  let deal = null
  if (task.deal_id) {
    const { data: d } = await svc.from('deals').select('title').eq('id', task.deal_id).maybeSingle()
    deal = d
  }

  const result = await syncTaskCalendar(svc, task, { contact, deal, purge: Boolean(purge) })
  return res.status(200).json({ ok: true, ...result })
}

// ─── Microsoft Graph: contact email correspondence ───────────────────────────
// The contact panel's "Emails" tab. Answers "what mail has passed between my
// mailbox and this contact's address" by querying Graph's MESSAGE store
// (/me/messages), in contrast to ?action=outlook-contact-lookup below, which
// searches the agent's Outlook CONTACTS address book for an entry to copy
// fields from. Conflating the two is what made this panel report "No matching
// Outlook contact found" for contacts the agent emails regularly.
//
// Always answers 200 with whatever is known, and says why anything is missing.
// "This contact has no email correspondence" and "Outlook could not be reached"
// are different facts, and an agent about to follow up needs to be able to tell
// them apart — so a Graph failure downgrades to a cached read plus an explicit
// `error`, rather than becoming an HTTP error with no content.
async function handleOutlookMessages(req, res) {
  const { agent } = await requireAgent(req)
  const svc = getServiceClient()
  const { contactId, intent = 'auto', limit = 50 } = req.body || {}
  if (!contactId) return res.status(400).json({ error: 'Missing contactId' })
  if (!['auto', 'refresh', 'more'].includes(intent)) {
    return res.status(400).json({ error: 'intent must be one of: auto, refresh, more' })
  }

  // Read the contact through the CALLER'S OWN client, not the service key: RLS
  // is what decides whether this agent may see this contact at all, and a
  // contact's correspondence is exactly as private as the contact.
  const user = getUserClient(req)
  const { data: contact, error: contactErr } = await user
    .from('contacts').select('id, first_name, last_name, email').eq('id', contactId).maybeSingle()
  if (contactErr) return errorResponse(res, Object.assign(new Error(contactErr.message), { status: 500 }))
  if (!contact) return res.status(404).json({ error: 'Contact not found' })

  if (!contact.email) {
    return res.status(200).json({
      ok: true, state: 'no-contact-email', messages: [], hasMore: false,
    })
  }

  const { data: conn } = await svc
    .from('ms_graph_connections')
    .select('agent_id, email, display_name, status, scopes, last_error')
    .eq('agent_id', agent.id)
    .maybeSingle()

  // Everything already mirrored is worth showing even when Graph is out of
  // reach — a disconnected mailbox doesn't erase the history the CRM logged.
  const cached = async () => readMirroredThread(user, contactId, { limit })
  const syncFacts = async () => {
    const st = await readSyncState(svc, { contactId, agentId: agent.id })
    return {
      lastSyncedAt: st?.last_synced_at || null,
      hasMore:      st ? !st.backfill_complete : false,
      // 'filter' = this mailbox refused $search, so only mail FROM the contact
      // could be found. Surfaced so the UI can say the list is one-directional
      // instead of quietly implying the agent never wrote back.
      partial:      st?.mode === 'filter',
    }
  }

  if (!conn) {
    return res.status(200).json({
      ok: true, state: 'not-connected', contactEmail: contact.email,
      messages: await cached(), ...(await syncFacts()),
    })
  }
  if (conn.status !== 'connected') {
    return res.status(200).json({
      ok: true, state: 'needs-reconnect', contactEmail: contact.email,
      mailbox: conn.email, error: { message: conn.last_error || 'Microsoft 365 needs you to reconnect' },
      messages: await cached(), ...(await syncFacts()),
    })
  }

  const level = mailReadLevel(conn)
  if (!level) {
    // Connected, but this grant carries no mail-read permission — a mailbox
    // connected under an older scope set. Nothing to retry; the agent has to
    // re-consent, so say that instead of showing an empty list.
    return res.status(200).json({
      ok: true, state: 'missing-mail-scope', contactEmail: contact.email, mailbox: conn.email,
      requiredScopes: ['Mail.Read', 'Mail.Send'],
      messages: await cached(), ...(await syncFacts()),
    })
  }

  let accessToken
  try {
    ({ accessToken } = await getValidAccessToken(svc, agent.id))
  } catch (err) {
    return res.status(200).json({
      ok: true, state: 'needs-reconnect', contactEmail: contact.email, mailbox: conn.email,
      error: { message: err.message },
      messages: await cached(), ...(await syncFacts()),
    })
  }

  const result = await syncContactMail(svc, {
    agentId:      agent.id,
    contactId,
    contactEmail: contact.email,
    mailboxEmail: conn.email,
    accessToken,
    level,
    intent,
  })

  const messages = await readMirroredThread(user, contactId, { limit })
  return res.status(200).json({
    ok:    true,
    state: result.error ? 'graph-error' : 'ok',
    contactEmail:  contact.email,
    mailbox:       conn.email,
    canSend:       canSendMail(conn),
    // 'basic' = Mail.ReadBasic only, which withholds message bodies — the list
    // is real, the snippets are legitimately absent.
    snippets:      level === 'full',
    messages,
    synced:        result.synced,
    fetched:       result.inserted + result.adopted,
    lastSyncedAt:  result.sync?.last_synced_at || null,
    hasMore:       result.sync ? !result.sync.backfill_complete : true,
    partial:       result.sync?.mode === 'filter',
    ...(result.error ? { error: result.error } : {}),
  })
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

// ─── Mass email: create a blast ──────────────────────────────────────────────
// Builds the send record and its recipient rows. Nothing is mailed here — the
// agent still has to start it — so an accidental double-click on "Send" creates
// at most a second draft rather than a second delivery.
async function handleBlastCreate(req, res) {
  const { agent } = await requireAgent(req)
  const svc  = getServiceClient()
  const user = getUserClient(req)
  const { contactIds, ...blast } = req.body || {}

  if (!blast.subject || !String(blast.subject).trim()) {
    return res.status(400).json({ error: 'A subject line is required' })
  }
  if (!blast.body || !String(blast.body).trim()) {
    return res.status(400).json({ error: 'The message body is empty' })
  }

  const created = await createBlast(svc, user, { agentId: agent.id, blast, contactIds })
  return res.status(200).json({ ok: true, blast: created })
}

// ─── Mass email: send one batch ──────────────────────────────────────────────
// Returns after a bounded slice of work rather than running to completion: the
// per-mailbox pacing Microsoft expects (~30/min) puts a 200-recipient send well
// past any serverless time limit. The client loops on { done: false }, so a
// batch that times out or is killed simply resumes from the pending rows.
async function handleBlastSend(req, res) {
  const { agent } = await requireAgent(req)
  const svc  = getServiceClient()
  const user = getUserClient(req)
  const { blastId } = req.body || {}
  if (!blastId) return res.status(400).json({ error: 'Missing blastId' })

  const blast = await loadSendableBlast(svc, { blastId, agentId: agent.id })

  // Property and contacts are read through the CALLER'S client so RLS still
  // decides what this agent may see; the send itself needs the service key to
  // write counters and log rows the agent must not be able to forge.
  let property = null
  if (blast.property_id) {
    const { data } = await user.from('properties')
      .select('id, address, city, state, zip, type, list_price, details')
      .eq('id', blast.property_id).maybeSingle()
    property = data
  }

  const { data: pendingRows } = await svc.from('email_blast_recipients')
    .select('contact_id').eq('blast_id', blast.id).eq('status', 'pending')
  const ids = [...new Set((pendingRows || []).map(r => r.contact_id).filter(Boolean))]
  const contactsById = {}
  if (ids.length) {
    const { data: contacts } = await user.from('contacts')
      .select('id, first_name, last_name, email').in('id', ids)
    for (const c of (contacts || [])) contactsById[c.id] = c
  }

  const progress = await sendBlastBatch(svc, { blast, agent, contactsById, property })
  return res.status(200).json({ ok: true, ...progress })
}

// ─── Mass email: progress ────────────────────────────────────────────────────
async function handleBlastStatus(req, res) {
  const { agent } = await requireAgent(req)
  const svc = getServiceClient()
  const { blastId } = req.body || {}
  if (!blastId) return res.status(400).json({ error: 'Missing blastId' })

  const { data: blast } = await svc.from('email_blasts').select('agent_id').eq('id', blastId).maybeSingle()
  if (!blast) return res.status(404).json({ error: 'Blast not found' })
  if (blast.agent_id !== agent.id) return res.status(403).json({ error: 'Not your send' })

  return res.status(200).json({ ok: true, ...(await blastProgress(svc, blastId)) })
}

// ─── Mass email: cancel ──────────────────────────────────────────────────────
// Stops the remaining recipients. Messages already accepted by Graph are gone
// and are NOT touched — the counts keep saying so, because a cancelled send that
// reported zero deliveries would be a lie to the agent who has to follow up.
async function handleBlastCancel(req, res) {
  const { agent } = await requireAgent(req)
  const svc = getServiceClient()
  const { blastId } = req.body || {}
  if (!blastId) return res.status(400).json({ error: 'Missing blastId' })

  const blast = await loadSendableBlast(svc, { blastId, agentId: agent.id })
  await svc.from('email_blasts')
    .update({ status: 'cancelled', completed_at: new Date().toISOString() })
    .eq('id', blast.id)
  return res.status(200).json({ ok: true, ...(await blastProgress(svc, blast.id)) })
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
    if (action === 'outlook-task-calendar-sync') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleOutlookTaskCalendarSync(req, res)
    }
    if (action === 'outlook-messages') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleOutlookMessages(req, res)
    }
    if (action === 'outlook-contact-lookup') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleOutlookContactLookup(req, res)
    }
    if (action === 'blast-create') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleBlastCreate(req, res)
    }
    if (action === 'blast-send') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleBlastSend(req, res)
    }
    if (action === 'blast-status') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleBlastStatus(req, res)
    }
    if (action === 'blast-cancel') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
      return await handleBlastCancel(req, res)
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
