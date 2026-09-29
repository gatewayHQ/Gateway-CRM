/**
 * Bounce tracking for mass email (api/_lib/bounces.js).
 *
 * "Failed" on a send only ever meant Microsoft refused the message. When the
 * RECEIVING server rejects it, the notice comes back to the agent's inbox and
 * the report used to go on saying "sent". These guard the read-back:
 *
 *   1. Only real bounce notices count — a delay warning ("still trying") is not
 *      a bounce, and neither is an ordinary email that quotes an address.
 *   2. Only recipients of THIS agent's recent sends are touched.
 *   3. A permanent bounce suppresses the address; a full mailbox does not.
 *   4. Re-running the sync never double-counts.
 */
import { describe, it, expect, vi } from 'vitest'

const { markBlastBounces, isBounceNotice, addressesIn, classifyBounce } = await import('../_lib/bounces.js')

function makeDb(seed = {}) {
  const tables = { email_blasts: [], email_blast_recipients: [], email_suppressions: [], activities: [], ...seed }

  function from(table) {
    const state = { filters: [], op: 'select', payload: null, count: false, opts: {} }
    const rowsOf = () => (tables[table] ||= [])
    const matched = () => rowsOf().filter(r => state.filters.every(f => f(r)))
    const api = {
      select(_c, opts = {}) { state.count = opts.count === 'exact'; return api },
      update(p) { state.op = 'update'; state.payload = p; return api },
      insert(rows) { state.op = 'insert'; state.payload = rows; return api },
      upsert(rows, opts = {}) { state.op = 'upsert'; state.payload = rows; state.opts = opts; return api },
      eq(c, v)  { state.filters.push(r => r[c] === v); return api },
      gte(c, v) { state.filters.push(r => r[c] != null && r[c] >= v); return api },
      is(c, v)  { state.filters.push(r => (v === null ? r[c] == null : r[c] === v)); return api },
      not(c)    { state.filters.push(r => r[c] != null); return api },
      in(c, vals) { state.filters.push(r => vals.includes(r[c])); return api },
      order() { return api },
      then(resolve, reject) { return Promise.resolve().then(run).then(resolve, reject) },
    }
    function run() {
      if (state.op === 'insert') { rowsOf().push(...state.payload); return { data: state.payload, error: null } }
      if (state.op === 'upsert') {
        for (const row of state.payload) {
          const existing = rowsOf().find(r => r.email === row.email)
          if (!existing) rowsOf().push(row)
          else if (!state.opts.ignoreDuplicates) Object.assign(existing, row)
        }
        return { data: null, error: null }
      }
      if (state.op === 'update') {
        const hits = matched(); for (const r of hits) Object.assign(r, state.payload)
        return { data: hits, error: null }
      }
      const hits = matched()
      return state.count ? { data: null, count: hits.length, error: null } : { data: hits, error: null }
    }
    return api
  }
  return { from, tables }
}

const hoursAgo = (n) => new Date(Date.now() - n * 3_600_000).toISOString()
const AGENT = 'agent-1'

const seed = () => makeDb({
  email_blasts: [
    { id: 'blast-1', agent_id: AGENT, created_at: hoursAgo(5), bounced_count: 0 },
    { id: 'blast-other', agent_id: 'agent-2', created_at: hoursAgo(5), bounced_count: 0 },
  ],
  email_blast_recipients: [
    { id: 'r1', blast_id: 'blast-1', email: 'gone@example.com', contact_id: 'c1', status: 'sent', sent_at: hoursAgo(4), bounced_at: null },
    { id: 'r2', blast_id: 'blast-1', email: 'full@example.com', contact_id: null, status: 'sent', sent_at: hoursAgo(4), bounced_at: null },
    { id: 'r3', blast_id: 'blast-1', email: 'fine@example.com', contact_id: 'c3', status: 'sent', sent_at: hoursAgo(4), bounced_at: null },
    { id: 'r9', blast_id: 'blast-other', email: 'gone@example.com', contact_id: null, status: 'sent', sent_at: hoursAgo(4), bounced_at: null },
  ],
})

const exchangeNdr = (to, preview, over = {}) => ({
  id: `ndr-${to}`,
  from: { emailAddress: { name: 'Microsoft Outlook', address: 'MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@gatewayreadvisors.com' } },
  subject: 'Undeliverable: Just Closed — 1200 Grand Ave',
  bodyPreview: preview ?? `Your message to ${to} couldn't be delivered. ${to.split('@')[0]} wasn't found at example.com.`,
  receivedDateTime: hoursAgo(3),
  ...over,
})

describe('recognising a bounce notice', () => {
  it('knows Exchange, Gmail and generic mailer-daemon notices', () => {
    expect(isBounceNotice(exchangeNdr('gone@example.com'))).toBe(true)
    expect(isBounceNotice({ from: { emailAddress: { address: 'mailer-daemon@googlemail.com' } }, subject: 'Delivery Status Notification (Failure)' })).toBe(true)
    expect(isBounceNotice({ from: { emailAddress: { address: 'postmaster@example.com' } }, subject: 'Returned mail: see transcript' })).toBe(true)
  })

  it('ignores delay warnings and ordinary mail', () => {
    expect(isBounceNotice({ from: { emailAddress: { address: 'postmaster@example.com' } }, subject: 'Delivery Status Notification (Delay)' })).toBe(false)
    expect(isBounceNotice({ from: { emailAddress: { address: 'MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@x.com' } }, subject: 'Delayed: Just Closed' })).toBe(false)
    expect(isBounceNotice({ from: { emailAddress: { address: 'pat@example.com' } }, subject: 'Re: Just Closed' })).toBe(false)
  })

  it('pulls addresses out of the text, but never the postmaster itself', () => {
    expect(addressesIn('Your message to Gone@Example.com couldn\'t be delivered — postmaster@example.com'))
      .toEqual(['gone@example.com'])
  })

  it('tells a dead address from a full mailbox', () => {
    expect(classifyBounce("gone wasn't found at example.com")).toEqual({ reason: 'Address does not exist', permanent: true })
    expect(classifyBounce('550 5.1.1 User unknown')).toEqual({ reason: 'Address does not exist', permanent: true })
    expect(classifyBounce("The recipient's mailbox is full")).toEqual({ reason: 'Mailbox full', permanent: false })
    expect(classifyBounce('something odd happened')).toEqual({ reason: 'Could not be delivered', permanent: false })
  })
})

describe('markBlastBounces', () => {
  it('stamps the bounced recipient, counts it on the blast, and suppresses a dead address', async () => {
    const db = seed()
    const marked = await markBlastBounces(db, { agentId: AGENT, messages: [exchangeNdr('gone@example.com')] })

    expect(marked).toBe(1)
    const r1 = db.tables.email_blast_recipients.find(r => r.id === 'r1')
    expect(r1).toMatchObject({ bounce_reason: 'Address does not exist', bounce_permanent: true })
    expect(r1.bounced_at).toBeTruthy()
    expect(db.tables.email_blasts.find(b => b.id === 'blast-1').bounced_count).toBe(1)
    expect(db.tables.email_suppressions).toEqual([expect.objectContaining({ email: 'gone@example.com', reason: 'bounced' })])
    expect(db.tables.activities[0].body).toContain('bounced')
  })

  it("never touches another agent's send to the same address", async () => {
    const db = seed()
    await markBlastBounces(db, { agentId: AGENT, messages: [exchangeNdr('gone@example.com')] })
    expect(db.tables.email_blast_recipients.find(r => r.id === 'r9').bounced_at).toBeNull()
  })

  it('records a full mailbox without suppressing the address', async () => {
    const db = seed()
    await markBlastBounces(db, { agentId: AGENT, messages: [
      exchangeNdr('full@example.com', "Your message to full@example.com couldn't be delivered. The recipient's mailbox is full."),
    ] })
    expect(db.tables.email_blast_recipients.find(r => r.id === 'r2')).toMatchObject({ bounce_reason: 'Mailbox full', bounce_permanent: false })
    expect(db.tables.email_suppressions).toHaveLength(0)
  })

  it('reads the full notice only when the preview names no address', async () => {
    const db = seed()
    const fetchText = vi.fn(async () => 'Delivery has failed to these recipients: gone@example.com\n550 5.1.1 User unknown')
    const marked = await markBlastBounces(db, {
      agentId: AGENT, fetchText,
      messages: [exchangeNdr('gone@example.com', 'Delivery has failed to these recipients or groups:')],
    })
    expect(fetchText).toHaveBeenCalledTimes(1)
    expect(marked).toBe(1)
  })

  it('does nothing for an address nobody mass-mailed, or an ordinary email', async () => {
    const db = seed()
    const marked = await markBlastBounces(db, { agentId: AGENT, messages: [
      exchangeNdr('stranger@example.com'),
      { id: 'x', from: { emailAddress: { address: 'fine@example.com' } }, subject: 'Re: Just Closed', bodyPreview: 'Thanks! fine@example.com' },
    ] })
    expect(marked).toBe(0)
    expect(db.tables.email_blast_recipients.every(r => r.bounced_at == null)).toBe(true)
  })

  it('ignores a notice older than the send it would be about', async () => {
    const db = seed()
    const marked = await markBlastBounces(db, { agentId: AGENT, messages: [exchangeNdr('gone@example.com', undefined, { receivedDateTime: hoursAgo(10) })] })
    expect(marked).toBe(0)
  })

  it('is idempotent across re-runs of the sync', async () => {
    const db = seed()
    const msgs = [exchangeNdr('gone@example.com')]
    await markBlastBounces(db, { agentId: AGENT, messages: msgs })
    const again = await markBlastBounces(db, { agentId: AGENT, messages: msgs })
    expect(again).toBe(0)
    expect(db.tables.email_blasts.find(b => b.id === 'blast-1').bounced_count).toBe(1)
    expect(db.tables.activities).toHaveLength(1)
  })

  it('keeps an existing unsubscribe as the reason rather than overwriting it', async () => {
    const db = seed()
    db.tables.email_suppressions.push({ email: 'gone@example.com', reason: 'unsubscribed' })
    await markBlastBounces(db, { agentId: AGENT, messages: [exchangeNdr('gone@example.com')] })
    expect(db.tables.email_suppressions).toEqual([{ email: 'gone@example.com', reason: 'unsubscribed' }])
  })
})
