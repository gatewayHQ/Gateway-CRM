import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  emailProvider, emailConfigured, appBaseUrl, buildGraphMessage,
  brandedEmail, brandedEmailText, esc,
} from '../_lib/email.js'

// Provider selection reads process.env at call time, so each test sets exactly
// the vars it cares about and restores the original environment afterward.
const EMAIL_VARS = [
  'EMAIL_PROVIDER', 'MS365_TENANT_ID', 'MS365_CLIENT_ID', 'MS365_CLIENT_SECRET',
  'MS365_SENDER', 'MS365_SENDER_NAME', 'RESEND_API_KEY', 'RESEND_FROM',
  'APP_BASE_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL',
]
let saved = {}

beforeEach(() => {
  saved = {}
  for (const k of EMAIL_VARS) { saved[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of EMAIL_VARS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function setGraph() {
  process.env.MS365_TENANT_ID     = 'tenant-1'
  process.env.MS365_CLIENT_ID     = 'client-1'
  process.env.MS365_CLIENT_SECRET = 'secret-1'
  process.env.MS365_SENDER        = 'noreply@gatewayreadvisors.com'
}
function setResend() {
  process.env.RESEND_API_KEY = 're_test'
  process.env.RESEND_FROM    = 'Gateway <hello@gatewayreadvisors.com>'
}

describe('emailProvider — transport selection', () => {
  it('returns null when nothing is configured, so callers can skip silently', () => {
    expect(emailProvider()).toBeNull()
    expect(emailConfigured()).toBe(false)
  })

  it('picks graph when only Microsoft 365 is configured', () => {
    setGraph()
    expect(emailProvider()).toBe('graph')
    expect(emailConfigured()).toBe(true)
  })

  it('picks resend when only Resend is configured', () => {
    setResend()
    expect(emailProvider()).toBe('resend')
  })

  it('prefers graph when both are configured', () => {
    // A tenant carrying both has deliberately moved to its own mail.
    setGraph(); setResend()
    expect(emailProvider()).toBe('graph')
  })

  it('honors EMAIL_PROVIDER to pin a transport', () => {
    setGraph(); setResend()
    process.env.EMAIL_PROVIDER = 'resend'
    expect(emailProvider()).toBe('resend')
    process.env.EMAIL_PROVIDER = 'GRAPH'   // case-insensitive
    expect(emailProvider()).toBe('graph')
  })

  it('returns null when EMAIL_PROVIDER pins a transport that is not configured', () => {
    // Failing closed beats silently falling back to the other provider — a
    // staging deploy pinned to resend must not start sending as the real
    // brokerage mailbox because someone forgot a key.
    setResend()
    process.env.EMAIL_PROVIDER = 'graph'
    expect(emailProvider()).toBeNull()
  })

  it('treats a partially-configured Microsoft 365 as not configured', () => {
    process.env.MS365_TENANT_ID = 'tenant-1'
    process.env.MS365_CLIENT_ID = 'client-1'
    // secret and sender missing
    expect(emailProvider()).toBeNull()
  })
})

describe('appBaseUrl', () => {
  it('returns empty when no URL is resolvable', () => {
    expect(appBaseUrl()).toBe('')
  })

  it('prefers APP_BASE_URL and strips trailing slashes', () => {
    process.env.APP_BASE_URL = 'https://crm.example.com///'
    process.env.VERCEL_URL   = 'ignored.vercel.app'
    expect(appBaseUrl()).toBe('https://crm.example.com')
  })

  it('adds https:// to a bare Vercel host', () => {
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'gateway-crm.vercel.app'
    expect(appBaseUrl()).toBe('https://gateway-crm.vercel.app')
  })

  it('falls back to the deployment URL on preview builds', () => {
    process.env.VERCEL_URL = 'gateway-crm-abc123.vercel.app'
    expect(appBaseUrl()).toBe('https://gateway-crm-abc123.vercel.app')
  })
})

describe('buildGraphMessage', () => {
  it('wraps a single recipient in Graph\'s shape', () => {
    const m = buildGraphMessage({ to: 'a@b.com', subject: 'Hi', html: '<p>x</p>' })
    expect(m.message.subject).toBe('Hi')
    expect(m.message.toRecipients).toEqual([{ emailAddress: { address: 'a@b.com' } }])
    expect(m.message.body).toEqual({ contentType: 'HTML', content: '<p>x</p>' })
  })

  it('accepts an array of recipients and drops empties', () => {
    const m = buildGraphMessage({ to: ['a@b.com', '', null, 'c@d.com'], subject: 'Hi', text: 'x' })
    expect(m.message.toRecipients).toHaveLength(2)
  })

  it('falls back to a plain-text body when there is no html', () => {
    const m = buildGraphMessage({ to: 'a@b.com', subject: 'Hi', text: 'plain' })
    expect(m.message.body).toEqual({ contentType: 'Text', content: 'plain' })
  })

  it('does not keep a copy in the sending mailbox', () => {
    // Notifications, not correspondence — thousands of these would bury Sent Items.
    expect(buildGraphMessage({ to: 'a@b.com', subject: 'x', text: 'y' }).saveToSentItems).toBe(false)
  })

  it('includes replyTo only when given', () => {
    expect(buildGraphMessage({ to: 'a@b.com', subject: 'x', text: 'y' }).message.replyTo).toBeUndefined()
    const m = buildGraphMessage({ to: 'a@b.com', subject: 'x', text: 'y', replyTo: 'r@s.com' })
    expect(m.message.replyTo).toEqual([{ emailAddress: { address: 'r@s.com' } }])
  })
})

describe('brandedEmail', () => {
  it('renders the Gateway header and escapes interpolated values', () => {
    const html = brandedEmail({
      eyebrow: 'Signature complete',
      headline: 'Smith & Co <Listing> is signed',
      rows: [{ label: 'Deal', value: '"Quoted" & co' }],
    })
    expect(html).toContain('Gateway')
    expect(html).toContain('Smith &amp; Co &lt;Listing&gt;')
    expect(html).not.toContain('<Listing>')
    expect(html).toContain('&quot;Quoted&quot; &amp; co')
  })

  it('omits the button when no URL is given', () => {
    expect(brandedEmail({ headline: 'x' })).not.toContain('<a href')
    expect(brandedEmail({ headline: 'x', ctaUrl: 'https://c.example.com' })).toContain('<a href')
  })

  it('drops detail rows with no value rather than printing a blank label', () => {
    const html = brandedEmail({ headline: 'x', rows: [{ label: 'Deal', value: '' }, { label: 'Signed by', value: 'Jane' }] })
    expect(html).not.toContain('Deal')
    expect(html).toContain('Signed by')
  })
})

describe('brandedEmailText', () => {
  it('lists rows and omits the CRM line when there is no URL', () => {
    const text = brandedEmailText({ headline: 'Signed', rows: [{ label: 'Deal', value: '9 Oak' }], note: 'All done' })
    expect(text).toContain('Deal: 9 Oak')
    expect(text).toContain('All done')
    expect(text).not.toContain('Open the CRM')
  })
})

describe('esc', () => {
  it('handles null and undefined without printing them', () => {
    expect(esc(null)).toBe('')
    expect(esc(undefined)).toBe('')
    expect(esc(0)).toBe('0')
  })
})
