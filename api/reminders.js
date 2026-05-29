/**
 * Gateway CRM — Deadline Reminder Runner
 *
 * GET /api/reminders
 *   Called by Vercel Cron daily at 8:00 AM UTC.
 *
 * What it does:
 *   For every active deal (not closed/lost) that has key dates, it sends:
 *     • 72h reminder  — when the date is exactly 3 days away
 *     • 24h reminder  — when the date is exactly 1 day away
 *     • Day-of reminder — when the date is today
 *
 *   Each reminder is logged in deadline_reminders with a UNIQUE constraint on
 *   (deal_id, date_type, threshold) so re-runs are fully idempotent — no double-sends.
 *
 * Sends:
 *   • Email → agent (via Resend/RESEND_API_KEY + RESEND_FROM)
 *   • SMS   → contact (if they have a phone number, via Twilio)
 *
 * Auth: GATEWAY_CRON_SECRET header (Vercel Cron sets this automatically if
 *       configured in vercel.json's `env` block, or set manually).
 *       Requests without the secret are rejected unless the env var is unset
 *       (dev/testing mode).
 *
 * Env vars required:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   RESEND_API_KEY, RESEND_FROM
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   (SMS optional — skipped if absent)
 *   GATEWAY_CRON_SECRET                     (recommended in production)
 */

import { createClient } from '@supabase/supabase-js'

const ACTIVE_STAGES = ['lead', 'qualified', 'showing', 'offer', 'under-contract']

// (deal_date string "YYYY-MM-DD", today Date) → days until, or null
function daysUntil(dateStr, today) {
  if (!dateStr) return null
  const target = new Date(dateStr + 'T00:00:00')
  const todayMidnight = new Date(today)
  todayMidnight.setHours(0, 0, 0, 0)
  return Math.round((target - todayMidnight) / 86400000)
}

function basicTwilioAuth(sid, token) {
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
}

async function sendEmail(apiKey, from, to, subject, html, text) {
  if (!apiKey || !from || !to) return { ok: false, reason: 'missing email config' }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from, to, subject, html, text }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

async function sendSms(sid, token, from, to, body) {
  if (!sid || !token || !from || !to) return { ok: false, reason: 'missing twilio config' }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicTwilioAuth(sid, token),
    },
    body: new URLSearchParams({ From: from, To: to, Body: body }),
  })
  const data = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, sid: data.sid, error: data.message }
}

function thresholdLabel(t) {
  return t === 'today' ? 'TODAY' : t === '24h' ? 'tomorrow' : 'in 3 days'
}

function emailHtml(deal, dateName, dateStr, threshold, agentName, contactName, propertyAddress) {
  const label    = thresholdLabel(threshold)
  const emphasis = threshold === 'today' ? '#c0392b' : threshold === '24h' ? '#d97706' : '#2d3561'
  const dateFormatted = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  return `
<!DOCTYPE html><html><body style="font-family:DM Sans,system-ui,sans-serif;color:#1e2642;margin:0;padding:0;background:#f7f8fa">
<div style="max-width:540px;margin:32px auto;background:#fff;border-radius:12px;border:1px solid #e6e9ef;overflow:hidden">
  <div style="background:#2d3561;padding:20px 28px">
    <div style="font-family:Cormorant Garamond,serif;font-size:22px;font-weight:600;color:#fff">Gateway</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.6);letter-spacing:0.04em">Real Estate Advisors</div>
  </div>
  <div style="padding:28px">
    <div style="font-size:13px;color:#9aa3b2;margin-bottom:6px">Key Date Reminder</div>
    <div style="font-size:22px;font-weight:700;margin-bottom:4px">${dateName} is <span style="color:${emphasis}">${label}</span></div>
    <div style="font-size:13px;color:#9aa3b2;margin-bottom:24px">${dateFormatted}</div>

    <div style="background:#f7f8fa;border-radius:8px;padding:14px 16px;margin-bottom:20px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#9aa3b2;margin-bottom:6px">Deal</div>
      <div style="font-size:14px;font-weight:600">${deal}</div>
      ${propertyAddress ? `<div style="font-size:12px;color:#9aa3b2;margin-top:2px">${propertyAddress}</div>` : ''}
      ${contactName     ? `<div style="font-size:12px;color:#9aa3b2;margin-top:2px">Client: ${contactName}</div>` : ''}
    </div>

    <div style="font-size:13px;color:#4a6fa5;font-weight:600">Review this deal in Gateway CRM →</div>
  </div>
  <div style="background:#f7f8fa;padding:14px 28px;font-size:11px;color:#9aa3b2">
    Hi ${agentName || 'Agent'} — this is an automated reminder from Gateway CRM. You can manage key dates in the Pipeline → Key Dates tab.
  </div>
</div>
</body></html>`
}

function smsBody(deal, dateName, threshold, propertyAddress) {
  const label = thresholdLabel(threshold)
  const addr  = propertyAddress ? ` (${propertyAddress})` : ''
  return `Gateway CRM reminder: ${dateName} for "${deal}"${addr} is ${label}. Log in to review your deal.`
}

export default async function handler(req, res) {
  // ── Auth ─────────────────────────────────────────────────────────────────
  const expectedSecret = process.env.GATEWAY_CRON_SECRET
  const providedSecret = req.headers['x-gateway-secret'] || req.query?.secret
  if (expectedSecret && providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // ── Supabase (service role) ───────────────────────────────────────────────
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !serviceKey) {
    return res.status(500).json({ error: 'SUPABASE_URL or service key not set' })
  }
  const supabase = createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  // ── Credentials ───────────────────────────────────────────────────────────
  const resendKey  = process.env.RESEND_API_KEY  || ''
  const resendFrom = process.env.RESEND_FROM     || ''
  const twilioSid  = process.env.TWILIO_ACCOUNT_SID  || ''
  const twilioToken= process.env.TWILIO_AUTH_TOKEN   || ''
  const smsEnabled = !!(twilioSid && twilioToken)

  const today = new Date()
  const log   = { sent: [], skipped: [], errors: [] }
  let totalSends = 0

  // ── Fetch active deals with key dates ────────────────────────────────────
  const { data: deals, error: dealsErr } = await supabase
    .from('deals')
    .select('id, title, stage, comp_data, agent_id, contact_id, property_id')
    .in('stage', ACTIVE_STAGES)

  if (dealsErr) return res.status(500).json({ error: dealsErr.message })

  const dealsWithDates = (deals || []).filter(d => {
    const kd = d.comp_data?.key_dates
    return Array.isArray(kd) && kd.some(e => e?.date)
  })

  if (!dealsWithDates.length) {
    return res.status(200).json({ ok: true, message: 'No active deals with key dates', ...log })
  }

  // ── Bulk-fetch agents, contacts, properties ───────────────────────────────
  const agentIds    = [...new Set(dealsWithDates.map(d => d.agent_id).filter(Boolean))]
  const contactIds  = [...new Set(dealsWithDates.map(d => d.contact_id).filter(Boolean))]
  const propertyIds = [...new Set(dealsWithDates.map(d => d.property_id).filter(Boolean))]

  const [agentsRes, contactsRes, propertiesRes] = await Promise.all([
    agentIds.length    ? supabase.from('agents').select('id, name, email, twilio_number').in('id', agentIds)                              : Promise.resolve({ data: [] }),
    contactIds.length  ? supabase.from('contacts').select('id, first_name, last_name, phone, email').in('id', contactIds)                 : Promise.resolve({ data: [] }),
    propertyIds.length ? supabase.from('properties').select('id, address, city, state').in('id', propertyIds)                            : Promise.resolve({ data: [] }),
  ])

  const agentMap    = Object.fromEntries((agentsRes.data    || []).map(a => [a.id, a]))
  const contactMap  = Object.fromEntries((contactsRes.data  || []).map(c => [c.id, c]))
  const propertyMap = Object.fromEntries((propertiesRes.data|| []).map(p => [p.id, p]))

  // ── Check already-sent reminders ─────────────────────────────────────────
  const dealIds = dealsWithDates.map(d => d.id)
  const { data: sent } = await supabase.from('deadline_reminders').select('deal_id, date_type, threshold').in('deal_id', dealIds)
  const sentSet = new Set((sent || []).map(r => `${r.deal_id}|${r.date_type}|${r.threshold}`))

  // ── Process each deal ─────────────────────────────────────────────────────
  for (const deal of dealsWithDates) {
    const agent    = agentMap[deal.agent_id]    || null
    const contact  = contactMap[deal.contact_id] || null
    const property = propertyMap[deal.property_id] || null

    const propertyAddress = property
      ? [property.address, [property.city, property.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')
      : null
    const contactName = contact ? `${contact.first_name} ${contact.last_name}`.trim() : null

    const keyDates = (deal.comp_data?.key_dates || []).filter(e => e?.date)

    for (const entry of keyDates) {
      const days = daysUntil(entry.date, today)
      if (days === null) continue

      // Map days-until to threshold labels
      const thresholds = []
      if (days === 3) thresholds.push('72h')
      if (days === 1) thresholds.push('24h')
      if (days === 0) thresholds.push('today')
      if (thresholds.length === 0) continue

      for (const threshold of thresholds) {
        const dedupeKey = `${deal.id}|${entry.type}|${threshold}`
        if (sentSet.has(dedupeKey)) { log.skipped.push(dedupeKey); continue }

        const sends = []

        // ── Email agent ──────────────────────────────────────────────────
        if (agent?.email && resendKey && resendFrom) {
          const subjectEmoji = threshold === 'today' ? '🚨' : threshold === '24h' ? '⚠️' : '📅'
          const subject = `${subjectEmoji} ${entry.type} ${threshold === 'today' ? 'is TODAY' : threshold === '24h' ? 'is TOMORROW' : 'in 3 days'} — ${deal.title}`
          const html  = emailHtml(deal.title, entry.type, entry.date, threshold, agent.name, contactName, propertyAddress)
          const text  = smsBody(deal.title, entry.type, threshold, propertyAddress)
          const result = await sendEmail(resendKey, resendFrom, agent.email, subject, html, text)
          sends.push({ channel: 'email:agent', ...result })
        }

        // ── SMS contact ───────────────────────────────────────────────────
        if (smsEnabled && contact?.phone && agent?.twilio_number) {
          const body   = smsBody(deal.title, entry.type, threshold, propertyAddress)
          const result = await sendSms(twilioSid, twilioToken, agent.twilio_number, contact.phone, body)
          sends.push({ channel: 'sms:contact', ...result })
        }

        // ── Log reminder (upsert — idempotent even if cron fires twice) ──
        if (sends.some(s => s.ok)) {
          await supabase.from('deadline_reminders').upsert(
            [{ deal_id: deal.id, date_type: entry.type, threshold }],
            { onConflict: 'deal_id,date_type,threshold', ignoreDuplicates: true }
          )
          sentSet.add(dedupeKey)
          log.sent.push({ deal: deal.title, date: entry.type, threshold, sends })
          totalSends++
        } else {
          const reasons = sends.map(s => s.reason || s.error || s.status).filter(Boolean)
          if (sends.length === 0) {
            log.skipped.push(`${dedupeKey} (no channels configured)`)
          } else {
            log.errors.push({ dedupeKey, reasons })
          }
        }
      }
    }

    if (totalSends >= 200) break  // safety cap
  }

  return res.status(200).json({
    ok: true,
    date: today.toISOString().slice(0, 10),
    totalSends,
    sent:    log.sent.length,
    skipped: log.skipped.length,
    errors:  log.errors.length,
    details: log,
  })
}
