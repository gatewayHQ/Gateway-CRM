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

const {
  mintUnsubscribeToken, readUnsubscribeToken, isContactUnsubscribeToken, canMintUnsubscribeTokens,
  mintRecipientUnsubscribeToken, mintOpenToken, readOpenToken,
} = await import('../_lib/unsubscribeToken.js')

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

// ─── v2: the address is the opt-out ──────────────────────────────────────────
// Mass email can go to addresses that are deliberately not contacts, and those
// people need the same one-click opt-out as anyone else. So the token stopped
// asking "which contact is this" and started asking "which mailbox is this".

describe('recipient tokens (v2)', () => {
  const EMAIL = 'Abigail.Hillers@BrownWinick.com'
  const RECIPIENT = '2b7e6c11-9c3a-4f5d-8a1b-6d0e2f3a4b5c'

  it('round-trips an address with no contact behind it', () => {
    const token = mintRecipientUnsubscribeToken({ email: EMAIL, recipientId: RECIPIENT })
    expect(readUnsubscribeToken(token)).toEqual({
      email: 'abigail.hillers@brownwinick.com',   // lower-cased: one mailbox, however typed
      contactId: null,
      recipientId: RECIPIENT,
    })
  })

  it('carries the contact too when there is one, so both records are updated', () => {
    const token = mintRecipientUnsubscribeToken({ email: EMAIL, contactId: CONTACT, recipientId: RECIPIENT })
    expect(readUnsubscribeToken(token)).toEqual({
      email: 'abigail.hillers@brownwinick.com',
      contactId: CONTACT,
      recipientId: RECIPIENT,
    })
  })

  it('refuses to mint without an address — there would be nothing to suppress', () => {
    expect(() => mintRecipientUnsubscribeToken({ email: '', contactId: CONTACT })).toThrow()
    expect(() => mintRecipientUnsubscribeToken({ email: '   ' })).toThrow()
  })

  it('still reads a v1 link, because one in an inbox cannot be re-issued', () => {
    expect(readUnsubscribeToken(mintUnsubscribeToken(CONTACT))).toEqual({ contactId: CONTACT })
  })

  it('cannot be forged by editing the address in the URL', () => {
    const token = mintRecipientUnsubscribeToken({ email: 'victim@x.com' })
    const [body, sig] = token.split('.')
    const swapped = Buffer.from(JSON.stringify({ v: 2, e: 'someone-else@x.com' })).toString('base64url')
    expect(readUnsubscribeToken(`${swapped}.${sig}`)).toBeNull()
    expect(readUnsubscribeToken(`${body}.${'x'.repeat(sig.length)}`)).toBeNull()
  })

  it('is URL-safe, so it survives being pasted out of a mail client', () => {
    expect(mintRecipientUnsubscribeToken({ email: EMAIL })).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })

  it('looks like a contact token to the router, which splits on the signature', () => {
    expect(isContactUnsubscribeToken(mintRecipientUnsubscribeToken({ email: EMAIL }))).toBe(true)
  })
})

describe('open-pixel tokens', () => {
  const RECIPIENT = '2b7e6c11-9c3a-4f5d-8a1b-6d0e2f3a4b5c'

  it('round-trips the recipient row it was minted for', () => {
    expect(readOpenToken(mintOpenToken(RECIPIENT))).toEqual({ recipientId: RECIPIENT })
  })

  it('cannot be forged, so nobody can fabricate opens for a send', () => {
    const [body, sig] = mintOpenToken(RECIPIENT).split('.')
    expect(readOpenToken(`${body}.${'x'.repeat(sig.length)}`)).toBeNull()
    expect(readOpenToken('nonsense')).toBeNull()
    expect(readOpenToken('')).toBeNull()
  })

  it('does not read an opt-out token, and an opt-out does not read a pixel token', () => {
    // Same secret, different jobs. A pixel fetch must never be able to opt
    // somebody out, and an opt-out link must never be spendable as an open.
    expect(readOpenToken(mintRecipientUnsubscribeToken({ email: 'a@x.com' }))).toBeNull()
    expect(readUnsubscribeToken(mintOpenToken(RECIPIENT))).toBeNull()
  })

  it('refuses to mint without a recipient row', () => {
    expect(() => mintOpenToken('')).toThrow()
  })
})
