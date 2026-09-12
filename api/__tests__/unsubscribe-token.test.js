/**
 * The opt-out link's token.
 *
 * Everything here is about one question: can somebody who is not us opt out a
 * contact they were never sent an email about? A guessable or forgeable token
 * means anyone can walk an agent's contact book and suppress the whole thing.
 *
 * The second property is the unglamorous one — these links must still work
 * months later. A token that expires is a legal opt-out that quietly stopped
 * being one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

process.env.UNSUBSCRIBE_SIGNING_SECRET = 'test-signing-secret'

const { mintUnsubscribeToken, readUnsubscribeToken, isContactUnsubscribeToken, canMintUnsubscribeTokens } =
  await import('../_lib/unsubscribeToken.js')

const CONTACT = '9f1c0c62-7d7e-4c31-9a3f-1f8d9f2b4c55'

describe('mint / read', () => {
  it('round-trips the contact it was minted for', () => {
    const token = mintUnsubscribeToken(CONTACT)
    expect(readUnsubscribeToken(token)).toEqual({ contactId: CONTACT })
  })

  it('gives a different token to a different contact', () => {
    expect(mintUnsubscribeToken(CONTACT)).not.toBe(mintUnsubscribeToken('other-id'))
  })

  it('is stable, so a link printed today still resolves tomorrow', () => {
    expect(mintUnsubscribeToken(CONTACT)).toBe(mintUnsubscribeToken(CONTACT))
  })

  it('is URL-safe — it has to survive being pasted out of an email client', () => {
    expect(mintUnsubscribeToken(CONTACT)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })

  it('refuses to mint without a contact', () => {
    expect(() => mintUnsubscribeToken('')).toThrow()
  })
})

describe('a token we did not issue', () => {
  it('rejects a tampered payload', () => {
    const [body, sig] = mintUnsubscribeToken(CONTACT).split('.')
    const forged = Buffer.from(JSON.stringify({ v: 1, c: 'someone-else' })).toString('base64url')
    expect(readUnsubscribeToken(`${forged}.${sig}`)).toBeNull()
  })

  it('rejects a tampered signature', () => {
    const [body] = mintUnsubscribeToken(CONTACT).split('.')
    expect(readUnsubscribeToken(`${body}.${'a'.repeat(32)}`)).toBeNull()
  })

  it('rejects a signature of the wrong length without throwing', () => {
    // timingSafeEqual throws on a length mismatch — a probe must get null, not
    // a 500 that tells the prober they found the boundary.
    const [body] = mintUnsubscribeToken(CONTACT).split('.')
    expect(readUnsubscribeToken(`${body}.short`)).toBeNull()
  })

  it('rejects junk, empties and the wrong shape', () => {
    for (const bad of ['', null, undefined, 'nodot', 'a.b', '....', 'YWJj.YWJj']) {
      expect(readUnsubscribeToken(bad)).toBeNull()
    }
  })

  it('rejects a payload from a future version rather than guessing', () => {
    const body = Buffer.from(JSON.stringify({ v: 2, c: CONTACT })).toString('base64url')
    // Signed correctly, but a shape this code does not claim to understand.
    const token = mintUnsubscribeToken(CONTACT)
    expect(readUnsubscribeToken(`${body}.${token.split('.')[1]}`)).toBeNull()
  })
})

describe('isContactUnsubscribeToken', () => {
  it('tells a signed contact token from a mailing subscriber’s hex token', () => {
    expect(isContactUnsubscribeToken(mintUnsubscribeToken(CONTACT))).toBe(true)
    expect(isContactUnsubscribeToken('a3f91c0c627d7e4c319a3f1f8d9f2b4c')).toBe(false)
    expect(isContactUnsubscribeToken('')).toBe(false)
  })
})

describe('with no signing secret configured', () => {
  const saved = { u: process.env.UNSUBSCRIBE_SIGNING_SECRET, s: process.env.SCAN_SIGNING_SECRET,
                  k: process.env.SUPABASE_SERVICE_KEY, r: process.env.SUPABASE_SERVICE_ROLE_KEY }
  beforeEach(() => {
    delete process.env.UNSUBSCRIBE_SIGNING_SECRET
    delete process.env.SCAN_SIGNING_SECRET
    delete process.env.SUPABASE_SERVICE_KEY
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })
  afterEach(() => {
    process.env.UNSUBSCRIBE_SIGNING_SECRET = saved.u
    if (saved.s) process.env.SCAN_SIGNING_SECRET = saved.s
    if (saved.k) process.env.SUPABASE_SERVICE_KEY = saved.k
    if (saved.r) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.r
  })

  it('says so, and refuses to mint an unverifiable link', () => {
    expect(canMintUnsubscribeTokens()).toBe(false)
    expect(() => mintUnsubscribeToken(CONTACT)).toThrow(/signing secret/i)
  })

  it('accepts nothing, so an unsigned deployment cannot be talked into an opt-out', () => {
    expect(readUnsubscribeToken('YWJj.YWJj')).toBeNull()
  })
})
