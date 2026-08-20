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

const sendGraphMail = vi.fn(async () => {})
vi.mock('../_lib/msGraph.js', () => ({
  getValidAccessToken: async () => ({ accessToken: 'tok', connection: { email: 'agent@gatewayreadvisors.com', scopes: ['Mail.Send'] } }),
  sendGraphMail:       (...args) => sendGraphMail(...args),
  canSendMail:         () => true,
}))

const { createBlast, sendBlastBatch, blastProgress, MAX_RECIPIENTS, DAILY_SEND_LIMIT } =
  await import('../_lib/massEmail.js')

// ─── Minimal in-memory stand-in for the supabase-js query builder ────────────
// Only the operations this module actually performs; anything else would be
// scaffolding pretending to be coverage.
function makeDb(seed = {}) {
  const tables = {
    contacts: [], properties: [], agents: [],
    email_blasts: [], email_blast_recipients: [], email_messages: [], activities: [],
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
      in(col, vals) { state.filters.push(r => vals.includes(r[col])); return api },
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

const runBatch = (db, blast, contacts) => sendBlastBatch(db, {
  blast, agent: AGENT, property: PROPERTY,
  contactsById: Object.fromEntries(contacts.map(c => [c.id, c])),
})

beforeEach(() => { sendGraphMail.mockClear(); sendGraphMail.mockImplementation(async () => {}) })

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
