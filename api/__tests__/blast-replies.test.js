/**
 * Reply matching for mass email (api/_lib/inboxSync.js#markBlastReplies).
 *
 * WHY THIS IS ITS OWN MECHANISM. A blast can go to addresses that are
 * deliberately not contacts — pasted off a spreadsheet, with no contact record
 * created. The nightly inbox sync already imports mail from known contacts onto
 * their timeline, but for a list recipient there is no timeline: their row on
 * the send is the entire record. "Four people replied" is the most useful
 * number a send produces, and without this it would be unanswerable for most
 * of a 122-person send.
 *
 * WHAT THESE GUARD
 *   1. The first reply wins. replied_at answers "did this send get a
 *      response" — overwriting it on every later message turns it into "when
 *      did they last email me", which the contact timeline already answers.
 *   2. It never reaches back past the window. An email a year after a send is
 *      its own conversation, and matching it would silently re-open sends that
 *      finished long ago.
 *   3. A failure here never takes the contact-mail import down with it. That
 *      half of the sync is older and matters more.
 */
import { describe, it, expect } from 'vitest'

const { markBlastReplies } = await import('../_lib/inboxSync.js')

// Minimal stand-in for the supabase-js builder — only the operations this
// function performs. Anything more would be scaffolding pretending to be
// coverage.
function makeDb(seed = {}) {
  const tables = { email_blast_recipients: [], email_blasts: [], ...seed }

  function from(table) {
    const state = { filters: [], op: 'select', payload: null, count: false, head: false }
    const rowsOf = () => (tables[table] ||= [])
    const matched = () => rowsOf().filter(r => state.filters.every(f => f(r)))

    const api = {
      select(_c, opts = {}) { state.count = opts.count === 'exact'; state.head = Boolean(opts.head); return api },
      update(patch) { state.op = 'update'; state.payload = patch; return api },
      eq(col, val)  { state.filters.push(r => r[col] === val); return api },
      gte(col, val) { state.filters.push(r => r[col] != null && r[col] >= val); return api },
      is(col, val)  { state.filters.push(r => (val === null ? r[col] == null : r[col] === val)); return api },
      not(col, op, val) {
        if (op !== 'is' || val !== null) throw new Error('stub .not() only supports ("col","is",null)')
        state.filters.push(r => r[col] != null)
        return api
      },
      in(col, vals) {
        const lower = vals.map(v => (typeof v === 'string' ? v.toLowerCase() : v))
        state.filters.push(r => typeof r[col] === 'string' && lower.includes(r[col].toLowerCase()))
        return api
      },
      order() { return api },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject) },
    }

    function run() {
      if (state.op === 'update') {
        const hits = matched()
        for (const row of hits) Object.assign(row, state.payload)
        return { data: hits, error: null }
      }
      const hits = matched()
      if (state.count) return { data: null, count: hits.length, error: null }
      return { data: hits, error: null }
    }
    return api
  }
  return { from, tables }
}

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString()

const recipient = (over) => ({
  id: over.id, blast_id: over.blast_id || 'blast-1', email: over.email,
  status: 'sent', sent_at: daysAgo(1), replied_at: null, reply_subject: null, ...over,
})

const message = (from, over = {}) => ({
  id: `m-${from}`, from: { emailAddress: { address: from } },
  subject: 'Re: Just Closed', receivedDateTime: new Date().toISOString(), ...over,
})

describe('markBlastReplies', () => {
  it('marks a list recipient who wrote back, though they are not a contact', () => {
    const db = makeDb({
      email_blast_recipients: [recipient({ id: 'r1', email: 'abigail@brownwinick.com', source: 'list', contact_id: null })],
      email_blasts: [{ id: 'blast-1', replied_count: 0 }],
    })
    return markBlastReplies(db, [message('abigail@brownwinick.com')]).then(n => {
      expect(n).toBe(1)
      expect(db.tables.email_blast_recipients[0].replied_at).toBeTruthy()
      expect(db.tables.email_blast_recipients[0].reply_subject).toBe('Re: Just Closed')
      expect(db.tables.email_blasts[0].replied_count).toBe(1)
    })
  })

  it('matches regardless of the case the sender address arrives in', async () => {
    const db = makeDb({
      email_blast_recipients: [recipient({ id: 'r1', email: 'pat@example.com' })],
      email_blasts: [{ id: 'blast-1', replied_count: 0 }],
    })
    expect(await markBlastReplies(db, [message('PAT@Example.COM')])).toBe(1)
  })

  it('keeps the FIRST reply when somebody writes twice', async () => {
    const db = makeDb({
      email_blast_recipients: [recipient({ id: 'r1', email: 'pat@example.com' })],
      email_blasts: [{ id: 'blast-1', replied_count: 0 }],
    })
    const first  = message('pat@example.com', { id: 'm1', subject: 'First',  receivedDateTime: daysAgo(1) })
    const second = message('pat@example.com', { id: 'm2', subject: 'Second', receivedDateTime: new Date().toISOString() })
    expect(await markBlastReplies(db, [first, second])).toBe(1)
    expect(db.tables.email_blast_recipients[0].reply_subject).toBe('First')

    // A later sync must not overwrite it either.
    expect(await markBlastReplies(db, [second])).toBe(0)
    expect(db.tables.email_blast_recipients[0].reply_subject).toBe('First')
  })

  it('ignores mail from somebody who was never on a send', async () => {
    const db = makeDb({
      email_blast_recipients: [recipient({ id: 'r1', email: 'pat@example.com' })],
      email_blasts: [{ id: 'blast-1', replied_count: 0 }],
    })
    expect(await markBlastReplies(db, [message('stranger@example.com')])).toBe(0)
    expect(db.tables.email_blast_recipients[0].replied_at).toBeNull()
  })

  it('ignores a recipient whose message never actually went out', async () => {
    const db = makeDb({
      email_blast_recipients: [recipient({ id: 'r1', email: 'pat@example.com', status: 'skipped' })],
      email_blasts: [{ id: 'blast-1', replied_count: 0 }],
    })
    expect(await markBlastReplies(db, [message('pat@example.com')])).toBe(0)
  })

  it('does not reach back past the reply window', async () => {
    // Ordinary correspondence months after a send is not a response to it.
    const db = makeDb({
      email_blast_recipients: [recipient({ id: 'r1', email: 'pat@example.com', sent_at: daysAgo(200) })],
      email_blasts: [{ id: 'blast-1', replied_count: 0 }],
    })
    expect(await markBlastReplies(db, [message('pat@example.com')])).toBe(0)
  })

  it('counts replies per blast by recounting, so a re-run cannot inflate it', async () => {
    const db = makeDb({
      email_blast_recipients: [
        recipient({ id: 'r1', email: 'a@x.com' }),
        recipient({ id: 'r2', email: 'b@x.com' }),
        recipient({ id: 'r3', email: 'c@x.com' }),
      ],
      email_blasts: [{ id: 'blast-1', replied_count: 0 }],
    })
    await markBlastReplies(db, [message('a@x.com'), message('b@x.com')])
    expect(db.tables.email_blasts[0].replied_count).toBe(2)
    await markBlastReplies(db, [message('a@x.com'), message('b@x.com')])
    expect(db.tables.email_blasts[0].replied_count).toBe(2)
  })

  it('returns zero rather than throwing when the columns are not migrated yet', async () => {
    // A deployment that has not run 0048 must keep syncing contact mail.
    const broken = {
      from: () => {
        const api = {
          select: () => api, in: () => api, eq: () => api, is: () => api, gte: () => api, order: () => api,
          then: (r) => Promise.resolve({ data: null, error: { message: 'column does not exist' } }).then(r),
        }
        return api
      },
    }
    expect(await markBlastReplies(broken, [message('pat@example.com')])).toBe(0)
  })

  it('does nothing with an empty or senderless batch', async () => {
    const db = makeDb()
    expect(await markBlastReplies(db, [])).toBe(0)
    expect(await markBlastReplies(db, [{ id: 'm1', subject: 'no from field' }])).toBe(0)
  })
})
