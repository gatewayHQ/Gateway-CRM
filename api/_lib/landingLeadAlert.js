/**
 * What happens the moment a QR landing page captures someone.
 *
 * Website leads have always told the agent instantly (leadNotify.js). QR leads
 * did not: they sat on the campaign's page until somebody opened it, and speed
 * to the first call is the single biggest factor in whether a lead converts.
 * This module closes that gap for both landing-page entry points — the Deal
 * Room registration and the plain "get more info" form:
 *
 *   1. ALERT every advisor on the campaign: in-app bell, email, and a text when
 *      Twilio is configured.
 *   2. TASK the primary advisor: a high-priority call, due now.
 *   3. DRIP, when the campaign names a follow-up sequence: enroll the contact.
 *      The drip runner stops it on its own the moment they reply.
 *
 * Every step is best effort and reports what landed. The lead is committed
 * before any of this runs; nothing here may cost the visitor their download or
 * the agent their lead.
 */
import { sendLeadEmail } from './leadNotify.js'

const INK  = '#1e2642'
const GOLD = '#c9a961'
const MUTE = '#6b7280'

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const ROLE_LABEL = { principal: 'Principal / buyer', broker: 'Broker', lender: 'Lender', other: 'Other' }

/** The advisors on a campaign: the owner first, then any co-agents. */
export function campaignAgentIds(mailing) {
  const cfg = mailing?.landing_config || {}
  return [...new Set([mailing?.agent_id, ...(Array.isArray(cfg.agent_ids) ? cfg.agent_ids : [])].filter(Boolean))]
}

/** One line per fact the agent will want before dialling. */
export function leadFacts(lead) {
  return [
    ['Name',  lead.name],
    lead.phone ? ['Phone', lead.phone, `tel:${lead.phone}`] : null,
    lead.email ? ['Email', lead.email, `mailto:${lead.email}`] : null,
    lead.mailing_address ? ['Mailing address', lead.mailing_address] : null,
    lead.buyer_role ? ['They are a', ROLE_LABEL[lead.buyer_role] || lead.buyer_role] : null,
    lead.is_1031 === true ? ['1031 exchange', 'Yes'] : lead.is_1031 === false ? ['1031 exchange', 'No'] : null,
    lead.message ? ['Message', lead.message] : null,
  ].filter(Boolean)
}

export function buildLandingLeadEmail({ agent, lead, mailing, dealRoom, crmUrl = null }) {
  const firstName = agent?.name?.split(' ')[0] || 'there'
  const campaign  = mailing?.name || 'your campaign'
  const subject   = dealRoom
    ? `Deal Room: ${lead.name} just registered on ${campaign}`
    : `New QR lead: ${lead.name} (${campaign})`
  const kicker = dealRoom ? 'Entered the Deal Room' : 'New QR landing-page lead'
  const banner = dealRoom
    ? 'just registered for the Deal Room and has the OM and financials in hand. This is the warmest lead a mailer produces: call while they are reading it.'
    : 'just asked for more information from your landing page.'

  const rows = leadFacts(lead).map(([label, value, href]) => `
        <tr>
          <td style="padding:7px 16px 7px 0;color:${MUTE};font-size:13px;white-space:nowrap;vertical-align:top">${esc(label)}</td>
          <td style="padding:7px 0;color:${INK};font-size:15px;font-weight:600">${
            href ? `<a href="${esc(href)}" style="color:${INK};text-decoration:none">${esc(value)}</a>` : esc(value)
          }</td>
        </tr>`).join('')

  const cta = crmUrl && lead.contact_id ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 0">
        <tr><td style="background:${INK};border-radius:6px">
          <a href="${esc(crmUrl)}/contacts?id=${esc(lead.contact_id)}"
             style="display:inline-block;padding:12px 26px;color:#fff;font-size:15px;font-weight:600;text-decoration:none">Open in the CRM</a>
        </td></tr>
      </table>` : ''

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f8">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f5f8;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600"
             style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
        <tr><td style="background:${INK};padding:22px 32px">
          <div style="color:#fff;font-size:17px;font-weight:600">Gateway Real Estate Advisors</div>
          <div style="height:2px;width:38px;background:${GOLD};margin-top:10px"></div>
        </td></tr>
        <tr><td style="padding:30px 32px 34px">
          <p style="margin:0 0 6px;color:${GOLD};font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase">${esc(kicker)}</p>
          <h1 style="margin:0 0 18px;color:${INK};font-size:24px;font-weight:700;line-height:1.25">${esc(lead.name)}</h1>
          <p style="margin:0 0 22px;color:${MUTE};font-size:15px;line-height:1.6">Hi ${esc(firstName)} — ${esc(lead.name)} ${banner}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#fafbfc;border-radius:8px;padding:6px 18px">${rows}</table>
          <p style="margin:22px 0 0;color:${MUTE};font-size:13px">Campaign: <strong style="color:${INK}">${esc(campaign)}</strong></p>
          ${cta}
        </td></tr>
        <tr><td style="padding:16px 32px 24px;border-top:1px solid #eef0f4;color:${MUTE};font-size:12px;line-height:1.5">
          Sent automatically by Gateway CRM when a QR landing page captures a lead. A call task is on your list.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`

  const text = [
    `${kicker}: ${lead.name}`,
    `Campaign: ${campaign}`,
    '',
    ...leadFacts(lead).map(([l, v]) => `${l}: ${v}`),
    crmUrl && lead.contact_id ? `\nOpen in the CRM: ${crmUrl}/contacts?id=${lead.contact_id}` : '',
  ].filter(s => s !== null).join('\n')

  return { subject, html, text }
}

/** The text message: short enough for one segment where possible, the phone number tappable. */
export function buildLandingLeadSms({ lead, mailing, dealRoom }) {
  const what = dealRoom ? 'entered the Deal Room' : 'asked for info'
  const parts = [`Gateway: ${lead.name} ${what} on ${mailing?.name || 'your QR page'}.`]
  if (lead.phone) parts.push(`Call ${lead.phone}`)
  if (lead.buyer_role) parts.push(`(${ROLE_LABEL[lead.buyer_role] || lead.buyer_role})`)
  return parts.join(' ').slice(0, 320)
}

/** Send one SMS through Twilio's REST API. True only if Twilio accepted it. */
export async function sendAlertSms({ to, from, body, fetchImpl = fetch }) {
  const SID   = process.env.TWILIO_ACCOUNT_SID
  const TOKEN = process.env.TWILIO_AUTH_TOKEN
  if (!SID || !TOKEN || !to || !from || !body) return false
  try {
    const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ Body: body, From: from, To: to }),
    })
    return r.ok
  } catch {
    return false
  }
}

/** E.164-ish: Twilio wants +1XXXXXXXXXX for a US number typed any which way. */
export function toE164(phone) {
  const d = String(phone || '').replace(/\D/g, '')
  if (d.length === 10) return `+1${d}`
  if (d.length === 11 && d.startsWith('1')) return `+${d}`
  return null
}

async function loadAgents(svc, ids) {
  if (!ids.length) return []
  let { data, error } = await svc.from('agents').select('id, name, email, phone, twilio_number').in('id', ids)
  if (error) ({ data } = await svc.from('agents').select('id, name, email, phone').in('id', ids))
  return ids.map(id => (data || []).find(a => a.id === id)).filter(Boolean)
}

/**
 * Alert, task and (optionally) drip for one landing-page lead.
 *
 *   lead     { name, email, phone, message, mailing_address, buyer_role, is_1031, contact_id }
 *   mailing  { id, name, agent_id, landing_config }
 *   dealRoom true when this was a Deal Room registration (warmer, says so)
 *
 * Returns a report of what landed; never throws.
 */
export async function handleLandingLead(svc, { lead, mailing, dealRoom = false, crmUrl = null, fetchImpl }) {
  const report = { alerted: [], task: false, drip: false }
  try {
    const agents = await loadAgents(svc, campaignAgentIds(mailing))
    const email = (agent) => buildLandingLeadEmail({ agent, lead, mailing, dealRoom, crmUrl })
    const smsBody = buildLandingLeadSms({ lead, mailing, dealRoom })
    const smsFrom = process.env.TWILIO_ALERT_FROM || null

    for (const agent of agents) {
      const r = { agent_id: agent.id, in_app: false, email: false, sms: false }
      try {
        const { error } = await svc.from('agent_notifications').insert({
          agent_id:   agent.id,
          title:      (dealRoom ? `Deal Room: ${lead.name}` : `QR lead: ${lead.name}`).slice(0, 200),
          message:    leadFacts(lead).filter(([l]) => l !== 'Message').map(([l, v]) => `${l}: ${v}`).join(' · ').slice(0, 1000),
          type:       'lead',
          contact_id: lead.contact_id || null,
        })
        r.in_app = !error
      } catch { /* bell is best effort */ }
      if (agent.email) r.email = await sendLeadEmail({ to: agent.email, ...email(agent) })
      const to = toE164(agent.phone)
      const from = smsFrom || agent.twilio_number || null
      if (to && from) r.sms = await sendAlertSms({ to, from, body: smsBody, fetchImpl })
      report.alerted.push(r)
    }

    const owner = agents[0]
    if (owner) {
      try {
        const { error } = await svc.from('tasks').insert({
          title:      `Call ${lead.name} — ${dealRoom ? 'entered the Deal Room' : 'QR lead'} (${mailing?.name || 'campaign'})`.slice(0, 200),
          type:       'call',
          priority:   'high',
          due_date:   new Date().toISOString(),
          contact_id: lead.contact_id || null,
          agent_id:   owner.id,
          notes:      leadFacts(lead).map(([l, v]) => `${l}: ${v}`).join('\n'),
        })
        report.task = !error
      } catch { /* task is best effort */ }
    }

    const sequenceId = mailing?.landing_config?.followup_sequence_id
    if (sequenceId && lead.contact_id && lead.email && owner) {
      try {
        const { data: already } = await svc.from('contact_sequences').select('id')
          .eq('contact_id', lead.contact_id).eq('sequence_id', sequenceId)
          .in('status', ['active', 'paused']).limit(1)
        if (!already?.length) {
          const { error } = await svc.from('contact_sequences').insert({
            contact_id:   lead.contact_id,
            sequence_id:  sequenceId,
            agent_id:     owner.id,
            current_step: 0,
            status:       'active',
            started_at:   new Date().toISOString(),
          })
          report.drip = !error
        } else {
          report.drip = true
        }
      } catch { /* drip is best effort */ }
    }
  } catch { /* the whole report is best effort */ }
  return report
}
