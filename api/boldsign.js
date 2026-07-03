import { applyJsonCors, requireAgent, errorResponse, getServiceClient } from './_lib/auth.js'
import closingPacketHandler from './_handlers/closing-packet.js'

// ─── BoldSign REST API client ────────────────────────────────────────────────
// https://developers.boldsign.com — auth via X-API-KEY header, base /v1.
// BOLDSIGN_API_BASE overrides for EU/CA-region accounts
// (https://api-eu.boldsign.com / https://api-ca.boldsign.com).
const API_BASE = process.env.BOLDSIGN_API_BASE || 'https://api.boldsign.com'
const API_KEY  = process.env.BOLDSIGN_API_KEY

async function boldsign(path, { method = 'GET', body, raw = false } = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'X-API-KEY': API_KEY,
      'Accept':    'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (raw) return r
  const text = await r.text()
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch { data = { message: text } }
  if (!r.ok) {
    const msg = data?.error
              || data?.message
              || (data?.errors && JSON.stringify(data.errors))
              || `BoldSign API ${r.status}`
    const err = new Error(msg)
    err.status = r.status
    err.data   = data
    throw err
  }
  return data
}

// ─── Status normalization ────────────────────────────────────────────────────
// BoldSign document statuses: WaitingForOthers / InProgress / NeedsAttention /
// Completed / Declined / Revoked / Expired / Draft / Scheduled / None.
// Frontend expects the lowercase vocabulary the app has used since DocuSign,
// plus 'expired' which now gets its own state (agents need to re-send).
function normalizeStatus(s) {
  const v = String(s || '').toLowerCase().replace(/[^a-z]/g, '')
  if (v === 'completed' || v === 'signed')  return 'completed'
  if (v === 'declined')                     return 'declined'
  if (v === 'revoked' || v === 'voided' || v === 'deleted') return 'voided'
  if (v === 'expired')                      return 'expired'
  if (v === 'viewed'  || v === 'delivered') return 'delivered'
  if (v === 'draft'   || v === 'scheduled') return 'draft'
  if (v === 'sent'    || v === 'inprogress' || v === 'waitingforothers'
      || v === 'needsattention' || v === 'none') return 'sent'
  return v || 'sent'
}

// Per-signer snapshot stored in esign_documents.signer_status so the UI can
// show who has viewed/signed without another API round-trip.
function extractSignerStatus(props) {
  return (props?.signerDetails || []).map(s => ({
    name:          s.signerName  || s.name  || '',
    email:         s.signerEmail || s.email || '',
    status:        normalizeStatus(s.status === 'NotCompleted' && s.isViewed ? 'viewed' : s.status),
    viewed:        Boolean(s.isViewed),
    declined_reason: s.declineMessage || null,
    last_activity: s.lastActivityDate || null,
  }))
}

// ─── Template mapping ────────────────────────────────────────────────────────
// BoldSign templates carry roles; each role owns form fields placed on the
// template. Text-like fields (textbox / label / dropdown / checkbox) can be
// pre-filled per send via existingFormFields — this is the org-level-template
// + per-send-customization flow the CRM is built around.
const PREFILLABLE = new Set(['textbox', 'label', 'dropdown', 'checkbox'])

function mapTemplateSummary(t) {
  return {
    id:          t.documentId || t.templateId || t.id,
    name:        t.templateName || t.messageTitle || t.documentTitle || 'Untitled template',
    description: t.templateDescription || t.description || '',
    createdAt:   t.createdDate || null,
  }
}

function mapTemplateRoles(props) {
  const roles = props?.roles || props?.templateRoles || []
  return roles.map((r, i) => ({
    roleIndex:    r.roleIndex ?? r.index ?? i + 1,
    roleName:     r.name || r.roleName || `Signer ${i + 1}`,
    defaultName:  r.defaultSignerName  || '',
    defaultEmail: r.defaultSignerEmail || '',
    signerOrder:  r.signerOrder ?? null,
    fields: (r.formFields || [])
      .filter(f => PREFILLABLE.has(String(f.fieldType || '').toLowerCase()))
      .map(f => ({
        id:    f.id || f.fieldId || f.name,
        type:  String(f.fieldType || '').toLowerCase(),
        value: f.value ?? '',
      }))
      .filter(f => f.id),
  }))
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  applyJsonCors(res)
  if (req.method === 'OPTIONS') return res.status(200).end()

  // GET/HEAD → health check. Lets anyone confirm the endpoint is deployed by
  // opening this URL in a browser, and keeps webhook-URL verifiers that probe
  // with GET happy. All real work happens via POST.
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.status(200).json({
      ok: true,
      service: 'gateway-crm/boldsign',
      configured: Boolean(API_KEY),
      hint: 'This endpoint is live. BoldSign webhook events and CRM actions are accepted via POST.',
    })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const body = req.body || {}

  // BoldSign webhook payloads carry { event, document } and no `action` field.
  // Route those to the webhook handler.
  if (!body.action) return handleWebhook(req, res)

  // Co-hosted closing-packet handler (lives in api/_handlers/, no extra Vercel
  // function). Admin auth is enforced inside the handler.
  if (body.action === 'closing-packet') return closingPacketHandler(req, res)

  if (!API_KEY) {
    return res.status(500).json({
      error: 'BoldSign environment variables not configured',
      missing: { BOLDSIGN_API_KEY: true },
    })
  }

  // Every authenticated frontend action requires a real session. Without this
  // gate, anyone with the public URL could send signature requests on the
  // brokerage's BoldSign account.
  let actor
  try { actor = await requireAgent(req) } catch (e) { return errorResponse(res, e) }

  if (body.action === 'debug') {
    return res.json({
      apiBase:       API_BASE,
      apiKeyPresent: Boolean(API_KEY),
      apiKeyPrefix:  API_KEY ? `${API_KEY.slice(0, 6)}…` : null,
      actor:         { agent: actor.agent.name, isAdmin: actor.isAdmin },
    })
  }

  try {
    // ── Org template catalog ──────────────────────────────────────────────
    if (body.action === 'templates') {
      const data = await boldsign(`/v1/template/list?PageSize=${Number(body.pageSize) || 50}&Page=${Number(body.page) || 1}`)
      const items = data?.result || data?.results || data?.templates || []
      return res.json({ templates: items.map(mapTemplateSummary) })
    }

    // Roles + pre-fillable fields for one template — drives the per-send
    // customization UI.
    if (body.action === 'template-fields') {
      if (!body.templateId) return res.status(400).json({ error: 'templateId required' })
      const props = await boldsign(`/v1/template/properties?templateId=${encodeURIComponent(body.templateId)}`)
      return res.json({
        id:    body.templateId,
        name:  props?.templateName || props?.messageTitle || '',
        roles: mapTemplateRoles(props),
      })
    }

    // ── Send from a reusable template (direct send, no editor hop) ────────
    // body.roles: [{ roleIndex, name, email, order?, existingFields?: [{id,value}] }]
    if (body.action === 'send-template') {
      const { templateId, roles, documentTitle, emailSubject, message } = body
      if (!templateId)    return res.status(400).json({ error: 'templateId required' })
      if (!roles?.length) return res.status(400).json({ error: 'At least one signer required' })
      const invalid = roles.find(r => !r.name?.trim() || !r.email?.trim())
      if (invalid) return res.status(400).json({ error: 'All signers need a name and email' })

      const hasOrder = roles.some(r => Number(r.order || 1) !== 1)
      const payload = {
        title:   documentTitle || emailSubject || 'Document',
        message: message || emailSubject || 'Please sign this document',
        roles: roles.map(r => ({
          roleIndex:   Number(r.roleIndex),
          signerName:  r.name,
          signerEmail: r.email,
          ...(hasOrder ? { signerOrder: Number(r.order || 1) } : {}),
          ...(r.existingFields?.length
            ? { existingFormFields: r.existingFields
                  .filter(f => f.id && f.value !== '' && f.value != null)
                  .map(f => ({ id: f.id, value: String(f.value) })) }
            : {}),
        })),
        ...(hasOrder ? { enableSigningOrder: true } : {}),
      }

      const data = await boldsign(`/v1/template/send/${encodeURIComponent(templateId)}`, {
        method: 'POST', body: payload,
      })
      return res.json({ documentId: data.documentId || data.id, status: 'sent' })
    }

    // ── Send an uploaded PDF via BoldSign's embedded prepare page ─────────
    // Mirrors the old draft flow: we create the request, the agent places
    // fields in BoldSign's prepare UI (new tab) and clicks Send there.
    if (body.action === 'send') {
      const { signers, documentBase64, documentName, emailSubject } = body
      if (!documentBase64)  return res.status(400).json({ error: 'documentBase64 required' })
      if (!signers?.length) return res.status(400).json({ error: 'At least one signer required' })

      const orderedSigners = [...signers].sort((a, b) =>
        Number(a.routingOrder || 1) - Number(b.routingOrder || 1)
      )
      const hasOrder = orderedSigners.some(s => Number(s.routingOrder || 1) !== 1)

      const payload = {
        title:   documentName || 'Document',
        message: emailSubject || 'Please sign this document',
        files:   [`data:application/pdf;base64,${documentBase64}`],
        signers: orderedSigners.map(s => ({
          name:       s.name,
          email:      s.email,
          signerType: 'Signer',
          ...(hasOrder ? { signerOrder: Number(s.routingOrder || 1) } : {}),
        })),
        ...(hasOrder ? { enableSigningOrder: true } : {}),
        sendViewOption: 'PreparePage',
        showToolbar:    true,
        showSendButton: true,
        showSaveButton: true,
      }

      const data = await boldsign('/v1/document/createEmbeddedRequestUrl', {
        method: 'POST', body: payload,
      })
      return res.json({
        documentId: data.documentId || data.id,
        status:     'draft',
        prepareUrl: data.sendUrl || null,
      })
    }

    // ── Status poll (also used by the manual refresh button) ──────────────
    if (body.action === 'status') {
      const id = body.documentId || body.envelopeId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      const props = await boldsign(`/v1/document/properties?documentId=${encodeURIComponent(id)}`)
      return res.json({
        status:            normalizeStatus(props.status),
        signerStatus:      extractSignerStatus(props),
        sentDateTime:      props.createdDate  || null,
        completedDateTime: props.completedDate || props.statusDate || null,
      })
    }

    // ── Signed-PDF download (base64, matches the old response shape) ──────
    if (body.action === 'download') {
      const id = body.documentId || body.envelopeId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      const r = await boldsign(`/v1/document/download?documentId=${encodeURIComponent(id)}`, { raw: true })
      if (!r.ok) return res.status(400).json({ error: 'Signed PDF not available yet' })
      const buffer = await r.arrayBuffer()
      return res.json({
        base64:      Buffer.from(buffer).toString('base64'),
        contentType: 'application/pdf',
      })
    }

    // ── Remind pending signers ─────────────────────────────────────────────
    if (body.action === 'remind') {
      const id = body.documentId || body.envelopeId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      // BoldSign requires the receiver emails; pull pending signers from the doc.
      const props   = await boldsign(`/v1/document/properties?documentId=${encodeURIComponent(id)}`)
      const pending = (props?.signerDetails || [])
        .filter(s => String(s.status) !== 'Completed')
        .map(s => s.signerEmail || s.email)
        .filter(Boolean)
      if (!pending.length) return res.status(400).json({ error: 'No pending signers to remind' })
      const qs = pending.map(e => `receiverEmails=${encodeURIComponent(e)}`).join('&')
      await boldsign(`/v1/document/remind?documentId=${encodeURIComponent(id)}&${qs}`, {
        method: 'POST', body: {},
      })
      return res.json({ ok: true, reminded: pending })
    }

    // ── Revoke (void) an in-flight request ────────────────────────────────
    if (body.action === 'revoke') {
      const id = body.documentId || body.envelopeId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      await boldsign(`/v1/document/revoke?documentId=${encodeURIComponent(id)}`, {
        method: 'POST',
        body:   { revokeMessage: body.reason || 'Revoked from Gateway CRM' },
      })
      return res.json({ ok: true })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}

// ─── BoldSign webhook handler ────────────────────────────────────────────────
// BoldSign POSTs document lifecycle events (Sent, Viewed, Signed, Completed,
// Declined, Expired, Revoked, SendFailed, …) to the registered webhook URL as
// { event: { eventType, … }, document: { documentId, … } }.
//
// Register (one time) in BoldSign → API → Webhooks with the URL:
//   https://<your-domain>/api/boldsign
//
// Trust model: the payload is treated as an untrusted *trigger only*. We never
// write payload data to the database — we re-fetch the document from the
// BoldSign API (server-side key) and persist that authoritative state. A
// forged webhook can therefore only cause a re-sync of a document we already
// track. (Vercel parses the JSON body before we see it, so raw-body HMAC
// verification of X-BoldSign-Signature isn't byte-reliable here; the
// round-trip gives a stronger guarantee anyway.)
async function handleWebhook(req, res) {
  // BoldSign's webhook-registration "Verify" button sends a Verification
  // event with no document attached. Acknowledge immediately — before any
  // Supabase dependency — so registration succeeds even on a half-configured
  // deployment.
  const probeEvent =
    req.body?.event?.eventType ||
    req.body?.eventType        ||
    ''
  if (String(probeEvent).toLowerCase() === 'verification') {
    return res.status(200).json({ received: true, verification: true })
  }

  let supabase
  try { supabase = getServiceClient() }
  catch (e) { return res.status(200).json({ received: true, error: e.message }) }

  try {
    const body = req.body || {}

    const eventName =
      body?.event?.eventType ||
      body?.eventType        ||
      body?.event            ||
      ''

    const doc =
      body?.document      ||
      body?.data?.document||
      body?.data          ||
      body

    const documentId = doc?.documentId || doc?.id || body?.documentId
    if (!documentId) return res.status(200).json({ received: true, note: 'No document id' })

    const { data: record } = await supabase
      .from('esign_documents')
      .select('*, deals(id, agent_id, title)')
      .eq('document_id', documentId)
      .maybeSingle()

    if (!record) return res.status(200).json({ received: true, note: 'Document not tracked' })

    // Authoritative state from the API, not the payload.
    let status, signerStatus, completedAt, errorText = null
    try {
      const props  = await boldsign(`/v1/document/properties?documentId=${encodeURIComponent(documentId)}`)
      status       = normalizeStatus(props.status)
      signerStatus = extractSignerStatus(props)
      completedAt  = props.completedDate || props.statusDate || null
      const decliner = signerStatus.find(s => s.declined_reason)
      if (status === 'declined') errorText = decliner?.declined_reason ? `Declined: ${decliner.declined_reason}` : 'Declined by signer'
      if (status === 'expired')  errorText = 'Signature request expired before all parties signed'
      if (String(eventName).toLowerCase() === 'sendfailed') {
        status    = 'error'
        errorText = 'BoldSign could not deliver the signature request (send failed)'
      }
    } catch (e) {
      // API unreachable — keep the row but surface the sync failure.
      return res.status(200).json({ received: true, error: `Status re-fetch failed: ${e.message}` })
    }

    const patch = { status, signer_status: signerStatus, error: errorText }
    if (completedAt && (status === 'completed')) patch.completed_at = completedAt
    await supabase.from('esign_documents').update(patch).eq('document_id', documentId)

    if (status === 'completed' && record.status !== 'completed') {
      // Download signed PDF + stash in deal-documents storage so agents can
      // grab it without round-tripping the BoldSign API.
      try {
        const r = await boldsign(`/v1/document/download?documentId=${encodeURIComponent(documentId)}`, { raw: true })
        if (r.ok) {
          const pdfBuffer   = await r.arrayBuffer()
          const baseName    = (record.document_name || 'document').replace(/\.pdf$/i, '')
          const storagePath = `deal-${record.deal_id}/${Date.now()}-signed-${baseName}.pdf`
          await supabase.storage.from('deal-documents').upload(
            storagePath, Buffer.from(pdfBuffer), { contentType: 'application/pdf', upsert: false }
          )
        }
      } catch (_) { /* non-fatal — status was already saved */ }

      const deal = record.deals
      if (deal?.agent_id) {
        await supabase.from('agent_notifications').insert([{
          agent_id:    deal.agent_id,
          deal_id:     record.deal_id,
          envelope_id: documentId,
          title:       'Document Signed',
          message:     `"${record.document_name || 'Document'}" for ${deal.title || 'your deal'} has been fully signed by ${record.signer_name || 'the signer'}. The signed copy has been saved to the deal's Documents tab.`,
          type:        'document_signed',
        }])
      }
    }

    return res.status(200).json({ received: true, documentId, status })
  } catch (err) {
    return res.status(200).json({ received: true, error: err.message })
  }
}

// (Closing packet generator lives in api/_handlers/closing-packet.js)
