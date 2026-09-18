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
//
// 4. A RECIPIENT DOES NOT HAVE TO BE A CONTACT, BUT STILL GETS AN OPT-OUT.
//    A send can carry addresses pasted off a spreadsheet that are deliberately
//    not in the contact book. Those people are recipients in every way that
//    matters to them: an individually addressed message, a working one-click
//    unsubscribe, and a suppression that outlives the send. What they don't get
//    is a contact timeline, because there is no contact — the recipient row is
//    their whole record, which is why opens, replies and opt-outs are stamped
//    on it rather than derived from `activities`.
// ─────────────────────────────────────────────────────────────────────────────

import { getValidAccessToken, sendGraphMail, canSendMail } from './msGraph.js'
import {
  mintRecipientUnsubscribeToken, mintOpenToken, canMintUnsubscribeTokens,
} from './unsubscribeToken.js'
import {
  renderAnnouncementHtml, renderTokens, announcementTokens, statusLabel,
  normalizeHiddenFacts,
} from '../../src/lib/dealAnnouncement.js'
import { unsubscribeUrl, openPixelUrl } from '../../src/lib/emailFooter.js'

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
 * Every address on this list that has opted out, lower-cased.
 *
 * The one check that is not the agent's to override, and the reason opt-out
 * moved out of `contacts` into its own table: a pasted list is full of
 * addresses with no contact record, and "we had nowhere to record that they
 * asked us to stop" is not an acceptable reason to mail somebody again.
 *
 * A failure here is fatal by design. Everywhere else in this module a failed
 * bookkeeping query degrades to a permissive default; this one cannot, because
 * the permissive default is mailing people who opted out.
 */
export async function suppressedEmails(svc, emails = []) {
  const list = [...new Set(emails.map(e => String(e || '').trim().toLowerCase()).filter(Boolean))]
  if (!list.length) return new Set()

  const found = new Set()
  // Chunked: a 500-recipient send would otherwise build a single `in` list long
  // enough to be refused as a URL.
  for (let i = 0; i < list.length; i += 200) {
    const slice = list.slice(i, i + 200)
    const { data, error } = await svc
      .from('email_suppressions')
      .select('email')
      .in('email', slice)
    if (error) {
      const e = new Error(`Could not check the unsubscribe list — nothing was sent. (${error.message})`)
      e.status = 500
      throw e
    }
    for (const row of (data || [])) found.add(String(row.email || '').toLowerCase())
  }
  return found
}

/** A pasted "Firstname Lastname" split into the two columns a row wants. */
export function splitListName(name = '') {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first_name: null, last_name: null }
  if (parts.length === 1) return { first_name: parts[0], last_name: null }
  // Last word is the surname; everything before it is the given name, so
  // "Abigail M. Hillers" keeps its middle initial with the first name rather
  // than losing it or turning it into the surname.
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts[parts.length - 1] }
}

/**
 * Create the blast and its recipient rows in one go.
 *
 * Two kinds of recipient arrive here and are treated the same from the moment
 * they have an address:
 *
 *   • `contactIds` — contacts the audience filter matched or the agent added.
 *     Re-validated against the CURRENT contact records rather than trusted from
 *     the browser: the wizard's list was built from a snapshot, and an opt-out
 *     or a deleted address between preview and send must win. The caller's own
 *     Supabase client does the read, so RLS decides which contacts this agent
 *     may mail at all — a hand-crafted request cannot blast contacts the agent
 *     cannot see.
 *
 *   • `listRecipients` — [{ email, name }] pasted or uploaded, with no contact
 *     record and none created. These are NOT read through RLS because there is
 *     nothing to read; they are whatever the agent typed. That is exactly why
 *     they go through the same address validation, the same suppression check
 *     and the same de-duplication as the rest — an address the agent supplied
 *     gets no more trust than one the CRM already had.
 */
export async function createBlast(svc, user, { agentId, blast, contactIds, listRecipients }) {
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  const pasted = Array.isArray(listRecipients) ? listRecipients : []

  if (ids.length === 0 && pasted.length === 0) {
    const e = new Error('No recipients selected')
    e.status = 400
    throw e
  }

  // The cap counts PEOPLE, not contacts: a 400-row paste on top of a
  // 200-contact audience is the runaway send this limit exists to stop, and
  // counting only one half of it would have let the bigger half through.
  //
  // Checked on what was ASKED FOR, before the contact lookup, so an oversized
  // request is refused rather than turned into an `in (...)` list of thousands
  // of ids. Re-checked on what RESOLVED below, because the two can differ.
  const tooMany = (n) => {
    const e = new Error(`This send has ${n} recipients — the per-send limit is ${MAX_RECIPIENTS}. Narrow the audience or split the list and send in stages.`)
    e.status = 400
    return e
  }
  if (ids.length + pasted.length > MAX_RECIPIENTS) throw tooMany(ids.length + pasted.length)

  const { data: contacts, error: contactErr } = ids.length
    ? await user
      .from('contacts')
      .select('id, first_name, last_name, email, email_opt_out, status')
      .in('id', ids)
    : { data: [], error: null }
  if (contactErr) { const e = new Error(contactErr.message); e.status = 500; throw e }

  const totalResolved = (contacts || []).length + pasted.length
  if (totalResolved > MAX_RECIPIENTS) throw tooMany(totalResolved)

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
    // Which detail rows the agent switched off (see ANNOUNCEMENT_FACT_FIELDS).
    // Normalised here rather than trusted: this arrives from the browser, and
    // an unknown key silently doing nothing is better than one stored on the
    // blast that a later reader has to interpret. Stored on the record because
    // it is part of what was sent — a resumed batch tomorrow has to withhold
    // the same price the first batch withheld.
    hidden_facts:   normalizeHiddenFacts(blast.hiddenFacts),
    audience:       blast.audience || {},
    list_source:    blast.listSource || null,
    status:         'draft',
  }]).select('*').single()
  if (blastErr) { const e = new Error(blastErr.message); e.status = 500; throw e }

  // The opt-out list, read ONCE for every address in the send — contacts and
  // pasted rows together, before a single row is written as sendable.
  const suppressed = await suppressedEmails(svc, [
    ...(contacts || []).map(c => c.email),
    ...pasted.map(r => r?.email),
  ])

  // Skipped recipients are STORED, not dropped. An agent who selected 250 and
  // sees 243 sent needs the other 7 named, or the feature has quietly decided
  // something on their behalf.
  const rows = []
  const seen = new Set()

  // Contacts first, so that when the same address appears in the contact book
  // AND in the pasted file, the row that survives is the one with a contact
  // behind it — the send then lands on that person's timeline instead of
  // becoming an anonymous list delivery.
  for (const c of (contacts || [])) {
    const email = String(c.email || '').trim()
    const key   = email.toLowerCase()
    let skip = null
    if (!email)                    skip = 'No email on file'
    else if (!isValidEmail(email)) skip = 'Invalid email address'
    else if (c.email_opt_out)      skip = 'Opted out of email'
    else if (suppressed.has(key))  skip = 'Unsubscribed'
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
      source:      'contact',
      status:      skip ? 'skipped' : 'pending',
      skip_reason: skip,
    })
  }

  for (const r of pasted) {
    const email = String(r?.email || '').trim()
    const key   = email.toLowerCase()
    let skip = null
    if (!email)                    skip = 'No email address'
    else if (!isValidEmail(email)) skip = 'Invalid email address'
    else if (suppressed.has(key))  skip = 'Unsubscribed'
    else if (seen.has(key))        skip = 'Duplicate address in this send'
    if (!skip) seen.add(key)

    // A pasted row has no contact_id — that is the whole point — so the
    // snapshotted name is all the personalisation this recipient will ever
    // have. A row with no name still sends: {{firstName}} falls back to
    // "there", which reads better than an empty gap after "Hi".
    const { first_name, last_name } = splitListName(r?.name)
    rows.push({
      blast_id:    created.id,
      contact_id:  null,
      email:       email || '(no email address)',
      first_name,
      last_name,
      source:      'list',
      status:      skip ? 'skipped' : 'pending',
      skip_reason: skip,
    })
  }

  const { error: recErr } = await svc.from('email_blast_recipients').insert(rows)
  if (recErr) { const e = new Error(recErr.message); e.status = 500; throw e }

  const sendable     = rows.filter(r => r.status === 'pending')
  const skippedCount = rows.length - sendable.length
  const { data: updated } = await svc.from('email_blasts').update({
    recipient_count:      sendable.length,
    skipped_count:        skippedCount,
    list_recipient_count: sendable.filter(r => r.source === 'list').length,
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
    opened:    blast?.opened_count || 0,
    replied:   blast?.replied_count || 0,
    unsubscribed: blast?.unsubscribed_count || 0,
    listRecipients: blast?.list_recipient_count || 0,
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
export async function sendBlastBatch(svc, { blast, agent, contactsById = {}, property = null, baseUrl = '' }) {
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

  // Every message in this batch has to carry a working opt-out link. Checked
  // once, here, rather than per recipient: a blast that goes out without them is
  // exactly the failure the link exists to prevent, and discovering it at
  // recipient 150 means 150 people already have a message they can't opt out of.
  if (!baseUrl || !canMintUnsubscribeTokens()) {
    const e = new Error('Cannot build unsubscribe links for this send — no public URL or signing secret configured. Nothing was sent.')
    e.status = 500
    throw e
  }

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

    // A list recipient has no contact record, so the row IS the contact as far
    // as personalisation is concerned — which is why the row snapshots a name.
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
    // Per recipient, so one person's opt-out never takes anybody else with them
    // — and minted for EVERY recipient, contact or not. This used to be
    // conditional on row.contact_id, which meant a recipient the CRM had no
    // record for received a bulk email with no way out of it. That is the one
    // defect in this module that could not be described as a trade-off.
    const optOut  = unsubscribeUrl(baseUrl, mintRecipientUnsubscribeToken({
      email: row.email, contactId: row.contact_id, recipientId: row.id,
    }))
    const html    = renderAnnouncementHtml({
      ...tokenArgs, photoUrl: blast.photo_url, body: blast.body, unsubscribeUrl: optOut,
      hiddenFacts: blast.hidden_facts,
      openPixelUrl: openPixelUrl(baseUrl, mintOpenToken(row.id)),
    })

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
  // A list recipient has no contact to hang history on, and inventing one is
  // precisely what this feature was asked not to do. Their record is the
  // recipient row — status, opens, replies and opt-out all live there, and the
  // send's own report is where an agent reads them.
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
  // Engagement is counted the same way — from the rows, never incremented — so
  // the report cannot drift from what actually happened. `not.is` rather than a
  // boolean column because the timestamp is the fact and "when" is the part an
  // agent asks about next.
  const countStamped = async (column) => {
    const { count } = await svc
      .from('email_blast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('blast_id', blastId).not(column, 'is', null)
    return count || 0
  }
  const [sent, failed, skipped, opened, replied, unsubscribed] = await Promise.all([
    countBy('sent'), countBy('failed'), countBy('skipped'),
    countStamped('first_opened_at'), countStamped('replied_at'), countStamped('unsubscribed_at'),
  ])
  await svc.from('email_blasts').update({
    sent_count: sent, failed_count: failed, skipped_count: skipped,
    opened_count: opened, replied_count: replied, unsubscribed_count: unsubscribed,
  }).eq('id', blastId)
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
