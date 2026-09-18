/**
 * The opt-out link and the open pixel, exercised through the REAL handler.
 *
 * The token module is unit-tested next door; this is the other half — that
 * clicking the link actually writes the rows that stop the next email. The two
 * can be individually correct and still not add up, which is exactly what
 * happened here once already: the suppression upsert named `email` as its
 * conflict target while the unique index was on `lower(email)`, and Postgres
 * cannot infer a conflict target from a column name when the index is on an
 * expression. Every click would have 500'd. Nothing in the token tests, the
 * send tests or the build would have caught it.
 *
 * WHAT THESE GUARD
 *   1. A click suppresses the ADDRESS, whether or not a contact owns it. A
 *      recipient mailed off a pasted list has no contact record, and "we had
 *      nowhere to record that they asked us to stop" is not an acceptable
 *      answer.
 *   2. A second click is a quiet success. People double-click, forward the mail
 *      to themselves, and open the link from a preview pane. An error page
 *      there reads as "it didn't work" and the next message gets reported as
 *      spam instead.
 *   3. The pixel always returns an image. A broken image in a marketing email
 *      is a visible defect the recipient blames the sender for, and a response
 *      that varied with whether the token resolved would let anyone probe which
 *      tokens are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.UNSUBSCRIBE_SIGNING_SECRET = 'test-signing-secret'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'

// ─── A table-aware stand-in for the service-role client ──────────────────────
// Enough of the builder for these two actions, including the one operation the
// production bug lived in: upsert with an onConflict column.
let tables

function makeClient() {
  const from = (table) => {
    const state = { op: 'select', filters: [], payload: null, conflict: null }
    const rowsOf = () => (tables[table] ||= [])
    const matched = () => rowsOf().filter(r => state.filters.every(f => f(r)))

    const chain = {
      select(_cols, opts = {}) { state.count = opts.count === 'exact'; state.head = Boolean(opts.head); return chain },
      insert(rows) { state.op = 'insert'; state.payload = rows; return chain },
      update(patch) { state.op = 'update'; state.payload = patch; return chain },
      upsert(rows, opts = {}) {
        state.op = 'upsert'; state.payload = rows; state.conflict = opts.onConflict || null
        return chain
      },
      eq(col, val) { state.filters.push(r => r[col] === val); return chain },
      not(col, op, val) {
        if (op !== 'is' || val !== null) throw new Error('stub .not() only supports ("col","is",null)')
        state.filters.push(r => r[col] != null)
        return chain
      },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject) },
      single() { state.single = true; return chain },
      maybeSingle() { state.maybe = true; return chain },
    }

    function run() {
      const rows = rowsOf()
      if (state.op === 'insert') {
        const incoming = (Array.isArray(state.payload) ? state.payload : [state.payload])
          .map(r => ({ id: `${table}-${rows.length + 1}`, ...r }))
        rows.push(...incoming)
        return { data: incoming, error: null }
      }
      if (state.op === 'upsert') {
        // The real constraint, modelled: ON CONFLICT needs a unique index on
        // the named column, and email_suppressions has a CHECK that the address
        // is stored lower-cased. Both are asserted here so a schema change that
        // breaks either shows up as a failing test rather than a 500 in
        // somebody's browser.
        if (!state.conflict) throw new Error('upsert without onConflict would duplicate')
        const key = state.conflict
        for (const r of (Array.isArray(state.payload) ? state.payload : [state.payload])) {
          if (key === 'email' && r.email !== String(r.email).toLowerCase()) {
            return { data: null, error: { message: 'violates check constraint "email_suppressions_lower_check"' } }
          }
          const existing = rows.find(x => x[key] === r[key])
          if (existing) Object.assign(existing, r)
          else rows.push({ id: `${table}-${rows.length + 1}`, ...r })
        }
        return { data: null, error: null }
      }
      if (state.op === 'update') {
        const hits = matched()
        for (const row of hits) Object.assign(row, state.payload)
        if (state.single || state.maybe) return { data: hits[0] || null, error: null }
        return { data: hits, error: null }
      }
      // Reads return COPIES, like the real client: a handler that mutates a row
      // and then re-reads its own stale object must not accidentally pass here.
      const hits = matched().map(r => ({ ...r }))
      if (state.count) return { data: state.head ? null : hits, count: hits.length, error: null }
      if (state.single || state.maybe) return { data: hits[0] || null, error: null }
      return { data: hits, error: null }
    }
    return chain
  }
  return { from, rpc: async () => ({ data: null, error: null }) }
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeClient() }))

function mockRes() {
  return {
    headers: {}, statusCode: null, body: undefined, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this },
    status(c) { this.statusCode = c; return this },
    send(b) { this.body = b; this.ended = true; return this },
    json(b) { this.body = b; this.ended = true; return this },
    end() { this.ended = true; return this },
  }
}

const CONTACT_ID   = '9f1c0c62-7d7e-4c31-9a3f-1f8d9f2b4c55'
const RECIPIENT_ID = '2b7e6c11-9c3a-4f5d-8a1b-6d0e2f3a4b5c'
const BLAST_ID     = '3c8f7d22-ad4b-4061-9b2c-7e1f3a4b5c6d'
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'

let handler, mint, mintOpen

beforeEach(async () => {
  vi.resetModules()
  tables = {
    contacts: [], email_suppressions: [], email_blast_recipients: [], email_blasts: [], activities: [],
  }
  handler = (await import('../campaigns.js')).default
  const tok = await import('../_lib/unsubscribeToken.js')
  mint     = tok.mintRecipientUnsubscribeToken
  mintOpen = tok.mintOpenToken
})

const unsub = async (token) => {
  const res = mockRes()
  await handler({ method: 'POST', headers: {}, body: { action: 'unsubscribe', token }, socket: {} }, res)
  return res
}

const openPixel = async (token, ua = BROWSER, headers = {}) => {
  const res = mockRes()
  await handler({
    method: 'GET', headers: { 'user-agent': ua, ...headers },
    query: { action: 'open', token }, socket: {},
  }, res)
  return res
}

// ─── Clicking the link ───────────────────────────────────────────────────────

describe('unsubscribe — a recipient with no contact record', () => {
  beforeEach(() => {
    tables.email_blast_recipients.push({
      id: RECIPIENT_ID, blast_id: BLAST_ID, contact_id: null,
      email: 'abigail.hillers@brownwinick.com', source: 'list', status: 'sent', unsubscribed_at: null,
    })
    tables.email_blasts.push({ id: BLAST_ID, unsubscribed_count: 0 })
  })

  it('suppresses the address and confirms it to them', async () => {
    const res = await unsub(mint({
      email: 'abigail.hillers@brownwinick.com', recipientId: RECIPIENT_ID,
    }))
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ ok: true, scope: 'address', email: 'abigail.hillers@brownwinick.com' })
    expect(tables.email_suppressions).toHaveLength(1)
    expect(tables.email_suppressions[0]).toMatchObject({
      email: 'abigail.hillers@brownwinick.com', reason: 'unsubscribed',
      blast_id: BLAST_ID, recipient_id: RECIPIENT_ID, contact_id: null,
    })
  })

  it('stamps the recipient row, so the send report can say who left', async () => {
    await unsub(mint({ email: 'abigail.hillers@brownwinick.com', recipientId: RECIPIENT_ID }))
    expect(tables.email_blast_recipients[0].unsubscribed_at).toBeTruthy()
  })

  it('invents no contact record on the way out', async () => {
    await unsub(mint({ email: 'abigail.hillers@brownwinick.com', recipientId: RECIPIENT_ID }))
    expect(tables.contacts).toHaveLength(0)
    expect(tables.activities).toHaveLength(0)
  })

  it('treats a second click as a quiet success, not an error page', async () => {
    const token = mint({ email: 'abigail.hillers@brownwinick.com', recipientId: RECIPIENT_ID })
    await unsub(token)
    const again = await unsub(token)
    expect(again.statusCode).toBe(200)
    expect(again.body.ok).toBe(true)
    expect(tables.email_suppressions).toHaveLength(1)   // still one row
  })

  it('stores the address lower-cased however the link capitalised it', async () => {
    const res = await unsub(mint({ email: 'Abigail.Hillers@BrownWinick.com', recipientId: RECIPIENT_ID }))
    expect(res.statusCode).toBe(200)
    expect(tables.email_suppressions[0].email).toBe('abigail.hillers@brownwinick.com')
  })
})

describe('unsubscribe — a recipient who IS a contact', () => {
  beforeEach(() => {
    tables.contacts.push({
      id: CONTACT_ID, email: 'pat@example.com', assigned_agent_id: 'agent-1', email_opt_out: false,
    })
    tables.email_blast_recipients.push({
      id: RECIPIENT_ID, blast_id: BLAST_ID, contact_id: CONTACT_ID,
      email: 'pat@example.com', source: 'contact', status: 'sent', unsubscribed_at: null,
    })
  })

  it('sets the contact flag AND the address suppression', async () => {
    // Both, deliberately: every screen in the CRM reads email_opt_out, and the
    // suppression is what survives the contact being duplicated or re-imported.
    const res = await unsub(mint({ email: 'pat@example.com', contactId: CONTACT_ID, recipientId: RECIPIENT_ID }))
    expect(res.body).toMatchObject({ ok: true, scope: 'contact', email: 'pat@example.com' })
    expect(tables.contacts[0].email_opt_out).toBe(true)
    expect(tables.email_suppressions[0]).toMatchObject({ email: 'pat@example.com', contact_id: CONTACT_ID })
  })

  it('records it on their timeline, so the agent hears it from the CRM', async () => {
    await unsub(mint({ email: 'pat@example.com', contactId: CONTACT_ID, recipientId: RECIPIENT_ID }))
    expect(tables.activities).toHaveLength(1)
    expect(tables.activities[0]).toMatchObject({ contact_id: CONTACT_ID, type: 'note' })
    expect(tables.activities[0].body).toMatch(/unsubscribed/i)
  })

  it('still honours a v1 link, looking the address up from the contact', async () => {
    // Links minted before v2 existed are sitting in inboxes and cannot be
    // re-issued. They have to keep working, and they have to suppress the
    // address too — not just set the old flag.
    const { mintUnsubscribeToken } = await import('../_lib/unsubscribeToken.js')
    const res = await unsub(mintUnsubscribeToken(CONTACT_ID))
    expect(res.statusCode).toBe(200)
    expect(tables.contacts[0].email_opt_out).toBe(true)
    expect(tables.email_suppressions[0].email).toBe('pat@example.com')
  })

  it('is spent rather than broken when the contact was deleted since', async () => {
    tables.contacts.length = 0
    const res = await unsub(mint({ email: 'pat@example.com', contactId: CONTACT_ID, recipientId: RECIPIENT_ID }))
    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(true)
    // The address is suppressed anyway — that is the part that protects them.
    expect(tables.email_suppressions[0].email).toBe('pat@example.com')
  })
})

describe('unsubscribe — links we did not issue', () => {
  it('refuses a forged or edited token without touching anything', async () => {
    const token = mint({ email: 'victim@example.com' })
    const [body, sig] = token.split('.')
    const forged = `${body}.${'x'.repeat(sig.length)}`
    const res = await unsub(forged)
    expect(res.statusCode).toBe(404)
    expect(tables.email_suppressions).toHaveLength(0)
  })

  it('asks for a token when none arrived', async () => {
    const res = await unsub('')
    expect(res.statusCode).toBe(400)
  })
})

// ─── The pixel ───────────────────────────────────────────────────────────────

describe('open pixel', () => {
  beforeEach(() => {
    tables.email_blast_recipients.push({
      id: RECIPIENT_ID, blast_id: BLAST_ID, email: 'pat@example.com',
      status: 'sent', open_count: 0, first_opened_at: null, last_opened_at: null,
    })
    tables.email_blasts.push({ id: BLAST_ID, opened_count: 0 })
  })

  it('records the open and answers with a GIF', async () => {
    const res = await openPixel(`${mintOpen(RECIPIENT_ID)}.gif`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/gif')
    expect(Buffer.isBuffer(res.body)).toBe(true)
    const row = tables.email_blast_recipients[0]
    expect(row.first_opened_at).toBeTruthy()
    expect(row.open_count).toBe(1)
  })

  it('keeps the first open time and counts the later ones', async () => {
    const token = `${mintOpen(RECIPIENT_ID)}.gif`
    await openPixel(token)
    const first = tables.email_blast_recipients[0].first_opened_at
    await openPixel(token)
    const row = tables.email_blast_recipients[0]
    expect(row.first_opened_at).toBe(first)
    expect(row.open_count).toBe(2)
  })

  it('counts a person once on the blast, not once per re-read', async () => {
    const token = `${mintOpen(RECIPIENT_ID)}.gif`
    await openPixel(token)
    await openPixel(token)
    expect(tables.email_blasts[0].opened_count).toBe(1)
  })

  it('does not count a scanner or prefetcher as a reader', async () => {
    await openPixel(`${mintOpen(RECIPIENT_ID)}.gif`, 'Mimecast-Link-Scanner/1.0 bot')
    expect(tables.email_blast_recipients[0].open_count).toBe(0)
    await openPixel(`${mintOpen(RECIPIENT_ID)}.gif`, BROWSER, { 'sec-purpose': 'prefetch' })
    expect(tables.email_blast_recipients[0].open_count).toBe(0)
  })

  it('still returns an image for a forged or missing token', async () => {
    // Never a broken image, and never a response that reveals which tokens are
    // real.
    for (const t of ['nonsense.gif', '', `${mintOpen(RECIPIENT_ID).split('.')[0]}.badsig.gif`]) {
      const res = await openPixel(t)
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toBe('image/gif')
    }
    expect(tables.email_blast_recipients[0].open_count).toBe(0)
  })

  it('never caches, so a proxy cannot swallow every later open', async () => {
    const res = await openPixel(`${mintOpen(RECIPIENT_ID)}.gif`)
    expect(res.headers['cache-control']).toMatch(/no-store/)
  })

  it('cannot be used to opt somebody out', async () => {
    await openPixel(`${mintOpen(RECIPIENT_ID)}.gif`)
    expect(tables.email_suppressions).toHaveLength(0)
  })
})
