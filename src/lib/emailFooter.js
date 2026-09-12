// ─────────────────────────────────────────────────────────────────────────────
// THE FOOTER EVERY BULK EMAIL HAS TO CARRY.
//
// Deal announcements go out through the agent's own Microsoft 365 mailbox, one
// individually addressed message per recipient, paced under Microsoft's own
// limits. That is the well-behaved half of the picture and it is most of what
// keeps mail out of a junk folder.
//
// The half that was missing is in the MESSAGE, not the plumbing. A commercial
// email in the US needs two things the announcement template did not have:
//
//   1. A working opt-out the recipient can use themselves. The CRM already had
//      unsubscribe machinery — but only for mailing-campaign subscribers, so a
//      person on the receiving end of an announcement had no way out except
//      asking an agent to tick a box for them. "Reply and ask" is not an opt-out
//      mechanism, and the people who don't get one press "report spam" instead,
//      which is the single fastest way to wreck a sending domain's reputation.
//
//   2. A real physical mailing address for the sender.
//
// Both live here rather than inside the announcement template, because the next
// bulk email this CRM learns to send needs exactly the same block and must not
// grow its own slightly different copy of it.
//
// Pure: strings in, strings out. Imported by BOTH the browser (the wizard's
// preview) and the server (the actual send), so what an agent approves is what
// a recipient receives — footer included.
// ─────────────────────────────────────────────────────────────────────────────

// ─── The sender of record ────────────────────────────────────────────────────
// A postal address is a legal requirement, not decoration, so it is a named
// constant in one file rather than a string pasted into a template. Overridable
// by environment on both sides: the office moving must not require a code
// change, and a test must not depend on the real one.
//
// NOTE: confirm this against the letterhead before the first real blast. It is
// the one value in this module that cannot be checked by a test — a wrong
// address is still a valid string, and it goes out to every recipient.
const env = (key) => {
  // import.meta.env in the browser build, process.env on the server. Neither is
  // guaranteed to exist in the other's context, so both are probed defensively.
  try {
    if (typeof import.meta !== 'undefined' && import.meta.env?.[`VITE_${key}`]) return import.meta.env[`VITE_${key}`]
  } catch { /* not a module context that defines import.meta */ }
  if (typeof process !== 'undefined' && process.env?.[key]) return process.env[key]
  return ''
}

export const COMPANY = {
  name:    env('COMPANY_NAME')    || 'Gateway Real Estate Advisors',
  address: env('COMPANY_ADDRESS') || '700 Nebraska St, Sioux City, IA 51101',
  phone:   env('COMPANY_PHONE')   || '(712) 900-0205',
}

/**
 * The unsubscribe link for one recipient.
 *
 * `/u/:token` is the path the public unsubscribe page already answers on — the
 * token says which kind of unsubscribe it is, so an announcement recipient and
 * a mailing-list subscriber use the same short, recognisable URL.
 */
export function unsubscribeUrl(baseUrl, token) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base || !token) return ''
  return `${base}/u/${token}`
}

/**
 * What the wizard's preview shows in place of a real token. A preview has no
 * recipient token to mint and must never render a live one — an agent clicking
 * their own preview would otherwise unsubscribe the contact it was drawn for.
 */
export const PREVIEW_UNSUBSCRIBE_URL = '#preview-unsubscribe'

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * The footer block, as the table row an email template drops in at the bottom.
 *
 * Table markup and inline styles because these land in Outlook as often as not.
 * The unsubscribe link is deliberately a plain, visible link rather than a
 * tracked redirect or a tiny grey word: a recipient who cannot find the opt-out
 * in five seconds reports the message instead of using it.
 */
export function renderEmailFooterHtml({ agentName = '', unsubscribeUrl: url = '', reason = '' } = {}) {
  const who = [escapeHtml(agentName), escapeHtml(COMPANY.name)].filter(Boolean).join(' · ')
  const why = reason
    ? escapeHtml(reason)
    : `You're receiving this because you're on the property-update list at ${escapeHtml(COMPANY.name)}.`

  // No link, no line. An unsubscribe row pointing nowhere is worse than an
  // honest omission — it reads as an opt-out that silently does nothing.
  const optOut = url ? `
              <div style="margin:8px 0 0 0">
                <a href="${escapeHtml(url)}" style="color:#6b7280;text-decoration:underline">Unsubscribe from these emails</a>
              </div>` : ''

  return `
          <tr>
            <td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280">
              <div style="color:#374151;font-weight:600">${who}</div>
              <div>${escapeHtml(COMPANY.address)}${COMPANY.phone ? ` · ${escapeHtml(COMPANY.phone)}` : ''}</div>
              <div style="margin:8px 0 0 0">${why}</div>${optOut}
            </td>
          </tr>`
}

/** The same footer for a plain-text part or a preview caption. */
export function emailFooterText({ agentName = '', unsubscribeUrl: url = '' } = {}) {
  return [
    [agentName, COMPANY.name].filter(Boolean).join(' · '),
    [COMPANY.address, COMPANY.phone].filter(Boolean).join(' · '),
    url ? `Unsubscribe: ${url}` : '',
  ].filter(Boolean).join('\n')
}
