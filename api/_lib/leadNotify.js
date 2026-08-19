/**
 * Telling the agent about a new website lead — in-app bell + email.
 *
 * BOTH ARE BEST EFFORT, DELIBERATELY. Every function here swallows its own
 * failures and reports them as data. A Resend outage, a revoked API key or an
 * agent row with no email address must degrade the notification, never the
 * lead: the lead is already committed by the time any of this runs, and a
 * webhook sender that receives a 500 retries, which would duplicate work
 * downstream of a problem it cannot fix.
 *
 * Brand colors match the landing pages (src/components/landing/landing.css):
 * ink #1e2642, gold #c9a961.
 */

const INK  = '#1e2642'
const GOLD = '#c9a961'
const MUTE = '#6b7280'

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const INTEREST_LABEL = {
  residential: 'Residential',
  commercial:  'Commercial',
  both:        'Residential + Commercial',
}

// ── In-app notification ──────────────────────────────────────────────────────

/**
 * Writes agent_notifications, which App.jsx is already subscribed to over
 * Supabase realtime — the bell updates without a refresh.
 */
export async function notifyInApp(creds, { agentId, title, message }) {
  if (!agentId) return false
  try {
    const r = await fetch(`${creds.url}/rest/v1/agent_notifications`, {
      method: 'POST',
      headers: { ...creds.headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        agent_id: agentId,
        title:    String(title).slice(0, 200),
        message:  String(message).slice(0, 1000),
        type:     'lead',
      }),
    })
    return r.ok
  } catch {
    return false
  }
}

// ── Email ────────────────────────────────────────────────────────────────────

/**
 * The agent's email. `role` distinguishes the two flavours:
 *   'owner'     — you own this lead, follow up.
 *   'secondary' — an interest_type 'both' lead whose primary owner is someone
 *                 else. Says so in the subject, the banner and the body, because
 *                 an agent who thinks they own a lead they don't (or the reverse)
 *                 is exactly the failure the single-owner rule exists to prevent.
 */
export function buildLeadEmail({
  agent, lead, views = [], primaryAgentName = null, role = 'owner', crmUrl = null,
}) {
  const firstName = agent?.name?.split(' ')[0] || 'there'
  const isFyi     = role === 'secondary'
  const interest  = INTEREST_LABEL[lead.interest_type] || lead.interest_type

  const subject = isFyi
    ? `FYI — ${interest.toLowerCase()} lead: ${lead.name} (${primaryAgentName || 'another agent'} is following up)`
    : `New website lead: ${lead.name}`

  const rows = [
    ['Name',     lead.name],
    ['Email',    lead.email, `mailto:${lead.email}`],
    lead.phone ? ['Phone', lead.phone, `tel:${lead.phone}`] : null,
    ['Interest', interest],
    lead.source_detail ? ['Source', lead.source_detail] : null,
  ].filter(Boolean)

  const detailRows = rows.map(([label, value, href]) => `
        <tr>
          <td style="padding:7px 16px 7px 0;color:${MUTE};font-size:13px;white-space:nowrap;vertical-align:top">${esc(label)}</td>
          <td style="padding:7px 0;color:${INK};font-size:15px;font-weight:600">${
            href ? `<a href="${esc(href)}" style="color:${INK};text-decoration:none">${esc(value)}</a>` : esc(value)
          }</td>
        </tr>`).join('')

  // Reversed: the most recent view is the strongest buying signal, so it leads.
  const viewItems = [...views].reverse().map((v, i) => {
    const label = v.title || v.url
    const link  = v.property_id && crmUrl
      ? `${crmUrl}/listing/${v.property_id}`
      : (v.url || null)
    return `
        <tr>
          <td style="padding:9px 12px 9px 0;color:${GOLD};font-size:13px;font-weight:700;vertical-align:top;white-space:nowrap">${
            i === 0 ? 'Most recent' : `#${views.length - i}`
          }</td>
          <td style="padding:9px 0;border-bottom:1px solid #eef0f4">
            ${link
              ? `<a href="${esc(link)}" style="color:${INK};font-size:14px;font-weight:600;text-decoration:none">${esc(label)}</a>`
              : `<span style="color:${INK};font-size:14px;font-weight:600">${esc(label)}</span>`}
            ${v.property_id ? `<div style="color:${MUTE};font-size:12px;margin-top:2px">In your CRM listings</div>` : ''}
          </td>
        </tr>`
  }).join('')

  const viewSection = views.length ? `
      <p style="margin:28px 0 8px;color:${INK};font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">
        Properties they viewed (${views.length})
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${viewItems}</table>`
    : `
      <p style="margin:28px 0 0;color:${MUTE};font-size:14px">
        No specific properties were viewed before they reached out.
      </p>`

  const messageSection = lead.message ? `
      <p style="margin:28px 0 8px;color:${INK};font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">
        Their message
      </p>
      <div style="border-left:3px solid ${GOLD};padding:4px 0 4px 14px;color:${INK};font-size:15px;line-height:1.55">
        ${esc(lead.message)}
      </div>` : ''

  const banner = isFyi
    ? `You are being copied because this lead said they are interested in
       <strong>both</strong> residential and commercial.
       <strong>${esc(primaryAgentName || 'Another agent')}</strong> owns the follow-up —
       reach out only about the ${lead.lane === 'residential' ? 'commercial' : 'residential'} side.`
    : `This lead was just assigned to you by the round-robin. They are in your
       CRM contacts now — reach out while it is hot.`

  const cta = crmUrl && lead.contact_id
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:30px 0 0">
        <tr><td style="background:${INK};border-radius:6px">
          <a href="${esc(crmUrl)}/contacts?id=${esc(lead.contact_id)}"
             style="display:inline-block;padding:12px 26px;color:#fff;font-size:15px;font-weight:600;text-decoration:none">
            Open in the CRM
          </a>
        </td></tr>
      </table>`
    : ''

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f8">
  <div style="display:none;max-height:0;overflow:hidden">${esc(
    [lead.name, lead.email, lead.phone, interest].filter(Boolean).join(' · ')
  )}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f5f8;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600"
             style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
        <tr><td style="background:${INK};padding:22px 32px">
          <div style="color:#fff;font-size:17px;font-weight:600;letter-spacing:.01em">Gateway Real Estate Advisors</div>
          <div style="height:2px;width:38px;background:${GOLD};margin-top:10px"></div>
        </td></tr>
        <tr><td style="padding:30px 32px 34px">
          <p style="margin:0 0 6px;color:${GOLD};font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase">
            ${isFyi ? 'Cross-specialty heads-up' : 'New website lead'}
          </p>
          <h1 style="margin:0 0 18px;color:${INK};font-size:24px;font-weight:700;line-height:1.25">${esc(lead.name)}</h1>
          <p style="margin:0 0 22px;color:${MUTE};font-size:15px;line-height:1.6">
            Hi ${esc(firstName)} — ${banner}
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
                 style="background:#fafbfc;border-radius:8px;padding:6px 18px">${detailRows}</table>
          ${messageSection}
          ${viewSection}
          ${cta}
        </td></tr>
        <tr><td style="padding:16px 32px 24px;border-top:1px solid #eef0f4;color:${MUTE};font-size:12px;line-height:1.5">
          Sent automatically by Gateway CRM when a lead arrives from the website.
          ${isFyi ? '' : 'You are receiving this because the lead rotation assigned this lead to you.'}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`

  // Plain-text alternative: some agents read mail in clients that never render
  // HTML, and a text part measurably helps deliverability.
  const text = [
    isFyi
      ? `FYI: ${lead.name} is interested in both residential and commercial. ${primaryAgentName || 'Another agent'} owns the follow-up.`
      : `New website lead assigned to you: ${lead.name}`,
    '',
    ...rows.map(([l, v]) => `${l}: ${v}`),
    lead.message ? `\nMessage: ${lead.message}` : '',
    views.length
      ? `\nProperties viewed (most recent first):\n${[...views].reverse()
          .map(v => `  - ${v.title || v.url}`).join('\n')}`
      : '\nNo specific properties were viewed.',
    crmUrl && lead.contact_id ? `\nOpen in the CRM: ${crmUrl}/contacts?id=${lead.contact_id}` : '',
  ].filter(Boolean).join('\n')

  return { subject, html, text }
}

/** Send through Resend. Returns true only if Resend accepted the message. */
export async function sendLeadEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY
  if (!key || !to) return false
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Gateway CRM <noreply@gatewayreadvisors.com>',
        to,
        subject,
        html,
        text,
      }),
    })
    return r.ok
  } catch {
    return false
  }
}

/**
 * Notify one agent both ways. Returns which channels landed, so the handler can
 * report it and an operator can tell "nobody was told" from "the email bounced".
 */
export async function notifyAgentOfLead(creds, {
  agent, lead, views, role = 'owner', primaryAgentName = null, crmUrl = null,
}) {
  if (!agent?.id) return { in_app: false, email: false }

  const interest = INTEREST_LABEL[lead.interest_type] || lead.interest_type
  const summary  = [
    role === 'secondary' ? `Owned by ${primaryAgentName || 'another agent'}` : null,
    `Interest: ${interest}`,
    lead.phone ? `Phone: ${lead.phone}` : null,
    `Email: ${lead.email}`,
    views.length ? `${views.length} propert${views.length === 1 ? 'y' : 'ies'} viewed` : null,
  ].filter(Boolean).join(' · ')

  const { subject, html, text } = buildLeadEmail({
    agent, lead, views, role, primaryAgentName, crmUrl,
  })

  // Sequential, not Promise.all: the bell is the channel that always works, so
  // it should not be able to fail because the email call threw first.
  const inApp = await notifyInApp(creds, {
    agentId: agent.id,
    title:   role === 'secondary'
      ? `Cross-specialty lead: ${lead.name}`
      : `New website lead: ${lead.name}`,
    message: summary,
  })
  const email = await sendLeadEmail({ to: agent.email, subject, html, text })

  return { in_app: inApp, email }
}
