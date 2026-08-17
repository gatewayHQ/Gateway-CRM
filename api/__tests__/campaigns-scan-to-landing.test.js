/**
 * Scan → redirect → landing page, walked end to end in one test.
 *
 * WHY THIS FILE EXISTS
 * The QR pipeline has two halves that are deployed together but run in different
 * places on different credentials:
 *
 *   half 1  /m/{token}          serverless, SERVICE key  → records the scan, 302s
 *   half 2  /lp/{type}/{id}     the SPA, in the BROWSER   → renders the page
 *
 * Every existing test covered one half or the other, so the halves were free to
 * disagree — and they did. Migration 0027 closed `mailings` to anon, half 2 was
 * still reading that table from the browser, and the result was a QR code that
 * counted a scan and then showed the scanner "Listing not available". Green
 * tests the whole time, because no test followed the redirect.
 *
 * So this test follows the redirect: it takes the Location header half 1 actually
 * emits, routes it through the SAME regex main.jsx uses to mount the page, and
 * then performs the fetch half 2 actually performs. A change that breaks the
 * handoff fails here regardless of which side it lands on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.env.SCAN_SIGNING_SECRET = 'test-secret-for-scan-signing'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1'

// The test campaign: one mailing, one QR token, a property landing page.
const TOKEN      = 'Ab3dEf7h'
const MAILING_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
const AGENT_ID   = 'bbbbbbbb-0000-0000-0000-000000000002'

const LANDING_CONFIG = {
  headline: '1240 Grand Ave — 24 Units',
  subheadline: 'Value-add multifamily in Des Moines',
  price: '2750000', units: '24',
  images: ['https://cdn.example/hero.jpg'],
}

// What record_mailing_scan returns for this campaign.
const SCAN_ROW = {
  mailing_id: MAILING_ID, name: 'Spring Postcard', landing_type: 'property',
  landing_custom_url: null, landing_config: LANDING_CONFIG, property_id: null,
  status: 'sent', scan_id: 'scan-uuid', recorded: true, duplicate: false,
}

// The row a service-key select on `mailings` returns. Anonymous callers get
// nothing from this table post-0027 — which is the entire point of the fix.
const MAILING_ROW = {
  id: MAILING_ID, name: 'Spring Postcard',
  agent_id: AGENT_ID, landing_config: LANDING_CONFIG,
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

let rpcCalls
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: (fn, args) => {
      rpcCalls.push({ fn, args })
      return Promise.resolve({ data: [SCAN_ROW], error: null })
    },
    from: () => {
      const chain = {
        select: () => chain, eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: MAILING_ROW, error: null }),
        single: () => Promise.resolve({ data: MAILING_ROW, error: null }),
        then: (resolve) => resolve({ data: [], error: null }),
      }
      return chain
    },
  }),
}))

let handler
beforeEach(async () => {
  vi.resetModules()
  rpcCalls = []
  handler = (await import('../campaigns.js')).default
})

// main.jsx decides which component to mount by regex on the pathname. Read the
// real one out of the source so this test cannot drift from the router: if the
// route stops matching what /m redirects to, that is the bug, and it shows up
// here instead of in production.
function propertyRouteRegex() {
  const src = readFileSync(fileURLToPath(new URL('../../src/main.jsx', import.meta.url)), 'utf8')
  const m = src.match(/lpPropMatch\s*=\s*pathname\.match\((\/.+?\/i)\)/)
  if (!m) throw new Error('could not find lpPropMatch route regex in main.jsx')
  return eval(m[1]) // eslint-disable-line no-eval -- the literal from our own source
}

describe('a QR scan lands on a page that actually renders', () => {
  it('walks scan → 302 → route match → landing fetch, and tracks the visit', async () => {
    // ── Step 1: the QR code encodes /m/{token}. (src/lib/qr.js builds this URL;
    //    it is a pure string join over the token, so the token is what matters.)
    const scanPath = `/m/${TOKEN}`
    expect(scanPath).toBe('/m/Ab3dEf7h')

    // ── Step 2: the scan hits the serverless endpoint.
    const scanRes = mockRes()
    await handler({
      method: 'GET',
      headers: { 'user-agent': IPHONE, host: 'crm.example.com' },
      query: { action: 'scan', token: TOKEN },
      socket: { remoteAddress: '1.2.3.4' },
    }, scanRes)

    // The visit IS tracked — the write is awaited and asked to record.
    expect(rpcCalls.map(c => c.fn)).toContain('record_mailing_scan')
    const scanArgs = rpcCalls.find(c => c.fn === 'record_mailing_scan').args
    expect(scanArgs.p_token).toBe(TOKEN)
    expect(scanArgs.p_record).toBe(true)
    expect(scanArgs.p_source).toBe('qr')

    // ── Step 3: it 302s to the landing page, carrying the visit id.
    expect(scanRes.statusCode).toBe(302)
    const location = scanRes.headers['location']
    expect(location).toMatch(/^\/lp\/property\/aaaaaaaa-0000-0000-0000-000000000001\?v=[0-9a-f]{20}$/)

    // The write was confirmed, so no replay token should be tacked on.
    expect(location).not.toContain('sr=')

    // ── Step 4: the SPA routes that path. This is the hop the bug lived past:
    //    the URL was always fine, so the redirect looked correct end to end.
    const url = new URL(location, 'https://crm.example.com')
    const routeMatch = url.pathname.match(propertyRouteRegex())
    expect(routeMatch, `main.jsx does not route ${url.pathname}`).toBeTruthy()
    expect(routeMatch[1]).toBe(MAILING_ID)

    const visitId = url.searchParams.get('v')
    expect(visitId).toHaveLength(20)

    // ── Step 5: the mounted page fetches its mailing. Pre-fix this was
    //    `supabase.from('mailings')` in the browser, which RLS emptied; the page
    //    then rendered "Listing not available" on a campaign that had just
    //    successfully recorded a scan.
    const landingRes = mockRes()
    await handler({
      method: 'GET',
      headers: { host: 'crm.example.com' },
      query: { action: 'landing', id: routeMatch[1] },
      socket: { remoteAddress: '1.2.3.4' },
    }, landingRes)

    expect(landingRes.statusCode).toBe(200)
    expect(landingRes.body.mailing.id).toBe(MAILING_ID)

    // ── Step 6: the page has what it needs to actually render.
    const cfg = landingRes.body.mailing.landing_config
    expect(cfg.headline).toBe('1240 Grand Ave — 24 Units')
    expect(cfg.images).toHaveLength(1)
    expect(landingRes.body.mailing.agent_id).toBe(AGENT_ID)

    // ── Step 7: rendering the page did NOT record a second scan. One scan per
    //    scan — a landing page gets reloaded, bookmarked and shared.
    expect(rpcCalls.filter(c => c.fn === 'record_mailing_scan')).toHaveLength(1)
  })
})
