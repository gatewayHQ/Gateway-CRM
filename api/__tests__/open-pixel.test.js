/**
 * The /e/:token.gif open pixel, through the real api/campaigns.js handler.
 *
 * Regression test for opens never being recorded: the pixel branch sat below
 * the handler's "POST required for write actions" gate, so the GET every mail
 * client makes for an image was answered 405 with JSON — nothing stamped, and
 * a broken image in every recipient's copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.SCAN_SIGNING_SECRET = 'test-secret-for-scan-signing'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'

let rows
let updates
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async () => ({ data: null, error: null }),
    from: (table) => {
      const state = { table, filters: {}, op: 'select', payload: null }
      const chain = {
        select: () => chain,
        update: (p) => { state.op = 'update'; state.payload = p; return chain },
        eq: (k, v) => { state.filters[k] = v; return chain },
        not: () => chain,
        maybeSingle: async () => ({ data: rows.find(r => r.id === state.filters.id) || null, error: null }),
        then: (resolve) => {
          if (state.op === 'update') updates.push({ table, payload: state.payload, filters: state.filters })
          const count = rows.filter(r => r.first_opened_at).length
          return resolve({ data: null, error: null, count })
        },
      }
      return chain
    },
  }),
}))

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

const OUTLOOK = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0'

let handler, mintOpenToken
beforeEach(async () => {
  vi.resetModules()
  rows = [{ id: 'rcpt-1', blast_id: 'blast-1', open_count: 0, first_opened_at: null }]
  updates = []
  handler = (await import('../campaigns.js')).default
  ;({ mintOpenToken } = await import('../_lib/unsubscribeToken.js'))
})

const pixelReq = (token, ua = OUTLOOK) => ({
  method: 'GET',
  headers: { 'user-agent': ua },
  query: { action: 'open', token: `${token}.gif` },
  socket: { remoteAddress: '1.2.3.4' },
})

describe('open pixel', () => {
  it('answers a GET with the image — not a 405 — and stamps the open', async () => {
    const res = mockRes()
    await handler(pixelReq(mintOpenToken('rcpt-1')), res)

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/gif')
    const stamp = updates.find(u => u.table === 'email_blast_recipients')
    expect(stamp.filters.id).toBe('rcpt-1')
    expect(stamp.payload.open_count).toBe(1)
    expect(stamp.payload.first_opened_at).toBeTruthy()
    // The blast's roll-up moves on the first open.
    expect(updates.some(u => u.table === 'email_blasts' && 'opened_count' in u.payload)).toBe(true)
  })

  it('still serves the image for a forged token, and records nothing', async () => {
    const res = mockRes()
    await handler(pixelReq('forged.token'), res)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/gif')
    expect(updates).toHaveLength(0)
  })

  it('does not count an automated fetch as an open', async () => {
    const res = mockRes()
    await handler(pixelReq(mintOpenToken('rcpt-1'), 'python-requests/2.31'), res)
    expect(res.statusCode).toBe(200)
    expect(updates).toHaveLength(0)
  })
})
