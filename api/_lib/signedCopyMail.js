// ─────────────────────────────────────────────────────────────────────────────
// The signed copy, in the agents' inboxes.
//
// WHAT WAS MISSING. When a packet finished signing, the CRM archived the signed
// PDF onto the deal and wrote an in-app notification — and that was the whole
// of it. The notification says "the signed copy has been saved to the deal's
// Documents tab", which is true and is not the same thing as having the
// document: an agent who is not in the CRM at that moment finds out later, and
// an agent who needs to forward the executed agreement to a lender, a title
// company or a client still has to go and fetch it. Worse, the notification
// only ever went to the deal's ASSIGNED agent, so on a co-listed deal the
// co-agent learned nothing at all.
//
// BoldSign can do a version of this itself — a CC recipient on the envelope is
// emailed the completed document — and the prepare screen has always exposed
// that box. But it starts empty, it is typed by hand per send, it puts the
// agents' addresses in front of every signer, and it can only ever carry what
// BoldSign itself holds: for a packet sent `Individually` that is the separate
// files, not the single combined PDF the CRM assembles at completion. So the
// automatic copy is the CRM's, sent from here, and the BoldSign CC box stays
// what it is for — the lender or attorney who is not on the deal.
//
// WHAT THIS SENDS. One email per completion, to the deal's assigned agent and
// every co-agent, with the signed PDF attached when it is small enough to
// attach and a link to the deal when it is not. Best-effort by contract: it is
// called from the BoldSign webhook, where a throw asks BoldSign to redeliver
// the whole event (two more PDF downloads, two more uploads), so nothing here
// ever throws.
// ─────────────────────────────────────────────────────────────────────────────
import { dealCoAgentIds } from '../../src/lib/coAgents.js'
import { streetLine, readPropertiesWithUnit } from '../../src/lib/address.js'

// Resend accepts a good deal more than this, but a signed commercial packet can
// run to hundreds of pages and a mailbox that bounces the message helps nobody.
// Over the cap the email still goes — with the link instead of the file.
export const MAX_ATTACHMENT_BYTES = Number(process.env.SIGNED_COPY_MAX_ATTACHMENT_BYTES || 8 * 1024 * 1024)

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Everyone this email is for, and the deal it is about.
 *
 * Recipients are the deal's assigned agent first, then its co-agents.
 * `co_agent_ids` arrived in migration 0025 and the property's own list is the
 * fallback for deals converted before it — dealCoAgentIds() already knows that,
 * so this only has to hand it the property when the deal has one. A database
 * without the column at all still produces the assigned agent rather than
 * nothing, which is the behaviour this replaces.
 *
 * The property comes back too, because the address belongs in the email: an
 * agent with three deals in flight should be able to tell from the subject and
 * the first line which one just got signed.
 */
export async function signedCopyAudience(svc, dealId) {
  const empty = { recipients: [], deal: null, property: null }
  if (!dealId) return empty

  const full = await svc.from('deals')
    .select('id, title, agent_id, co_agent_ids, property_id').eq('id', dealId).maybeSingle()
  // A database that predates migration 0025 has no co_agent_ids — the assigned
  // agent alone is still far better than the nothing this replaces.
  const deal = full.error
    ? (await svc.from('deals').select('id, title, agent_id').eq('id', dealId).maybeSingle()).data
    : full.data
  if (!deal) return empty

  let property = null
  if (deal.property_id) {
    const { data } = await readPropertiesWithUnit('id, address, city, state, details', (cols) =>
      svc.from('properties').select(cols).eq('id', deal.property_id).maybeSingle())
    property = data
  }

  const ids = [deal.agent_id, ...dealCoAgentIds(deal, property)].filter(Boolean)
  if (!ids.length) return { ...empty, deal, property }

  const { data: agents } = await svc.from('agents').select('id, name, email').in('id', ids)
  const byId = Object.fromEntries((agents || []).map(a => [a.id, a]))
  // Assigned agent first, and anyone without an address dropped — one blank
  // recipient is what fails a whole Resend call rather than one address.
  const recipients = []
  const seen = new Set()
  for (const id of ids) {
    const email = byId[id]?.email?.trim()
    if (!email || seen.has(email.toLowerCase())) continue
    seen.add(email.toLowerCase())
    recipients.push({ id, name: byId[id].name || null, email })
  }
  return { recipients, deal, property }
}

/** "1201 Grand Ave · Des Moines, IA", or null when the deal has no property. */
export function propertyLine(property) {
  if (!property) return null
  const city = [property.city, property.state].filter(Boolean).join(', ')
  return [streetLine(property), city].filter(Boolean).join(' · ') || null
}

/**
 * Subject and body. Pure — the wording is the part worth testing, and it should
 * not need a database or a mail provider to check.
 *
 * `attached` decides which of the two closing lines the agent reads: the file is
 * on the message, or the file was too big and lives on the deal.
 */
export function signedCopyEmail({
  documentName, dealTitle, propertyAddress, signerNames = [], completedAt, dealUrl, attached, filename,
}) {
  const docLabel = documentName || 'Document'
  const signedBy = signerNames.filter(Boolean).join(', ')
  const dateLabel = completedAt ? String(completedAt).slice(0, 10) : new Date().toISOString().slice(0, 10)

  const subject = `✅ Signed: ${docLabel}${dealTitle ? ` — ${dealTitle}` : ''}`

  const text = [
    `${docLabel} has been fully signed${signedBy ? ` by ${signedBy}` : ''}.`,
    dealTitle ? `Deal: ${dealTitle}` : null,
    propertyAddress || null,
    `Completed: ${dateLabel}`,
    '',
    attached
      ? `The signed copy is attached to this email${filename ? ` as ${filename}` : ''}, and is filed on the deal's Documents tab.`
      : `The signed copy was too large to attach. It is filed on the deal's Documents tab.`,
    dealUrl ? `Open the deal: ${dealUrl}` : null,
  ].filter(v => v !== null).join('\n')

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f8fa">
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;background:#fff">
  <div style="padding:24px 28px 8px">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#3f9a6a">Fully signed</div>
    <div style="font-size:18px;font-weight:700;color:#1b2230;margin-top:6px">${escapeHtml(docLabel)}</div>
  </div>
  <div style="padding:0 28px 20px">
    <div style="background:#f7f8fa;border-radius:8px;padding:14px 16px;margin:12px 0 18px">
      ${dealTitle ? `<div style="font-size:14px;font-weight:600;color:#1b2230">${escapeHtml(dealTitle)}</div>` : ''}
      ${propertyAddress ? `<div style="font-size:12px;color:#9aa3b2;margin-top:2px">${escapeHtml(propertyAddress)}</div>` : ''}
      ${signedBy ? `<div style="font-size:12px;color:#9aa3b2;margin-top:6px">Signed by ${escapeHtml(signedBy)}</div>` : ''}
      <div style="font-size:12px;color:#9aa3b2;margin-top:2px">Completed ${escapeHtml(dateLabel)}</div>
    </div>
    <div style="font-size:13px;color:#4a5263;line-height:1.5">
      ${attached
        ? `The signed copy is attached${filename ? ` as <b>${escapeHtml(filename)}</b>` : ''}, and has been filed on the deal&rsquo;s Documents tab along with the compliance audit trail.`
        : `The signed copy was too large to attach to this email. It has been filed on the deal&rsquo;s Documents tab along with the compliance audit trail.`}
    </div>
    ${dealUrl ? `<div style="margin-top:18px"><a href="${escapeHtml(dealUrl)}" style="display:inline-block;background:#2d3561;color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 18px;border-radius:6px">Open the deal</a></div>` : ''}
  </div>
  <div style="background:#f7f8fa;padding:14px 28px;font-size:11px;color:#9aa3b2">
    Sent by Gateway CRM because you are on this deal.
  </div>
</div>
</body></html>`

  return { subject, html, text }
}

/**
 * Post the message. Split out so the send path above can be tested without a
 * network, and so the attachment encoding lives next to the size cap it obeys.
 */
async function postResend({ apiKey, from, to, subject, html, text, attachment, idempotencyKey }) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from, to, subject, html, text,
      ...(attachment ? { attachments: [attachment] } : {}),
    }),
  })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, id: body?.id, error: body?.message || body?.error }
}

/**
 * Email the signed copy to every agent on the deal.
 *
 * Returns a small report rather than throwing — the caller is a webhook that
 * must answer 200 whatever happens here, and `{ sent: false, reason }` is the
 * thing worth having in the logs.
 *
 * The idempotency key is the document: BoldSign redelivers, and the caller
 * already gates this on the one delivery that made the transition, but a second
 * key on the message itself costs nothing and is the difference between a
 * belt-and-braces retry and an agent reading the same email twice.
 */
export async function mailSignedCopyToAgents(svc, opts) {
  // "Never throws" is a contract the caller relies on, so it is enforced here
  // once rather than by guarding each risky line and hoping none was missed —
  // a throw out of this function is a 500 out of the webhook, which asks
  // BoldSign to redeliver an event whose archive already succeeded.
  try {
    return await sendSignedCopy(svc, opts)
  } catch (e) {
    return { sent: false, reason: e.message }
  }
}

async function sendSignedCopy(svc, {
  dealId, documentId, documentName, dealTitle,
  signerNames = [], completedAt, signedStoragePath, bucket, baseUrl,
}) {
  const apiKey = process.env.RESEND_API_KEY || ''
  const from   = process.env.RESEND_FROM    || ''
  if (!apiKey || !from) return { sent: false, reason: 'Resend is not configured' }

  let audience
  try {
    audience = await signedCopyAudience(svc, dealId)
  } catch (e) {
    return { sent: false, reason: `Could not resolve the deal's agents: ${e.message}` }
  }
  const { recipients, deal, property } = audience
  if (!recipients.length) return { sent: false, reason: 'No agent on this deal has an email address' }

  // The attachment, when there is one small enough to be one. A download that
  // fails is not a reason to withhold the email — the link still gets the agent
  // to the file, which is strictly better than the silence this replaces.
  const filename = `signed-${(documentName || 'document').replace(/\.pdf$/i, '')}.pdf`
  let attachment = null
  let skippedAttachment = null
  if (signedStoragePath && bucket) {
    try {
      const { data, error } = await svc.storage.from(bucket).download(signedStoragePath)
      if (error) throw new Error(error.message)
      const bytes = Buffer.from(await data.arrayBuffer())
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        skippedAttachment = `too large (${Math.round(bytes.length / 1024)}KB)`
      } else {
        attachment = { filename, content: bytes.toString('base64') }
      }
    } catch (e) {
      skippedAttachment = e.message
    }
  } else {
    skippedAttachment = 'no signed copy was archived'
  }

  // ?deal=<id>, not /deal/<id>: this app routes in memory, so a path is a page
  // that does not exist. src/App.jsx reads this param and opens the deal.
  const dealUrl = baseUrl && dealId
    ? `${String(baseUrl).replace(/\/+$/, '')}/?deal=${encodeURIComponent(dealId)}`
    : null
  const { subject, html, text } = signedCopyEmail({
    documentName,
    dealTitle: deal?.title || dealTitle || null,
    propertyAddress: propertyLine(property),
    signerNames, completedAt, dealUrl,
    attached: Boolean(attachment), filename,
  })

  try {
    const result = await postResend({
      apiKey, from, to: recipients.map(r => r.email), subject, html, text, attachment,
      idempotencyKey: documentId ? `signed-copy:${documentId}` : null,
    })
    if (!result.ok) return { sent: false, reason: result.error || `Resend HTTP ${result.status}`, recipients: recipients.length }
    return {
      sent: true, id: result.id, recipients: recipients.length,
      attached: Boolean(attachment), ...(skippedAttachment ? { skippedAttachment } : {}),
    }
  } catch (e) {
    return { sent: false, reason: e.message, recipients: recipients.length }
  }
}
