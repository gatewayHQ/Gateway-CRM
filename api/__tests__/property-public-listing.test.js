/**
 * /listing/:id and /share/:id — the public property pages.
 *
 * Both were broken by migration 0027 in the two different ways this file pins:
 *
 *   /listing/:id  PropertyLanding.jsx read `properties` in the BROWSER with the
 *                 anon key. RLS filters rather than errors, so the page showed
 *                 "not found" to every visitor.
 *   /share/:id    handleShare ran server-side but presented the ANON key, so it
 *                 broke identically despite being a serverless function.
 *
 * The projection tests are the important ones. `properties` is a CRM table —
 * assigned agent, linked contact, price history, comps, listing expiry — and
 * `details` is a free-form jsonb blob that already holds internal
 * `co_agent_ids`. A `select(*)` here publishes the CRM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const PROPERTY_ID = 'cccccccc-0000-0000-0000-000000000003'

process.env.SUPABASE_URL = 'https://test.supabase.co'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'

// A row as the database would hand it back, including the internal bits that
// must not reach a visitor.
const ROW = {
  id: PROPERTY_ID,
  address: '1240 Grand Ave', city: 'Des Moines', state: 'IA', zip: '50309',
  county: 'Polk', type: 'multifamily', status: 'active',
  list_price: 2750000, beds: null, baths: null, sqft: 28400,
  garage: 0, mls_number: 'DM-99213',
  notes: 'Value-add multifamily, 24 units.',
  details: {
    photos: ['https://cdn.example/1.jpg'],
    year_built: 1974, total_units: 24, cap_rate: '7.1', noi: 195000,
    // Internal — must be filtered out of the public payload.
    co_agent_ids: ['bbbbbbbb-0000-0000-0000-000000000002'],
    internal_seller_motivation: 'divorce, motivated',
  },
  agent: { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Daniel Stillson',
           email: 'daniel@example.com', role: 'Associate', color: '#c9a961', initials: 'DS' },
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

let fetchCalls
let handler
beforeEach(async () => {
  vi.resetModules()
  fetchCalls = []
  globalThis.fetch = vi.fn(async (url, opts) => {
    fetchCalls.push({ url: String(url), opts })
    return { ok: true, json: async () => [ROW] }
  })
  handler = (await import('../property-public.js')).default
})

const listingReq = (query = {}) => ({
  method: 'GET',
  headers: { host: 'crm.example.com' },
  query: { action: 'listing', id: PROPERTY_ID, ...query },
})

describe('?action=listing — the read PropertyLanding could not do itself', () => {
  it('returns the listing to an anonymous visitor', async () => {
    const res = mockRes()
    await handler(listingReq(), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.property.address).toBe('1240 Grand Ave')
    expect(res.body.property.agent.initials).toBe('DS')
  })

  it('reads with the SERVICE key, never the anon key', async () => {
    const res = mockRes()
    await handler(listingReq(), res)
    const call = fetchCalls.find(c => c.url.includes('/rest/v1/properties'))
    expect(call).toBeTruthy()
    expect(call.opts.headers.apikey).toBe('test-service-key')
  })

  it('selects an explicit column list, never *', async () => {
    const res = mockRes()
    await handler(listingReq(), res)
    const url = decodeURIComponent(fetchCalls.find(c => c.url.includes('/rest/v1/properties')).url)

    expect(url).toContain('select=id,address,city')
    expect(url).not.toContain('select=*')
    // Columns a visitor has no business seeing. `select=` is checked rather than
    // the whole URL because `id=eq.` is legitimately in the query string.
    const select = url.split('select=')[1]
    for (const internal of ['linked_contact_id', 'price_history', 'comps',
                            'listing_expiry_date', 'submarket']) {
      expect(select, `listing must not select ${internal}`).not.toContain(internal)
    }

    // `assigned_agent_id` appears in the select only as the FK of the
    // `agent:assigned_agent_id(...)` embed, which PostgREST returns nested under
    // `agent`. So assert on the RESPONSE: no bare agent id at the top level.
    expect(select).toContain('agent:assigned_agent_id(')
    expect(res.body.property).not.toHaveProperty('assigned_agent_id')
  })

  it('filters the details blob to the keys the page renders', async () => {
    const res = mockRes()
    await handler(listingReq(), res)
    const details = res.body.property.details

    // Public spec keys survive.
    expect(details.year_built).toBe(1974)
    expect(details.total_units).toBe(24)
    expect(details.cap_rate).toBe('7.1')
    expect(details.photos).toHaveLength(1)

    // Internal keys are stripped. co_agent_ids is real; the motivation note
    // stands in for "any key someone adds to this blob later".
    expect(details).not.toHaveProperty('co_agent_ids')
    expect(details).not.toHaveProperty('internal_seller_motivation')
    expect(JSON.stringify(res.body.property)).not.toContain('divorce')
  })

  it('404s an id that does not resolve and 400s a malformed one', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => [] }))
    const missing = mockRes()
    await handler(listingReq(), missing)
    expect(missing.statusCode).toBe(404)

    for (const id of ['not-a-uuid', '', "' or 1=1 --"]) {
      const bad = mockRes()
      await handler(listingReq({ id }), bad)
      expect(bad.statusCode, `id=${JSON.stringify(id)}`).toBe(400)
    }
  })

  it('is not cached — a listing edit must show up immediately', async () => {
    const res = mockRes()
    await handler(listingReq(), res)
    expect(res.headers['cache-control']).toBe('no-store')
  })
})

describe('/share/:id — the share card reads with the service key too', () => {
  it('presents the service key, not the anon key', async () => {
    const res = mockRes()
    await handler({ method: 'GET', headers: { host: 'crm.example.com' },
                    query: { id: PROPERTY_ID } }, res)

    const call = fetchCalls.find(c => c.url.includes('/rest/v1/properties'))
    expect(call.opts.headers.apikey).toBe('test-service-key')
    // handleShare sends without calling .status() — Vercel defaults that to 200,
    // so the card itself is the evidence it resolved rather than 404'd.
    expect(res.body).toContain('og:title')
    expect(res.body).toContain('1240 Grand Ave')
  })

  it('still routes plain GET to the share card, not the listing JSON', async () => {
    // The /share/:id rewrite passes only ?id=, so the default GET must stay HTML.
    const res = mockRes()
    await handler({ method: 'GET', headers: { host: 'crm.example.com' },
                    query: { id: PROPERTY_ID } }, res)
    expect(res.headers['content-type']).toMatch(/text\/html/)
  })
})
