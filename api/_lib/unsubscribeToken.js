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
  try {
    const secret = signingSecret()
    if (!secret) return null
    const [body, sig] = String(token || '').split('.')
    if (!body || !sig) return null
    const want = mac(body, secret)
    const a = Buffer.from(sig), b = Buffer.from(want)
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
    const obj = b64u.dec(body)
    if (obj?.v !== 1 || !obj?.c) return null
    return { contactId: String(obj.c) }
  } catch { return null }
}

/**
 * Does this look like a contact opt-out token rather than a mailing-list one?
 *
 * The two kinds share the /u/:token path. A mailing subscriber's token is a
 * bare hex string from the database; a contact's carries its signature after a
 * dot, which a hex token can never contain.
 */
export const isContactUnsubscribeToken = (token) => String(token || '').includes('.')
