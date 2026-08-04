/**
 * Gateway CRM — shared transactional email helper
 *
 * Server-side only. Two things live here:
 *
 *   sendResend()    the raw Resend call, previously duplicated inside api/cron.js
 *   brandedEmail()  the Gateway-branded HTML shell every automated email uses
 *
 * WHY THIS FILE EXISTS
 *   `api/email-send.js` is an HTTP endpoint, not a module — a serverless function
 *   cannot import it without paying for a second network round trip and having to
 *   know its own absolute URL. Internal senders (the cron worker, the BoldSign
 *   webhook) therefore talk to Resend directly. That helper used to be a private
 *   function inside cron.js, so the BoldSign webhook had nothing to call; rather
 *   than copy it and let the two drift, it moved here.
 *
 *   `api/email-send.js` stays as-is: it is the *browser's* path to sending mail
 *   (rate limited, key kept server-side) and has different concerns.
 */

// ─── Config ──────────────────────────────────────────────────────────────────

/** Resend credentials, or nulls when email isn't configured on this deployment. */
export function emailEnv() {
  return {
    key:  process.env.RESEND_API_KEY || '',
    from: process.env.RESEND_FROM    || '',
  }
}

/** True when this deployment can actually send mail. */
export function emailConfigured() {
  const { key, from } = emailEnv()
  return Boolean(key && from)
}

/**
 * Absolute base URL of this app, for "open the CRM" buttons in emails.
 *
 * APP_BASE_URL wins when set. Otherwise Vercel's own vars are used, so a normal
 * deployment needs no configuration at all:
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

// ─── Send ────────────────────────────────────────────────────────────────────

/**
 * POST one email to Resend. Never throws — returns { ok, ... } so a caller in a
 * webhook can log a failure and still answer 200.
 *
 * `idempotencyKey` is honored by Resend, so a retried webhook delivery does not
 * send the same notification twice.
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
    return { ok: r.ok, status: r.status, id: body?.id, error: body?.message || body?.error, body }
  } catch (e) {
    // A DNS/socket failure reaching Resend must not take down the caller.
    return { ok: false, error: e.message }
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
