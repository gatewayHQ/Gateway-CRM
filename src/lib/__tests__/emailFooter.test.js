import { describe, it, expect } from 'vitest'
import {
  COMPANY, unsubscribeUrl, renderEmailFooterHtml, emailFooterText,
  PREVIEW_UNSUBSCRIBE_URL, escapeHtml,
} from '../emailFooter.js'

// ─────────────────────────────────────────────────────────────────────────────
// The footer is the part of a bulk email that stops it being a complaint. Two
// things have to be in every message — a postal address and an opt-out the
// recipient can operate themselves — and neither can be quietly dropped by a
// caller that forgets to pass something.
// ─────────────────────────────────────────────────────────────────────────────

describe('COMPANY', () => {
  it('has a real postal address, not a placeholder', () => {
    // A blank or obviously fake address ships to every recipient and is exactly
    // as non-compliant as having none at all.
    expect(COMPANY.address).toBeTruthy()
    expect(COMPANY.address).toMatch(/\d/)                       // a street number
    expect(COMPANY.address).toMatch(/[A-Z]{2}\s+\d{5}/)         // state + ZIP
    expect(COMPANY.address.toLowerCase()).not.toMatch(/todo|tbd|xxx|placeholder/)
  })
})

describe('unsubscribeUrl', () => {
  it('builds a /u/:token link on the deployment it was sent from', () => {
    expect(unsubscribeUrl('https://crm.example.com', 'abc.def')).toBe('https://crm.example.com/u/abc.def')
  })

  it('does not care about a trailing slash on the base', () => {
    expect(unsubscribeUrl('https://crm.example.com/', 'tok')).toBe('https://crm.example.com/u/tok')
  })

  it('returns nothing rather than a broken link when it has nothing to build from', () => {
    expect(unsubscribeUrl('', 'tok')).toBe('')
    expect(unsubscribeUrl('https://crm.example.com', '')).toBe('')
  })
})

describe('renderEmailFooterHtml', () => {
  const html = (over = {}) => renderEmailFooterHtml({
    agentName: 'Daniel Ryan', unsubscribeUrl: 'https://crm.example.com/u/tok', ...over,
  })

  it('carries the sender, the postal address and the opt-out', () => {
    const out = html()
    expect(out).toContain('Daniel Ryan')
    expect(out).toContain(COMPANY.name)
    expect(out).toContain(COMPANY.address)
    expect(out).toContain('href="https://crm.example.com/u/tok"')
    expect(out).toContain('Unsubscribe')
  })

  it('says why the person is receiving it', () => {
    expect(html()).toMatch(/receiving this because/i)
    expect(html({ reason: 'You asked to hear about Sioux City listings.' }))
      .toContain('You asked to hear about Sioux City listings.')
  })

  it('omits the opt-out line entirely rather than linking nowhere', () => {
    // A visible "Unsubscribe" that does nothing is worse than no link: the
    // recipient believes they have opted out and reports the next one as spam.
    const out = html({ unsubscribeUrl: '' })
    expect(out).not.toContain('Unsubscribe')
    expect(out).not.toContain('href=""')
    expect(out).toContain(COMPANY.address)      // the address still has to be there
  })

  it('escapes a name that would otherwise break out of the markup', () => {
    const out = html({ agentName: '<script>alert(1)</script>' })
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('still renders in a preview, with a link that goes nowhere real', () => {
    const out = html({ unsubscribeUrl: PREVIEW_UNSUBSCRIBE_URL })
    expect(out).toContain('Unsubscribe')
    expect(out).toContain(PREVIEW_UNSUBSCRIBE_URL)
    expect(PREVIEW_UNSUBSCRIBE_URL.startsWith('#')).toBe(true)   // never leaves the page
  })
})

describe('emailFooterText', () => {
  it('carries the same three facts in plain text', () => {
    const out = emailFooterText({ agentName: 'Daniel Ryan', unsubscribeUrl: 'https://x.test/u/t' })
    expect(out).toContain('Daniel Ryan')
    expect(out).toContain(COMPANY.address)
    expect(out).toContain('Unsubscribe: https://x.test/u/t')
  })
})

describe('escapeHtml', () => {
  it('escapes every character that can change the meaning of markup', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
    expect(escapeHtml(null)).toBe('')
  })
})
