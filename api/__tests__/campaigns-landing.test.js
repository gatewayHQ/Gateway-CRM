/**
 * The /lp/{type}/{id} landing-page read — the second half of a QR scan.
 *
 * THE BUG THESE GUARD
 * /m/{token} recorded the scan on the service key and 302'd to /lp/{type}/{id}.
 * That URL is served by the SPA, so the landing page fetched its mailing from
 * the BROWSER with the anon key. Migration 0027 then closed `mailings` to anon;
 * RLS filters rather than errors, so the select came back with zero rows and
 * every scanner of every QR code saw "Listing not available" on a healthy
 * campaign. Scans kept counting the whole time, which is why the tracking
 * dashboards looked fine.
 *
 * The fix is the public `landing` action: a service-key read of exactly the
 * four fields the Landing* pages render. The projection test below is the one
 * that matters most — `select('*')` here would publish qr_token to everyone who
 * scans a QR code, and a token is all you need to forge scans for a campaign.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.SCAN_SIGNING_SECRET = 'test-secret-for-scan-signing'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'

const MAILING_ID = 'aaaaaaaa-0000-0000-0000-000000000001'

const ROW = {
  id:             MAILING_ID,
  name:           'Spring Postcard',
  agent_id:       'bbbbbbbb-0000-0000-0000-000000000002',
  landing_config: { headline: 'A Great Property' },
}

function mockRes() {
  const res = {
    headers: {}, statusCode: null, body: undefined, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this },
    status(c) { this.statusCode = c; return this },
    send(b) { this.body = b; this.ended = true; return this },
    json(b) { this.body = b; this.ended = true; return this },
    end() { this.ended = true; return this },
  }
  return res
}

// Records the table + column list the handler asked for, so the projection can
// be asserted rather than assumed.
let selectCalls
let rowImpl
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async () => ({ data: [], error: null }),
    from: (table) => {
      const chain = {
        select: (cols) => { selectCalls.push({ table, cols }); return chain },
        eq: () => chain,
        maybeSingle: () => Promise.resolve(rowImpl()),
        single: () => Promise.resolve(rowImpl()),
        then: (resolve) => resolve({ data: [], error: null }),
      }
      return chain
    },
  }),
}))

let handler
beforeEach(async () => {
  vi.resetModules()
  selectCalls = []
  rowImpl = () => ({ data: ROW, error: null })
  handler = (await import('../campaigns.js')).default
})

const req = (query = {}) => ({
  method: 'GET',
  headers: {},
  query: { action: 'landing', id: MAILING_ID, ...query },
  socket: { remoteAddress: '1.2.3.4' },
})

describe('?action=landing — the read the landing pages could not do themselves', () => {
  it('returns the mailing to an anonymous caller with no session at all', async () => {
    const res = mockRes()
    await handler(req(), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.mailing).toEqual(ROW)
  })

  it('selects ONLY the four rendered columns — never qr_token, never *', async () => {
    const res = mockRes()
    await handler(req(), res)

    const call = selectCalls.find(c => c.table === 'mailings')
    expect(call, 'expected a select against mailings').toBeTruthy()
    expect(call.cols).toBe('id, name, agent_id, landing_config')
    // Spelled out: these are the failures that would matter, and `*` is the
    // easy accident a future "just add one more field" edit makes.
    expect(call.cols).not.toContain('*')
    for (const secret of ['qr_token', 'description', 'scan_count', 'lead_count', 'recipient_count', 'status']) {
      expect(call.cols, `landing must not expose ${secret}`).not.toContain(secret)
    }
  })

  it('404s a mailing id that does not resolve, so the page shows "not available"', async () => {
    rowImpl = () => ({ data: null, error: null })
    const res = mockRes()
    await handler(req(), res)
    expect(res.statusCode).toBe(404)
  })

  it('400s a malformed id instead of letting Postgres 500 on the uuid cast', async () => {
    for (const id of ['not-a-uuid', '', '123', "' or 1=1 --"]) {
      const res = mockRes()
      await handler(req({ id }), res)
      expect(res.statusCode, `id=${JSON.stringify(id)}`).toBe(400)
    }
    // Nothing malformed should ever have reached the database.
    expect(selectCalls.filter(c => c.table === 'mailings')).toHaveLength(0)
  })

  it('does not record a scan — /lp/ URLs are shared and reloaded freely', async () => {
    // The scan is recorded once, by /m/{token}. If this action also counted,
    // every refresh of a landing page would inflate the campaign's numbers.
    const res = mockRes()
    await handler(req(), res)
    expect(selectCalls.some(c => c.table === 'mailing_scans')).toBe(false)
  })
})
