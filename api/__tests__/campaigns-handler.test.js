/**
 * The /m/{token} scan endpoint, exercised through the real handler.
 *
 * These are regression tests for the ways scans were being lost in production.
 * The most important one is the caching group: a single link-preview fetch used
 * to install a cacheable response at the edge for the /m/{token} URL, after
 * which every real scan of that QR code was served by the CDN and never reached
 * this function at all — silent, total scan loss for the life of the cache
 * entry, on exactly the links that get shared the most.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.SCAN_SIGNING_SECRET = 'test-secret-for-scan-signing'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'

const MAILING = {
  mailing_id:         'aaaaaaaa-0000-0000-0000-000000000001',
  name:               'Spring Postcard',
  landing_type:       'property',
  landing_custom_url: null,
  landing_config:     { headline: 'A Great Property', images: ['https://img/1.jpg'] },
  property_id:        null,
  status:             'sent',
  scan_id:            'scan-uuid',
  recorded:           true,
  duplicate:          false,
}

// Captures what the handler did to the response.
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

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1'

// Swap the Supabase client for a stub whose rpc() we control per test.
// maybeSingleImpl covers the destination-resolve fallback: the scan handler falls
// back to a plain `mailings` lookup whenever the RPC gives it no destination, so
// a test that wants "no destination at all" has to make BOTH fail.
let rpcImpl
let maybeSingleImpl
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (...args) => rpcImpl(...args),
    from: () => {
      const chain = {
        select: () => chain, insert: () => chain, update: () => chain, upsert: () => chain,
        delete: () => chain, eq: () => chain, in: () => chain, gt: () => chain, lt: () => chain,
        gte: () => chain, ilike: () => chain, order: () => chain, limit: () => chain,
        single: () => maybeSingleImpl(),
        maybeSingle: () => maybeSingleImpl(),
        then: (resolve) => resolve({ data: [], error: null, count: 0 }),
      }
      return chain
    },
  }),
}))

let handler
beforeEach(async () => {
  vi.resetModules()
  rpcImpl = vi.fn(async () => ({ data: [MAILING], error: null }))
  maybeSingleImpl = () => Promise.resolve({ data: null, error: null })
  handler = (await import('../campaigns.js')).default
})

const scanReq = (headers = {}, query = {}) => ({
  method: 'GET',
  headers: { 'user-agent': IPHONE, ...headers },
  query: { action: 'scan', token: 'Ab3dEf7h', ...query },
  socket: { remoteAddress: '1.2.3.4' },
})

describe('/m/{token} — nothing on the scan path may ever be cached', () => {
  it('sends no-store on a normal scan', async () => {
    const res = mockRes()
    await handler(scanReq(), res)
    expect(res.statusCode).toBe(302)
    expect(res.headers['cache-control']).toMatch(/no-store/)
    expect(res.headers['cdn-cache-control']).toBe('no-store')
    expect(res.headers['vercel-cdn-cache-control']).toBe('no-store')
    expect(res.headers['vary']).toBe('User-Agent')
  })

  it('sends no-store to a social crawler too — THE regression that lost scans', async () => {
    // Previously this branch set `Cache-Control: public, s-maxage=3600` on the
    // /m/{token} URL with no Vary, so one iMessage/Facebook preview silenced
    // the campaign's QR code at the edge for the next hour.
    const res = mockRes()
    await handler(scanReq({ 'user-agent': 'facebookexternalhit/1.1' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('og:title')
    expect(res.headers['cache-control']).toMatch(/no-store/)
    expect(res.headers['cache-control']).not.toMatch(/s-maxage|public/)
    expect(res.headers['vary']).toBe('User-Agent')
  })

  it('sends no-store on the 404 path', async () => {
    rpcImpl = vi.fn(async () => ({ data: [], error: null }))
    const res = mockRes()
    await handler(scanReq(), res)
    expect(res.statusCode).toBe(404)
    expect(res.headers['cache-control']).toMatch(/no-store/)
  })
})

describe('/m/{token} — the write happens before the redirect', () => {
  it('records the scan atomically and only then redirects', async () => {
    const res = mockRes()
    await handler(scanReq(), res)

    expect(rpcImpl).toHaveBeenCalledTimes(1)
    const [fn, args] = rpcImpl.mock.calls[0]
    expect(fn).toBe('record_mailing_scan')
    expect(args.p_token).toBe('Ab3dEf7h')
    expect(args.p_record).toBe(true)
    // The scan id is minted server-side so a replay can be deduplicated.
    expect(args.p_scan_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(args.p_visit_id).toBeTruthy()
    expect(res.statusCode).toBe(302)
  })

  it('captures device, platform and location with the scan', async () => {
    const res = mockRes()
    await handler(scanReq({
      'x-vercel-ip-country': 'US',
      'x-vercel-ip-country-region': 'IA',
      'x-vercel-ip-city': 'Des%20Moines',
    }), res)

    const [, args] = rpcImpl.mock.calls[0]
    expect(args.p_device_type).toBe('mobile')
    expect(args.p_os).toBe('iOS')
    expect(args.p_country).toBe('US')
    expect(args.p_region).toBe('IA')
    expect(args.p_city).toBe('Des Moines')   // URL-decoded
    expect(args.p_is_bot).toBe(false)
  })

  it('still records a crawler hit, flagged so it cannot inflate the count', async () => {
    const res = mockRes()
    await handler(scanReq({ 'user-agent': 'facebookexternalhit/1.1' }), res)
    const [, args] = rpcImpl.mock.calls[0]
    expect(args.p_is_bot).toBe(true)
    expect(args.p_bot_reason).toBe('social-crawler')
    expect(args.p_source).toBe('crawler')
  })

  it('carries the visit id to the landing page so a lead can be attributed', async () => {
    const res = mockRes()
    await handler(scanReq(), res)
    expect(res.headers['location']).toMatch(/^\/lp\/property\/aaaaaaaa-0000-0000-0000-000000000001\?v=/)
  })
})

describe('/m/{token} — an unconfirmed write is never a lost scan', () => {
  it('redirects anyway and attaches a signed replay when the write times out', async () => {
    process.env.SCAN_WRITE_BUDGET_MS = '30'
    // First call: resolve the token so the destination gets cached in-process.
    await handler(scanReq(), mockRes())
    // Second call: the database hangs.
    rpcImpl = vi.fn(() => new Promise(() => {}))

    const res = mockRes()
    await handler(scanReq(), res)

    expect(res.statusCode).toBe(302)                       // the scanner is never blocked
    expect(res.headers['location']).toMatch(/[?&]sr=/)     // ...and the scan rides along
    delete process.env.SCAN_WRITE_BUDGET_MS
  })

  it('serves a self-retrying page when the destination cannot be resolved at all', async () => {
    // "At all" means the database is unreachable, so BOTH the RPC and the
    // fallback `mailings` lookup have to hang. If only the RPC fails, the
    // fallback resolves the destination and the scanner is redirected instead —
    // that is the point of the fallback, and it is covered in
    // campaigns-scan-resilience.test.js.
    process.env.SCAN_WRITE_BUDGET_MS = '30'
    process.env.SCAN_FALLBACK_BUDGET_MS = '30'
    rpcImpl = vi.fn(() => new Promise(() => {}))
    maybeSingleImpl = () => new Promise(() => {})

    const res = mockRes()
    await handler(scanReq({}, { token: 'NeverSeenBefore' }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('scan_replay')   // keeps trying until it lands
    expect(res.headers['cache-control']).toMatch(/no-store/)
    delete process.env.SCAN_WRITE_BUDGET_MS
    delete process.env.SCAN_FALLBACK_BUDGET_MS
  })

  it('a reachable database that says "no such token" is a 404, not a spinner', async () => {
    // The distinction the fallback introduces: an authoritative "that token does
    // not exist" is an answer, and answering it with an endless spinner would
    // hide a mistyped or deleted campaign forever.
    process.env.SCAN_WRITE_BUDGET_MS = '30'
    rpcImpl = vi.fn(() => new Promise(() => {}))
    maybeSingleImpl = () => Promise.resolve({ data: null, error: null })

    const res = mockRes()
    await handler(scanReq({}, { token: 'NeverSeenBefore' }), res)

    expect(res.statusCode).toBe(404)
    delete process.env.SCAN_WRITE_BUDGET_MS
  })

  it('accepts a replay it signed and reports whether the original write had landed', async () => {
    const { signPayload } = await import('../campaigns.js')
    const replay = signPayload({ k: 'Ab3dEf7h', s: 'scan-uuid', v: 'visit-1', t: Date.now() })
    rpcImpl = vi.fn(async () => ({ data: [{ ...MAILING, recorded: false }], error: null }))

    const res = mockRes()
    await handler({ method: 'POST', headers: { 'user-agent': IPHONE }, query: {},
                    body: { action: 'scan_replay', replay }, socket: {} }, res)

    expect(res.statusCode).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.recorded).toBe(false)          // it had already landed — absorbed
    expect(res.body.dest).toContain('/lp/property/')
    // Crucially, the replay reuses the ORIGINAL scan id, so it cannot double-count.
    expect(rpcImpl.mock.calls[0][1].p_scan_id).toBe('scan-uuid')
    expect(rpcImpl.mock.calls[0][1].p_source).toBe('replay')
  })

  it('refuses a forged replay', async () => {
    const res = mockRes()
    await handler({ method: 'POST', headers: {}, query: {},
                    body: { action: 'scan_replay', replay: 'forged.signature' }, socket: {} }, res)
    expect(res.statusCode).toBe(400)
    expect(rpcImpl).not.toHaveBeenCalled()
  })
})
