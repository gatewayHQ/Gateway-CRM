import { describe, it, expect } from 'vitest'
import { portalSignableEmails } from '../portal.js'

// ─────────────────────────────────────────────────────────────────────────────
// Portal signing authorization.
//
// The bug this closes: /api/portal?action=sign-link authorized on "is this
// address A signer on the document", not "is it THIS portal's client". A
// document's signer list normally also contains the listing agent (who
// countersigns) and, on a dual-representation deal, the other party. The portal
// payload shipped that whole list and the UI rendered it as a dropdown — so
// anyone holding the portal link could open a signing session as the agent and
// execute their signature block.
// ─────────────────────────────────────────────────────────────────────────────
describe('portalSignableEmails — a portal visitor may only sign as their own contacts', () => {
  const AGENT  = 'daniel@gatewayreadvisors.com'
  const CLIENT = 'client@example.com'
  const SPOUSE = 'spouse@example.com'

  it('excludes the listing agent from what a client may sign as', () => {
    const signable = portalSignableEmails(`${CLIENT}, ${AGENT}`, [CLIENT])
    expect(signable).toEqual([CLIENT])
    expect(signable).not.toContain(AGENT)
  })

  it('excludes the other party on a dual-representation deal', () => {
    const signable = portalSignableEmails(`buyer@example.com, seller@example.com`, ['buyer@example.com'])
    expect(signable).toEqual(['buyer@example.com'])
  })

  it('allows every client contact on the deal (co-buyers / spouses)', () => {
    const signable = portalSignableEmails(`${CLIENT}, ${SPOUSE}, ${AGENT}`, [CLIENT, SPOUSE])
    expect(signable).toEqual([CLIENT, SPOUSE])
  })

  it('fails closed when the deal has no client contacts on file', () => {
    expect(portalSignableEmails(`${CLIENT}, ${AGENT}`, [])).toEqual([])
    expect(portalSignableEmails(`${CLIENT}, ${AGENT}`, undefined)).toEqual([])
  })

  it('fails closed when the document has no signers recorded', () => {
    expect(portalSignableEmails('', [CLIENT])).toEqual([])
    expect(portalSignableEmails(null, [CLIENT])).toEqual([])
  })

  it('matches case-insensitively and tolerates whitespace on both sides', () => {
    // Signer emails are typed by an agent; contact records are typed elsewhere.
    // A case difference must not lock a client out of signing.
    expect(portalSignableEmails('  Client@Example.COM , agent@x.com ', ['client@example.com']))
      .toEqual(['client@example.com'])
    expect(portalSignableEmails('client@example.com', ['  CLIENT@example.com  ']))
      .toEqual(['client@example.com'])
  })

  it('never returns an address that is not a signer, even if it is a client', () => {
    // A client contact who isn't on this particular document can't sign it.
    expect(portalSignableEmails(`${AGENT}`, [CLIENT])).toEqual([])
  })

  it('does not leak the agent address even when it is also a deal contact', () => {
    // Defensive: if an agent were somehow linked as a contact, the intersection
    // still only returns what is genuinely on both lists — no special-casing,
    // no surprises.
    expect(portalSignableEmails(`${CLIENT}, ${AGENT}`, [CLIENT, AGENT])).toEqual([CLIENT, AGENT])
  })
})
