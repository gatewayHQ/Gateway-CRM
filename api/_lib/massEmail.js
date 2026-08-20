// ─────────────────────────────────────────────────────────────────────────────
// Mass email (deal announcements) — server-side send engine.
//
// Server-only (api/_lib/* is never bundled into the browser build). Drives one
// blast from a built recipient list to a finished send, through the AGENT'S OWN
// Microsoft 365 mailbox — the same /me/sendMail path a one-off send from the
// compose box uses. No third-party bulk mail service is involved, so every
// message lands in the agent's Sent Items and replies come back to them.
//
// ── Three properties this module is built around ─────────────────────────────
//
// 1. NO CONTACT IS EVER MAILED TWICE. Graph write paths deliberately do not
//    retry (see api/_lib/msGraph.js), a Vercel function can be killed at any
//    moment, and the client re-calls the batch action until the blast finishes.
//    So the recipient row — not the loop counter — is the send cursor: a row
//    moves pending → sent/failed exactly once, and only 'pending' rows are ever
//    picked up. A batch that dies after Graph accepted a message but before the
//    row was updated is the one case that can re-send; it is narrowed to a
//    single message by marking each row immediately after its own send.
//
// 2. THROTTLING IS THE MAILBOX'S, NOT OURS. Exchange Online caps a mailbox at
//    roughly 30 messages/minute and 10,000 recipients/day. Exceeding the first
//    earns 429s; exceeding the second gets the mailbox blocked from sending for
//    24 hours — a far worse outcome than a slow send. So messages are paced
//    apart, batches are bounded by the function's own time limit, and a daily
//    per-agent cap is enforced before the first message goes out.
//
// 3. A PARTIAL SEND IS REPORTED, NEVER ROUNDED OFF. Per-recipient failures are
//    stored with their Graph error, counted, and surfaced. "Sent to 240 of 247,
//    7 failed" is the truth an agent can act on; "sent" is not.
// ─────────────────────────────────────────────────────────────────────────────

import { getValidAccessToken, sendGraphMail, canSendMail } from './msGraph.js'
import {
  renderAnnouncementHtml, renderTokens, announcementTokens, statusLabel,
} from '../../src/lib/dealAnnouncement.js'

// ─── Pacing / limits ─────────────────────────────────────────────────────────

// Milliseconds between two messages from the same mailbox. 2s ≈ 30/min, which
// is the documented Exchange Online per-mailbox rate. Configurable because a
// tenant on a different plan may be allowed more (or less).
export const SEND_INTERVAL_MS = Number(process.env.MASS_EMAIL_INTERVAL_MS || 2000)

// How long one batch may keep working before returning to the caller, who then
// calls again. Sits under the function's maxDuration (60s in vercel.json) with
// enough headroom for the final send plus its logging writes.
export const BATCH_BUDGET_MS = Number(process.env.MASS_EMAIL_BATCH_MS || 40_000)

// Hard ceiling on recipients per batch regardless of the time budget.
export const BATCH_MAX = Number(process.env.MASS_EMAIL_BATCH_MAX || 25)

// Messages one agent may send through the CRM in a rolling 24 hours. Set well
// under the Microsoft 10,000/day recipient limit: the CRM is not the only thing
// sending from that mailbox, and being throttled by Microsoft costs the agent
// their normal correspondence too, not just the blast.
export const DAILY_SEND_LIMIT = Number(process.env.MASS_EMAIL_DAILY_LIMIT || 1000)

// Recipients one blast may carry. A four-figure audience from a mis-set filter
// is a mistake, not a campaign — and this feature is explicitly a manual,
// one-time send rather than list marketing.
export const MAX_RECIPIENTS = Number(process.env.MASS_EMAIL_MAX_RECIPIENTS || 500)

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const isValidEmail = (e) => EMAIL_RE.test(String(e || '').trim())

/**
 * How many messages this agent has sent through the CRM in the last 24 hours.
 * Counts email_messages rather than blast rows so one-off sends from the
 * compose box count against the same mailbox budget they actually consume.
 */
export async function sentInLast24h(svc, agentId) {
  const since = new Date(Date.now() - 86_400_000).toISOString()
  const { count, error } = await svc
    .from('email_messages')
    .select('id', { count: 'exact', head: true })
    .eq('agent_id', agentId)
    .eq('status', 'sent')
    .gte('sent_at', since)
  if (error) return 0     // never block a send because the budget query failed
  return count || 0
}

/**
 * Create the blast and its recipient rows in one go.
 *
 * Recipients are re-validated here against the CURRENT contact records rather
 * than trusted from the browser: the wizard's list was built from a snapshot,
 * and an opt-out or a deleted address between preview and send must win. The
 * caller's own Supabase client does the read, so RLS decides which contacts
 * this agent may mail at all — a hand-crafted request cannot blast contacts the
 * agent cannot see.
 */
export async function createBlast(svc, user, { agentId, blast, contactIds }) {
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  if (ids.length === 0) {
    const e = new Error('No recipients selected')
    e.status = 400
    throw e
  }
  if (ids.length > MAX_RECIPIENTS) {
    const e = new Error(`This send has ${ids.length} recipients — the per-send limit is ${MAX_RECIPIENTS}. Narrow the audience and send in stages.`)
    e.status = 400
    throw e
  }

  const { data: contacts, error: contactErr } = await user
    .from('contacts')
    .select('id, first_name, last_name, email, email_opt_out, status')
    .in('id', ids)
  if (contactErr) { const e = new Error(contactErr.message); e.status = 500; throw e }

  const { data: created, error: blastErr } = await svc.from('email_blasts').insert([{
    agent_id:       agentId,
    property_id:    blast.propertyId || null,
    template_id:    blast.templateId || null,
    deal_status:    blast.dealStatus || null,
    subject:        blast.subject || '(no subject)',
    body:           blast.body || '',
    photo_url:      blast.photoUrl || null,
    terms:          blast.terms || null,
    custom_message: blast.customMessage || null,
    audience:       blast.audience || {},
    status:         'draft',
  }]).select('*').single()
  if (blastErr) { const e = new Error(blastErr.message); e.status = 500; throw e }

  // Skipped recipients are STORED, not dropped. An agent who selected 250 and
  // sees 243 sent needs the other 7 named, or the feature has quietly decided
  // something on their behalf.
  const rows = []
  const seen = new Set()
  for (const c of (contacts || [])) {
    const email = String(c.email || '').trim()
    const key   = email.toLowerCase()
    let skip = null
    if (!email)                    skip = 'No email on file'
    else if (!isValidEmail(email)) skip = 'Invalid email address'
    else if (c.email_opt_out)      skip = 'Opted out of email'
    else if (seen.has(key))        skip = 'Duplicate address in this send'
    if (!skip) seen.add(key)

    rows.push({
      blast_id:    created.id,
      contact_id:  c.id,
      // Skipped rows are exempt from the (blast, address) unique index, so a
      // duplicate address keeps its real value here instead of a mangled one.
      email:       email || '(no email on file)',
      first_name:  c.first_name || null,
      last_name:   c.last_name || null,
      status:      skip ? 'skipped' : 'pending',
      skip_reason: skip,
    })
  }

  const { error: recErr } = await svc.from('email_blast_recipients').insert(rows)
  if (recErr) { const e = new Error(recErr.message); e.status = 500; throw e }

  const skippedCount = rows.filter(r => r.status === 'skipped').length
  const { data: updated } = await svc.from('email_blasts').update({
    recipient_count: rows.length - skippedCount,
    skipped_count:   skippedCount,
  }).eq('id', created.id).select('*').single()

  return updated || created
}

/** Load a blast the caller is allowed to send: their own, and not already done. */
export async function loadSendableBlast(svc, { blastId, agentId }) {
  const { data: blast, error } = await svc.from('email_blasts').select('*').eq('id', blastId).maybeSingle()
  if (error) { const e = new Error(error.message); e.status = 500; throw e }
  if (!blast) { const e = new Error('Blast not found'); e.status = 404; throw e }
  // Sending is never delegated: the messages go out of THIS agent's mailbox and
  // land in THEIR sent items, so a team peer who can read the blast still
  // cannot push it.
  if (blast.agent_id !== agentId) {
    const e = new Error('Only the agent who created this send can send it')
    e.status = 403
    throw e
  }
  if (blast.status === 'cancelled') { const e = new Error('This send was cancelled'); e.status = 409; throw e }
  return blast
}

/** Progress snapshot for the client's polling loop and the review screen. */
export async function blastProgress(svc, blastId) {
  const { data: blast } = await svc.from('email_blasts').select('*').eq('id', blastId).maybeSingle()
  const { count: remaining } = await svc
    .from('email_blast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('blast_id', blastId)
    .eq('status', 'pending')
  return {
    blastId,
    status:    blast?.status || 'unknown',
    total:     blast?.recipient_count || 0,
    sent:      blast?.sent_count || 0,
    failed:    blast?.failed_count || 0,
    skipped:   blast?.skipped_count || 0,
    remaining: remaining || 0,
    lastError: blast?.last_error || null,
    done:      (remaining || 0) === 0,
  }
}

/**
 * Send one batch of a blast, then return so the caller can call again.
 *
 * Chunked rather than looped-to-completion because a serverless function has a
 * hard wall-clock limit and pacing 250 messages at 2s apart takes eight minutes
 * — far past it. Each call does as much as it safely can and reports what is
 * left; the client drives the loop and can show real progress while it happens.
 */
export async function sendBlastBatch(svc, { blast, agent, contactsById = {}, property = null }) {
  const startedAt = Date.now()

  const { data: pending, error: pendErr } = await svc
    .from('email_blast_recipients')
    .select('*')
    .eq('blast_id', blast.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(BATCH_MAX)
  if (pendErr) { const e = new Error(pendErr.message); e.status = 500; throw e }

  if (!pending || pending.length === 0) {
    await finalizeBlast(svc, blast.id)
    return blastProgress(svc, blast.id)
  }

  // Daily budget: checked per batch, not once per blast, because a long send and
  // the agent's ordinary mail both draw on the same mailbox allowance.
  const alreadySent = await sentInLast24h(svc, agent.id)
  if (alreadySent >= DAILY_SEND_LIMIT) {
    await svc.from('email_blasts').update({
      status:     'failed',
      last_error: `Daily send limit reached (${DAILY_SEND_LIMIT} messages in 24h). The remaining recipients are still pending — resume this send tomorrow.`,
    }).eq('id', blast.id)
    const e = new Error(`Daily send limit reached (${DAILY_SEND_LIMIT} messages in 24h). Resume this send tomorrow — nobody will be mailed twice.`)
    e.status = 429
    throw e
  }
  const roomToday = DAILY_SEND_LIMIT - alreadySent

  const { accessToken, connection } = await getValidAccessToken(svc, agent.id)
  if (!canSendMail(connection)) {
    const e = new Error('This Microsoft connection has no Mail.Send permission — reconnect Outlook in Integrations')
    e.status = 409
    throw e
  }

  if (blast.status === 'draft') {
    await svc.from('email_blasts')
      .update({ status: 'sending', started_at: new Date().toISOString(), last_error: null })
      .eq('id', blast.id)
  }

  let sent = 0
  let failed = 0

  for (const [index, row] of pending.entries()) {
    if (sent + failed >= roomToday) break
    // Stop before the function's own wall clock does, so the batch always ends
    // with every row it touched accounted for.
    if (Date.now() - startedAt > BATCH_BUDGET_MS) break
    if (index > 0) await sleep(SEND_INTERVAL_MS)

    const contact = contactsById[row.contact_id] || {
      id: row.contact_id, first_name: row.first_name, last_name: row.last_name, email: row.email,
    }

    const tokenArgs = {
      property, status: blast.deal_status, agent, contact,
      terms: blast.terms || '', customMessage: blast.custom_message || '',
    }
    // Subject and body resolve from the SAME token map the preview used, so
    // what the agent approved is what each recipient receives.
    const subject = renderTokens(blast.subject, announcementTokens(tokenArgs))
    const html    = renderAnnouncementHtml({ ...tokenArgs, photoUrl: blast.photo_url, body: blast.body })

    let sendError = null
    try {
      await sendGraphMail(accessToken, { subject, html, to: [row.email] })
    } catch (err) {
      sendError = err.message
    }

    // Mark the row before anything else. If the function dies here, the worst
    // case is one message whose row still says pending — bounded to a single
    // duplicate rather than a whole batch of them.
    const now = new Date().toISOString()
    await svc.from('email_blast_recipients').update({
      status:        sendError ? 'failed' : 'sent',
      error_message: sendError,
      sent_at:       sendError ? null : now,
    }).eq('id', row.id).eq('status', 'pending')

    if (sendError) { failed++; continue }
    sent++

    // Logging is best-effort and never turns a delivered message into a
    // reported failure — the mail is already gone.
    try {
      await logDelivery(svc, { blast, agent, row, subject, html, property })
    } catch (err) {
      console.error('[massEmail] logging failed for recipient', row.id, err.message)
    }
  }

  // Counters are recomputed from the recipient rows rather than incremented, so
  // a retried or interrupted batch can't double-count.
  await refreshCounters(svc, blast.id)
  const progress = await blastProgress(svc, blast.id)
  if (progress.remaining === 0) {
    await finalizeBlast(svc, blast.id)
    return blastProgress(svc, blast.id)
  }
  return progress
}

/**
 * The contact-history half of a blast: an `activities` row (so the send shows
 * up on the contact's timeline next to calls and notes) and an `email_messages`
 * row (so it shows up in the contact's Emails tab, tagged with its blast).
 * Exactly the pattern api/email-send.js?action=outlook-send already uses for a
 * one-off send — a mass send must not be a second, parallel kind of history.
 */
async function logDelivery(svc, { blast, agent, row, subject, html, property }) {
  if (!row.contact_id) return

  const label = statusLabel(blast.deal_status)
  const where = property?.address ? ` — ${property.address}` : ''
  const { data: activity } = await svc.from('activities').insert([{
    contact_id: row.contact_id,
    agent_id:   agent.id,
    type:       'email',
    body:       `Sent announcement (${label}${where}): "${subject}"`,
  }]).select('id').single()

  const { data: message } = await svc.from('email_messages').insert([{
    agent_id:      agent.id,
    contact_id:    row.contact_id,
    activity_id:   activity?.id || null,
    blast_id:      blast.id,
    subject,
    body_preview:  `${statusLabel(blast.deal_status)}${where}`.slice(0, 280),
    body_html:     html,
    to_recipients: [{ email: row.email }],
    status:        'sent',
    source:        'crm',
  }]).select('id').single()

  if (message?.id) {
    await svc.from('email_blast_recipients').update({ email_message_id: message.id }).eq('id', row.id)
  }
}

async function refreshCounters(svc, blastId) {
  const countBy = async (status) => {
    const { count } = await svc
      .from('email_blast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('blast_id', blastId).eq('status', status)
    return count || 0
  }
  const [sent, failed, skipped] = await Promise.all([countBy('sent'), countBy('failed'), countBy('skipped')])
  await svc.from('email_blasts').update({ sent_count: sent, failed_count: failed, skipped_count: skipped }).eq('id', blastId)
}

/**
 * Close out a blast with nothing left pending. A send where every message
 * failed is 'failed'; anything else is 'sent' — including a partial, whose
 * failed_count carries the rest of the story.
 */
async function finalizeBlast(svc, blastId) {
  await refreshCounters(svc, blastId)
  const { data: blast } = await svc.from('email_blasts').select('*').eq('id', blastId).maybeSingle()
  if (!blast || blast.status === 'cancelled') return
  const allFailed = blast.sent_count === 0 && blast.failed_count > 0
  await svc.from('email_blasts').update({
    status:       allFailed ? 'failed' : 'sent',
    completed_at: new Date().toISOString(),
  }).eq('id', blastId)
}
