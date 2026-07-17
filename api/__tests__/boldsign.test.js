import { describe, it, expect, vi, beforeEach } from 'vitest'
import { boldsign, backoffMs, buildSignerPayload, requiresExplicitFieldPlacement } from '../boldsign.js'

const okResp  = (body = '{}') => ({ ok: true,  status: 200, text: () => Promise.resolve(body), headers: { get: () => null } })
const errResp = (status)      => ({ ok: false, status,      text: () => Promise.resolve('{"message":"boom"}'), headers: { get: () => null } })

describe('backoffMs', () => {
  it('honors Retry-After seconds, capped at 20s', () => {
    expect(backoffMs(0, 3)).toBe(3000)
    expect(backoffMs(0, 999)).toBe(20000)
  })
  it('grows exponentially within a jitter band', () => {
    const d0 = backoffMs(0, 0), d1 = backoffMs(1, 0), d2 = backoffMs(2, 0)
    expect(d0).toBeGreaterThanOrEqual(400); expect(d0).toBeLessThan(700)
    expect(d1).toBeGreaterThanOrEqual(800); expect(d1).toBeLessThan(1100)
    expect(d2).toBeGreaterThanOrEqual(1600); expect(d2).toBeLessThan(1900)
  })
})

describe('boldsign() retry + idempotency', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('retries a transient 5xx then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errResp(503))
      .mockResolvedValueOnce(okResp('{"documentId":"d1"}'))
    vi.stubGlobal('fetch', fetchMock)
    const data = await boldsign('/x', { method: 'POST', json: { a: 1 }, maxRetries: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(data.documentId).toBe('d1')
  })

  it('reuses a stable Idempotency-Key across write retries', async () => {
    const keys = []
    const fetchMock = vi.fn((_url, opts) => {
      keys.push(opts.headers['Idempotency-Key'])
      return Promise.resolve(keys.length < 2 ? errResp(500) : okResp())
    })
    vi.stubGlobal('fetch', fetchMock)
    await boldsign('/x', { method: 'POST', json: {}, maxRetries: 2 })
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBeTruthy()
    expect(keys[0]).toBe(keys[1])   // same key across the retry
  })

  it('does not attach an Idempotency-Key to GETs', async () => {
    let headers
    vi.stubGlobal('fetch', vi.fn((_u, o) => { headers = o.headers; return Promise.resolve(okResp()) }))
    await boldsign('/x', { method: 'GET' })
    expect(headers['Idempotency-Key']).toBeUndefined()
  })

  it('throws with status after exhausting retries', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(errResp(500))))
    await expect(boldsign('/x', { method: 'GET', maxRetries: 1 })).rejects.toMatchObject({ status: 500 })
  })
})

describe('buildSignerPayload — retired coordinate auto-placement', () => {
  it('never invents formFields when no tabs are given', () => {
    const [entry] = buildSignerPayload([{ name: 'Jane', email: 'jane@x.com', routingOrder: 1 }])
    expect(entry).toEqual({ name: 'Jane', emailAddress: 'jane@x.com', signerType: 'Signer', signerOrder: 1 })
    expect(entry.formFields).toBeUndefined()
  })

  it('honors explicit caller-supplied tabs verbatim (not guessed)', () => {
    const [entry] = buildSignerPayload([{
      name: 'Jane', email: 'jane@x.com', routingOrder: 1,
      tabs: [{ type: 'signature', page: 2, xPosition: 100, yPosition: 200, width: 150, height: 40, required: true }],
    }])
    expect(entry.formFields).toEqual([{
      id: 'f_1_1', fieldType: 'Signature', pageNumber: 2,
      bounds: { x: 100, y: 200, width: 150, height: 40 }, isRequired: true,
    }])
  })
})

describe('requiresExplicitFieldPlacement', () => {
  it('allows useTextTags with no per-signer fields', () => {
    expect(requiresExplicitFieldPlacement([{ name: 'A', email: 'a@x.com' }], true)).toBeNull()
  })
  it('allows explicit tabs on every signer', () => {
    expect(requiresExplicitFieldPlacement([{ name: 'A', email: 'a@x.com', tabs: [{ type: 'signature' }] }], false)).toBeNull()
  })
  it('rejects when neither useTextTags nor tabs are provided', () => {
    expect(requiresExplicitFieldPlacement([{ name: 'A', email: 'a@x.com' }], false)).toMatch(/retired/)
  })
  it('rejects when only SOME signers have tabs', () => {
    const signers = [{ name: 'A', email: 'a@x.com', tabs: [{ type: 'signature' }] }, { name: 'B', email: 'b@x.com' }]
    expect(requiresExplicitFieldPlacement(signers, false)).toMatch(/retired/)
  })
})
