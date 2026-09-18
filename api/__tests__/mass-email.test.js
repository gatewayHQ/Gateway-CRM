/**
 * Mass email / deal announcements — the send engine (api/_lib/massEmail.js).
 *
 * WHAT THESE GUARD
 *
 * 1. NOBODY IS MAILED TWICE. This is the property that matters most: a blast is
 *    N un-retryable Graph calls driven by a client loop over a serverless
 *    function that can be killed mid-batch. The recipient row is the cursor, so
 *    re-running a batch — the normal case, not the exception — must send zero
 *    additional messages once the rows say 'sent'.
 *
 * 2. NOBODY SEES THE LIST. Each recipient gets their own message. A refactor to
 *    one call with many recipients would leak the agent's whole segmented
 *    contact list to every person on it, so the per-message recipient count is
 *    pinned at one.
 *
 * 3. A PARTIAL SEND TELLS THE TRUTH. One address failing must not fail the
 *    batch, must not stop the rest, and must be visible afterwards with its
 *    error. "Sent" for a send where 7 of 247 bounced is a lie an agent would
 *    act on.
 *
 * 4. THE SUPPRESSIONS ACTUALLY SUPPRESS. Opt-out, missing address and duplicate
 *    addresses are decided against the CURRENT contact rows at send time, not
 *    against the browser's snapshot — and each exclusion is recorded with its
 *    reason rather than silently shrinking the count.
 *
 * 5. THE MAILBOX'S LIMITS WIN. Exceeding Microsoft's daily send allowance gets
 *    the agent's whole mailbox throttled, not just the blast, so the cap is
 *    enforced before sending and leaves the remaining recipients resumable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Pacing is what makes a real send take minutes; tests assert ordering and
// bookkeeping, not wall-clock, so the interval is zeroed before the module
// reads it at import time.
process.env.MASS_EMAIL_INTERVAL_MS = '0'

// Unsubscribe links are signed server-side; without a secret the module refuses
// to send at all (which is itself asserted below). Set before the import so the
// real minting path runs rather than a stub.
process.env.UNSUBSCRIBE_SIGNING_SECRET = 'test-signing-secret'

const sendGraphMail = vi.fn(async () => {})
vi.mock('../_lib/msGraph.js', () => ({
  getValidAccessToken: async () => ({ accessToken: 'tok', connection: { email: 'agent@gatewayreadvisors.com', scopes: ['Mail.Send'] } }),
  sendGraphMail:       (...args) => sendGraphMail(...args),
  canSendMail:         () => true,
}))

const { createBlast, sendBlastBatch, blastProgress, splitListName, MAX_RECIPIENTS, DAILY_SEND_LIMIT } =
  await import('../_lib/massEmail.js')
const { COMPANY } = await import('../../src/lib/emailFooter.js')

// ─── Minimal in-memory stand-in for the supabase-js query builder ────────────
// Only the operations this module actually performs; anything else would be
// scaffolding pretending to be coverage.
function makeDb(seed = {}) {
  const tables = {
    contacts: [], properties: [], agents: [],
    email_blasts: [], email_blast_recipients: [], email_messages: [], activities: [],
    email_suppressions: [],
    ...seed,
  }
  let seq = 0
  const nextId = (t) => `${t}-${String(++seq).padStart(3, '0')}`

  function from(table) {
    const state = { op: 'select', filters: [], payload: null, count: false, head: false, limit: null, single: false, maybe: false }
    const rowsOf = () => (tables[table] ||= [])
    const matched = () => rowsOf().filter(r => state.filters.every(f => f(r)))

    const api = {
      select(_cols, opts = {}) { state.count = opts.count === 'exact'; state.head = Boolean(opts.head); return api },
      insert(rows)  { state.op = 'insert'; state.payload = rows; return api },
      update(patch) { state.op = 'update'; state.payload = patch; return api },
      eq(col, val)  { state.filters.push(r => r[col] === val); return api },
      neq(col, val) { state.filters.push(r => r[col] !== val); return api },
      gte(col, val) { state.filters.push(r => r[col] != null && r[col] >= val); return api },
      in(col, vals) {
        // Case-insensitive for the address columns, matching the lower(email)
        // unique index the real suppression lookup hits.
        const lower = vals.map(v => (typeof v === 'string' ? v.toLowerCase() : v))
        state.filters.push(r => vals.includes(r[col]) ||
          (typeof r[col] === 'string' && lower.includes(r[col].toLowerCase())))
        return api
      },
      not(col, op, val) {
        if (op !== 'is' || val !== null) throw new Error(`stub .not() only supports ("${col}", "is", null)`)
        state.filters.push(r => r[col] != null)
        return api
      },
      order() { return api },
      limit(n) { state.limit = n; return api },
      single()      { state.single = true; return api },
      maybeSingle() { state.maybe  = true; return api },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject) },
    }

    function run() {
      const t = rowsOf()
      if (state.op === 'insert') {
        const incoming = (Array.isArray(state.payload) ? state.payload : [state.payload])
          .map(r => ({ id: nextId(table), created_at: new Date().toISOString(), ...r }))
        t.push(...incoming)
        return { data: state.single ? incoming[0] : incoming, error: null }
      }
      if (state.op === 'update') {
        const hits = matched()
        for (const row of hits) Object.assign(row, state.payload)
        if (state.single || state.maybe) return { data: hits[0] || null, error: null }
        return { data: hits, error: null }
      }
      let hits = matched()
      if (state.count) return { data: state.head ? null : hits, count: hits.length, error: null }
      if (state.limit != null) hits = hits.slice(0, state.limit)
      if (state.single) return { data: hits[0] || null, error: null }
      if (state.maybe)  return { data: hits[0] || null, error: null }
      return { data: hits, error: null }
    }
    return api
  }
  return { from, tables }
}

const AGENT = { id: 'agent-1', name: 'Daniel Stillson' }
const PROPERTY = {
  id: 'prop-1', address: '1200 Grand Ave', city: 'Des Moines', state: 'IA',
  type: 'multifamily', list_price: 4_250_000, details: { total_units: 24, photos: ['https://cdn/one.jpg'] },
}
const BLAST_INPUT = {
  propertyId: 'prop-1', dealStatus: 'closed',
  subject: 'Just Closed — {{propertyAddress}}',
  body: 'Hi {{firstName}}, we closed {{propertyAddress}}.\n\n{{customMessage}}',
  customMessage: 'Third this quarter.', terms: 'All cash',
  audience: { assetTypes: ['multifamily'], sides: ['buyer', 'seller'] },
}

const contact = (over) => ({
  id: over.id, first_name: over.first_name || 'Pat', last_name: 'Ryan',
  email: `${over.id}@example.com`, email_opt_out: false, status: 'active', ...over,
})

async function seedBlast(db, contacts) {
  const contactIds = contacts.map(c => c.id)
  db.tables.contacts.push(...contacts)
  return createBlast(db, db, { agentId: AGENT.id, blast: BLAST_INPUT, contactIds })
}

const BASE_URL = 'https://crm.example.com'

const runBatch = (db, blast, contacts, over = {}) => sendBlastBatch(db, {
  blast, agent: AGENT, property: PROPERTY, baseUrl: BASE_URL,
  contactsById: Object.fromEntries(contacts.map(c => [c.id, c])),
  ...over,
})

beforeEach(() => { sendGraphMail.mockClear(); sendGraphMail.mockImplementation(async () => {}) })

// ─── The footer every message has to carry ───────────────────────────────────

describe('unsubscribe links', () => {
  it('gives each recipient their own working opt-out link', async () => {
    const contacts = [
      { id: 'c1', first_name: 'A', email: 'a@x.com' },
      { id: 'c2', first_name: 'B', email: 'b@x.com' },
    ]
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedBlast(db, contacts)
    await runBatch(db, blast, contacts)

    const links = sendGraphMail.mock.calls.map(([, msg]) => msg.html.match(/https:\/\/crm\.example\.com\/u\/[A-Za-z0-9._-]+/)[0])
    expect(links).toHaveLength(2)
    // One person's opt-out must never take anybody else with them.
    expect(new Set(links).size).toBe(2)
  })

  it('puts the postal address in every message', async () => {
    const contacts = [{ id: 'c1', first_name: 'A', email: 'a@x.com' }]
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedBlast(db, contacts)
    await runBatch(db, blast, contacts)
    expect(sendGraphMail.mock.calls[0][1].html).toContain(COMPANY.address)
  })

  it('sends nothing at all when it cannot build the links', async () => {
    // Half a blast delivered without an opt-out is not a degraded send, it is
    // the exact outcome this feature exists to prevent — so it fails closed.
    const contacts = [{ id: 'c1', first_name: 'A', email: 'a@x.com' }]
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedBlast(db, contacts)
    await expect(runBatch(db, blast, contacts, { baseUrl: '' })).rejects.toThrow(/unsubscribe/i)
    expect(sendGraphMail).not.toHaveBeenCalled()
    expect(db.tables.email_blast_recipients.every(r => r.status === 'pending')).toBe(true)
  })
})

// ─── Building the send ────────────────────────────────────────────────────────

describe('createBlast', () => {
  it('queues one pending recipient per mailable contact', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1' }), contact({ id: 'c2' })]
    const blast = await seedBlast(db, contacts)

    expect(blast.recipient_count).toBe(2)
    expect(blast.status).toBe('draft')
    expect(db.tables.email_blast_recipients.every(r => r.status === 'pending')).toBe(true)
  })

  it('skips an opted-out contact and records why', async () => {
    const db = makeDb()
    const blast = await seedBlast(db, [contact({ id: 'c1' }), contact({ id: 'c2', email_opt_out: true })])

    expect(blast.recipient_count).toBe(1)
    expect(blast.skipped_count).toBe(1)
    const skipped = db.tables.email_blast_recipients.find(r => r.status === 'skipped')
    expect(skipped.skip_reason).toBe('Opted out of email')
  })

  it('skips a contact with no address, and one with an unusable address', async () => {
    const db = makeDb()
    const blast = await seedBlast(db, [
      contact({ id: 'c1' }),
      contact({ id: 'c2', email: null }),
      contact({ id: 'c3', email: 'not-an-address' }),
    ])
    expect(blast.recipient_count).toBe(1)
    const reasons = db.tables.email_blast_recipients.filter(r => r.status === 'skipped').map(r => r.skip_reason)
    expect(reasons).toEqual(expect.arrayContaining(['No email on file', 'Invalid email address']))
  })

  it('mails a shared household address once', async () => {
    const db = makeDb()
    const blast = await seedBlast(db, [
      contact({ id: 'c1', email: 'household@example.com' }),
      contact({ id: 'c2', email: 'HOUSEHOLD@example.com' }),
    ])
    expect(blast.recipient_count).toBe(1)
    expect(db.tables.email_blast_recipients.find(r => r.status === 'skipped').skip_reason)
      .toBe('Duplicate address in this send')
  })

  it('refuses an empty recipient list rather than creating a send that mails nobody', async () => {
    const db = makeDb()
    await expect(createBlast(db, db, { agentId: AGENT.id, blast: BLAST_INPUT, contactIds: [] }))
      .rejects.toThrow(/No recipients/)
  })

  it('refuses a list past the per-send ceiling', async () => {
    const db = makeDb()
    const ids = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `c${i}`)
    await expect(createBlast(db, db, { agentId: AGENT.id, blast: BLAST_INPUT, contactIds: ids }))
      .rejects.toThrow(new RegExp(`per-send limit is ${MAX_RECIPIENTS}`))
  })
})

// ─── Sending ──────────────────────────────────────────────────────────────────

describe('sendBlastBatch', () => {
  it('sends each recipient their own message — the list never leaks', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1' }), contact({ id: 'c2' }), contact({ id: 'c3' })]
    const blast = await seedBlast(db, contacts)

    const progress = await runBatch(db, blast, contacts)

    expect(sendGraphMail).toHaveBeenCalledTimes(3)
    for (const [, message] of sendGraphMail.mock.calls) {
      expect(message.to).toHaveLength(1)
      expect(message.cc).toBeUndefined()
    }
    const addressed = sendGraphMail.mock.calls.map(([, m]) => m.to[0]).sort()
    expect(addressed).toEqual(['c1@example.com', 'c2@example.com', 'c3@example.com'])
    expect(progress).toMatchObject({ sent: 3, failed: 0, remaining: 0, done: true, status: 'sent' })
  })

  it('personalises the subject and body per recipient', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1', first_name: 'Pat' }), contact({ id: 'c2', first_name: 'Sam' })]
    const blast = await seedBlast(db, contacts)
    await runBatch(db, blast, contacts)

    const bodies = sendGraphMail.mock.calls.map(([, m]) => m.html)
    expect(bodies.some(h => h.includes('Hi Pat,'))).toBe(true)
    expect(bodies.some(h => h.includes('Hi Sam,'))).toBe(true)
    // Property facts resolve from the record, not from the token literal.
    expect(bodies[0]).toContain('1200 Grand Ave')
    expect(bodies[0]).not.toContain('{{propertyAddress}}')
    expect(sendGraphMail.mock.calls[0][1].subject).toBe('Just Closed — 1200 Grand Ave, Des Moines, IA')
  })

  it('re-running a finished send mails nobody a second time', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1' }), contact({ id: 'c2' })]
    const blast = await seedBlast(db, contacts)

    await runBatch(db, blast, contacts)
    expect(sendGraphMail).toHaveBeenCalledTimes(2)

    const again = await runBatch(db, blast, contacts)
    expect(sendGraphMail).toHaveBeenCalledTimes(2)          // unchanged
    expect(again).toMatchObject({ sent: 2, remaining: 0, done: true })
  })

  it('resumes a send that was interrupted, without repeating the delivered half', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1' }), contact({ id: 'c2' }), contact({ id: 'c3' })]
    const blast = await seedBlast(db, contacts)

    // Simulate a batch that got through one recipient before the function died.
    const first = db.tables.email_blast_recipients.find(r => r.contact_id === 'c1')
    first.status = 'sent'
    first.sent_at = new Date().toISOString()

    const progress = await runBatch(db, blast, contacts)
    const mailed = sendGraphMail.mock.calls.map(([, m]) => m.to[0])
    expect(mailed).not.toContain('c1@example.com')
    expect(mailed).toHaveLength(2)
    expect(progress).toMatchObject({ sent: 3, done: true })
  })

  it('keeps going past a failed address and records its error', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1' }), contact({ id: 'c2' }), contact({ id: 'c3' })]
    const blast = await seedBlast(db, contacts)

    sendGraphMail.mockImplementation(async (_tok, message) => {
      if (message.to[0] === 'c2@example.com') throw new Error('Mailbox unavailable')
    })

    const progress = await runBatch(db, blast, contacts)
    expect(progress).toMatchObject({ sent: 2, failed: 1, done: true })
    // A partial send still reads as sent — failed_count carries the rest of the
    // story, and the failed row keeps the reason.
    expect(progress.status).toBe('sent')
    const failed = db.tables.email_blast_recipients.find(r => r.status === 'failed')
    expect(failed.contact_id).toBe('c2')
    expect(failed.error_message).toBe('Mailbox unavailable')
    expect(failed.sent_at).toBeNull()
  })

  it('marks a send where every message failed as failed, not sent', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1' }), contact({ id: 'c2' })]
    const blast = await seedBlast(db, contacts)
    sendGraphMail.mockImplementation(async () => { throw new Error('Token revoked') })

    const progress = await runBatch(db, blast, contacts)
    expect(progress).toMatchObject({ sent: 0, failed: 2, status: 'failed', done: true })
  })

  it('logs each delivery to the contact timeline and the email log', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1' })]
    const blast = await seedBlast(db, contacts)
    await runBatch(db, blast, contacts)

    const activity = db.tables.activities.find(a => a.contact_id === 'c1')
    expect(activity).toMatchObject({ type: 'email', agent_id: AGENT.id })
    expect(activity.body).toContain('Just Closed')
    expect(activity.body).toContain('1200 Grand Ave')

    const message = db.tables.email_messages.find(m => m.contact_id === 'c1')
    expect(message).toMatchObject({ status: 'sent', blast_id: blast.id, source: 'crm' })
    expect(message.activity_id).toBe(activity.id)
    // The recipient row points at the logged message, so the audit trail joins
    // up in both directions.
    expect(db.tables.email_blast_recipients[0].email_message_id).toBe(message.id)
  })

  it('does not log a timeline entry for a message that failed to send', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1' })]
    const blast = await seedBlast(db, contacts)
    sendGraphMail.mockImplementation(async () => { throw new Error('nope') })

    await runBatch(db, blast, contacts)
    expect(db.tables.activities).toHaveLength(0)
    expect(db.tables.email_messages).toHaveLength(0)
  })

  it('stops before the mailbox daily allowance and leaves the rest resumable', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1' })]
    const blast = await seedBlast(db, contacts)

    // The agent has already used their day — through this CRM, whatever sent it.
    const now = new Date().toISOString()
    for (let i = 0; i < DAILY_SEND_LIMIT; i++) {
      db.tables.email_messages.push({ id: `m${i}`, agent_id: AGENT.id, status: 'sent', sent_at: now })
    }

    await expect(runBatch(db, blast, contacts)).rejects.toThrow(/Daily send limit/)
    expect(sendGraphMail).not.toHaveBeenCalled()
    // Still pending — tomorrow's run picks them up, nobody is mailed twice.
    expect(db.tables.email_blast_recipients.every(r => r.status === 'pending')).toBe(true)
  })

  it('reports progress for a blast with nothing left to do', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1', email_opt_out: true })]
    const blast = await seedBlast(db, contacts)

    const progress = await runBatch(db, blast, contacts)
    expect(sendGraphMail).not.toHaveBeenCalled()
    expect(progress).toMatchObject({ sent: 0, skipped: 1, remaining: 0, done: true })
  })
})

describe('blastProgress', () => {
  it('counts what was sent, what failed, what was skipped and what remains', async () => {
    const db = makeDb()
    const contacts = [contact({ id: 'c1' }), contact({ id: 'c2' }), contact({ id: 'c3', email_opt_out: true })]
    const blast = await seedBlast(db, contacts)
    await runBatch(db, blast, contacts)

    expect(await blastProgress(db, blast.id)).toMatchObject({
      total: 2, sent: 2, failed: 0, skipped: 1, remaining: 0, done: true,
    })
  })
})

// ─── Recipients who are not contacts ─────────────────────────────────────────
// The feature this section guards: an agent pastes 122 addresses off a county
// roll, none of which are in the CRM, and all 122 get mailed WITHOUT 122 junk
// contact records being created. Everything that used to hang off the contact
// record — the opt-out above all — has to work for them anyway.

const listRow = (email, name = '') => ({ email, name })

const seedMixedBlast = (db, { contacts = [], listRecipients = [], listSource = 'owners.csv' } = {}) => {
  db.tables.contacts.push(...contacts)
  return createBlast(db, db, {
    agentId: AGENT.id,
    blast: { ...BLAST_INPUT, listSource },
    contactIds: contacts.map(c => c.id),
    listRecipients,
  })
}

describe('pasted-list recipients', () => {
  it('mails an address with no contact record at all', async () => {
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedMixedBlast(db, {
      listRecipients: [listRow('abigail.hillers@brownwinick.com', 'Abigail M. Hillers')],
    })
    expect(blast.recipient_count).toBe(1)
    expect(blast.list_recipient_count).toBe(1)

    await runBatch(db, blast, [])
    expect(sendGraphMail).toHaveBeenCalledTimes(1)
    expect(sendGraphMail.mock.calls[0][1].to).toEqual(['abigail.hillers@brownwinick.com'])
  })

  it('creates NO contacts — the row on the send is the whole record', async () => {
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedMixedBlast(db, {
      listRecipients: [listRow('a@x.com', 'A One'), listRow('b@x.com', 'B Two')],
    })
    await runBatch(db, blast, [])
    expect(db.tables.contacts).toHaveLength(0)
    expect(db.tables.email_blast_recipients.every(r => r.contact_id === null)).toBe(true)
    expect(db.tables.email_blast_recipients.every(r => r.source === 'list')).toBe(true)
  })

  it('still gives every one of them a working unsubscribe link', async () => {
    // The defect this closes: the link used to be minted only when the row had
    // a contact_id, so a list recipient received a bulk email with no way out.
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedMixedBlast(db, {
      listRecipients: [listRow('a@x.com'), listRow('b@x.com')],
    })
    await runBatch(db, blast, [])

    const links = sendGraphMail.mock.calls.map(([, m]) =>
      m.html.match(/https:\/\/crm\.example\.com\/u\/[A-Za-z0-9._-]+/)?.[0])
    expect(links.filter(Boolean)).toHaveLength(2)
    expect(new Set(links).size).toBe(2)
    expect(sendGraphMail.mock.calls.every(([, m]) => m.html.includes('Unsubscribe'))).toBe(true)
  })

  it('personalises from the name snapshotted on the row, and greets a nameless one gracefully', async () => {
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedMixedBlast(db, {
      listRecipients: [listRow('a@x.com', 'Abigail M. Hillers'), listRow('b@x.com')],
    })
    await runBatch(db, blast, [])
    const bodies = sendGraphMail.mock.calls.map(([, m]) => m.html)
    expect(bodies.some(h => h.includes('Hi Abigail M.,'))).toBe(true)
    expect(bodies.some(h => h.includes('Hi there,'))).toBe(true)
  })

  it('writes no contact history for them, and does not crash trying', async () => {
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedMixedBlast(db, { listRecipients: [listRow('a@x.com')] })
    await runBatch(db, blast, [])
    expect(db.tables.activities).toHaveLength(0)
    expect(db.tables.email_messages).toHaveLength(0)
    // …but the send itself is recorded as delivered.
    expect(db.tables.email_blast_recipients[0].status).toBe('sent')
  })

  it('sends to contacts and list addresses in one blast, counting both', async () => {
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedMixedBlast(db, {
      contacts: [contact({ id: 'c1', email: 'c1@x.com' })],
      listRecipients: [listRow('list@x.com')],
    })
    expect(blast.recipient_count).toBe(2)
    expect(blast.list_recipient_count).toBe(1)
    await runBatch(db, blast, [contact({ id: 'c1', email: 'c1@x.com' })])
    expect(sendGraphMail).toHaveBeenCalledTimes(2)
  })

  it('keeps the contact when the same address is in the book AND the file', async () => {
    // The contact row wins, so the send lands on that person's timeline rather
    // than becoming an anonymous list delivery — and they get ONE email.
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedMixedBlast(db, {
      contacts: [contact({ id: 'c1', email: 'dup@x.com' })],
      listRecipients: [listRow('DUP@x.com', 'Dup Person')],
    })
    await runBatch(db, blast, [contact({ id: 'c1', email: 'dup@x.com' })])
    expect(sendGraphMail).toHaveBeenCalledTimes(1)
    const kept = db.tables.email_blast_recipients.filter(r => r.status === 'pending' || r.status === 'sent')
    expect(kept).toHaveLength(1)
    expect(kept[0].source).toBe('contact')
    const skipped = db.tables.email_blast_recipients.find(r => r.status === 'skipped')
    expect(skipped.skip_reason).toMatch(/duplicate/i)
  })

  it('drops an unusable address with a reason rather than attempting it', async () => {
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedMixedBlast(db, {
      listRecipients: [listRow('not-an-email'), listRow('good@x.com')],
    })
    expect(blast.recipient_count).toBe(1)
    await runBatch(db, blast, [])
    expect(sendGraphMail).toHaveBeenCalledTimes(1)
    expect(db.tables.email_blast_recipients.find(r => r.status === 'skipped').skip_reason)
      .toMatch(/invalid/i)
  })

  it('counts contacts and list rows together against the per-send cap', async () => {
    const db = makeDb({ agents: [AGENT] })
    const listRecipients = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => listRow(`p${i}@x.com`))
    await expect(seedMixedBlast(db, { listRecipients }))
      .rejects.toThrow(new RegExp(`per-send limit is ${MAX_RECIPIENTS}`))
  })

  it('refuses a send with no recipients of either kind', async () => {
    const db = makeDb({ agents: [AGENT] })
    await expect(seedMixedBlast(db, {})).rejects.toThrow(/no recipients/i)
  })
})

// ─── The suppression list ────────────────────────────────────────────────────

describe('address-level opt-out', () => {
  it('never mails a suppressed address, contact or not', async () => {
    const db = makeDb({
      agents: [AGENT],
      email_suppressions: [
        { id: 's1', email: 'gone@x.com',      reason: 'unsubscribed' },
        { id: 's2', email: 'also-gone@x.com', reason: 'unsubscribed' },
      ],
    })
    const blast = await seedMixedBlast(db, {
      contacts: [contact({ id: 'c1', email: 'gone@x.com' })],
      listRecipients: [listRow('also-gone@x.com'), listRow('fine@x.com')],
    })
    expect(blast.recipient_count).toBe(1)

    await runBatch(db, blast, [contact({ id: 'c1', email: 'gone@x.com' })])
    expect(sendGraphMail).toHaveBeenCalledTimes(1)
    expect(sendGraphMail.mock.calls[0][1].to).toEqual(['fine@x.com'])

    // Named, not silently dropped: an agent who selected 3 and sees 1 sent has
    // to be able to find out what happened to the other two.
    const reasons = db.tables.email_blast_recipients
      .filter(r => r.status === 'skipped').map(r => r.skip_reason)
    expect(reasons).toEqual(['Unsubscribed', 'Unsubscribed'])
  })

  it('matches a suppression regardless of how the address was capitalised', async () => {
    const db = makeDb({
      agents: [AGENT],
      email_suppressions: [{ id: 's1', email: 'gone@x.com', reason: 'unsubscribed' }],
    })
    const blast = await seedMixedBlast(db, { listRecipients: [listRow('GONE@X.com')] })
    expect(blast.recipient_count).toBe(0)
  })

  it('sends nothing at all if the opt-out list cannot be read', async () => {
    // Everywhere else a failed bookkeeping query degrades to a permissive
    // default. Here the permissive default is mailing people who opted out.
    const db = makeDb({ agents: [AGENT] })
    const realFrom = db.from
    const guarded = {
      from: (table) => {
        if (table === 'email_suppressions') {
          const boom = { error: { message: 'connection reset' }, data: null }
          const api = { select: () => api, in: () => api, then: (r) => Promise.resolve(boom).then(r) }
          return api
        }
        return realFrom(table)
      },
      tables: db.tables,
    }
    await expect(createBlast(guarded, guarded, {
      agentId: AGENT.id, blast: BLAST_INPUT, listRecipients: [listRow('a@x.com')],
    })).rejects.toThrow(/unsubscribe list/i)
  })
})

// ─── Open tracking ───────────────────────────────────────────────────────────

describe('open tracking pixel', () => {
  it('embeds a per-recipient pixel, so an open is attributable to one person', async () => {
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedMixedBlast(db, {
      listRecipients: [listRow('a@x.com'), listRow('b@x.com')],
    })
    await runBatch(db, blast, [])
    const pixels = sendGraphMail.mock.calls.map(([, m]) =>
      m.html.match(/https:\/\/crm\.example\.com\/e\/[A-Za-z0-9._-]+\.gif/)?.[0])
    expect(pixels.filter(Boolean)).toHaveLength(2)
    expect(new Set(pixels).size).toBe(2)
  })

  it('renders the pixel as a 1×1 that no client will draw as a broken image', async () => {
    const db = makeDb({ agents: [AGENT] })
    const blast = await seedMixedBlast(db, { listRecipients: [listRow('a@x.com')] })
    await runBatch(db, blast, [])
    const html = sendGraphMail.mock.calls[0][1].html
    expect(html).toMatch(/width="1" height="1" alt="" aria-hidden="true"/)
  })
})

describe('splitListName', () => {
  // A pasted file gives one name cell, and the row needs two columns. Getting
  // this wrong shows up in the greeting of every message in the send.
  it('keeps a middle initial with the first name rather than losing it', () => {
    expect(splitListName('Abigail M. Hillers')).toEqual({ first_name: 'Abigail M.', last_name: 'Hillers' })
  })

  it('handles a plain two-part name', () => {
    expect(splitListName('Tony Reed')).toEqual({ first_name: 'Tony', last_name: 'Reed' })
  })

  it('treats a single word as the first name, so the greeting still reads', () => {
    expect(splitListName('Susan')).toEqual({ first_name: 'Susan', last_name: null })
  })

  it('returns nothing for an empty cell instead of empty strings', () => {
    expect(splitListName('')).toEqual({ first_name: null, last_name: null })
    expect(splitListName('   ')).toEqual({ first_name: null, last_name: null })
    expect(splitListName(undefined)).toEqual({ first_name: null, last_name: null })
  })

  it('collapses the ragged whitespace a spreadsheet paste brings with it', () => {
    expect(splitListName('  Tony   Joseph   Reed ')).toEqual({ first_name: 'Tony Joseph', last_name: 'Reed' })
  })
})
