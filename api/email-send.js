/**
 * Gateway CRM — Email Send API
 *
 * POST /api/email-send
 *
 * Body:
 *   {
 *     to:        string | string[]   - recipient address(es)
 *     subject:   string                - email subject
 *     html:      string                - HTML body (preferred)
 *     text:      string                - plaintext fallback
 *     from?:     string                - "Name <email@domain>" (defaults to RESEND_FROM env)
 *     replyTo?:  string                - reply-to address
 *     tags?:     {name, value}[]       - Resend tags for tracking
 *     idempotencyKey?: string          - prevents duplicate sends on retry
 *   }
 *
 * Headers (optional):
 *   x-resend-key                       - pins this request to Resend using the
 *                                        caller's own key, bypassing the
 *                                        deployment's configured provider
 *
 * Why this exists:
 *  • Keeps the provider API key/secret out of the browser (security)
 *  • Provides a server-side audit point for compliance / logging
 *  • Centralized rate limiting + retry logic
 *
 * Transport: requests without an x-resend-key go through api/_lib/email.js, so
 * they use whichever provider the deployment is configured for (Microsoft 365 via
 * Graph, or Resend). `from` is only honored on the Resend path — Graph always
 * sends as the mailbox its Azure app is scoped to.
 */

import { sendEmail, emailConfigured } from './_lib/email.js'

const SHARED_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-resend-key, x-gateway-secret',
}

// In-memory rate limit (per cold-start). Resets when the function reloads.
// For multi-instance enforcement, swap this for Upstash/Redis later.
const rateMap = new Map()
const RATE_WINDOW_MS = 60_000   // 1 minute
const RATE_LIMIT     = 30       // 30 emails/min/IP

function checkRateLimit(ip) {
  const now = Date.now()
  const entry = rateMap.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS }
  if (now > entry.resetAt) {
    entry.count = 0
    entry.resetAt = now + RATE_WINDOW_MS
  }
  entry.count++
  rateMap.set(ip, entry)
  return entry.count <= RATE_LIMIT
}

function applyCors(res) {
  for (const [k, v] of Object.entries(SHARED_HEADERS)) res.setHeader(k, v)
}

export default async function handler(req, res) {
  applyCors(res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' })

  // ── Rate limit ────────────────────────────────────────────────────────────
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
             req.socket?.remoteAddress || 'unknown'
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' })
  }

  // ── Resolve transport ─────────────────────────────────────────────────────
  // An explicit x-resend-key still pins this request to Resend (power users with
  // their own account). Without it, the deployment's configured provider is used
  // — Microsoft 365 or Resend, see api/_lib/email.js.
  const pinnedResendKey = req.headers['x-resend-key'] || ''
  if (!pinnedResendKey && !emailConfigured()) {
    return res.status(500).json({
      error: 'No email provider configured. Set MS365_* or RESEND_* env vars in Vercel, or pass an x-resend-key header.',
    })
  }

  // ── Validate payload ──────────────────────────────────────────────────────
  const { to, subject, html, text, from, replyTo, tags, idempotencyKey } = req.body || {}

  if (!to || (Array.isArray(to) && to.length === 0)) {
    return res.status(400).json({ error: 'Missing "to" recipient' })
  }
  if (!subject || typeof subject !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "subject"' })
  }
  if (!html && !text) {
    return res.status(400).json({ error: 'Provide either "html" or "text" body' })
  }

  // A `from` is only required on the Resend path. Graph sends as the mailbox the
  // Azure app is scoped to (MS365_SENDER), so the sender is not the caller's to
  // choose — passing one would be silently ignored, which is worse than not
  // accepting it.
  const fromAddr = from || process.env.RESEND_FROM
  if (pinnedResendKey && !fromAddr) {
    return res.status(400).json({
      error: 'No "from" address. Pass `from` in the request body or set RESEND_FROM env var.',
    })
  }

  // Basic email sanity check — catches obvious typos before hitting the provider
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const toList = Array.isArray(to) ? to : [to]
  for (const addr of toList) {
    if (!emailRegex.test(addr)) {
      return res.status(400).json({ error: `Invalid recipient address: ${addr}` })
    }
  }

  // ── Send via the shared sender, unless this request pinned a Resend key ────
  if (!pinnedResendKey) {
    const result = await sendEmail({ to: toList, subject, html, text, replyTo, idempotencyKey })
    if (result.ok) return res.status(200).json({ ok: true, id: result.id, provider: result.provider })
    return res.status(502).json({ error: result.error || result.reason || 'Email send failed' })
  }

  // ── Pinned-Resend path: build payload for the caller's own key ────────────
  const apiKey = pinnedResendKey
  const payload = {
    from:    fromAddr,
    to:      toList,
    subject,
    ...(html    ? { html }    : {}),
    ...(text    ? { text }    : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(tags    ? { tags }    : {}),
  }

  // ── Send via Resend with retry on transient errors ────────────────────────
  const maxAttempts = 3
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const headers = {
        Authorization:  `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      }
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })

      const data = await response.json().catch(() => ({}))

      if (response.ok) {
        // Success — return Resend's response (includes message ID)
        return res.status(200).json({
          ok: true,
          id: data.id,
          attempt,
        })
      }

      // 4xx: don't retry, return immediately with normalized error
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return res.status(response.status).json({
          error:   data?.message || data?.error || `Resend API error (HTTP ${response.status})`,
          details: data,
        })
      }

      // 5xx or 429: retry with backoff
      lastError = data?.message || `HTTP ${response.status}`
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt - 1)))
      }
    } catch (err) {
      lastError = err.message
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt - 1)))
      }
    }
  }

  return res.status(502).json({
    error: `Email send failed after ${maxAttempts} attempts: ${lastError}`,
  })
}
