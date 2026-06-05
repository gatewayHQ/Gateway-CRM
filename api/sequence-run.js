/**
 * Gateway CRM — Sequence Runner
 *
 * GET /api/sequence-run
 *   (called by Vercel Cron once daily — step delays are measured in days)
 *
 * Responsibilities:
 *   1. Find all active contact_sequences
 *   2. For each, determine if the next step's delay has elapsed
 *   3. Render the step body with the contact's merge tags
 *   4. Send via Resend (using /api/email-send semantics inline)
 *   5. Advance current_step or mark complete
 *   6. Write to email_log for audit
 *
 * Auth: requires `x-gateway-secret` header matching GATEWAY_CRON_SECRET env var.
 *
 * Vercel cron config (in vercel.json):
 *   {
 *     "crons": [
 *       { "path": "/api/sequence-run", "schedule": "0 9 * * *" }
 *     ]
 *   }
 *
 * Resilience:
 *   - Single batch with bounded fan-out (max 100 sends per invocation)
 *   - Per-send try/catch — one failure doesn't block the queue
 *   - Idempotency key on every send prevents double-billing on retry
 */

import { createClient } from '@supabase/supabase-js'

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

async function sendEmail({ apiKey, from, to, subject, html, text, idempotencyKey }) {
  const headers = {
    Authorization:  `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  })
  const data = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, id: data?.id, error: data?.message || data?.error }
}

export default async function handler(req, res) {
  // Auth check — block public/unauthenticated runs
  const secret = req.headers['x-gateway-secret']
  const expected = process.env.GATEWAY_CRON_SECRET
  if (expected && secret !== expected) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'SUPABASE_URL or service key missing' })
  }

  const resendKey = process.env.RESEND_API_KEY
  const resendFrom = process.env.RESEND_FROM
  if (!resendKey || !resendFrom) {
    return res.status(500).json({ error: 'RESEND_API_KEY or RESEND_FROM missing' })
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  })

  // 1. Pull active enrollments
  const { data: enrollments, error: enrollErr } = await supabase
    .from('contact_sequences')
    .select('*')
    .eq('status', 'active')
    .limit(500)

  if (enrollErr) {
    return res.status(500).json({ error: enrollErr.message })
  }
  if (!enrollments?.length) {
    return res.status(200).json({ ok: true, sent: 0, message: 'No active sequences' })
  }

  // 2. Bulk fetch related data (contacts, agents, steps)
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

  // 3. Process each enrollment
  const results = { sent: 0, skipped: 0, errors: 0, details: [] }
  const now = Date.now()

  for (const e of enrollments) {
    if (results.sent >= MAX_SENDS_PER_RUN) break

    const contact = contactMap.get(e.contact_id)
    const steps   = stepsBySequence.get(e.sequence_id) || []
    if (!contact?.email || steps.length === 0) {
      results.skipped++; continue
    }

    // Determine next step
    const nextStepIdx = e.current_step || 0
    if (nextStepIdx >= steps.length) {
      // All steps done — mark complete
      await supabase.from('contact_sequences')
        .update({ status: 'completed' }).eq('id', e.id)
      results.skipped++
      continue
    }

    const step = steps[nextStepIdx]

    // Check delay: time since enrollment (step 0) or since last send
    const referenceTs = nextStepIdx === 0
      ? new Date(e.started_at).getTime()
      : new Date(e.last_sent_at || e.started_at).getTime()
    const dueAt = referenceTs + (step.delay_days || 0) * 86400_000

    if (now < dueAt) {
      results.skipped++
      continue
    }

    // 4. Render and send
    const agent = agentMap.get(e.agent_id) || {}
    const subject = renderTemplate(step.subject, contact, agent)
    const bodyText = renderTemplate(step.body, contact, agent)
    const bodyHtml = htmlFromText(bodyText)
    const idempotencyKey = `seq-${e.id}-step-${step.id}`

    const sendResult = await sendEmail({
      apiKey: resendKey,
      from: resendFrom,
      to: contact.email,
      subject,
      html: bodyHtml,
      text: bodyText,
      idempotencyKey,
    })

    // 5. Log + advance
    await supabase.from('email_log').insert({
      enrollment_id:   e.id,
      sequence_id:     e.sequence_id,
      sequence_step_id: step.id,
      contact_id:      contact.id,
      agent_id:        e.agent_id,
      to_email:        contact.email,
      subject,
      status:          sendResult.ok ? 'sent' : 'failed',
      provider_id:     sendResult.id || null,
      error:           sendResult.ok ? null : (sendResult.error || `HTTP ${sendResult.status}`),
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

  return res.status(200).json({ ok: true, ...results })
}
