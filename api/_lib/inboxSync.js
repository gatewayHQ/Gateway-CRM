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

  return { scanned: messages.length, matched }
}

// Nightly sweep over every connected agent.
export async function syncAllInboxes(svc) {
  const { data: connections } = await svc.from('ms_graph_connections')
    .select('agent_id, mail_delta_link, status').eq('status', 'connected')
  if (!connections?.length) {
    return { ok: true, agents: 0, scanned: 0, matched: 0, errors: [] }
  }

  let scanned = 0, matched = 0
  const errors = []
  for (const conn of connections) {
    try {
      const r = await syncAgentInbox(svc, conn)
      scanned += r.scanned
      matched += r.matched
    } catch (err) {
      errors.push({ agent_id: conn.agent_id, error: err.message })
    }
  }

  return { ok: true, agents: connections.length, scanned, matched, errors }
}
