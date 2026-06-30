/**
 * Gateway CRM — Unified Cron Runner
 *
 * GET /api/cron?task=reminders   — daily deadline reminders (email + SMS)
 * GET /api/cron?task=sequence    — drip-sequence step runner (email)
 *
 * Two scheduled tasks share one serverless function (Vercel Hobby caps total
 * functions at 12). Each is dispatched by the `task` query param and called by
 * Vercel Cron on its own schedule (see vercel.json).
 *
 * Auth: GATEWAY_CRON_SECRET via `x-gateway-secret` header or `?secret=` query.
 *       Requests without the secret are rejected unless the env var is unset.
 *
 * Env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY            (required)
 *   RESEND_API_KEY, RESEND_FROM                   (required for sequence; optional for reminders)
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN         (reminders SMS — optional)
 *   GATEWAY_CRON_SECRET                           (recommended in production)
 */

import { createClient } from '@supabase/supabase-js'

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────
function basicTwilioAuth(sid, token) {
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
}

async function sendResend(apiKey, from, to, subject, html, text, idempotencyKey) {
  if (!apiKey || !from || !to) return { ok: false, reason: 'missing email config' }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers,
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html, text }),
  })
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, id: body?.id, error: body?.message || body?.error, body }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task: deadline reminders (formerly /api/reminders)
// ─────────────────────────────────────────────────────────────────────────────
const ACTIVE_STAGES = ['lead', 'qualified', 'showing', 'offer', 'under-contract']

function daysUntil(dateStr, today) {
  if (!dateStr) return null
  const target = new Date(dateStr + 'T00:00:00')
  const todayMidnight = new Date(today)
  todayMidnight.setHours(0, 0, 0, 0)
  return Math.round((target - todayMidnight) / 86400000)
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

async function runReminders(supabase) {
  const resendKey  = process.env.RESEND_API_KEY  || ''
  const resendFrom = process.env.RESEND_FROM     || ''
  const twilioSid  = process.env.TWILIO_ACCOUNT_SID  || ''
  const twilioToken= process.env.TWILIO_AUTH_TOKEN   || ''
  const smsEnabled = !!(twilioSid && twilioToken)

  const today = new Date()
  const log   = { sent: [], skipped: [], errors: [] }
  let totalSends = 0

  const { data: deals, error: dealsErr } = await supabase
    .from('deals')
    .select('id, title, stage, comp_data, agent_id, contact_id, property_id')
    .in('stage', ACTIVE_STAGES)
  if (dealsErr) return { status: 500, body: { error: dealsErr.message } }

  const dealsWithDates = (deals || []).filter(d => {
    const kd = d.comp_data?.key_dates
    return Array.isArray(kd) && kd.some(e => e?.date)
  })
  if (!dealsWithDates.length) {
    return { status: 200, body: { ok: true, message: 'No active deals with key dates', ...log } }
  }

  const agentIds    = [...new Set(dealsWithDates.map(d => d.agent_id).filter(Boolean))]
  const contactIds  = [...new Set(dealsWithDates.map(d => d.contact_id).filter(Boolean))]
  const propertyIds = [...new Set(dealsWithDates.map(d => d.property_id).filter(Boolean))]

  const [agentsRes, contactsRes, propertiesRes] = await Promise.all([
    agentIds.length    ? supabase.from('agents').select('id, name, email, twilio_number').in('id', agentIds)              : Promise.resolve({ data: [] }),
    contactIds.length  ? supabase.from('contacts').select('id, first_name, last_name, phone, email').in('id', contactIds) : Promise.resolve({ data: [] }),
    propertyIds.length ? supabase.from('properties').select('id, address, city, state').in('id', propertyIds)             : Promise.resolve({ data: [] }),
  ])

  const agentMap    = Object.fromEntries((agentsRes.data    || []).map(a => [a.id, a]))
  const contactMap  = Object.fromEntries((contactsRes.data  || []).map(c => [c.id, c]))
  const propertyMap = Object.fromEntries((propertiesRes.data|| []).map(p => [p.id, p]))

  const dealIds = dealsWithDates.map(d => d.id)
  const { data: sent } = await supabase.from('deadline_reminders').select('deal_id, date_type, threshold').in('deal_id', dealIds)
  const sentSet = new Set((sent || []).map(r => `${r.deal_id}|${r.date_type}|${r.threshold}`))

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

      const thresholds = []
      if (days === 3) thresholds.push('72h')
      if (days === 1) thresholds.push('24h')
      if (days === 0) thresholds.push('today')
      if (thresholds.length === 0) continue

      for (const threshold of thresholds) {
        const dedupeKey = `${deal.id}|${entry.type}|${threshold}`
        if (sentSet.has(dedupeKey)) { log.skipped.push(dedupeKey); continue }

        const sends = []

        if (agent?.email && resendKey && resendFrom) {
          const subjectEmoji = threshold === 'today' ? '🚨' : threshold === '24h' ? '⚠️' : '📅'
          const subject = `${subjectEmoji} ${entry.type} ${threshold === 'today' ? 'is TODAY' : threshold === '24h' ? 'is TOMORROW' : 'in 3 days'} — ${deal.title}`
          const html  = emailHtml(deal.title, entry.type, entry.date, threshold, agent.name, contactName, propertyAddress)
          const text  = smsBody(deal.title, entry.type, threshold, propertyAddress)
          const result = await sendResend(resendKey, resendFrom, agent.email, subject, html, text)
          sends.push({ channel: 'email:agent', ...result })
        }

        if (smsEnabled && contact?.phone && agent?.twilio_number) {
          const body   = smsBody(deal.title, entry.type, threshold, propertyAddress)
          const result = await sendSms(twilioSid, twilioToken, agent.twilio_number, contact.phone, body)
          sends.push({ channel: 'sms:contact', ...result })
        }

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
          if (sends.length === 0) log.skipped.push(`${dedupeKey} (no channels configured)`)
          else log.errors.push({ dedupeKey, reasons })
        }
      }
    }

    if (totalSends >= 200) break  // safety cap
  }

  return {
    status: 200,
    body: {
      ok: true,
      date: today.toISOString().slice(0, 10),
      totalSends,
      sent:    log.sent.length,
      skipped: log.skipped.length,
      errors:  log.errors.length,
      details: log,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task: drip-sequence runner (formerly /api/sequence-run)
// ─────────────────────────────────────────────────────────────────────────────
const MAX_SENDS_PER_RUN = 100

function renderTemplate(str, contact, agent) {
  if (!str) return ''
  return str
    .replace(/\{\{firstName\}\}/g,       contact?.first_name || '')
    .replace(/\{\{lastName\}\}/g,        contact?.last_name  || '')
    .replace(/\{\{email\}\}/g,           contact?.email      || '')
    .replace(/\{\{agentName\}\}/g,       agent?.name         || '')
    .replace(/\{\{agentEmail\}\}/g,      agent?.email        || '')
    .replace(/\{\{propertyAddress\}\}/g, contact?.owner_address || '')
    .replace(/\{\{dealValue\}\}/g,       '')
}

function htmlFromText(text) {
  return text
    .split(/\n\n+/)
    .map(p => `<p style="margin:0 0 16px 0">${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
}

async function runSequences(supabase) {
  const resendKey = process.env.RESEND_API_KEY
  const resendFrom = process.env.RESEND_FROM
  if (!resendKey || !resendFrom) {
    return { status: 500, body: { error: 'RESEND_API_KEY or RESEND_FROM missing' } }
  }

  const { data: enrollments, error: enrollErr } = await supabase
    .from('contact_sequences')
    .select('*')
    .eq('status', 'active')
    .limit(500)
  if (enrollErr) return { status: 500, body: { error: enrollErr.message } }
  if (!enrollments?.length) {
    return { status: 200, body: { ok: true, sent: 0, message: 'No active sequences' } }
  }

  const contactIds  = [...new Set(enrollments.map(e => e.contact_id).filter(Boolean))]
  const sequenceIds = [...new Set(enrollments.map(e => e.sequence_id).filter(Boolean))]
  const agentIds    = [...new Set(enrollments.map(e => e.agent_id).filter(Boolean))]

  const [contactsRes, agentsRes, stepsRes] = await Promise.all([
    supabase.from('contacts').select('*').in('id', contactIds),
    supabase.from('agents').select('*').in('id', agentIds),
    supabase.from('sequence_steps').select('*').in('sequence_id', sequenceIds).order('sort_order'),
  ])

  const contactMap = new Map((contactsRes.data || []).map(c => [c.id, c]))
  const agentMap   = new Map((agentsRes.data   || []).map(a => [a.id, a]))
  const stepsBySequence = new Map()
  for (const s of stepsRes.data || []) {
    if (!stepsBySequence.has(s.sequence_id)) stepsBySequence.set(s.sequence_id, [])
    stepsBySequence.get(s.sequence_id).push(s)
  }

  const results = { sent: 0, skipped: 0, errors: 0, details: [] }
  const now = Date.now()

  for (const e of enrollments) {
    if (results.sent >= MAX_SENDS_PER_RUN) break

    const contact = contactMap.get(e.contact_id)
    const steps   = stepsBySequence.get(e.sequence_id) || []
    if (!contact?.email || steps.length === 0) { results.skipped++; continue }

    const nextStepIdx = e.current_step || 0
    if (nextStepIdx >= steps.length) {
      await supabase.from('contact_sequences').update({ status: 'completed' }).eq('id', e.id)
      results.skipped++
      continue
    }

    const step = steps[nextStepIdx]
    const referenceTs = nextStepIdx === 0
      ? new Date(e.started_at).getTime()
      : new Date(e.last_sent_at || e.started_at).getTime()
    const dueAt = referenceTs + (step.delay_days || 0) * 86400_000
    if (now < dueAt) { results.skipped++; continue }

    const agent = agentMap.get(e.agent_id) || {}
    const subject = renderTemplate(step.subject, contact, agent)
    const bodyText = renderTemplate(step.body, contact, agent)
    const bodyHtml = htmlFromText(bodyText)
    const idempotencyKey = `seq-${e.id}-step-${step.id}`

    const sendResult = await sendResend(resendKey, resendFrom, contact.email, subject, bodyHtml, bodyText, idempotencyKey)

    await supabase.from('email_log').insert({
      enrollment_id:    e.id,
      sequence_id:      e.sequence_id,
      sequence_step_id: step.id,
      contact_id:       contact.id,
      agent_id:         e.agent_id,
      to_email:         contact.email,
      subject,
      status:           sendResult.ok ? 'sent' : 'failed',
      provider_id:      sendResult.id || null,
      error:            sendResult.ok ? null : (sendResult.error || `HTTP ${sendResult.status}`),
    }).then(() => {}).catch(() => {})

    if (sendResult.ok) {
      await supabase.from('contact_sequences').update({
        current_step: nextStepIdx + 1,
        last_sent_at: new Date().toISOString(),
        status: nextStepIdx + 1 >= steps.length ? 'completed' : 'active',
      }).eq('id', e.id)
      results.sent++
      results.details.push({ to: contact.email, step: nextStepIdx, id: sendResult.id })
    } else {
      results.errors++
      results.details.push({ to: contact.email, step: nextStepIdx, error: sendResult.error })
    }
  }

  return { status: 200, body: { ok: true, ...results } }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Auth — header or ?secret= query (Vercel Cron sets the header automatically)
  const expectedSecret = process.env.GATEWAY_CRON_SECRET
  const providedSecret = req.headers['x-gateway-secret'] || req.query?.secret
  if (expectedSecret && providedSecret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!SUPABASE_URL || !serviceKey) {
    return res.status(500).json({ error: 'SUPABASE_URL or service key not set' })
  }
  const supabase = createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const task = (req.query?.task || 'reminders').toLowerCase()
  let result
  if (task === 'reminders') {
    result = await runReminders(supabase)
  } else if (task === 'sequence' || task === 'sequence-run' || task === 'sequences') {
    result = await runSequences(supabase)
  } else if (task === 'nudges') {
    result = await runNudges(supabase)
  } else {
    return res.status(400).json({ error: `Unknown task "${task}" — use ?task=reminders, ?task=sequence, or ?task=nudges` })
  }

  return res.status(result.status).json(result.body)
}

// ─────────────────────────────────────────────────────────────────────────────
// Task: agent nudges (transaction management layer)
//
// Three categories, all deduped to once-per-day per (agent, deal, kind):
//   • review_overdue   → admin gets pinged when a deal has been awaiting
//                        review for >24h
//   • closing_soon     → primary agent gets pinged when a deal closes within
//                        7 days but transaction_steps aren't all complete
//   • rotting_steps    → primary agent gets pinged when their deal is rotting
//                        (per pipeline.js thresholds) AND has open steps
// ─────────────────────────────────────────────────────────────────────────────
const OPEN_STAGES_FOR_NUDGES = ['lead','qualified','showing','offer','under-contract','psa','due-diligence','loi','active','on-market']

// Mirror pipeline.js rotting thresholds (cron has no client-side imports).
const ROT_DAYS = {
  lead: 14, qualified: 14, showing: 10, offer: 7, 'under-contract': 30,
  pursuit: 21, 'om-marketing': 21, 'listing-agreement': 14, 'on-market': 30,
  loi: 10, psa: 30, 'due-diligence': 21, 'pre-list': 14, active: 30,
}
const DEFAULT_ROT = 21

function nudgeEmailHtml({ title, deal, agent, reason, detail, link }) {
  const color = reason === 'review_overdue' ? '#c0392b'
              : reason === 'closing_soon'   ? '#d97706'
              :                                '#2d3561'
  return `<!DOCTYPE html><html><body style="font-family:DM Sans,system-ui,sans-serif;color:#1e2642;margin:0;padding:0;background:#f7f8fa">
<div style="max-width:540px;margin:32px auto;background:#fff;border-radius:12px;border:1px solid #e6e9ef;overflow:hidden">
  <div style="background:#2d3561;padding:20px 28px">
    <div style="font-family:Cormorant Garamond,serif;font-size:22px;font-weight:600;color:#fff">Gateway</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.6);letter-spacing:0.04em">Real Estate Advisors</div>
  </div>
  <div style="padding:28px">
    <div style="font-size:13px;color:#9aa3b2;margin-bottom:6px">Action needed</div>
    <div style="font-size:22px;font-weight:700;margin-bottom:14px;color:${color}">${title}</div>
    <div style="background:#f7f8fa;border-radius:8px;padding:14px 16px;margin-bottom:20px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#9aa3b2;margin-bottom:6px">Deal</div>
      <div style="font-size:14px;font-weight:600">${deal}</div>
      ${detail ? `<div style="font-size:12px;color:#9aa3b2;margin-top:6px">${detail}</div>` : ''}
    </div>
    <div style="font-size:13px;color:#4a6fa5;font-weight:600">Review this deal in Gateway CRM →</div>
  </div>
  <div style="background:#f7f8fa;padding:14px 28px;font-size:11px;color:#9aa3b2">
    Hi ${agent || 'there'} — daily nudge from Gateway CRM. You can mute these by closing the deal or completing the open items.
  </div>
</div>
</body></html>`
}

async function dispatchNudge(supabase, { agent, deal, kind, title, detail }) {
  // Dedupe — one nudge per (agent, deal, kind, day)
  const { data: dupe } = await supabase
    .from('agent_nudges')
    .select('id')
    .eq('agent_id', agent.id).eq('deal_id', deal.id).eq('nudge_kind', kind)
    .gte('sent_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString())
    .limit(1)
  if (dupe?.length) return { skipped: true, reason: 'already sent today' }

  const resendKey  = process.env.RESEND_API_KEY  || ''
  const resendFrom = process.env.RESEND_FROM     || ''
  let emailOk = false
  if (agent.email && resendKey && resendFrom) {
    const r = await sendResend(
      resendKey, resendFrom, agent.email,
      `${kind === 'review_overdue' ? '🛂 ' : kind === 'closing_soon' ? '⏳ ' : '⏰ '}${title}`,
      nudgeEmailHtml({ title, deal: deal.title, agent: agent.name, reason: kind, detail }),
      detail || title,
    )
    emailOk = !!r.ok
  }

  // In-app notification regardless of email outcome
  await supabase.from('agent_notifications').insert([{
    agent_id: agent.id, deal_id: deal.id,
    title, message: detail || title, type: `nudge_${kind}`,
  }])

  await supabase.from('agent_nudges').insert([{
    agent_id: agent.id, deal_id: deal.id, nudge_kind: kind,
  }])
  return { ok: true, email: emailOk }
}

async function runNudges(supabase) {
  const today = new Date()
  const out   = { sent: 0, skipped: 0, kinds: { review_overdue: 0, closing_soon: 0, rotting_steps: 0 } }

  // Only sweep deals that could plausibly trigger a nudge: open OR with a
  // pending review. Avoids scanning closed/lost rows we'd never nudge on.
  const { data: deals } = await supabase
    .from('deals')
    .select('id, title, stage, agent_id, comp_data, updated_at, created_at, expected_close_date, review_status, review_requested_at, review_requested_by')
    .or(`stage.in.(${OPEN_STAGES_FOR_NUDGES.join(',')}),review_status.eq.pending`)

  const dealsArr = deals || []
  if (!dealsArr.length) return { status: 200, body: { ok: true, ...out, note: 'no deals' } }

  // Pull steps for any deal we may need to nag (cheap: one query for all)
  const dealIds = dealsArr.map(d => d.id)
  const { data: stepRows } = await supabase
    .from('transaction_steps').select('deal_id, completed, if_applicable')
    .in('deal_id', dealIds)
  const openByDeal = new Map()
  for (const s of stepRows || []) {
    if (s.if_applicable || s.completed) continue
    openByDeal.set(s.deal_id, (openByDeal.get(s.deal_id) || 0) + 1)
  }

  // Cache agents + admins
  const agentIds = [...new Set(dealsArr.map(d => d.agent_id).filter(Boolean))]
  const reviewerIds = [...new Set(dealsArr.map(d => d.review_requested_by).filter(Boolean))]
  const wantedIds = [...new Set([...agentIds, ...reviewerIds])]
  const { data: agents } = wantedIds.length
    ? await supabase.from('agents').select('id, name, email, is_admin, role').in('id', wantedIds)
    : { data: [] }
  const agentMap = Object.fromEntries((agents || []).map(a => [a.id, a]))

  const { data: adminAgents } = await supabase
    .from('agents').select('id, name, email, is_admin, role')
  const admins = (adminAgents || []).filter(a => a.is_admin === true || (a.role || '').toLowerCase().includes('admin'))

  for (const deal of dealsArr) {
    // ── 1) review_overdue (admin) ──
    if (deal.review_status === 'pending' && deal.review_requested_at) {
      const hours = (today - new Date(deal.review_requested_at)) / 3_600_000
      if (hours >= 24) {
        for (const admin of admins) {
          const r = await dispatchNudge(supabase, {
            agent: admin, deal, kind: 'review_overdue',
            title: 'A deal has been waiting more than a day for your review',
            detail: `${deal.title} — submitted ${Math.round(hours)}h ago`,
          })
          if (r.ok) { out.sent++; out.kinds.review_overdue++ } else out.skipped++
        }
      }
    }

    if (!OPEN_STAGES_FOR_NUDGES.includes(deal.stage)) continue
    const primary = agentMap[deal.agent_id]
    if (!primary) continue

    // ── 2) closing_soon (primary agent) ──
    if (deal.expected_close_date) {
      const close = new Date(deal.expected_close_date + 'T00:00:00')
      const daysToClose = Math.round((close - today) / 86_400_000)
      const openSteps = openByDeal.get(deal.id) || 0
      if (daysToClose >= 0 && daysToClose <= 7 && openSteps > 0) {
        const r = await dispatchNudge(supabase, {
          agent: primary, deal, kind: 'closing_soon',
          title: 'Closing soon — checklist not done',
          detail: `${openSteps} open item${openSteps === 1 ? '' : 's'} · closes in ${daysToClose}d`,
        })
        if (r.ok) { out.sent++; out.kinds.closing_soon++ } else out.skipped++
      }
    }

    // ── 3) rotting_steps (primary agent) ──
    const stageSince = deal.comp_data?.stage_since || deal.updated_at || deal.created_at
    if (stageSince) {
      const idle = Math.round((today - new Date(stageSince)) / 86_400_000)
      const rot  = ROT_DAYS[deal.stage] ?? DEFAULT_ROT
      const openSteps = openByDeal.get(deal.id) || 0
      if (idle >= rot && openSteps > 0) {
        const r = await dispatchNudge(supabase, {
          agent: primary, deal, kind: 'rotting_steps',
          title: 'Deal has gone quiet',
          detail: `Idle ${idle}d in ${deal.stage} · ${openSteps} open checklist item${openSteps === 1 ? '' : 's'}`,
        })
        if (r.ok) { out.sent++; out.kinds.rotting_steps++ } else out.skipped++
      }
    }

    if (out.sent >= 200) break  // safety cap
  }

  return { status: 200, body: { ok: true, date: today.toISOString().slice(0, 10), ...out } }
}
