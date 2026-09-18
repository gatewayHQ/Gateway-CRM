// ─────────────────────────────────────────────────────────────────────────────
// Inbound mail matching — nightly poll (api/cron.js ?task=inbox-sync).
//
// For each agent with Outlook connected, pages through Microsoft Graph's
// inbox delta feed (only what changed since the last run — see
// ms_graph_connections.mail_delta_link) and matches each message's sender to
// a known CRM contact by email address. A match becomes an `email_messages`
// row (direction='inbound', status='received') plus a companion `activities`
// row, exactly like an outbound send does — so a contact's timeline shows
// both directions of the conversation, not just what the agent sent.
//
// Deliberately narrow: a message from a sender that ISN'T a known contact is
// never imported. This isn't a general mailbox archiver — it's scoped to
// "mail from someone already in the CRM," which is both the useful case and
// the privacy-respecting one (an agent's personal/unrelated mail never
// touches the database).
//
// ── REPLIES TO A MASS SEND ───────────────────────────────────────────────────
// The same pass also marks blast recipients who wrote back (migration 0048).
// That is a separate job from the import above and has to be, because a mass
// send can go to addresses that are deliberately NOT contacts — pasted off a
// spreadsheet, with no contact record created. "Four people replied" is the
// single most useful number a send produces, and for those recipients there is
// no timeline it could be read from; the recipient row is their whole record.
//
// Only a flag and the subject are stored for a non-contact reply, never the
// body: the narrowness above is a privacy property worth keeping, and an agent
// who wants to read the reply has it in their own inbox already.
//
// Polling, not a Graph webhook subscription: a subscription needs a public
// notification endpoint and expires every ~3 days requiring renewal — real
// complexity for a feature that doesn't need to be real-time for 7-8 agents.
// A daily poll (the only cadence Vercel Hobby cron schedules support anyway)
// is a simpler, equally reliable trade for this scale.
// ─────────────────────────────────────────────────────────────────────────────
import { getValidAccessToken, fetchInboxDelta } from './msGraph.js'

const MAX_PAGES_PER_AGENT = 10   // bounds one agent's sync within the function's time budget

// Sync one agent's inbox. Returns { scanned, matched } or throws.
export async function syncAgentInbox(svc, connection) {
  const { accessToken } = await getValidAccessToken(svc, connection.agent_id)

  const messages = []
  let link = connection.mail_delta_link || undefined
  let page = await fetchInboxDelta(accessToken, { link })
  messages.push(...(page.value || []))

  let pages = 1
  while (page['@odata.nextLink'] && pages < MAX_PAGES_PER_AGENT) {
    page = await fetchInboxDelta(accessToken, { link: page['@odata.nextLink'] })
    messages.push(...(page.value || []))
    pages++
  }

  // Always persist the newest cursor we reached, even if we hit the page cap
  // (nextLink) rather than finishing (deltaLink) — the next run picks up
  // exactly where this one stopped instead of re-scanning from scratch.
  const newLink = page['@odata.deltaLink'] || page['@odata.nextLink'] || connection.mail_delta_link
  if (newLink && newLink !== connection.mail_delta_link) {
    await svc.from('ms_graph_connections').update({ mail_delta_link: newLink }).eq('agent_id', connection.agent_id)
  }

  if (!messages.length) return { scanned: 0, matched: 0 }

  const senderEmails = [...new Set(
    messages.map(m => m.from?.emailAddress?.address?.toLowerCase()).filter(Boolean)
  )]
  if (!senderEmails.length) return { scanned: messages.length, matched: 0 }

  const { data: contacts } = await svc.from('contacts')
    .select('id, email').in('email', senderEmails)
  const contactByEmail = new Map((contacts || []).map(c => [c.email.toLowerCase(), c]))

  const replies = await markBlastReplies(svc, messages)

  let matched = 0
  for (const m of messages) {
    const senderEmail = m.from?.emailAddress?.address?.toLowerCase()
    const contact = senderEmail && contactByEmail.get(senderEmail)
    if (!contact) continue

    const preview = (m.bodyPreview || '').slice(0, 280)

    // Idempotency: uq_email_messages_graph_id — a redelivered/duplicate delta
    // entry for a message we've already recorded just fails this insert, which
    // is the intended outcome (not an error worth surfacing).
    const { error } = await svc.from('email_messages').insert([{
      agent_id:         connection.agent_id,
      contact_id:       contact.id,
      direction:        'inbound',
      subject:          m.subject || null,
      body_preview:     preview || null,
      to_recipients:    [],
      cc_recipients:    [],
      status:           'received',
      graph_message_id: m.id,
      conversation_id:  m.conversationId || null,
      sent_at:          m.receivedDateTime || new Date().toISOString(),
    }])
    if (error) continue   // duplicate or transient — the next run will retry via the delta cursor either way

    matched++
    await svc.from('activities').insert([{
      contact_id: contact.id,
      agent_id:   connection.agent_id,
      type:       'email',
      body:       `Received: "${m.subject || '(no subject)'}"${preview ? `\n\n${preview}` : ''}`,
    }])
  }

  return { scanned: messages.length, matched, replies }
}

// How far back a reply can still be attributed to a send. A month covers the
// "saw it, meant to answer, finally did" case; beyond that an inbound message
// is its own conversation rather than a response to a blast, and matching it
// would quietly re-open sends that are long finished.
const REPLY_WINDOW_DAYS = 30

/**
 * Mark blast recipients who have written back.
 *
 * Matches on the sender's address against recipients of recent sends. The
 * FIRST reply wins and later ones are left alone: replied_at answers "did this
 * send get a response", and overwriting it with every subsequent message would
 * turn that into "when did they last email me", which is a different question
 * the contact timeline already answers.
 */
export async function markBlastReplies(svc, messages = []) {
  const senders = [...new Set(
    messages.map(m => m.from?.emailAddress?.address?.toLowerCase().trim()).filter(Boolean)
  )]
  if (!senders.length) return 0

  const since = new Date(Date.now() - REPLY_WINDOW_DAYS * 86_400_000).toISOString()

  // Newest send first: an address on two sends in the window is answering the
  // one it most likely just received.
  const { data: rows, error } = await svc
    .from('email_blast_recipients')
    .select('id, blast_id, email, replied_at, sent_at')
    .in('email', senders)
    .eq('status', 'sent')
    .is('replied_at', null)
    .gte('sent_at', since)
    .order('sent_at', { ascending: false })
  // A schema without migration 0048 yet, or any read failure, must not take the
  // contact-mail import down with it — that half of this sync is the older and
  // more important one.
  if (error || !rows?.length) return 0

  // One row per address, so two messages from the same person in one sync don't
  // both try to claim it.
  const byEmail = new Map()
  for (const r of rows) {
    const key = String(r.email || '').toLowerCase()
    if (!byEmail.has(key)) byEmail.set(key, r)
  }

  const touchedBlasts = new Set()
  let replied = 0

  for (const m of messages) {
    const sender = m.from?.emailAddress?.address?.toLowerCase().trim()
    const row    = sender && byEmail.get(sender)
    if (!row) continue
    byEmail.delete(sender)            // claimed — a second message is the same reply

    const { error: upErr } = await svc.from('email_blast_recipients').update({
      replied_at:    m.receivedDateTime || new Date().toISOString(),
      reply_subject: (m.subject || '').slice(0, 200) || null,
    }).eq('id', row.id).is('replied_at', null)
    if (upErr) continue

    replied++
    if (row.blast_id) touchedBlasts.add(row.blast_id)
  }

  // Recount rather than increment, for the same reason every other counter on a
  // blast is recomputed: a re-run of this sync must not inflate the number.
  for (const blastId of touchedBlasts) {
    const { count } = await svc
      .from('email_blast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('blast_id', blastId)
      .not('replied_at', 'is', null)
    await svc.from('email_blasts').update({ replied_count: count || 0 }).eq('id', blastId)
  }

  return replied
}

// Nightly sweep over every connected agent.
export async function syncAllInboxes(svc) {
  const { data: connections } = await svc.from('ms_graph_connections')
    .select('agent_id, mail_delta_link, status').eq('status', 'connected')
  if (!connections?.length) {
    return { ok: true, agents: 0, scanned: 0, matched: 0, replies: 0, errors: [] }
  }

  let scanned = 0, matched = 0, replies = 0
  const errors = []
  for (const conn of connections) {
    try {
      const r = await syncAgentInbox(svc, conn)
      scanned += r.scanned
      matched += r.matched
      replies += r.replies || 0
    } catch (err) {
      errors.push({ agent_id: conn.agent_id, error: err.message })
    }
  }

  return { ok: true, agents: connections.length, scanned, matched, replies, errors }
}
