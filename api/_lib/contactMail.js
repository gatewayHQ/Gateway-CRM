// ─────────────────────────────────────────────────────────────────────────────
// Contact email correspondence — the data layer behind the contact panel's
// "Emails" tab (api/email-send.js ?action=outlook-messages).
//
// What this is NOT: a contact-matching lookup. The panel this replaced asked
// Microsoft Graph for the agent's Outlook CONTACTS entry for an address
// (/me/contacts) and reported "no matching Outlook contact found" whenever the
// address had never been saved to the address book — which is the normal case
// for a correspondent. This asks the only question that actually matters: what
// mail has passed between this mailbox and this address, in either direction,
// ever.
//
// Shape of a request:
//   1. Read what's already mirrored for the contact (cheap, RLS-scoped).
//   2. Hit Graph only when the mirror is stale, the agent asked for a refresh,
//      or the agent asked for an older page — never on every render.
//   3. Mirror whatever came back into email_messages (source='graph'), and
//      park the paging cursor in contact_email_sync so "Load more" resumes.
//
// The mirror is a cache, not the source of truth: every row is keyed by its
// Graph message id, so re-pulling a page is idempotent, and a stale mirror is
// only ever missing recent mail, never wrong about it.
// ─────────────────────────────────────────────────────────────────────────────
import { fetchMailWithParticipant, normalizeGraphMessage, MAIL_PAGE_SIZE } from './msGraph.js'

// How long a mirrored page is treated as current. Mail is not a live feed and
// the panel is opened and re-opened constantly while an agent works a contact;
// five minutes means flipping between tabs costs nothing, while a genuinely new
// reply is at most one Refresh click away.
export const MAIL_SYNC_TTL_MS = 5 * 60 * 1000

// Cap on how far back one request will page. A lifetime pull is paged, not
// unbounded: Graph throttles per-mailbox, and a serverless function has a wall
// clock. Each request advances the history by at most this many pages and hands
// the cursor back, so "Load more" walks the rest at the agent's pace rather
// than risking a timeout or a 429 storm on first open.
const MAX_PAGES_PER_REQUEST = 2

// Two mirrored copies of one email are worse than none — a subject+timestamp
// near-match is how an outbound row the CRM created at send time (which has no
// Graph id, because /me/sendMail doesn't return one) is recognized as the same
// message as its Sent Items copy.
const ADOPT_WINDOW_MS = 10 * 60 * 1000

const norm = (s) => String(s || '').trim().toLowerCase()

const MIRROR_SELECT =
  'id, direction, subject, body_preview, from_address, from_name, to_recipients, ' +
  'cc_recipients, status, source, web_link, has_attachments, conversation_id, sent_at'

// ─── Cached read ──────────────────────────────────────────────────────────────
// Deliberately takes the RLS-scoped user client, not the service client: a
// contact's correspondence is exactly as visible as the contact is
// (email_messages_scope, migration 0034), and this route is not the place to
// widen that.
export async function readMirroredThread(userClient, contactId, { limit = 50 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 500)
  const { data, error } = await userClient
    .from('email_messages')
    .select(MIRROR_SELECT)
    .eq('contact_id', contactId)
    .neq('status', 'draft')            // a draft was never correspondence
    .order('sent_at', { ascending: false })
    .limit(capped)
  if (error) { const e = new Error(error.message); e.status = 500; throw e }
  return data || []
}

// ─── Mirroring one page of Graph results ──────────────────────────────────────
// Returns { inserted, adopted }. Never throws on a per-row conflict: a message
// already mirrored (by another agent's request, or a re-pulled page) is the
// expected case, not an error.
export async function mirrorMessages(svc, { agentId, contactId, messages }) {
  const usable = messages.filter(m => m.graphMessageId && !m.isDraft)
  if (!usable.length) return { inserted: 0, adopted: 0 }

  // Which of these do we already hold? Asked by id rather than by scanning the
  // contact's whole history, so the cost doesn't grow with the mirror.
  const ids = usable.map(m => m.graphMessageId)
  const { data: existing } = await svc
    .from('email_messages')
    .select('graph_message_id')
    .in('graph_message_id', ids)
  const known = new Set((existing || []).map(r => r.graph_message_id))

  let fresh = usable.filter(m => !known.has(m.graphMessageId))
  if (!fresh.length) return { inserted: 0, adopted: 0 }

  // Adopt, rather than duplicate, the rows this CRM created at send time. Those
  // carry no Graph id (POST /me/sendMail returns 202 with no body), so their
  // Sent Items copy would otherwise mirror in as a second row for one email.
  const { data: unlinked } = await svc
    .from('email_messages')
    .select('id, subject, sent_at')
    .eq('contact_id', contactId)
    .eq('direction', 'outbound')
    .is('graph_message_id', null)
    .order('sent_at', { ascending: false })
    .limit(200)

  let adopted = 0
  const claimed = new Set()
  for (const m of fresh.filter(m => m.direction === 'outbound')) {
    const match = (unlinked || []).find(r =>
      !claimed.has(r.id) &&
      norm(r.subject) === norm(m.subject) &&
      r.sent_at && m.sentAt &&
      Math.abs(new Date(r.sent_at) - new Date(m.sentAt)) <= ADOPT_WINDOW_MS
    )
    if (!match) continue
    claimed.add(match.id)
    const { error } = await svc.from('email_messages').update({
      graph_message_id: m.graphMessageId,
      conversation_id:  m.conversationId,
      from_address:     m.fromAddress,
      from_name:        m.fromName,
      web_link:         m.webLink,
      has_attachments:  m.hasAttachments,
    }).eq('id', match.id)
    if (!error) { adopted++; known.add(m.graphMessageId) }
  }
  fresh = fresh.filter(m => !known.has(m.graphMessageId))

  let inserted = 0
  if (fresh.length) {
    const rows = fresh.map(m => ({
      agent_id:         agentId,
      contact_id:       contactId,
      direction:        m.direction,
      subject:          m.subject,
      body_preview:     m.preview,
      to_recipients:    m.to,
      cc_recipients:    m.cc,
      // An inbound message was never "sent" by this CRM; an outbound one it
      // merely observed still genuinely left the mailbox.
      status:           m.direction === 'inbound' ? 'received' : 'sent',
      source:           'graph',
      from_address:     m.fromAddress,
      from_name:        m.fromName,
      web_link:         m.webLink,
      has_attachments:  m.hasAttachments,
      graph_message_id: m.graphMessageId,
      conversation_id:  m.conversationId,
      sent_at:          m.sentAt,
    }))
    // Row-at-a-time: uq_email_messages_graph_id is a PARTIAL unique index, so it
    // can't be used as an upsert conflict target through PostgREST. One losing
    // insert (a concurrent request mirrored the same page) must not take the
    // rest of the page down with it.
    for (const row of rows) {
      const { error } = await svc.from('email_messages').insert([row])
      if (!error) inserted++
    }
  }

  return { inserted, adopted }
}

// ─── Sync state ───────────────────────────────────────────────────────────────

export async function readSyncState(svc, { contactId, agentId }) {
  const { data } = await svc
    .from('contact_email_sync')
    .select('*')
    .eq('contact_id', contactId)
    .eq('agent_id', agentId)
    .maybeSingle()
  return data || null
}

async function writeSyncState(svc, { contactId, agentId, email }, patch) {
  const existing = await readSyncState(svc, { contactId, agentId })
  if (existing) {
    const { data } = await svc.from('contact_email_sync')
      .update(patch).eq('id', existing.id).select('*').single()
    return data || { ...existing, ...patch }
  }
  const { data } = await svc.from('contact_email_sync')
    .insert([{ contact_id: contactId, agent_id: agentId, email, ...patch }])
    .select('*').single()
  return data
}

// The stored cursor belongs to the address it was built for. If the contact's
// email was corrected since (a typo fixed, a personal address swapped for a
// work one), continuing to page it would silently serve someone else's mail.
export function cursorMatchesEmail(sync, email) {
  return !!sync && norm(sync.email) === norm(email)
}

export function isStale(sync, { now = Date.now() } = {}) {
  if (!sync?.last_synced_at) return true
  return now - new Date(sync.last_synced_at).getTime() > MAIL_SYNC_TTL_MS
}

// ─── The one entry point ──────────────────────────────────────────────────────
// Decides whether to talk to Graph at all, pulls at most MAX_PAGES_PER_REQUEST,
// mirrors what came back, and records where it stopped.
//
// `intent`:
//   'auto'    — refresh only if the mirror is stale (the normal panel open)
//   'refresh' — always re-pull the newest page (the agent clicked Refresh)
//   'more'    — continue from the stored cursor into older mail ("Load more")
//
// A Graph failure here is returned, not thrown: the panel should still render
// whatever is mirrored, with an honest banner about why it might be behind.
export async function syncContactMail(svc, {
  agentId, contactId, contactEmail, mailboxEmail, accessToken,
  level = 'full', intent = 'auto',
}) {
  let sync = await readSyncState(svc, { contactId, agentId })

  // A changed address invalidates both the cursor and the mirror built from it.
  // Dropping only source='graph' rows leaves the CRM's own send/receive record
  // (which is tied to the contact, not to whichever address was current) intact.
  if (sync && !cursorMatchesEmail(sync, contactEmail)) {
    await svc.from('email_messages')
      .delete().eq('contact_id', contactId).eq('source', 'graph')
    sync = await writeSyncState(svc, { contactId, agentId, email: contactEmail }, {
      email: contactEmail, next_link: null, backfill_complete: false,
      message_count: 0, last_synced_at: null, last_error: null,
    })
    if (intent === 'more') intent = 'auto'      // nothing left to continue from
  }

  const wantsGraph =
    intent === 'refresh' ||
    (intent === 'more' && !sync?.backfill_complete) ||
    (intent === 'auto' && isStale(sync))

  if (!wantsGraph) {
    return { synced: false, sync, error: null, inserted: 0, adopted: 0 }
  }

  // 'more' resumes from the cursor; anything else starts at the newest page.
  // 'more' with no cursor yet (Load more clicked before a first page ever
  // landed) falls through to a normal first page rather than doing nothing.
  let link = intent === 'more' ? (sync?.next_link || null) : null

  let inserted = 0, adopted = 0, pages = 0
  let mode = sync?.mode || null
  let nextLink = intent === 'more' ? null : (sync?.next_link || null)
  let reachedEnd = false

  try {
    do {
      const page = await fetchMailWithParticipant(accessToken, {
        email: contactEmail, link, level, top: MAIL_PAGE_SIZE,
      })
      if (page.mode !== 'continued') mode = page.mode
      const normalized = page.messages.map(m => normalizeGraphMessage(m, mailboxEmail))
      const r = await mirrorMessages(svc, { agentId, contactId, messages: normalized })
      inserted += r.inserted
      adopted  += r.adopted
      pages++

      if (intent === 'more') {
        // Walking backwards through history: the cursor must always point at
        // the oldest page not yet mirrored.
        nextLink = page.nextLink
        if (!page.nextLink) reachedEnd = true
      } else if (pages === 1 && !sync?.next_link) {
        // A fresh first page with no cursor further back: its nextLink IS the
        // backfill cursor, and its absence means this address's whole history
        // fit in one page. When a cursor already exists it is older than
        // anything this page could say, so neither is touched.
        nextLink = page.nextLink
        if (!page.nextLink) reachedEnd = true
      }
      link = intent === 'more' ? page.nextLink : null
    } while (intent === 'more' && link && pages < MAX_PAGES_PER_REQUEST)
  } catch (err) {
    await writeSyncState(svc, { contactId, agentId, email: contactEmail }, {
      last_error: err.message,
    })
    return {
      synced: false,
      sync: await readSyncState(svc, { contactId, agentId }),
      error: { message: err.message, status: err.status || 502 },
      inserted, adopted,
    }
  }

  const { count } = await svc
    .from('email_messages')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .neq('status', 'draft')

  const updated = await writeSyncState(svc, { contactId, agentId, email: contactEmail }, {
    email:             contactEmail,
    next_link:         nextLink,
    // Complete only when a page actually came back empty-handed of a
    // nextLink — never inferred from a missing cursor, which is also what a
    // brand-new sync looks like.
    backfill_complete: reachedEnd || (intent === 'more' && !nextLink),
    mode,
    message_count:     count ?? 0,
    last_synced_at:    new Date().toISOString(),
    last_error:        null,
  })

  return { synced: true, sync: updated, error: null, inserted, adopted }
}
