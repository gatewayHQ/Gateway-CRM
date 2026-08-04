/**
 * Gateway CRM — shared transactional email
 *
 * One entry point, `sendEmail()`, over two interchangeable transports:
 *
 *   graph   Microsoft 365 via the Graph API      (this brokerage's mail)
 *   resend  Resend's HTTP API                    (the original provider)
 *
 * WHY THIS FILE EXISTS
 *   `api/email-send.js` is an HTTP endpoint, not a module — a serverless
 *   function cannot import it without paying for a second network round trip and
 *   having to know its own absolute URL. Internal senders (the cron worker, the
 *   BoldSign webhook) therefore talk to the provider directly. That helper used
 *   to be a private function inside cron.js, so the BoldSign webhook had nothing
 *   to call; rather than copy it, it moved here and grew a second transport.
 *
 * WHY GRAPH AND NOT SMTP FOR MICROSOFT 365
 *   Sending through smtp.office365.com is the obvious route and the wrong one
 *   here:
 *     • SMTP AUTH is disabled by default on modern M365 tenants and has to be
 *       re-enabled per mailbox, and Microsoft has spent years narrowing basic
 *       auth on it. Graph is the path they actually support going forward.
 *     • SMTP needs a real socket on port 587. Serverless functions are a poor
 *       host for that — a fresh connection and TLS handshake on every cold
 *       invocation, and some platforms block outbound 587 entirely.
 *     • SMTP would add nodemailer to the bundle. Graph is plain fetch, exactly
 *       like the Resend transport next to it.
 *     • Graph authenticates as an Azure app with its own client secret, so no
 *       user's mailbox password is ever stored in an env var.
 *
 * SETUP — Microsoft 365 (Azure portal, one-time, needs a tenant admin)
 *   1. Entra ID → App registrations → New registration. Name it "Gateway CRM
 *      Mail". Single tenant. No redirect URI.
 *   2. Copy the Application (client) ID and Directory (tenant) ID.
 *   3. Certificates & secrets → New client secret. Copy the VALUE immediately;
 *      it is never shown again. Note its expiry — mail stops when it lapses.
 *   4. API permissions → Add a permission → Microsoft Graph → APPLICATION
 *      permissions (not delegated) → Mail.Send → Add, then Grant admin consent.
 *   5. Recommended: scope the app so it can only send as the one mailbox you
 *      intend, rather than every mailbox in the tenant. In Exchange Online
 *      PowerShell:
 *        New-ApplicationAccessPolicy -AppId <client-id> `
 *          -PolicyScopeGroupId <mail-enabled-security-group> `
 *          -AccessRight RestrictAccess
 *      Without this, Mail.Send grants the app send-as rights tenant-wide.
 *   6. Set MS365_TENANT_ID, MS365_CLIENT_ID, MS365_CLIENT_SECRET and
 *      MS365_SENDER (the mailbox to send from) in Vercel, then redeploy.
 */

// ─── Provider resolution ─────────────────────────────────────────────────────

function graphEnv() {
  return {
    tenantId:     process.env.MS365_TENANT_ID     || '',
    clientId:     process.env.MS365_CLIENT_ID     || '',
    clientSecret: process.env.MS365_CLIENT_SECRET || '',
    sender:       process.env.MS365_SENDER        || '',
    senderName:   process.env.MS365_SENDER_NAME   || 'Gateway Real Estate Advisors',
  }
}

/** Resend credentials, or empty strings when it isn't configured. */
export function emailEnv() {
  return {
    key:  process.env.RESEND_API_KEY || '',
    from: process.env.RESEND_FROM    || '',
  }
}

/**
 * Which transport this deployment will use: 'graph' | 'resend' | null.
 *
 * EMAIL_PROVIDER forces a choice when both are configured (useful for a staging
 * deploy that should not send as the real brokerage mailbox). Otherwise Graph
 * wins, because a tenant that has both configured has deliberately moved.
 * Exported so a caller can log which path it took.
 */
export function emailProvider() {
  const forced = (process.env.EMAIL_PROVIDER || '').trim().toLowerCase()
  const g = graphEnv()
  const graphReady  = Boolean(g.tenantId && g.clientId && g.clientSecret && g.sender)
  const { key, from } = emailEnv()
  const resendReady = Boolean(key && from)

  if (forced === 'graph')  return graphReady  ? 'graph'  : null
  if (forced === 'resend') return resendReady ? 'resend' : null
  if (graphReady)  return 'graph'
  if (resendReady) return 'resend'
  return null
}

/** True when this deployment can actually send mail by some route. */
export function emailConfigured() {
  return emailProvider() !== null
}

/**
 * Absolute base URL of this app, for "open the CRM" buttons in emails.
 *
 * APP_BASE_URL wins when set. Otherwise Vercel's own vars are used, so a normal
 * deployment needs no configuration:
 *   VERCEL_PROJECT_PRODUCTION_URL — the stable production domain
 *   VERCEL_URL                    — this specific deployment (preview builds)
 * Returns '' when nothing is available; callers must omit the button rather than
 * emit a broken link.
 */
export function appBaseUrl() {
  const raw = process.env.APP_BASE_URL
    || process.env.VERCEL_PROJECT_PRODUCTION_URL
    || process.env.VERCEL_URL
    || ''
  const trimmed = String(raw).trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

// ─── Microsoft Graph transport ───────────────────────────────────────────────

// Access tokens last an hour. Module scope survives warm invocations, so a busy
// deployment fetches one token instead of one per email. Refreshed 60s early to
// avoid racing the expiry.
let tokenCache = { token: '', expiresAt: 0 }

/** Reset the cached token. Tests only — never call this from request code. */
export function _resetGraphTokenCache() {
  tokenCache = { token: '', expiresAt: 0 }
}

async function graphToken({ tenantId, clientId, clientSecret }) {
  const now = Date.now()
  if (tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token

  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
      scope:         'https://graph.microsoft.com/.default',
    }),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok || !body.access_token) {
    // AADSTS codes are the useful part — surface them rather than a bare 401.
    throw new Error(body.error_description || body.error || `token request failed (HTTP ${r.status})`)
  }
  tokenCache = {
    token:     body.access_token,
    expiresAt: now + (Number(body.expires_in || 3600) - 60) * 1000,
  }
  return tokenCache.token
}

/**
 * Build a Graph sendMail body. Pure, so the shape can be asserted in tests.
 *
 * Graph's JSON sendMail carries ONE body, either HTML or Text — there is no
 * multipart/alternative without hand-rolling MIME and using a different
 * endpoint. HTML wins when present; the plain-text twin is dropped. Every modern
 * client renders HTML, and the alternative is worse than the tradeoff.
 */
export function buildGraphMessage({ to, subject, html, text, replyTo }) {
  const recipients = (Array.isArray(to) ? to : [to])
    .filter(Boolean)
    .map(address => ({ emailAddress: { address } }))
  return {
    message: {
      subject: subject || '',
      body: html
        ? { contentType: 'HTML', content: html }
        : { contentType: 'Text', content: text || '' },
      toRecipients: recipients,
      ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
    },
    // These are notifications, not correspondence — keeping a copy of every one
    // would bury the sending mailbox's Sent Items.
    saveToSentItems: false,
  }
}

async function sendViaGraph({ to, subject, html, text, replyTo }) {
  const env = graphEnv()
  const token = await graphToken(env)
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.sender)}/sendMail`
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGraphMessage({ to, subject, html, text, replyTo })),
  })
  // sendMail answers 202 Accepted with an empty body on success.
  if (r.status === 202 || r.ok) return { ok: true, provider: 'graph', status: r.status }
  const body = await r.json().catch(() => ({}))
  return {
    ok: false, provider: 'graph', status: r.status,
    error: body?.error?.message || body?.error_description || `Graph sendMail failed (HTTP ${r.status})`,
  }
}

// ─── Resend transport ────────────────────────────────────────────────────────

/**
 * POST one email to Resend. Never throws — returns { ok, ... } so a caller in a
 * webhook can log a failure and still answer 200.
 *
 * Kept exported with its original signature: api/email-send.js lets a caller
 * supply their own Resend key per request, which bypasses provider selection.
 */
export async function sendResend(apiKey, from, to, subject, html, text, idempotencyKey) {
  if (!apiKey || !from || !to) return { ok: false, reason: 'missing email config' }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers,
      body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html, text }),
    })
    const body = await r.json().catch(() => ({}))
    return { ok: r.ok, provider: 'resend', status: r.status, id: body?.id, error: body?.message || body?.error, body }
  } catch (e) {
    // A DNS/socket failure reaching Resend must not take down the caller.
    return { ok: false, provider: 'resend', error: e.message }
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Send one email over whichever transport this deployment is configured for.
 * Never throws: returns { ok, provider, error? }. Callers in webhooks and cron
 * jobs log a failure and carry on.
 *
 * `idempotencyKey` is honored by Resend only — Graph has no equivalent, so
 * callers that must not double-send need their own guard upstream rather than
 * relying on the transport.
 */
export async function sendEmail({ to, subject, html, text, replyTo, idempotencyKey }) {
  if (!to)      return { ok: false, reason: 'no recipient' }
  if (!subject) return { ok: false, reason: 'no subject' }

  const provider = emailProvider()
  if (!provider) return { ok: false, reason: 'no email provider configured' }

  try {
    if (provider === 'graph') return await sendViaGraph({ to, subject, html, text, replyTo })
    const { key, from } = emailEnv()
    return await sendResend(key, from, to, subject, html, text, idempotencyKey)
  } catch (e) {
    // Graph's token fetch throws; nothing above this line may propagate.
    return { ok: false, provider, error: e.message }
  }
}

// ─── Branded HTML shell ──────────────────────────────────────────────────────

/**
 * Escape interpolated values. Deal titles, document names and signer names are
 * user-entered and land inside HTML — an unescaped `&` or `<` silently corrupts
 * the markup in some clients.
 */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const INK      = '#1e2642'
const MUTED    = '#9aa3b2'
const BRAND    = '#2d3561'
const SURFACE  = '#f7f8fa'
const HAIRLINE = '#e6e9ef'

/**
 * The Gateway email shell — same visual language as the existing deadline
 * reminder mail in api/cron.js, extracted so every automated email matches.
 *
 *   eyebrow   small label above the headline ("Signature complete")
 *   headline  the one sentence the agent needs to read
 *   accent    headline emphasis color (semantic: good / warning / critical)
 *   rows      [{ label, value }] rendered as a detail block
 *   note      supporting sentence under the detail block
 *   ctaLabel  button text — omitted entirely when ctaUrl is falsy
 *   ctaUrl    absolute URL for the button
 *   footNote  small print at the bottom of the card
 *
 * All values are escaped here, so callers pass plain strings.
 */
export function brandedEmail({ eyebrow, headline, accent = BRAND, rows = [], note, ctaLabel, ctaUrl, footNote }) {
  const detail = rows.filter(r => r && r.value).map(r => `
      <tr>
        <td style="padding:0 0 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${MUTED};width:38%;vertical-align:top">${esc(r.label)}</td>
        <td style="padding:0 0 8px;font-size:14px;color:${INK};vertical-align:top">${esc(r.value)}</td>
      </tr>`).join('')

  const button = ctaUrl ? `
    <a href="${esc(ctaUrl)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:8px">${esc(ctaLabel || 'Open Gateway CRM')}</a>` : ''

  return `<!DOCTYPE html>
<html><body style="font-family:DM Sans,system-ui,-apple-system,sans-serif;color:${INK};margin:0;padding:0;background:${SURFACE}">
<div style="max-width:540px;margin:32px auto;background:#ffffff;border-radius:12px;border:1px solid ${HAIRLINE};overflow:hidden">
  <div style="background:${BRAND};padding:20px 28px">
    <div style="font-family:Cormorant Garamond,Georgia,serif;font-size:22px;font-weight:600;color:#ffffff">Gateway</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.6);letter-spacing:0.04em">Real Estate Advisors</div>
  </div>
  <div style="padding:28px">
    ${eyebrow ? `<div style="font-size:13px;color:${MUTED};margin-bottom:6px">${esc(eyebrow)}</div>` : ''}
    <div style="font-size:21px;font-weight:700;line-height:1.35;color:${accent};margin-bottom:20px">${esc(headline)}</div>
    ${detail ? `<div style="background:${SURFACE};border-radius:8px;padding:16px 18px;margin-bottom:20px">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">${detail}</table>
    </div>` : ''}
    ${note ? `<div style="font-size:14px;line-height:1.6;color:${INK};margin-bottom:22px">${esc(note)}</div>` : ''}
    ${button}
    ${footNote ? `<div style="font-size:12px;color:${MUTED};margin-top:22px;padding-top:16px;border-top:1px solid ${HAIRLINE}">${esc(footNote)}</div>` : ''}
  </div>
</div>
</body></html>`
}

/** Plain-text twin of brandedEmail, for clients that refuse HTML. */
export function brandedEmailText({ headline, rows = [], note, ctaUrl }) {
  const lines = ['GATEWAY REAL ESTATE ADVISORS', '', headline, '']
  for (const r of rows.filter(x => x && x.value)) lines.push(`${r.label}: ${r.value}`)
  if (note)   lines.push('', note)
  if (ctaUrl) lines.push('', `Open the CRM: ${ctaUrl}`)
  return lines.join('\n')
}
