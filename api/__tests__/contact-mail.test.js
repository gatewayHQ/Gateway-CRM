/**
 * Contact email correspondence — the "Emails" tab on a contact record
 * (api/_lib/msGraph.js mail helpers + api/_lib/contactMail.js).
 *
 * WHAT THESE GUARD
 *
 * 1. THE RESOURCE. The bug this feature fixes was asking the wrong Graph
 *    resource: /me/contacts (the agent's ADDRESS BOOK) instead of /me/messages
 *    (the mailbox). An address that was never saved as an Outlook Contact —
 *    which is most correspondents — made the address-book query return zero
 *    rows, and the panel reported "no matching Outlook contact found" as though
 *    no mail existed. The URL-shape tests are the regression guard: if a future
 *    refactor points this at /me/contacts or /me/people again, they fail.
 *
 * 2. BOTH DIRECTIONS. `participants:` is the only KQL property that covers
 *    from + to + cc in one query, because Graph has no lambda $filter over
 *    toRecipients. A test pins it, because narrowing to `from:` would silently
 *    turn a conversation into a one-sided list.
 *
 * 3. FALLBACK IS FOR REFUSALS, NOT FAILURES. A mailbox that can't answer a
 *    $search should degrade to a received-only list flagged as partial. A 401
 *    or a 429 must NOT: swallowing those would render an empty panel that looks
 *    exactly like "no correspondence", which is the very confusion this feature
 *    exists to end.
 *
 * 4. NO DOUBLE-COUNTING A SEND. POST /me/sendMail returns 202 with no body, so
 *    the row the CRM writes at send time has no Graph id. Its Sent Items copy
 *    arrives later through the mirror and must be recognized as the SAME email,
 *    or every email an agent sends from the CRM shows up twice.
 *
 * 5. THROTTLING. A lifetime-history pull is the one call here that can walk
 *    into Graph's per-mailbox limit. Retry-After has to be honored, and a read
 *    that keeps failing must surface rather than loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  buildMailSearchUrl, buildMailFilterUrl, mailReadLevel, canSendMail,
  normalizeGraphMessage, fetchMailWithParticipant, graphBackoffMs, graphFetch,
  MAIL_PAGE_SIZE,
} from '../_lib/msGraph.js'
import {
  mirrorMessages, isStale, cursorMatchesEmail, MAIL_SYNC_TTL_MS,
} from '../_lib/contactMail.js'

// URLSearchParams encodes a space as '+' (legal in a query string, and OData
// reads it as a space), which decodeURIComponent leaves alone — so assertions
// on filter syntax have to undo both.
const readable = (url) => decodeURIComponent(url).replace(/\+/g, ' ')

const CONTACT_EMAIL = 'Janet_Hala@yahoo.com'
const MAILBOX       = 'agent@gatewayreadvisors.com'
const CONTACT_ID    = 'cccccccc-0000-0000-0000-00000000c001'
const AGENT_ID      = 'aaaaaaaa-0000-0000-0000-00000000a001'

// ─── Graph query shape ────────────────────────────────────────────────────────

describe('mail query targets the mailbox, not the address book', () => {
  it('searches /me/messages — never /me/contacts or /me/people', () => {
    const url = buildMailSearchUrl(CONTACT_EMAIL)
    expect(url).toContain('/me/messages')
    expect(url).not.toContain('/me/contacts')
    expect(url).not.toContain('/me/people')
  })

  it('matches on participants, so sent AND received mail both come back', () => {
    const url = decodeURIComponent(buildMailSearchUrl(CONTACT_EMAIL))
    expect(url).toContain(`$search="participants:${CONTACT_EMAIL}"`)
  })

  it('asks for the fields the panel renders', () => {
    const url = decodeURIComponent(buildMailSearchUrl(CONTACT_EMAIL))
    for (const field of ['subject', 'bodyPreview', 'from', 'toRecipients', 'sentDateTime', 'webLink']) {
      expect(url).toContain(field)
    }
    expect(url).toContain(`$top=${MAIL_PAGE_SIZE}`)
  })

  it('drops bodyPreview under Mail.ReadBasic, which forbids it', () => {
    const basic = decodeURIComponent(buildMailSearchUrl(CONTACT_EMAIL, { level: 'basic' }))
    expect(basic).not.toContain('bodyPreview')
    expect(basic).toContain('subject')
  })

  it('escapes a quote in the address rather than breaking out of the KQL string', () => {
    const url = decodeURIComponent(buildMailSearchUrl('od"d@x.com'))
    expect(url).toContain('$search="participants:odd@x.com"')
  })

  it('doubles a single quote in the $filter fallback (OData escaping)', () => {
    const url = readable(buildMailFilterUrl("o'brien@x.com"))
    expect(url).toContain("from/emailAddress/address eq 'o''brien@x.com'")
    expect(url).toContain('$orderby=receivedDateTime desc')
  })
})

// ─── Scope reporting ──────────────────────────────────────────────────────────

describe('mailReadLevel / canSendMail', () => {
  it('reads a fully-qualified scope URI, which is how Microsoft returns them', () => {
    expect(mailReadLevel({ scopes: ['https://graph.microsoft.com/Mail.ReadWrite'] })).toBe('full')
    expect(canSendMail({ scopes: ['https://graph.microsoft.com/Mail.Send'] })).toBe(true)
  })

  it('accepts a bare scope name too', () => {
    expect(mailReadLevel({ scopes: ['Mail.Read'] })).toBe('full')
    expect(mailReadLevel({ scopes: ['mail.readbasic'] })).toBe('basic')
  })

  it('reports null when no mail-read scope was granted, so the UI can say "reconnect"', () => {
    expect(mailReadLevel({ scopes: ['User.Read', 'Calendars.Read', 'Contacts.Read'] })).toBeNull()
    expect(mailReadLevel({ scopes: [] })).toBeNull()
    expect(mailReadLevel(null)).toBeNull()
  })

  it('treats Mail.ReadWrite as send capability — it covers sendMail', () => {
    expect(canSendMail({ scopes: ['Mail.ReadWrite'] })).toBe(true)
    expect(canSendMail({ scopes: ['Mail.ReadBasic'] })).toBe(false)
  })
})

// ─── Normalization ────────────────────────────────────────────────────────────

describe('normalizeGraphMessage', () => {
  const inbound = {
    id: 'AAA', subject: 'Re: 12th St offer', bodyPreview: 'Sounds good  —\n Janet',
    from: { emailAddress: { name: 'Janet Hala', address: CONTACT_EMAIL } },
    toRecipients: [{ emailAddress: { name: 'Agent', address: MAILBOX } }],
    receivedDateTime: '2026-08-01T15:00:00Z', conversationId: 'C1',
    webLink: 'https://outlook.office.com/x', hasAttachments: true,
  }

  it('calls mail FROM the contact "inbound"', () => {
    const n = normalizeGraphMessage(inbound, MAILBOX)
    expect(n.direction).toBe('inbound')
    expect(n.fromAddress).toBe(CONTACT_EMAIL)
    expect(n.hasAttachments).toBe(true)
    expect(n.webLink).toBe('https://outlook.office.com/x')
  })

  it('calls mail FROM the connected mailbox "outbound", case-insensitively', () => {
    const n = normalizeGraphMessage({
      ...inbound,
      from: { emailAddress: { address: MAILBOX.toUpperCase() } },
      sentDateTime: '2026-08-02T09:00:00Z',
    }, MAILBOX)
    expect(n.direction).toBe('outbound')
    // Folder is unknowable in a mailbox-wide $search result, so direction must
    // come from the sender — this is the assertion that pins that.
    expect(n.sentAt).toBe('2026-08-02T09:00:00Z')
  })

  it('collapses whitespace in the snippet so the list stays one line per message', () => {
    expect(normalizeGraphMessage(inbound, MAILBOX).preview).toBe('Sounds good — Janet')
  })

  it('survives a message with no snippet (Mail.ReadBasic) without inventing one', () => {
    const { bodyPreview, ...noPreview } = inbound
    expect(normalizeGraphMessage(noPreview, MAILBOX).preview).toBeNull()
  })

  it('falls back to receivedDateTime when sentDateTime is absent', () => {
    expect(normalizeGraphMessage(inbound, MAILBOX).sentAt).toBe('2026-08-01T15:00:00Z')
  })
})

// ─── Throttling + fallback ────────────────────────────────────────────────────

describe('graphBackoffMs', () => {
  it('honors Retry-After in seconds', () => {
    expect(graphBackoffMs(0, 7)).toBe(7000)
  })
  it('caps a hostile Retry-After so a request cannot hang for minutes', () => {
    expect(graphBackoffMs(0, 600)).toBe(20000)
  })
  it('backs off exponentially when Graph gives no hint', () => {
    expect(graphBackoffMs(0, 0)).toBeGreaterThanOrEqual(500)
    expect(graphBackoffMs(2, 0)).toBeGreaterThanOrEqual(2000)
  })
})

describe('graphFetch', () => {
  let fetchMock
  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const ok   = (body) => ({ ok: true,  status: 200, headers: new Headers(), json: async () => body })
  const fail = (status, headers = {}) => ({
    ok: false, status, headers: new Headers(headers),
    json: async () => ({ error: { message: `boom ${status}` } }),
  })

  it('retries a 429 and returns the eventual success', async () => {
    fetchMock.mockResolvedValueOnce(fail(429, { 'retry-after': '1' }))
             .mockResolvedValueOnce(ok({ value: [{ id: 'A' }] }))
    const p = graphFetch('https://graph/x', { accessToken: 't' })
    await vi.runAllTimersAsync()
    await expect(p).resolves.toEqual({ value: [{ id: 'A' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after maxRetries and throws with the status intact', async () => {
    fetchMock.mockResolvedValue(fail(429))
    const p = graphFetch('https://graph/x', { accessToken: 't', maxRetries: 2 })
    const assertion = expect(p).rejects.toMatchObject({ status: 429 })
    await vi.runAllTimersAsync()
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(3)   // initial + 2 retries
  })

  it('does NOT retry a 401 — a dead token will not heal by waiting', async () => {
    fetchMock.mockResolvedValue(fail(401))
    await expect(graphFetch('https://graph/x', { accessToken: 't' }))
      .rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('fetchMailWithParticipant', () => {
  let fetchMock
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const ok = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body })
  const fail = (status) => ({
    ok: false, status, headers: new Headers(),
    json: async () => ({ error: { message: `graph says no (${status})` } }),
  })

  it('reports mode "search" on the happy path', async () => {
    fetchMock.mockResolvedValueOnce(ok({ value: [{ id: 'A' }], '@odata.nextLink': 'https://graph/next' }))
    const r = await fetchMailWithParticipant('t', { email: CONTACT_EMAIL })
    expect(r.mode).toBe('search')
    expect(r.nextLink).toBe('https://graph/next')
    expect(r.messages).toHaveLength(1)
  })

  it('falls back to a from-filter when the mailbox refuses $search, flagging it', async () => {
    fetchMock.mockResolvedValueOnce(fail(400))
             .mockResolvedValueOnce(ok({ value: [{ id: 'B' }] }))
    const r = await fetchMailWithParticipant('t', { email: CONTACT_EMAIL })
    expect(r.mode).toBe('filter')
    expect(readable(fetchMock.mock.calls[1][0])).toContain('from/emailAddress/address eq')
  })

  it('does NOT swallow a 403 into an empty list — that would read as "no correspondence"', async () => {
    fetchMock.mockResolvedValue(fail(403))
    await expect(fetchMailWithParticipant('t', { email: CONTACT_EMAIL }))
      .rejects.toMatchObject({ status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)   // no fallback attempt
  })

  it('follows a nextLink verbatim instead of rebuilding the query', async () => {
    fetchMock.mockResolvedValueOnce(ok({ value: [] }))
    const r = await fetchMailWithParticipant('t', { email: CONTACT_EMAIL, link: 'https://graph/page2?$skip=25' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://graph/page2?$skip=25')
    expect(r.mode).toBe('continued')
  })
})

// ─── Mirroring ────────────────────────────────────────────────────────────────

// Minimal chainable stand-in for the Supabase client: every filter method
// returns `this`, and awaiting the chain resolves whatever the test queued for
// that (table, verb) pair.
function fakeSvc(responses) {
  const calls = []
  const chain = (table, verb, payload) => {
    const state = { table, verb, payload, filters: {} }
    calls.push(state)
    const self = {
      select: (...a) => { state.select = a[0]; return self },
      eq:  (k, v) => { state.filters[k] = v; return self },
      neq: (k, v) => { state.filters[`neq:${k}`] = v; return self },
      is:  (k, v) => { state.filters[`is:${k}`] = v; return self },
      in:  (k, v) => { state.filters[`in:${k}`] = v; return self },
      order: () => self,
      limit: () => self,
      maybeSingle: () => self,
      single: () => self,
      then: (resolve, reject) => {
        const key = `${table}.${verb}`
        const queued = responses[key]
        const value = typeof queued === 'function' ? queued(state) : (queued ?? { data: [], error: null })
        return Promise.resolve(value).then(resolve, reject)
      },
    }
    return self
  }
  return {
    calls,
    from: (table) => ({
      select: (...a) => chain(table, 'select').select(...a),
      insert: (rows) => chain(table, 'insert', rows),
      update: (patch) => chain(table, 'update', patch),
      delete: () => chain(table, 'delete'),
    }),
  }
}

const gmsg = (over = {}) => ({
  graphMessageId: 'M1', subject: 'Offer on 12th St', preview: 'attached',
  direction: 'inbound', fromAddress: CONTACT_EMAIL, fromName: 'Janet Hala',
  to: [{ email: MAILBOX }], cc: [], sentAt: '2026-08-01T15:00:00Z',
  conversationId: 'C1', webLink: 'https://outlook/x', hasAttachments: false,
  isDraft: false, ...over,
})

describe('mirrorMessages', () => {
  it('inserts an unseen inbound message as status=received, source=graph', async () => {
    const svc = fakeSvc({ 'email_messages.select': { data: [], error: null }, 'email_messages.insert': { error: null } })
    const r = await mirrorMessages(svc, { agentId: AGENT_ID, contactId: CONTACT_ID, messages: [gmsg()] })
    expect(r).toEqual({ inserted: 1, adopted: 0 })
    const insert = svc.calls.find(c => c.verb === 'insert')
    expect(insert.payload[0]).toMatchObject({
      contact_id: CONTACT_ID, direction: 'inbound', status: 'received',
      source: 'graph', graph_message_id: 'M1', from_address: CONTACT_EMAIL,
    })
  })

  it('marks an observed outbound message status=sent, not received', async () => {
    const svc = fakeSvc({ 'email_messages.select': { data: [], error: null }, 'email_messages.insert': { error: null } })
    await mirrorMessages(svc, {
      agentId: AGENT_ID, contactId: CONTACT_ID,
      messages: [gmsg({ direction: 'outbound', fromAddress: MAILBOX })],
    })
    expect(svc.calls.find(c => c.verb === 'insert').payload[0].status).toBe('sent')
  })

  it('skips a message already mirrored — re-pulling a page is idempotent', async () => {
    const svc = fakeSvc({
      'email_messages.select': { data: [{ graph_message_id: 'M1' }], error: null },
      'email_messages.insert': { error: null },
    })
    const r = await mirrorMessages(svc, { agentId: AGENT_ID, contactId: CONTACT_ID, messages: [gmsg()] })
    expect(r).toEqual({ inserted: 0, adopted: 0 })
    expect(svc.calls.some(c => c.verb === 'insert')).toBe(false)
  })

  it('never mirrors a draft — it was never correspondence', async () => {
    const svc = fakeSvc({ 'email_messages.select': { data: [], error: null } })
    const r = await mirrorMessages(svc, {
      agentId: AGENT_ID, contactId: CONTACT_ID, messages: [gmsg({ isDraft: true })],
    })
    expect(r).toEqual({ inserted: 0, adopted: 0 })
  })

  it('ADOPTS the row the CRM wrote at send time instead of inserting a twin', async () => {
    // /me/sendMail returns 202 with no body, so the CRM's own row has no Graph
    // id. Its Sent Items copy must land on that row, not beside it.
    const svc = fakeSvc({
      'email_messages.select': (state) =>
        state.filters['in:graph_message_id']
          ? { data: [], error: null }
          : { data: [{ id: 'row-1', subject: 'Offer on 12th St', sent_at: '2026-08-02T09:03:00Z' }], error: null },
      'email_messages.update': { error: null },
      'email_messages.insert': { error: null },
    })
    const r = await mirrorMessages(svc, {
      agentId: AGENT_ID, contactId: CONTACT_ID,
      messages: [gmsg({
        direction: 'outbound', fromAddress: MAILBOX,
        sentAt: '2026-08-02T09:04:30Z',       // 90s off — same email, clocks differ
      })],
    })
    expect(r).toEqual({ inserted: 0, adopted: 1 })
    const update = svc.calls.find(c => c.verb === 'update')
    expect(update.payload).toMatchObject({ graph_message_id: 'M1', web_link: 'https://outlook/x' })
    expect(update.filters.id).toBe('row-1')
  })

  it('does NOT adopt a same-subject send from a different day', async () => {
    const svc = fakeSvc({
      'email_messages.select': (state) =>
        state.filters['in:graph_message_id']
          ? { data: [], error: null }
          : { data: [{ id: 'row-1', subject: 'Offer on 12th St', sent_at: '2026-07-01T09:00:00Z' }], error: null },
      'email_messages.insert': { error: null },
    })
    const r = await mirrorMessages(svc, {
      agentId: AGENT_ID, contactId: CONTACT_ID,
      messages: [gmsg({ direction: 'outbound', fromAddress: MAILBOX, sentAt: '2026-08-02T09:00:00Z' })],
    })
    expect(r).toEqual({ inserted: 1, adopted: 0 })
  })

  it('lets one losing insert fail without dropping the rest of the page', async () => {
    let n = 0
    const svc = fakeSvc({
      'email_messages.select': { data: [], error: null },
      'email_messages.insert': () => (++n === 1 ? { error: { message: 'duplicate key' } } : { error: null }),
    })
    const r = await mirrorMessages(svc, {
      agentId: AGENT_ID, contactId: CONTACT_ID,
      messages: [gmsg({ graphMessageId: 'M1' }), gmsg({ graphMessageId: 'M2' }), gmsg({ graphMessageId: 'M3' })],
    })
    expect(r.inserted).toBe(2)
  })
})

// ─── Cache freshness ──────────────────────────────────────────────────────────

describe('sync state', () => {
  it('treats a never-synced contact as stale', () => {
    expect(isStale(null)).toBe(true)
    expect(isStale({ last_synced_at: null })).toBe(true)
  })

  it('keeps a recent sync — reopening the tab must not re-hit Graph', () => {
    expect(isStale({ last_synced_at: new Date().toISOString() })).toBe(false)
  })

  it('goes stale past the TTL', () => {
    const old = new Date(Date.now() - MAIL_SYNC_TTL_MS - 1000).toISOString()
    expect(isStale({ last_synced_at: old })).toBe(true)
  })

  it('invalidates the cursor when the contact address changed under it', () => {
    expect(cursorMatchesEmail({ email: CONTACT_EMAIL }, CONTACT_EMAIL)).toBe(true)
    expect(cursorMatchesEmail({ email: CONTACT_EMAIL }, 'janet.hala@work.com')).toBe(false)
    // Case and padding are not a change of address.
    expect(cursorMatchesEmail({ email: ' JANET_HALA@YAHOO.COM ' }, CONTACT_EMAIL)).toBe(true)
  })
})
