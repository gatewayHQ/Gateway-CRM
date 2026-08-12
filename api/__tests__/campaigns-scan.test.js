/**
 * QR scan capture — the reliability-critical primitives.
 *
 * These cover the classification, signing and destination logic that decides
 * whether a scan is counted, how it is attributed, and whether an unconfirmed
 * write can be safely replayed. The atomic write path itself is exercised
 * against a real PostgreSQL database by migrations/0031_qr_scan_reliability.sql
 * (see the test harness notes in docs/qr-scan-tracking.md).
 */
import { describe, it, expect, beforeAll } from 'vitest'

// Signing derives its key from the environment, so this has to be set before
// the module is imported.
process.env.SCAN_SIGNING_SECRET = 'test-secret-for-scan-signing'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'

let classifyBot, parseUa, signPayload, verifyPayload, destinationFor, withVisit, visitorHash, withTimeout, TIMEOUT

beforeAll(async () => {
  const m = await import('../campaigns.js')
  ;({ classifyBot, parseUa, signPayload, verifyPayload, destinationFor, withVisit, visitorHash, withTimeout, TIMEOUT } = m)
})

const req = (headers = {}, method = 'GET') => ({ headers, method })

const IPHONE   = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const ANDROID  = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'
const IPAD     = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/604.1'
const MAC      = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const IG       = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 320.0.0.0'

describe('classifyBot — what counts as a real scan', () => {
  it('treats a phone camera scan as a real person', () => {
    expect(classifyBot(req({}), IPHONE)).toEqual({ isBot: false, reason: null })
    expect(classifyBot(req({}), ANDROID).isBot).toBe(false)
  })

  it('flags social link-preview crawlers', () => {
    // This is the exact traffic that used to poison the CDN cache.
    expect(classifyBot(req({}), 'facebookexternalhit/1.1').isBot).toBe(true)
    expect(classifyBot(req({}), 'WhatsApp/2.23').isBot).toBe(true)
    expect(classifyBot(req({}), 'Slackbot-LinkExpanding 1.0').isBot).toBe(true)
    expect(classifyBot(req({}), 'facebookexternalhit/1.1').reason).toBe('social-crawler')
  })

  it('flags security scanners and automation that follow mailed links', () => {
    for (const ua of ['curl/8.4.0', 'python-requests/2.31', 'HeadlessChrome/122', 'Googlebot/2.1',
                      'Barracuda Link Protection', 'urlscan.io', 'Go-http-client/2.0']) {
      expect(classifyBot(req({}), ua).isBot, ua).toBe(true)
    }
  })

  it('flags browser prefetch and prerender hints', () => {
    // The link was fetched speculatively — nobody actually opened it.
    expect(classifyBot(req({ 'sec-purpose': 'prefetch;prerender' }), IPHONE).isBot).toBe(true)
    expect(classifyBot(req({ purpose: 'prefetch' }), IPHONE).isBot).toBe(true)
    expect(classifyBot(req({ 'x-moz': 'prefetch' }), IPHONE).isBot).toBe(true)
    expect(classifyBot(req({ 'x-purpose': 'preview' }), IPHONE).isBot).toBe(true)
    expect(classifyBot(req({ 'sec-purpose': 'prefetch' }), IPHONE).reason).toMatch(/^prefetch:/)
  })

  it('flags HEAD requests and missing user agents', () => {
    expect(classifyBot(req({}, 'HEAD'), IPHONE)).toEqual({ isBot: true, reason: 'head-request' })
    expect(classifyBot(req({}), '')).toEqual({ isBot: true, reason: 'no-user-agent' })
  })

  it('does not mistake ordinary browsers for bots', () => {
    // Guards against an over-broad pattern silently zeroing out a campaign:
    // every one of these contains a substring near a bot keyword.
    for (const ua of [IPHONE, ANDROID, IPAD, MAC, IG]) {
      expect(classifyBot(req({}), ua).isBot, ua).toBe(false)
    }
  })
})

describe('parseUa', () => {
  it('identifies phones, tablets and desktops', () => {
    expect(parseUa(IPHONE).device).toBe('mobile')
    expect(parseUa(ANDROID).device).toBe('mobile')
    expect(parseUa(IPAD).device).toBe('tablet')
    expect(parseUa(MAC).device).toBe('desktop')
  })

  it('identifies the platform', () => {
    expect(parseUa(IPHONE).os).toBe('iOS')
    expect(parseUa(ANDROID).os).toBe('Android')
    expect(parseUa(MAC).os).toBe('macOS')
  })

  it('identifies in-app browsers rather than reporting them as Safari', () => {
    // A QR code posted to social gets opened inside the app's own browser —
    // reporting these as Safari would hide where the traffic actually came from.
    expect(parseUa(IG).browser).toBe('Instagram')
    expect(parseUa(IPHONE).browser).toBe('Safari')
    expect(parseUa(ANDROID).browser).toBe('Chrome')
  })

  it('never throws on junk input', () => {
    for (const v of ['', null, undefined, '💥', 'x'.repeat(5000)]) {
      expect(() => parseUa(v)).not.toThrow()
    }
  })
})

describe('replay signing — a scan can be re-reported but never forged', () => {
  it('round-trips a payload it signed', () => {
    const token = signPayload({ k: 'Ab3dEf7h', s: 'scan-1', v: 'visit-1', t: Date.now() })
    expect(verifyPayload(token)).toMatchObject({ k: 'Ab3dEf7h', s: 'scan-1', v: 'visit-1' })
  })

  it('rejects a tampered payload', () => {
    const token = signPayload({ k: 'Ab3dEf7h', s: 'scan-1', v: 'visit-1', t: Date.now() })
    const [body, mac] = token.split('.')
    // Swap in a different campaign token, keep the signature.
    const forged = Buffer.from(JSON.stringify({ k: 'HACKED', s: 'scan-1', v: 'v', t: Date.now() })).toString('base64url')
    expect(verifyPayload(`${forged}.${mac}`)).toBeNull()
    // Or keep the body and invent a signature.
    expect(verifyPayload(`${body}.${'a'.repeat(mac.length)}`)).toBeNull()
  })

  it('rejects malformed and empty tokens', () => {
    for (const v of ['', null, undefined, 'nodot', 'a.b.c.d', '.', 'x.']) {
      expect(verifyPayload(v), String(v)).toBeNull()
    }
  })

  it('rejects a payload that has aged out', () => {
    const stale = signPayload({ k: 'Ab3dEf7h', s: 'scan-1', v: 'v', t: Date.now() - 60 * 60 * 1000 })
    expect(verifyPayload(stale, 30 * 60 * 1000)).toBeNull()
    // Still valid inside a wider window.
    expect(verifyPayload(stale, 2 * 60 * 60 * 1000)).toMatchObject({ k: 'Ab3dEf7h' })
  })

  it('rejects a payload with no timestamp', () => {
    expect(verifyPayload(signPayload({ k: 'x', s: 'y', v: 'z' }))).toBeNull()
  })
})

describe('destinationFor', () => {
  const id = 'aaaaaaaa-0000-0000-0000-000000000001'

  it('routes each landing type', () => {
    expect(destinationFor({ mailing_id: id, landing_type: 'property'    })).toBe(`/lp/property/${id}`)
    expect(destinationFor({ mailing_id: id, landing_type: 'valuation'   })).toBe(`/lp/valuation/${id}`)
    expect(destinationFor({ mailing_id: id, landing_type: 'multifamily' })).toBe(`/lp/multifamily/${id}`)
    expect(destinationFor({ mailing_id: id, landing_type: 'mailing'     })).toBe(`/lp/mailing/${id}`)
  })

  it('falls back to the property page for an unknown type', () => {
    expect(destinationFor({ mailing_id: id, landing_type: 'nonsense' })).toBe(`/lp/property/${id}`)
  })

  it('uses a custom URL only when one is actually set', () => {
    expect(destinationFor({ mailing_id: id, landing_type: 'custom', landing_custom_url: 'https://example.com/x' }))
      .toBe('https://example.com/x')
    // custom with no URL must not produce a broken redirect.
    expect(destinationFor({ mailing_id: id, landing_type: 'custom', landing_custom_url: null }))
      .toBe(`/lp/property/${id}`)
  })

  it('accepts either the RPC shape (mailing_id) or a raw row (id)', () => {
    expect(destinationFor({ id, landing_type: 'property' })).toBe(`/lp/property/${id}`)
  })
})

describe('withVisit — attribution rides along, but only on our own pages', () => {
  it('appends the visit id to internal landing pages', () => {
    expect(withVisit('/lp/property/abc', 'v1')).toBe('/lp/property/abc?v=v1')
    expect(withVisit('/lp/property/abc?x=1', 'v1')).toBe('/lp/property/abc?x=1&v=v1')
  })

  it('never appends tracking to an external custom URL', () => {
    // The agent typed that link; we don't rewrite someone else's URL, and there
    // is nothing of ours on the far side to stitch it to.
    expect(withVisit('https://example.com/promo', 'v1')).toBe('https://example.com/promo')
    expect(withVisit('http://example.com/promo?a=b', 'v1')).toBe('http://example.com/promo?a=b')
  })

  it('is a no-op without a visit id', () => {
    expect(withVisit('/lp/property/abc', null)).toBe('/lp/property/abc')
  })
})

describe('visitorHash — unique-people counting', () => {
  it('is stable for the same visitor', () => {
    expect(visitorHash('1.2.3.4', IPHONE)).toBe(visitorHash('1.2.3.4', IPHONE))
  })

  it('separates different visitors', () => {
    expect(visitorHash('1.2.3.4', IPHONE)).not.toBe(visitorHash('5.6.7.8', IPHONE))
    expect(visitorHash('1.2.3.4', IPHONE)).not.toBe(visitorHash('1.2.3.4', ANDROID))
  })

  it('never returns a raw address', () => {
    const h = visitorHash('1.2.3.4', IPHONE)
    expect(h).not.toContain('1.2.3.4')
    expect(h).toMatch(/^[0-9a-f]{32}$/)
  })

  it('returns null when there is nothing to hash', () => {
    expect(visitorHash(null, null)).toBeNull()
  })
})

describe('withTimeout — a slow database can never hold a scanner on a blank screen', () => {
  it('resolves with the value when it beats the budget', async () => {
    expect(await withTimeout(Promise.resolve({ data: 'ok' }), 500)).toEqual({ data: 'ok' })
  })

  it('resolves to TIMEOUT rather than hanging or throwing', async () => {
    expect(await withTimeout(new Promise(() => {}), 20)).toBe(TIMEOUT)
  })

  it('surfaces a rejection as a value instead of throwing', async () => {
    // The scan path must be able to tell "failed" from "too slow" without a
    // try/catch around the redirect.
    const out = await withTimeout(Promise.reject(new Error('db down')), 500)
    expect(out.error).toBeInstanceOf(Error)
    expect(out.error.message).toBe('db down')
  })
})
