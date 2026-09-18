// ─────────────────────────────────────────────────────────────────────────────
// THE UNSUBSCRIBE LINK IN A DEAL ANNOUNCEMENT.
//
// A recipient's opt-out link has to satisfy three things at once:
//
//   • It must work with NO login, months after the email was sent. An opt-out
//     that has expired is an opt-out that doesn't exist, and the recipient who
//     finds it broken reports the message instead.
//   • It must not be guessable. A sequential or bare-id link lets anyone walk
//     the contact book and opt out an agent's whole database.
//   • It must identify exactly one contact, so the opt-out lands on the right
//     person rather than on "whoever that address belongs to today".
//
// A SIGNED token does all three with no new column and nothing to migrate: the
// contact id travels in the link, and an HMAC the server alone can produce
// proves the link came from us. Nothing to store means nothing to back-fill for
// the contacts that already exist, and no per-contact secret to leak.
//
// Deliberately NOT time-limited — see the first bullet. This is the one token
// in the codebase that is supposed to outlive everything around it.
//
// ── TWO SHAPES, BECAUSE NOT EVERY RECIPIENT IS A CONTACT ─────────────────────
//
// v1 carries a contact id. It is what the first announcements shipped with and
// is read forever: a link in somebody's inbox is not something we get to
// re-issue.
//
// v2 carries the ADDRESS, plus the contact id and blast-recipient row when
// there are any. Mass email can now go to a pasted list of addresses that are
// deliberately NOT contacts (an agent with 122 owners off a county roll should
// not have to pollute the contact book to mail them). Those people need the
// same one-click opt-out as anyone else — an email with no working unsubscribe
// is the one thing a bulk send must never be — so the token stopped being
// "which contact is this" and became "which mailbox is this".
//
// Carrying all three means one opt-out does all the things it should: the
// address goes on the suppression list, the contact record (if there is one)
// gets email_opt_out, and the recipient row is stamped so the send's own report
// can say who left.
//
// Server-only (api/_lib/* is never bundled into the browser build): the signing
// secret must never reach a page.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto'

// Shares the signing secret the QR scan pipeline already uses, falling back to
// the service key — the same chain api/campaigns.js follows, so a deployment
// that can talk to Supabase at all can also mint and verify these.
function signingSecret() {
  return process.env.UNSUBSCRIBE_SIGNING_SECRET
      || process.env.SCAN_SIGNING_SECRET
      || process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || ''
}

const b64u = {
  enc: obj => Buffer.from(JSON.stringify(obj)).toString('base64url'),
  dec: str => JSON.parse(Buffer.from(String(str), 'base64url').toString('utf8')),
}

const mac = (body, secret) =>
  crypto.createHmac('sha256', secret).update(body).digest('base64url').slice(0, 32)

/**
 * True when this deployment can mint unsubscribe links at all.
 *
 * Checked BEFORE a blast sends its first message rather than per recipient: a
 * send that goes out without working opt-out links is the failure this whole
 * module exists to prevent, and it is not one to discover halfway through 250
 * recipients.
 */
export function canMintUnsubscribeTokens() {
  return Boolean(signingSecret())
}

/** A permanent, unguessable opt-out token for one contact. */
export function mintUnsubscribeToken(contactId) {
  const secret = signingSecret()
  if (!secret) throw new Error('Server misconfigured: no signing secret for unsubscribe links')
  if (!contactId) throw new Error('mintUnsubscribeToken requires a contact id')
  const body = b64u.enc({ v: 1, c: String(contactId) })
  return `${body}.${mac(body, secret)}`
}

/**
 * The contact id inside a token, or null if the token is not one we issued.
 *
 * Timing-safe compare so the MAC cannot be probed a byte at a time, and every
 * malformed shape returns the same null — a caller must not be able to tell a
 * forged signature from a truncated link.
 */
export function readUnsubscribeToken(token) {
  const obj = verified(token)
  if (!obj) return null
  // v1: the original contact-only link. Its shape is part of the contract —
  // links minted before v2 existed still arrive and must read the same.
  if (obj.v === 1 && obj.c) return { contactId: String(obj.c) }
  // v2: an address, which every recipient has, plus whatever else we knew.
  if (obj.v === 2 && obj.e) {
    return {
      email:       String(obj.e),
      contactId:   obj.c ? String(obj.c) : null,
      recipientId: obj.r ? String(obj.r) : null,
    }
  }
  return null
}

/** Shared verify step: signature first, then let each reader judge the shape. */
function verified(token) {
  try {
    const secret = signingSecret()
    if (!secret) return null
    const [body, sig] = String(token || '').split('.')
    if (!body || !sig) return null
    const want = mac(body, secret)
    const a = Buffer.from(sig), b = Buffer.from(want)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    return b64u.dec(body)
  } catch { return null }
}

/**
 * The opt-out token for one recipient of one blast — contact or pasted address.
 *
 * `email` is required because it is the only identifier every recipient has,
 * and because suppression is per MAILBOX: the person who opts out is telling us
 * not to mail that address again, whether or not a contact record exists for it
 * today or gets created next month.
 */
export function mintRecipientUnsubscribeToken({ email, contactId = null, recipientId = null }) {
  const secret = signingSecret()
  if (!secret) throw new Error('Server misconfigured: no signing secret for unsubscribe links')
  const addr = String(email || '').trim().toLowerCase()
  if (!addr) throw new Error('mintRecipientUnsubscribeToken requires an email address')
  const payload = { v: 2, e: addr }
  if (contactId)   payload.c = String(contactId)
  if (recipientId) payload.r = String(recipientId)
  const body = b64u.enc(payload)
  return `${body}.${mac(body, secret)}`
}

/**
 * The token behind an open-tracking pixel.
 *
 * Signed for the same reason the opt-out link is: an unsigned or sequential id
 * would let anyone inflate — or, worse, fabricate — the open record for a send
 * they never received. It identifies a recipient ROW, not a person, so it says
 * nothing about who was mailed if the URL leaks out of the email.
 */
export function mintOpenToken(recipientId) {
  const secret = signingSecret()
  if (!secret) throw new Error('Server misconfigured: no signing secret for tracking pixels')
  if (!recipientId) throw new Error('mintOpenToken requires a recipient id')
  const body = b64u.enc({ v: 1, o: String(recipientId) })
  return `${body}.${mac(body, secret)}`
}

/** The recipient row a pixel token points at, or null if we didn't issue it. */
export function readOpenToken(token) {
  const obj = verified(token)
  if (!obj || obj.v !== 1 || !obj.o) return null
  return { recipientId: String(obj.o) }
}

/**
 * Does this look like a contact opt-out token rather than a mailing-list one?
 *
 * The two kinds share the /u/:token path. A mailing subscriber's token is a
 * bare hex string from the database; a contact's carries its signature after a
 * dot, which a hex token can never contain.
 */
export const isContactUnsubscribeToken = (token) => String(token || '').includes('.')
