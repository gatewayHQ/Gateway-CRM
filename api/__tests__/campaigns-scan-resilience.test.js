/**
 * A printed QR code must reach its landing page even when tracking is broken.
 *
 * THE BUG THESE GUARD
 * record_mailing_scan() resolves the token AND writes the scan AND bumps the
 * counter in one atomic round trip. Correct for the count — but it fused the
 * redirect to the write. Only ONE failure mode had a fallback ("the function
 * isn't there"); every other failure inside that RPC left the handler with no
 * destination, so the scanner got the "Opening your page…" retry page and sat
 * there. Scans recorded nothing and nobody reached the landing page.
 *
 * That failure is unrecoverable in the field: the codes are already printed on
 * mailed postcards and flyers. So the rule these tests encode is:
 *
 *   The ONLY thing that may produce the retry page is a database that cannot be
 *   reached at all. Anything else redirects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.SCAN_SIGNING_SECRET = 'test-secret-for-scan-signing'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'

const TOKEN      = 'NLBK8k6W'
const MAILING_ID = 'aaaaaaaa-0000-0000-0000-000000000001'

// What a plain SELECT on mailings returns — no RPC involved.
const ROW = {
  id: MAILING_ID, name: 'Spring Postcard', landing_type: 'property',
  landing_custom_url: null, landing_config: { headline: 'A Great Property' },
  property_id: null, status: 'sent',
}

function mockRes() {
  return {
    headers: {}, statusCode: null, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this },
    status(c) { this.statusCode = c; return this },
    send(b) { this.body = b; return this },
    json(b) { this.body = b; return this },
    end() { return this },
  }
}

// Per-test control over what the RPC does and what the table reads do.
let rpcImpl, selectImpl, insertImpl, inserted
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (...a) => rpcImpl(...a),
    from: (table) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => selectImpl(table),
        single: () => selectImpl(table),
        insert: (row) => { inserted.push({ table, row }); return insertImpl(table) },
        then: (resolve) => resolve({ data: [], error: null }),
      }
      return chain
    },
  }),
}))

let handler
beforeEach(async () => {
  vi.resetModules()
  inserted = []
  rpcImpl    = async () => ({ data: [], error: null })
  selectImpl = async () => ({ data: ROW, error: null })
  insertImpl = async () => ({ error: null })
  handler = (await import('../campaigns.js')).default
})

const scanReq = () => ({
  method: 'GET',
  headers: { 'user-agent': 'Mozilla/5.0 (iPhone)', host: 'crm.example.com' },
  query: { action: 'scan', token: TOKEN },
  socket: { remoteAddress: '1.2.3.4' },
})

// Every way record_mailing_scan can fail WITHOUT being absent. Each of these
// used to produce the retry page.
const RPC_FAILURES = [
  ['errors inside the function',
    async () => ({ data: null, error: { message: 'null value in column "visit_id" violates not-null constraint' } })],
  ['errors on a column a partial migration never added',
    async () => ({ data: null, error: { message: 'column "visitor_hash" of relation "mailing_scans" does not exist' } })],
  ['raises a permission error',
    async () => ({ data: null, error: { message: 'permission denied for table mailing_scans' } })],
  ['rejects outright',
    async () => { throw new Error('fetch failed') }],
  ['hangs past the write budget',
    () => new Promise(() => {})],
]

describe('a broken tracking write never blocks the redirect', () => {
  for (const [label, impl] of RPC_FAILURES) {
    it(`redirects to the landing page when the RPC ${label}`, async () => {
      process.env.SCAN_WRITE_BUDGET_MS = '30'
      rpcImpl = impl
      const res = mockRes()
      await handler(scanReq(), res)
      delete process.env.SCAN_WRITE_BUDGET_MS

      expect(res.statusCode, 'must 302, not serve the retry page').toBe(302)
      expect(res.headers['location']).toMatch(/^\/lp\/property\/aaaaaaaa-0000-0000-0000-000000000001\?v=/)
      expect(String(res.body ?? '')).not.toContain('Opening your page')
    })

    it(`still records the scan when the RPC ${label}`, async () => {
      process.env.SCAN_WRITE_BUDGET_MS = '30'
      rpcImpl = impl
      const res = mockRes()
      await handler(scanReq(), res)
      delete process.env.SCAN_WRITE_BUDGET_MS

      // A plain INSERT, which does not depend on the RPC being healthy.
      const scanInsert = inserted.find(i => i.table === 'mailing_scans')
      expect(scanInsert, 'the scan must still be stored').toBeTruthy()
      expect(scanInsert.row.mailing_id).toBe(MAILING_ID)
      // Confirmed by the insert, so no replay token needs tacking on.
      expect(res.headers['location']).not.toContain('sr=')
    })
  }

  it('a token that does not exist is still a 404, not a spinner', async () => {
    rpcImpl    = async () => ({ data: null, error: { message: 'boom' } })
    selectImpl = async () => ({ data: null, error: null })   // no such qr_token
    const res = mockRes()
    await handler(scanReq(), res)
    expect(res.statusCode).toBe(404)
  })

  it('carries a replay token when the fallback resolves but cannot store', async () => {
    rpcImpl    = async () => ({ data: null, error: { message: 'boom' } })
    insertImpl = async () => ({ error: { message: 'permission denied for table mailing_scans' } })
    const res = mockRes()
    await handler(scanReq(), res)

    expect(res.statusCode).toBe(302)
    // The page re-reports it, so the scan is not simply dropped.
    expect(res.headers['location']).toContain('sr=')
  })

  it('a duplicate key on the fallback insert counts as stored', async () => {
    // The RPC's write actually landed, then reported failure. The row is there.
    rpcImpl    = async () => ({ data: null, error: { message: 'boom' } })
    insertImpl = async () => ({ error: { message: 'duplicate key value violates unique constraint' } })
    const res = mockRes()
    await handler(scanReq(), res)

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).not.toContain('sr=')
  })

  it('ONLY a database that cannot be reached at all serves the retry page', async () => {
    process.env.SCAN_WRITE_BUDGET_MS = '30'
    process.env.SCAN_FALLBACK_BUDGET_MS = '30'
    rpcImpl    = () => new Promise(() => {})
    selectImpl = () => new Promise(() => {})   // the lookup hangs too
    const res = mockRes()
    await handler(scanReq(), res)
    delete process.env.SCAN_WRITE_BUDGET_MS
    delete process.env.SCAN_FALLBACK_BUDGET_MS

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Opening your page')
    // Even then the scan rides along as a signed replay rather than being lost.
    expect(res.body).toContain('scan_replay')
  })

  it('the healthy path is unchanged — one RPC, no fallback lookup', async () => {
    rpcImpl = async () => ({
      data: [{ ...ROW, mailing_id: MAILING_ID, scan_id: 'x', recorded: true, duplicate: false }],
      error: null,
    })
    const res = mockRes()
    await handler(scanReq(), res)

    expect(res.statusCode).toBe(302)
    expect(res.headers['location']).not.toContain('sr=')
    // No second trip to the database when the RPC did its job.
    expect(inserted).toHaveLength(0)
  })
})
