/**
 * ?action=om_request — the Offering Memorandum download gate.
 *
 * The trade this endpoint exists to enforce: a visitor who wants the OM gives
 * up a name, a phone number and an email, and gets a signed URL that expires.
 * Three properties are load-bearing and each has a test below.
 *
 *   1. THE FILE COMES FROM THE CAMPAIGN, NEVER FROM THE REQUEST. This action is
 *      unauthenticated. If it signed whatever path a caller passed, it would be
 *      an anonymous reader for the whole private `campaign-oms` bucket — every
 *      OM of every campaign, one curl away.
 *
 *   2. ALL THREE FIELDS ARE REQUIRED. capture_lead accepts any one of name /
 *      email / phone, which is right for a "call me" form and wrong here: the
 *      OM is the most valuable thing on the page and a first name is not a
 *      trade. A missing or junk field must not yield a URL.
 *
 *   3. THE LEAD SURVIVES A BROKEN AUDIT TABLE. mailing_om_requests arrives with
 *      migration 0045; on a database that hasn't applied it, the visitor still
 *      gets their download and the agent still gets their lead.
 *
 * Plus the landing-page side: `?action=landing` must not hand the OM's storage
 * path to an anonymous browser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.SCAN_SIGNING_SECRET = 'test-secret-for-scan-signing'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'

const MAILING_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
const LEAD_ID    = 'cccccccc-0000-0000-0000-000000000003'
const OM_PATH    = '1720000000000-abc123/Riverside-OM.pdf'

const MAILING = {
  id:   MAILING_ID,
  name: 'Riverside Apartments',
  landing_config: {
    headline: '24 Units in Riverside',
    om: { path: OM_PATH, filename: 'Riverside-OM.pdf', title: 'Riverside · OM', size: 4_200_000 },
  },
}

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

// What the handler did, per table, so the writes can be asserted rather than assumed.
let inserts, upserts, updates, signCalls
let mailingRow          // what the `mailings` lookup returns
let signImpl            // storage.createSignedUrl
let failTable           // a table whose writes blow up (pre-migration simulation)
let rejectFirstContact  // simulate contacts.source's pre-0045 CHECK rejecting the insert

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async () => ({ data: [], error: null }),
    storage: {
      from: (bucket) => ({
        createSignedUrl: (path, ttl, opts) => {
          signCalls.push({ bucket, path, ttl, opts })
          return Promise.resolve(signImpl())
        },
      }),
    },
    from: (table) => {
      const boom = () => { if (failTable === table) throw new Error(`relation "${table}" does not exist`) }
      const chain = {
        select: () => chain,
        insert: (rows) => { boom(); inserts.push({ table, rows }); return chain },
        upsert: (row, opts) => { boom(); upserts.push({ table, row, opts }); return chain },
        update: (patch) => { boom(); updates.push({ table, patch }); return chain },
        delete: () => chain,
        eq: () => chain, in: () => chain, limit: () => chain, order: () => chain,
        single:     () => Promise.resolve(rowFor(table)),
        maybeSingle: () => Promise.resolve(rowFor(table)),
        then: (resolve) => resolve({ data: [], error: null, count: 1 }),
      }
      return chain
    },
  }),
}))

function rowFor(table) {
  if (table === 'mailings')      return mailingRow()
  if (table === 'mailing_leads') return { data: { id: LEAD_ID }, error: null }
  if (table === 'contacts') {
    const attempt = inserts.filter(i => i.table === 'contacts').length
    if (rejectFirstContact && attempt === 1) {
      return { data: null, error: { code: '23514', message: 'violates check constraint "contacts_source_check"' } }
    }
    return { data: { id: 'dddddddd-0000-0000-0000-000000000004' }, error: null }
  }
  return { data: null, error: null }
}

let handler
beforeEach(async () => {
  vi.resetModules()
  inserts = []; upserts = []; updates = []; signCalls = []
  mailingRow = () => ({ data: MAILING, error: null })
  signImpl   = () => ({ data: { signedUrl: 'https://storage.test/signed?token=xyz' }, error: null })
  failTable  = null
  rejectFirstContact = false
  handler = (await import('../campaigns.js')).default
})

const post = (body = {}) => ({
  method: 'POST',
  headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' },
  query: {},
  body: { action: 'om_request', mailing_id: MAILING_ID, ...body },
  socket: { remoteAddress: '1.2.3.4' },
})

const GOOD = { name: 'Jane Investor', phone: '(515) 555-0134', email: 'jane@fund.com' }

describe('?action=om_request — trading contact details for the OM', () => {
  it('signs the OM and returns the URL when all three fields are given', async () => {
    const res = mockRes()
    await handler(post(GOOD), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.url).toBe('https://storage.test/signed?token=xyz')
    expect(res.body.filename).toBe('Riverside-OM.pdf')
    expect(res.body.lead_id).toBe(LEAD_ID)
  })

  it('signs the path from the campaign config, not one supplied by the caller', async () => {
    const res = mockRes()
    await handler(post({ ...GOOD, om_path: 'someone-elses-deal/secret-OM.pdf' }), res)

    expect(res.statusCode).toBe(200)
    expect(signCalls).toHaveLength(1)
    expect(signCalls[0].bucket).toBe('campaign-oms')
    expect(signCalls[0].path).toBe(OM_PATH)
  })

  it('gives the signed URL a short life so a forwarded link is worthless', async () => {
    await handler(post(GOOD), mockRes())
    expect(signCalls[0].ttl).toBeGreaterThan(0)
    expect(signCalls[0].ttl).toBeLessThanOrEqual(60 * 60)
  })

  it('never lets an edge cache hold the response carrying the URL', async () => {
    const res = mockRes()
    await handler(post(GOOD), res)
    expect(res.headers['cache-control']).toMatch(/no-store/)
  })

  it('records the lead, flags it as an OM download, and logs the unlock', async () => {
    await handler(post(GOOD), mockRes())

    const lead = inserts.find(i => i.table === 'mailing_leads')
    expect(lead).toBeTruthy()
    expect(lead.rows[0].email).toBe('jane@fund.com')
    expect(lead.rows[0].phone).toBe('(515) 555-0134')
    expect(updates.some(u => u.table === 'mailing_leads' && u.patch.om_requested === true)).toBe(true)

    const om = upserts.find(u => u.table === 'mailing_om_requests')
    expect(om.row.om_path).toBe(OM_PATH)
    expect(om.row.email).toBe('jane@fund.com')
    // Clicking download twice is one person, not two rows.
    expect(om.opts.onConflict).toBe('mailing_id,email')
  })

  it('attributes the unlock to the scan that produced it', async () => {
    await handler(post({ ...GOOD, visit_id: 'visit-abc-123' }), mockRes())
    const om = upserts.find(u => u.table === 'mailing_om_requests')
    expect(om.row.visit_id).toBe('visit-abc-123')
  })

  it('lower-cases the email so the dedupe index actually dedupes', async () => {
    await handler(post({ ...GOOD, email: 'Jane@Fund.COM' }), mockRes())
    const om = upserts.find(u => u.table === 'mailing_om_requests')
    expect(om.row.email).toBe('jane@fund.com')
  })

  it.each([
    ['no email',       { name: 'Jane Investor', phone: '5155550134' }],
    ['a junk email',   { ...GOOD, email: 'jane@' }],
    ['no phone',       { name: 'Jane Investor', email: 'jane@fund.com' }],
    ['a phone with no area code', { ...GOOD, phone: '555-0134' }],
    ['no name',        { phone: '5155550134', email: 'jane@fund.com' }],
  ])('refuses to hand over the OM for %s', async (_label, body) => {
    const res = mockRes()
    await handler(post(body), res)

    expect(res.statusCode).toBe(400)
    expect(res.body.url).toBeUndefined()
    expect(signCalls).toHaveLength(0)
  })

  it('404s when the campaign has no OM attached', async () => {
    mailingRow = () => ({ data: { ...MAILING, landing_config: { headline: 'No OM here' } }, error: null })
    const res = mockRes()
    await handler(post(GOOD), res)

    expect(res.statusCode).toBe(404)
    expect(signCalls).toHaveLength(0)
  })

  it('404s on an unknown mailing rather than signing anything', async () => {
    mailingRow = () => ({ data: null, error: null })
    const res = mockRes()
    await handler(post(GOOD), res)
    expect(res.statusCode).toBe(404)
  })

  it('does not capture a lead when the file cannot be signed', async () => {
    signImpl = () => ({ data: null, error: { message: 'storage unavailable' } })
    const res = mockRes()
    await handler(post(GOOD), res)

    expect(res.statusCode).toBe(502)
    // They still have the form in front of them; a phantom "download" row would
    // be a lie in the agent's OM list.
    expect(inserts.some(i => i.table === 'mailing_leads')).toBe(false)
  })

  it('still delivers the download and the lead on a pre-0045 database', async () => {
    failTable = 'mailing_om_requests'   // the audit table does not exist yet
    const res = mockRes()
    await handler(post(GOOD), res)

    expect(res.statusCode).toBe(200)
    expect(res.body.url).toBe('https://storage.test/signed?token=xyz')
    expect(inserts.some(i => i.table === 'mailing_leads')).toBe(true)
  })

  it('files the contact under om-download so the CRM says where they came from', async () => {
    await handler(post(GOOD), mockRes())
    const contact = inserts.find(i => i.table === 'contacts')
    expect(contact.rows[0].source).toBe('om-download')
    expect(contact.rows[0].email).toBe('jane@fund.com')
  })

  it('still creates the contact when the source value is not yet a legal one', async () => {
    // Pre-0045, contacts.source's CHECK rejected 'om-download' and the insert
    // failed inside a best-effort try/catch — a lead with nobody in the CRM
    // behind it. The retry files them under a value that has always been valid.
    rejectFirstContact = true
    const res = mockRes()
    await handler(post(GOOD), res)

    expect(res.statusCode).toBe(200)
    const attempts = inserts.filter(i => i.table === 'contacts')
    expect(attempts).toHaveLength(2)
    expect(attempts[1].rows[0].source).toBe('website')
    expect(updates.some(u => u.table === 'mailing_leads' && u.patch.contact_id)).toBe(true)
  })

  it('requires a mailing_id', async () => {
    const res = mockRes()
    await handler({ ...post(GOOD), body: { action: 'om_request', ...GOOD } }, res)
    expect(res.statusCode).toBe(400)
  })
})

describe('?action=landing — the OM path stays server-side', () => {
  const landingReq = () => ({
    method: 'GET', headers: {},
    query: { action: 'landing', id: MAILING_ID },
    socket: { remoteAddress: '1.2.3.4' },
  })

  it('tells the page an OM exists without handing over its storage path', async () => {
    const res = mockRes()
    await handler(landingReq(), res)

    const om = res.body.mailing.landing_config.om
    expect(om.available).toBe(true)
    expect(om.filename).toBe('Riverside-OM.pdf')
    expect(om.path).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain(OM_PATH)
  })

  it('leaves a campaign with no OM exactly as it was', async () => {
    mailingRow = () => ({ data: { ...MAILING, landing_config: { headline: 'Plain' } }, error: null })
    const res = mockRes()
    await handler(landingReq(), res)
    expect(res.body.mailing.landing_config).toEqual({ headline: 'Plain' })
  })
})
