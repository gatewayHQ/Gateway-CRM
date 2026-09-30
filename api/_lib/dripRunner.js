// ─────────────────────────────────────────────────────────────────────────────
// Drip sequence runner — sends each due step from the OWNING AGENT'S Outlook.
//
// Called by:
//   • api/cron.js ?task=sequence          — the daily sweep over every active
//                                           enrollment
//   • api/_handlers/website-lead.js       — right after a round-robin lead is
//                                           enrolled, so a Day-0 email reaches
//                                           them in seconds, not tomorrow
//   • api/email-send.js ?action=drip-run  — right after an agent enrolls
//                                           contacts by hand
//
// WHO SENDS. A sequence belongs to one agent (sequences.agent_id, migration
// 0060), and every email step goes out through that agent's own Microsoft 365
// mailbox via Graph /me/sendMail — the same path as a one-off send and a mass
// email. There is no shared sender and no Resend. An agent whose Outlook is not
// connected simply has nothing sent: the enrollment keeps its place, records
// why in last_error, and resumes on the first run after they reconnect.
//
// WHAT STOPS A DRIP
//   • the contact replied (an inbound email_messages row from inbox sync)
//   • the contact opted out, or the address is on email_suppressions
//   • the contact has no email address (an email step cannot send)
//   • the contact was deleted
// A replied or stopped enrollment is never restarted automatically.
//
// NOTHING IS SENT TWICE. An enrollment is CLAIMED — current_step advanced with
// a compare-and-set on its old value — before its email goes out, so two runs
// that overlap (the cron and a webhook, say) cannot both send the same step. A
// failed send hands the claim back so the step is retried on the next run.
// ─────────────────────────────────────────────────────────────────────────────

import {
  getValidAccessToken as defaultGetToken,
  sendGraphMail as defaultSendMail,
  canSendMail,
} from './msGraph.js'
import { sentInLast24h, suppressedEmails, DAILY_SEND_LIMIT } from './massEmail.js'
import { mintRecipientUnsubscribeToken, canMintUnsubscribeTokens } from './unsubscribeToken.js'
import { unsubscribeUrl } from '../../src/lib/emailFooter.js'
import {
  dripTokens, renderDripEmail, renderDripText, matchListings, searchCriteria, wantsListings,
} from '../../src/lib/dripTokens.js'

const DAY_MS = 86_400_000

// A cron invocation has 60 seconds (vercel.json). Stop starting new sends well
// before that, so every claimed step is either sent or handed back.
export const RUN_BUDGET_MS = 45_000
export const MAX_SENDS_PER_RUN = 150
// Graph throttles per mailbox; a short gap between one agent's sends keeps a
// burst of due steps well under it.
const SEND_GAP_MS = 250

const CONTACT_COLUMNS =
  'id, first_name, last_name, email, email_opt_out, submarket, assigned_agent_id, ' +
  'search_beds_min, search_baths_min, search_price_min, search_price_max'
const CONTACT_COLUMNS_LEGACY =
  'id, first_name, last_name, email, email_opt_out, submarket, assigned_agent_id'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** When step `idx` of this enrollment is due, in ms since the epoch. */
export function stepDueAt(enrollment, step, idx) {
  const ref = idx === 0 || !enrollment.last_sent_at
    ? new Date(enrollment.started_at || enrollment.created_at || 0).getTime()
    : new Date(enrollment.last_sent_at).getTime()
  return ref + (Number(step?.delay_days) || 0) * DAY_MS
}

async function selectIn(svc, table, columns, column, ids) {
  if (!ids.length) return []
  const out = []
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await svc.from(table).select(columns).in(column, ids.slice(i, i + 200))
    if (error) { const e = new Error(`${table}: ${error.message}`); e.table = table; throw e }
    out.push(...(data || []))
  }
  return out
}

/** Contacts, tolerating a database that has not run 0060 yet. */
async function loadContacts(svc, ids) {
  try {
    return await selectIn(svc, 'contacts', CONTACT_COLUMNS, 'id', ids)
  } catch {
    return selectIn(svc, 'contacts', CONTACT_COLUMNS_LEGACY, 'id', ids)
  }
}

/** Active residential listings — the pool {{matchingListings}} draws from. */
async function loadListings(svc) {
  const cols = 'id, address, city, state, zip, county, type, status, list_price, beds, baths, sqft, details'
  let { data, error } = await svc.from('properties').select(`${cols}, unit`).eq('status', 'active').limit(2000)
  if (error) ({ data } = await svc.from('properties').select(cols).eq('status', 'active').limit(2000))
  return data || []
}

async function patchEnrollment(svc, id, patch, guard = null) {
  let q = svc.from('contact_sequences').update(patch).eq('id', id)
  if (guard) for (const [k, v] of Object.entries(guard)) q = q.eq(k, v)
  const { data, error } = await q.select('id')
  if (error) return { ok: false, error: error.message }
  return { ok: (data || []).length > 0 }
}

async function stopEnrollment(svc, e, status, reason) {
  await patchEnrollment(svc, e.id, { status, stopped_reason: reason, last_error: null })
}

/**
 * Run every due step.
 *
 * @param svc   service-role supabase-js client
 * @param opts.enrollmentIds  only these enrollments (the "send Day 0 now" path)
 * @param opts.baseUrl        public CRM origin, for listing and opt-out links
 * @param opts.deps           { getValidAccessToken, sendGraphMail } — for tests
 */
export async function runDripSequences(svc, {
  enrollmentIds = null,
  baseUrl = '',
  now = Date.now(),
  budgetMs = RUN_BUDGET_MS,
  maxSends = MAX_SENDS_PER_RUN,
  gapMs = SEND_GAP_MS,
  deps = {},
} = {}) {
  const getToken = deps.getValidAccessToken || defaultGetToken
  const sendMail = deps.sendGraphMail || defaultSendMail
  const startedAt = Date.now()
  const result = { sent: 0, calls: 0, skipped: 0, stopped: 0, replied: 0, errors: 0, details: [] }

  // ── Load ────────────────────────────────────────────────────────────────
  let q = svc.from('contact_sequences').select('*').eq('status', 'active')
  if (enrollmentIds) {
    if (!enrollmentIds.length) return { status: 200, body: { ok: true, ...result } }
    q = q.in('id', enrollmentIds)
  }
  const { data: enrollments, error: enrollErr } = await q.limit(2000)
  if (enrollErr) return { status: 500, body: { error: enrollErr.message } }
  if (!enrollments?.length) return { status: 200, body: { ok: true, ...result, message: 'No active enrollments' } }

  const uniq = (xs) => [...new Set(xs.filter(Boolean))]
  const sequenceIds = uniq(enrollments.map(e => e.sequence_id))

  let sequences, steps, contacts
  try {
    ;[sequences, steps, contacts] = await Promise.all([
      selectIn(svc, 'sequences', 'id, name, agent_id', 'id', sequenceIds),
      selectIn(svc, 'sequence_steps', '*', 'sequence_id', sequenceIds),
      loadContacts(svc, uniq(enrollments.map(e => e.contact_id))),
    ])
  } catch (err) {
    return { status: 500, body: { error: err.message } }
  }

  const sequenceById = new Map(sequences.map(s => [s.id, s]))
  const contactById  = new Map(contacts.map(c => [c.id, c]))
  const stepsBySeq   = new Map()
  for (const s of steps.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
    if (!stepsBySeq.has(s.sequence_id)) stepsBySeq.set(s.sequence_id, [])
    stepsBySeq.get(s.sequence_id).push(s)
  }

  // The sender is the sequence's owner. A pre-0060 sequence with no owner falls
  // back to whoever enrolled the contact.
  const senderOf = (e) => sequenceById.get(e.sequence_id)?.agent_id || e.agent_id || null

  // ── What is due ─────────────────────────────────────────────────────────
  const due = []
  for (const e of enrollments) {
    const list = stepsBySeq.get(e.sequence_id) || []
    const idx  = Number(e.current_step) || 0
    if (!list.length) { result.skipped++; continue }
    if (idx >= list.length) {
      await patchEnrollment(svc, e.id, { status: 'completed' })
      result.skipped++
      continue
    }
    const step = list[idx]
    const dueAt = stepDueAt(e, step, idx)
    if (dueAt > now) { result.skipped++; continue }
    due.push({ e, step, idx, total: list.length, dueAt })
  }
  if (!due.length) return { status: 200, body: { ok: true, ...result } }
  due.sort((a, b) => a.dueAt - b.dueAt)

  const agentIds = uniq(due.map(d => senderOf(d.e)))
  const dueContactIds = uniq(due.map(d => d.e.contact_id))
  const leadIds = uniq(due.map(d => d.e.lead_id))

  let agents = [], replies = [], views = []
  try {
    ;[agents, replies, views] = await Promise.all([
      selectIn(svc, 'agents', 'id, name, email, phone', 'id', agentIds),
      // Inbound mail matched by inbox sync. Any reply after the enrollment
      // started ends the drip — the agent is in a conversation now.
      svc.from('email_messages').select('contact_id, sent_at')
        .in('contact_id', dueContactIds.slice(0, 500)).eq('status', 'received')
        .then(r => r.data || []),
      leadIds.length
        ? svc.from('lead_property_views').select('lead_id, title, url, position')
            .in('lead_id', leadIds.slice(0, 500)).order('position').then(r => r.data || [])
        : [],
    ])
  } catch (err) {
    return { status: 500, body: { error: err.message } }
  }
  const agentById = new Map(agents.map(a => [a.id, a]))
  const lastReplyAt = new Map()
  for (const r of replies) {
    const t = new Date(r.sent_at).getTime()
    if (!lastReplyAt.has(r.contact_id) || t > lastReplyAt.get(r.contact_id)) lastReplyAt.set(r.contact_id, t)
  }
  const viewedByLead = new Map()
  for (const v of views) if (!viewedByLead.has(v.lead_id)) viewedByLead.set(v.lead_id, v.title || v.url || '')

  // Opt-outs. A failure here is fatal, as in mass email: the permissive default
  // would be mailing people who asked us to stop.
  let suppressed
  try {
    suppressed = await suppressedEmails(svc, contacts.map(c => c.email))
  } catch (err) {
    return { status: 500, body: { error: err.message } }
  }

  const listings = due.some(d => d.step.step_type !== 'call' && wantsListings(d.step.body))
    ? await loadListings(svc) : []

  const optOutReady = Boolean(baseUrl) && canMintUnsubscribeTokens()

  // Per-agent mailbox state, resolved once on first use.
  const mailbox = new Map()   // agentId → { accessToken, room } | { error }
  async function mailboxFor(agentId) {
    if (mailbox.has(agentId)) return mailbox.get(agentId)
    let state
    try {
      const { accessToken, connection } = await getToken(svc, agentId)
      if (!canSendMail(connection)) {
        state = { error: 'Outlook is connected without send permission — reconnect Outlook in Integrations' }
      } else {
        const used = await sentInLast24h(svc, agentId)
        state = { accessToken, room: Math.max(0, DAILY_SEND_LIMIT - used), lastSendAt: 0 }
      }
    } catch (err) {
      state = { error: err.status === 409 ? 'Outlook is not connected — connect it in Integrations to send your drip' : err.message }
    }
    mailbox.set(agentId, state)
    return state
  }

  // ── Work the queue ──────────────────────────────────────────────────────
  for (const { e, step, idx, total } of due) {
    if (Date.now() - startedAt > budgetMs) break
    if (result.sent >= maxSends) break

    const contact = contactById.get(e.contact_id)
    const agentId = senderOf(e)
    const agent   = agentById.get(agentId) || { id: agentId }
    const isCall  = step.step_type === 'call'

    if (!contact) {
      await stopEnrollment(svc, e, 'stopped', 'Contact was deleted'); result.stopped++; continue
    }
    const replyAt = lastReplyAt.get(contact.id)
    const since = new Date(e.started_at || e.created_at || 0).getTime()
    if (replyAt && replyAt >= since) {
      await stopEnrollment(svc, e, 'replied', `Replied ${new Date(replyAt).toISOString().slice(0, 10)}`)
      await svc.from('activities').insert([{
        contact_id: contact.id, agent_id: agentId, type: 'note',
        body: `Drip sequence "${sequenceById.get(e.sequence_id)?.name || ''}" stopped — ${contact.first_name || 'the contact'} replied. Time to call!`,
      }]).then(() => {}, () => {})
      result.replied++
      continue
    }
    if (!agentId) {
      await patchEnrollment(svc, e.id, { last_error: 'This sequence has no owner' }); result.errors++; continue
    }

    const email = String(contact.email || '').trim().toLowerCase()
    if (!isCall) {
      if (contact.email_opt_out || (email && suppressed.has(email))) {
        await stopEnrollment(svc, e, 'stopped', 'Contact unsubscribed from email'); result.stopped++; continue
      }
      if (!email) {
        await stopEnrollment(svc, e, 'stopped', 'Contact has no email address'); result.stopped++; continue
      }
    }

    const tokens = dripTokens({ contact, agent, propertyViewed: viewedByLead.get(e.lead_id) || '' })
    const isLast = idx + 1 >= total
    const claim = {
      current_step: idx + 1,
      last_sent_at: new Date(now).toISOString(),
      status:       isLast ? 'completed' : 'active',
      last_error:   null,
    }
    const release = { current_step: idx, last_sent_at: e.last_sent_at || null, status: 'active' }

    // ── Call step: a task on the agent's list, due today ─────────────────
    if (isCall) {
      const got = await patchEnrollment(svc, e.id, claim, { current_step: idx, status: 'active' })
      if (!got.ok) { result.skipped++; continue }
      const title = renderDripText(step.subject, tokens).trim()
        || `Call ${[contact.first_name, tokens.lastName].filter(Boolean).join(' ')}`
      const { error } = await svc.from('tasks').insert([{
        title:      title.slice(0, 200),
        type:       'call',
        priority:   'high',
        due_date:   new Date(now).toISOString(),
        contact_id: contact.id,
        agent_id:   agentId,
        notes:      renderDripText(step.body, tokens).trim() || null,
      }])
      if (error) {
        await patchEnrollment(svc, e.id, { ...release, last_error: `Could not create call task: ${error.message}` }, { current_step: idx + 1 })
        result.errors++
        continue
      }
      result.calls++
      result.details.push({ enrollment: e.id, step: idx, call: true })
      continue
    }

    // ── Email step: the agent's own Outlook ──────────────────────────────
    const box = await mailboxFor(agentId)
    if (box.error) {
      await patchEnrollment(svc, e.id, { last_error: box.error }); result.errors++; continue
    }
    if (box.room <= 0) {
      await patchEnrollment(svc, e.id, { last_error: `Daily send limit reached (${DAILY_SEND_LIMIT}/24h) — will send on the next run` })
      result.skipped++
      continue
    }
    if (!optOutReady) {
      await patchEnrollment(svc, e.id, { last_error: 'Unsubscribe links are not configured (PUBLIC_BASE_URL) — nothing was sent' })
      result.errors++
      continue
    }

    const got = await patchEnrollment(svc, e.id, claim, { current_step: idx, status: 'active' })
    if (!got.ok) { result.skipped++; continue }

    const optOut = unsubscribeUrl(baseUrl, mintRecipientUnsubscribeToken({ email, contactId: contact.id }))
    const picks  = wantsListings(step.body) ? matchListings(listings, searchCriteria(contact)) : []
    const msg    = renderDripEmail({
      subject: step.subject, body: step.body, tokens, listings: picks, agent, baseUrl, unsubscribeUrl: optOut,
    })

    if (gapMs && box.lastSendAt) {
      const wait = gapMs - (Date.now() - box.lastSendAt)
      if (wait > 0) await sleep(wait)
    }

    let sendError = null
    try {
      await sendMail(box.accessToken, { subject: msg.subject, html: msg.html, to: [contact.email] })
    } catch (err) {
      sendError = err.message || 'Send failed'
      // A dead token fails every later send for this agent the same way.
      if (err.status === 401) mailbox.set(agentId, { error: 'Microsoft sign-in expired — reconnect Outlook in Integrations' })
    }
    box.lastSendAt = Date.now()

    await svc.from('email_log').insert([{
      enrollment_id: e.id, sequence_id: e.sequence_id, sequence_step_id: step.id,
      contact_id: contact.id, agent_id: agentId, to_email: contact.email,
      subject: msg.subject, status: sendError ? 'failed' : 'sent', error: sendError,
    }]).then(() => {}, () => {})

    if (sendError) {
      await patchEnrollment(svc, e.id, { ...release, last_error: sendError }, { current_step: idx + 1 })
      result.errors++
      result.details.push({ enrollment: e.id, step: idx, error: sendError })
      continue
    }

    box.room--
    result.sent++
    result.details.push({ enrollment: e.id, step: idx, to: contact.email })

    // Contact history: the timeline and the Emails tab, the same two rows a
    // one-off send and a mass email write. Best effort — the mail is gone.
    try {
      const seqName = sequenceById.get(e.sequence_id)?.name || 'drip'
      const { data: activity } = await svc.from('activities').insert([{
        contact_id: contact.id, agent_id: agentId, type: 'email',
        body: `Drip "${seqName}" step ${idx + 1}/${total}: "${msg.subject}"`,
      }]).select('id').single()
      await svc.from('email_messages').insert([{
        agent_id:      agentId,
        contact_id:    contact.id,
        activity_id:   activity?.id || null,
        subject:       msg.subject,
        body_preview:  msg.text.slice(0, 280),
        body_html:     msg.html,
        to_recipients: [{ email: contact.email }],
        status:        'sent',
        source:        'crm',
        sent_at:       new Date().toISOString(),
      }])
    } catch (err) {
      console.error('[drip] history logging failed for enrollment', e.id, err.message)
    }
  }

  return { status: 200, body: { ok: true, ...result } }
}

/** The public CRM origin for links in the email, from env or the request. */
export function publicBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.CRM_BASE_URL
  if (configured) return configured.trim().replace(/\/+$/, '')
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host
  if (!host) return ''
  return `${req.headers['x-forwarded-proto'] || 'https'}://${host}`
}
