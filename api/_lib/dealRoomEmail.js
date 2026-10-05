/**
 * "New in the Deal Room" — the email that brings registered buyers back.
 *
 * The Matthews-style touch: "We just uploaded the September financials to the
 * deal room." It goes from the listing agent's own Outlook (like a mass email
 * or a drip step), only to people who registered for THIS Deal Room, and each
 * copy carries that person's own signed link so the click lands them inside,
 * already signed in — and shows up on the agent's "who came back" list.
 */
import { renderEmailFooterHtml, emailFooterText, escapeHtml as esc } from '../../src/lib/emailFooter.js'

const INK  = '#1e2642'
const GOLD = '#c9a961'
const MUTE = '#6b7280'

function fmtDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(iso || ''))) return ''
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function defaultSubject({ headline, update }) {
  const what = update?.title ? update.title : 'New in the Deal Room'
  return `${what} — ${headline || 'Deal Room update'}`.slice(0, 200)
}

/**
 * recipient   { name, email }
 * agent       { name, email, phone }
 * headline    the listing's headline
 * update      { title, body, date } | null
 * note        the agent's own covering message (optional)
 * link        this recipient's signed Deal Room link
 * callForOffers 'YYYY-MM-DD' | null
 */
export function buildDealRoomUpdateEmail({
  recipient, agent, headline, update = null, note = '', link, unsubscribeUrl = '', callForOffers = null, subject,
}) {
  const first = String(recipient?.name || '').split(/\s+/)[0] || 'there'
  const subj  = subject || defaultSubject({ headline, update })
  const cfo   = fmtDate(callForOffers)

  const para = (t) => String(t || '').split(/\n{2,}/).map(p =>
    `<p style="margin:0 0 14px;color:${INK};font-size:15px;line-height:1.6">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')

  const updateBlock = update ? `
          <div style="border-left:3px solid ${GOLD};padding:6px 0 6px 16px;margin:6px 0 20px">
            ${update.date ? `<div style="color:${MUTE};font-size:12px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">${esc(fmtDate(update.date))}</div>` : ''}
            <div style="color:${INK};font-size:16px;font-weight:700;margin-bottom:6px">${esc(update.title)}</div>
            ${update.body ? `<div style="color:${INK};font-size:14px;line-height:1.6">${esc(update.body).replace(/\n/g, '<br>')}</div>` : ''}
          </div>` : ''

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subj)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f8">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f5f8;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600"
             style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
        <tr><td style="background:${INK};padding:22px 32px">
          <div style="color:${GOLD};font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase">Deal Room update</div>
          <div style="color:#fff;font-size:20px;font-weight:600;margin-top:6px;line-height:1.3">${esc(headline || '')}</div>
        </td></tr>
        <tr><td style="padding:28px 32px 30px">
          <p style="margin:0 0 14px;color:${INK};font-size:15px;line-height:1.6">Hi ${esc(first)},</p>
          ${note ? para(note) : ''}
          ${updateBlock}
          ${cfo ? `<p style="margin:0 0 18px;color:${INK};font-size:14px"><strong>Call for Offers:</strong> ${esc(cfo)}</p>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 0">
            <tr><td style="background:${GOLD};border-radius:6px">
              <a href="${esc(link)}" style="display:inline-block;padding:13px 28px;color:#15130f;font-size:15px;font-weight:700;text-decoration:none">Open the Deal Room</a>
            </td></tr>
          </table>
          <p style="margin:22px 0 0;color:${MUTE};font-size:14px;line-height:1.6">
            Questions? Reply to this email${agent?.phone ? ` or call ${esc(agent.name?.split(' ')[0] || 'me')} at ${esc(agent.phone)}` : ''}.
          </p>
          <p style="margin:14px 0 0;color:${INK};font-size:14px">${esc(agent?.name || '')}</p>
        </td></tr>
        ${renderEmailFooterHtml({
          agentName: agent?.name || '',
          unsubscribeUrl,
          reason: 'You are receiving this because you registered for this Deal Room.',
        })}
      </table>
    </td></tr>
  </table>
</body></html>`

  const text = [
    `Hi ${first},`,
    '',
    note || '',
    update ? `${update.date ? fmtDate(update.date) + ' — ' : ''}${update.title}\n${update.body || ''}` : '',
    cfo ? `Call for Offers: ${cfo}` : '',
    `Open the Deal Room: ${link}`,
    '',
    agent?.name || '',
    emailFooterText({ agentName: agent?.name || '', unsubscribeUrl }),
  ].filter(s => s !== '').join('\n')

  return { subject: subj, html, text }
}
