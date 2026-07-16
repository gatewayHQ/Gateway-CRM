import { applyJsonCors, requireAgent, errorResponse, getServiceClient } from './_lib/auth.js'
import closingPacketHandler from './_handlers/closing-packet.js'
import { PDFDocument } from 'pdf-lib'
import crypto from 'node:crypto'

// We verify webhook signatures against the RAW request body, so the automatic
// body parser must be off — we read the stream and parse it ourselves below.
export const config = { api: { bodyParser: false } }

// ─── BoldSign REST API client ────────────────────────────────────────────────
// https://developers.boldsign.com — auth via X-API-KEY header, base /v1.
// Sandbox vs Live is decided entirely by WHICH api key is configured (there is
// no per-request test flag like SignWell had); a sandbox key never sends real
// email or consumes credits.
const API_BASE = 'https://api.boldsign.com/v1'
const API_KEY  = process.env.BOLDSIGN_API_KEY
const WEBHOOK_SECRET = process.env.BOLDSIGN_WEBHOOK_SECRET

// Read the raw request body as a string (body parser is disabled above).
async function readRawBody(req) {
  if (typeof req.body === 'string') return req.body
  if (Buffer.isBuffer(req.body))    return req.body.toString('utf8')
  const chunks = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  return Buffer.concat(chunks).toString('utf8')
}

// Verify BoldSign's X-BoldSign-Signature header ("t=<unix>, s0=<hmac-sha256-hex>")
// over `${t}.${rawBody}` using the endpoint's signing secret. Returns:
//   'ok'         — verified (or no secret configured → verification disabled)
//   'invalid'    — secret configured but signature/timestamp did not match
function verifyWebhookSignature(rawBody, header) {
  if (!WEBHOOK_SECRET) return 'ok'                  // opt-in — unset preserves prior behavior
  if (!header) return 'invalid'
  const parts = {}
  for (const kv of String(header).split(',')) {
    const [k, v] = kv.split('=').map(s => (s || '').trim())
    if (k) parts[k] = v
  }
  const t = parts.t, sig = parts.s0
  if (!t || !sig) return 'invalid'
  // Reject events outside a 5-minute window (replay protection).
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(Number(t)) || Math.abs(now - Number(t)) > 300) return 'invalid'
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex')
  const a = Buffer.from(expected), b = Buffer.from(String(sig))
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'invalid'
}

async function boldsign(path, { method = 'GET', form, json, raw = false } = {}) {
  const headers = { 'X-API-KEY': API_KEY, Accept: 'application/json' }
  let body
  if (form) {
    body = form                       // FormData — fetch sets the multipart boundary itself
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(json)
  }
  const r = await fetch(`${API_BASE}${path}`, { method, headers, body })
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

// ─── Field placement ─────────────────────────────────────────────────────────
// BoldSign requires at least one form field per signer. We send directly (no
// embedded editor), so we place the fields programmatically:
//   • If a signer carries explicit `tabs` (type/page/x/y), we honor them.
//   • Otherwise we auto-place a Signature + DateSigned near the bottom of the
//     LAST page, stacking each signer upward so blocks don't overlap.
// BoldSign bounds use a TOP-LEFT origin in PDF points (72/inch), y increasing
// downward — so a larger y sits lower on the page. We read the page size with
// pdf-lib only to learn the last page's dimensions (pdf-lib's own draw origin
// is bottom-left, but we never draw with it here). These defaults are a
// sensible starting point; tune the coordinates if a document needs it.
const FIELD_TYPES = {
  signature: 'Signature',
  initials:  'Initial',
  date:      'DateSigned',
  checkbox:  'CheckBox',
  text:      'TextBox',
}

async function buildSigners(orderedSigners, pdfBuffer) {
  // Read the PDF once to learn the last page + its dimensions for defaults.
  let lastPage = 1, pageW = 612, pageH = 792   // US-Letter fallback
  try {
    const doc  = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true })
    lastPage   = doc.getPageCount() || 1
    const page = doc.getPage(lastPage - 1)
    pageW = page.getWidth()
    pageH = page.getHeight()
  } catch { /* fall back to Letter defaults — send still succeeds */ }

  return orderedSigners.map((s, i) => {
    let formFields
    if (Array.isArray(s.tabs) && s.tabs.length) {
      // Explicit coordinates supplied by the caller.
      formFields = s.tabs.map((t, j) => ({
        id:         t.api_id || `f_${i + 1}_${j + 1}`,
        fieldType:  FIELD_TYPES[t.type] || 'Signature',
        pageNumber: Number(t.page) || 1,
        bounds: {
          x:      Number(t.xPosition) || 0,
          y:      Number(t.yPosition) || 0,
          width:  Number(t.width)  || 180,
          height: Number(t.height) || 35,
        },
        isRequired: t.required !== false,
      }))
    } else {
      // Auto-placed signature + date on the last page, one row per signer.
      const rowY = Math.max(40, pageH - 120 - i * 80)
      formFields = [
        { id: `sig_${i + 1}`,  fieldType: 'Signature',  pageNumber: lastPage,
          bounds: { x: 60,  y: rowY, width: 180, height: 35 }, isRequired: true },
        { id: `date_${i + 1}`, fieldType: 'DateSigned', pageNumber: lastPage,
          bounds: { x: Math.min(300, pageW - 150), y: rowY, width: 130, height: 25 }, isRequired: false },
      ]
    }
    return {
      name:         s.name,
      emailAddress: s.email,
      signerType:   'Signer',
      signerOrder:  Number(s.routingOrder || 1),
      formFields,
    }
  })
}

// BoldSign's multipart /document/send binds ONE signer per repeated `Signers`
// field, each value a single JSON object — NOT one field holding a JSON array
// (that yields {"Signers":["Value is invalid"]}). Append them the right way.
function appendSigners(form, signerPayload) {
  for (const s of signerPayload) form.append('Signers', JSON.stringify(s))
}

// Validate signers before hitting the API — the other common source of
// "Signers: Value is invalid" is an empty or malformed email/name.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
function validateSigners(signers) {
  if (!Array.isArray(signers) || !signers.length) return 'At least one signer is required'
  for (const s of signers) {
    if (!s?.name || !String(s.name).trim())            return 'Every signer needs a name'
    if (!s?.email || !EMAIL_RE.test(String(s.email).trim())) return `"${s?.name || 'Signer'}" needs a valid email address`
  }
  return null
}

// ─── Status normalization ─────────────────────────────────────────────────────
// BoldSign statuses: None / Sent / InProgress / WaitingForOthers / NeedToSign /
// Completed / Declined / Revoked / Expired / Viewed. Frontend expects lowercase
// docusign-style values, so we normalize on every read.
function normalizeStatus(s) {
  const v = String(s || '').toLowerCase()
  if (v === 'completed' || v === 'signed')                 return 'completed'
  if (v === 'declined')                                    return 'declined'
  if (v === 'revoked' || v === 'voided' || v === 'canceled' || v === 'cancelled') return 'voided'
  if (v === 'expired')                                     return 'voided'
  if (v === 'viewed' || v === 'delivered')                 return 'delivered'
  if (v === 'sent' || v === 'inprogress' || v === 'waitingforothers' || v === 'needtosign') return 'sent'
  return v || 'sent'
}

// BoldSign timestamps come back as Unix epoch seconds. Accept a number (seconds)
// or an already-formatted date string; return an ISO string or null.
function toIso(v) {
  if (v == null) return null
  if (typeof v === 'number') return new Date(v * 1000).toISOString()
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

// Sender-identity approval status → our lowercase enum.
function normalizeIdentityStatus(s) {
  const v = String(s || '').toLowerCase()
  if (v === 'approved' || v === 'active')   return 'approved'
  if (v === 'declined' || v === 'denied')   return 'declined'
  return 'pending'
}

// Resolve the "send as this agent" email. Returns the agent's sender-identity
// email ONLY if it's approved in BoldSign; otherwise null (send from the
// account default). Uses the service client so it works regardless of caller RLS.
async function resolveOnBehalfOf(supabase, agentId) {
  if (!agentId) return null
  try {
    const { data } = await supabase
      .from('boldsign_sender_identities')
      .select('email, status')
      .eq('agent_id', agentId)
      .maybeSingle()
    return data && data.status === 'approved' ? data.email : null
  } catch { return null }
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  applyJsonCors(res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  // A GET returns 200 so webhook-endpoint reachability checks pass.
  if (req.method === 'GET')     return res.status(200).json({ ok: true })
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' })

  // Body parser is disabled — read the raw body once, parse it, and expose the
  // parsed object on req.body so downstream handlers keep working. Keep the raw
  // string for webhook signature verification.
  const rawBody = await readRawBody(req)
  let body = {}
  try { body = rawBody ? JSON.parse(rawBody) : {} } catch { body = {} }
  req.body    = body
  req.rawBody = rawBody

  // BoldSign webhook payloads do NOT carry an `action` field. Route those to the
  // webhook handler, which verifies the signature (when a secret is configured)
  // and authenticates by document-id round-trip.
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

  // Every authenticated frontend action — send, status, download, remind —
  // requires a real session. Without this gate, anyone with the public URL could
  // send signature requests on the brokerage's BoldSign account.
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
    if (body.action === 'send') {
      const { signers, documentBase64, documentName, emailSubject } = body
      if (!documentBase64) return res.status(400).json({ error: 'documentBase64 required' })
      const invalid = validateSigners(signers)
      if (invalid) return res.status(400).json({ error: invalid })

      const orderedSigners = [...signers].sort((a, b) =>
        Number(a.routingOrder || 1) - Number(b.routingOrder || 1)
      )
      const hasOrder = orderedSigners.some(s => Number(s.routingOrder || 1) !== 1)

      const pdfBuffer     = Buffer.from(documentBase64, 'base64')
      const signerPayload = await buildSigners(orderedSigners, pdfBuffer)

      // Send AS the acting agent when they have an approved sender identity, so
      // the client sees the request coming from their agent (not a generic box).
      let onBehalfOf = null
      try { onBehalfOf = await resolveOnBehalfOf(getServiceClient(), actor.agent.id) } catch { /* fall back to account default */ }

      // BoldSign send = multipart/form-data: Files (binary) + one repeated
      // `Signers` field per signer (JSON object each).
      const form = new FormData()
      form.append('Title',              documentName || 'Document')
      form.append('Message',            emailSubject || 'Please sign this document')
      form.append('EnableSigningOrder', String(hasOrder))
      appendSigners(form, signerPayload)
      if (onBehalfOf) form.append('OnBehalfOf', onBehalfOf)
      form.append('Files', new Blob([pdfBuffer], { type: 'application/pdf' }), documentName || 'document.pdf')

      const data = await boldsign('/document/send', { method: 'POST', form })

      return res.json({
        envelopeId: data.documentId,   // alias for app compatibility
        documentId: data.documentId,
        status:     'sent',
      })
    }

    // Ad-hoc embedded send: upload a PDF and get a BoldSign prepare/send URL to
    // render in an iframe (agent adjusts fields + clicks Send inside BoldSign).
    if (body.action === 'document-embed-url') {
      const { signers, documentBase64, documentName, emailSubject, redirectUrl } = body
      if (!documentBase64) return res.status(400).json({ error: 'documentBase64 required' })
      const invalidEmbed = validateSigners(signers)
      if (invalidEmbed) return res.status(400).json({ error: invalidEmbed })

      const orderedSigners = [...signers].sort((a, b) => Number(a.routingOrder || 1) - Number(b.routingOrder || 1))
      const hasOrder      = orderedSigners.some(s => Number(s.routingOrder || 1) !== 1)
      const pdfBuffer     = Buffer.from(documentBase64, 'base64')
      const signerPayload = await buildSigners(orderedSigners, pdfBuffer)
      let onBehalfOf = null
      try { onBehalfOf = await resolveOnBehalfOf(getServiceClient(), actor.agent.id) } catch { /* default sender */ }

      const form = new FormData()
      form.append('Title',              documentName || 'Document')
      form.append('Message',            emailSubject || 'Please sign this document')
      form.append('EnableSigningOrder', String(hasOrder))
      appendSigners(form, signerPayload)
      form.append('SendViewOption',     'PreparePage')
      form.append('ShowToolbar',        'true')
      if (redirectUrl) form.append('RedirectUrl', redirectUrl)
      if (onBehalfOf)  form.append('OnBehalfOf', onBehalfOf)
      form.append('Files', new Blob([pdfBuffer], { type: 'application/pdf' }), documentName || 'document.pdf')

      const data = await boldsign('/document/createEmbeddedRequestUrl', { method: 'POST', form })
      return res.json({ url: data.sendUrl || data.embeddedSendUrl || data.url || null, documentId: data.documentId || null })
    }

    // Embedded SIGNING: a URL to load in an iframe so a signer completes the
    // document inside our app instead of via the BoldSign email link.
    if (body.action === 'sign-link') {
      const id          = body.envelopeId || body.documentId
      const signerEmail = body.signerEmail
      if (!id)          return res.status(400).json({ error: 'documentId required' })
      if (!signerEmail) return res.status(400).json({ error: 'signerEmail required' })
      const qs = new URLSearchParams({ documentId: id, signerEmail })
      if (body.redirectUrl) qs.set('redirectUrl', body.redirectUrl)
      const data = await boldsign(`/document/getEmbeddedSignLink?${qs.toString()}`)
      return res.json({ url: data.signLink || data.embeddedSigningLink || data.url || null })
    }

    if (body.action === 'status') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      const data = await boldsign(`/document/properties?documentId=${encodeURIComponent(id)}`)
      return res.json({
        status:            normalizeStatus(data.status),
        sentDateTime:      toIso(data.createdDate || data.sentDate || null),
        completedDateTime: toIso(data.completedDate || data.signedDate || null),
      })
    }

    if (body.action === 'download') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      // BoldSign returns the signed PDF bytes directly (not a JSON url).
      const r = await boldsign(`/document/download?documentId=${encodeURIComponent(id)}`, { raw: true })
      if (!r.ok) return res.status(400).json({ error: 'Completed PDF not available' })
      const buffer = await r.arrayBuffer()
      return res.json({
        base64:      Buffer.from(buffer).toString('base64'),
        contentType: 'application/pdf',
      })
    }

    if (body.action === 'remind') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      await boldsign(`/document/remind?documentId=${encodeURIComponent(id)}`, { method: 'POST', json: {} })
      return res.json({ ok: true })
    }

    // ─── Phase 1: Sender identities (admin only) ──────────────────────────────
    // Each agent is registered as a sender identity so their signature requests
    // come from them. BoldSign emails the agent an approval link; we track the
    // Pending → Approved lifecycle in boldsign_sender_identities.
    if (body.action === 'identity-create') {
      if (!actor.isAdmin) return res.status(403).json({ error: 'Admin only' })
      const { agentId, name, email } = body
      if (!email) return res.status(400).json({ error: 'email required' })
      await boldsign('/senderIdentities/create', { method: 'POST', json: { Name: name || email, Email: email } })
      const svc = getServiceClient()
      await svc.from('boldsign_sender_identities').upsert({
        agent_id: agentId || null, email, name: name || null,
        status: 'pending', updated_at: new Date().toISOString(),
      }, { onConflict: 'agent_id' })
      return res.json({ ok: true, email, status: 'pending' })
    }

    if (body.action === 'identity-sync') {
      if (!actor.isAdmin) return res.status(403).json({ error: 'Admin only' })
      const list  = await boldsign('/senderIdentities/list')
      const items = list.result || list.identities || (Array.isArray(list) ? list : [])
      const svc   = getServiceClient()
      for (const it of items) {
        const email = it.email || it.senderEmail
        if (!email) continue
        await svc.from('boldsign_sender_identities')
          .update({ status: normalizeIdentityStatus(it.status || it.approvalStatus), updated_at: new Date().toISOString() })
          .eq('email', email)
      }
      return res.json({ ok: true, count: items.length })
    }

    if (body.action === 'identity-resend') {
      if (!actor.isAdmin) return res.status(403).json({ error: 'Admin only' })
      if (!body.email) return res.status(400).json({ error: 'email required' })
      await boldsign('/senderIdentities/resendInvitation', { method: 'POST', json: { email: body.email } })
      return res.json({ ok: true })
    }

    // ─── Templates ────────────────────────────────────────────────────────────
    if (body.action === 'template-list') {
      const data = await boldsign('/template/list?page=1&pageSize=100')
      return res.json({ templates: data.result || data.templates || [] })
    }

    // Read a template's roles + form fields so the app can render one signer
    // input per role and one value input per fillable field (dynamic send).
    if (body.action === 'template-details') {
      const { templateId } = body
      if (!templateId) return res.status(400).json({ error: 'templateId required' })
      const data = await boldsign(`/template/properties?templateId=${encodeURIComponent(templateId)}`)
      const rawRoles  = data.roles || data.signerRoles || data.templateRoles || []
      const roles = rawRoles.map((r, i) => ({
        index: Number(r.roleIndex ?? r.index ?? i + 1),
        name:  r.roleName || r.name || r.signerRole || `Role ${i + 1}`,
        defaultName:  r.signerName || r.defaultSignerName || '',
        defaultEmail: r.signerEmail || r.defaultSignerEmail || '',
      }))
      const rawFields = data.formFields || data.fields || []
      const fields = rawFields.map(f => ({
        id:        f.id || f.fieldId || f.name,
        type:      f.fieldType || f.type,
        roleIndex: f.roleIndex != null ? Number(f.roleIndex) : (f.signerIndex != null ? Number(f.signerIndex) : null),
      })).filter(f => f.id)
      return res.json({ roles, fields })
    }

    // Returns an embedded BoldSign editor URL (open in an iframe/new tab) where an
    // admin places/moves/removes fields. Pass a templateId to edit an existing
    // template, or a PDF (documentBase64) to build a new one.
    if (body.action === 'template-editor-url') {
      if (!actor.isAdmin) return res.status(403).json({ error: 'Admin only' })
      const { templateId, title, documentBase64, documentName, redirectUrl } = body
      if (templateId) {
        const data = await boldsign(`/template/getEmbeddedTemplateEditUrl?templateId=${encodeURIComponent(templateId)}`, {
          method: 'POST', json: { RedirectUrl: redirectUrl || '', ShowToolbar: true, ViewOption: 'PreparePage' },
        })
        return res.json({ url: data.editUrl || data.createUrl || data.url, templateId })
      }
      if (!documentBase64) return res.status(400).json({ error: 'documentBase64 or templateId required' })
      const form = new FormData()
      form.append('Title',       title || 'New Template')
      form.append('RedirectUrl', redirectUrl || '')
      form.append('ShowToolbar', 'true')
      form.append('Files', new Blob([Buffer.from(documentBase64, 'base64')], { type: 'application/pdf' }), documentName || 'template.pdf')
      const data = await boldsign('/template/createEmbeddedTemplateUrl', { method: 'POST', form })
      return res.json({ url: data.createUrl, templateId: data.templateId })
    }

    // Send a document generated from a template, with CRM-prefilled fields.
    // roles: [{ roleIndex, signerName, signerEmail, signerOrder?,
    //           existingFormFields: [{ id, value, isReadOnly }] }]
    if (body.action === 'template-send') {
      const { templateId, deal_id, roles, emailSubject, message, cc, documentName, labels, roleRemovalIndices } = body
      if (!templateId)     return res.status(400).json({ error: 'templateId required' })
      if (!roles?.length)  return res.status(400).json({ error: 'roles required' })

      const svc        = getServiceClient()
      const onBehalfOf = await resolveOnBehalfOf(svc, actor.agent.id)
      const payload = {
        // `title` is the sent-document name the signer sees (and the signed PDF
        // filename). Prefer the caller's documentName so it's deal-specific.
        title:   documentName || emailSubject || 'Please sign this document',
        message: message || 'Please review and sign.',
        roles,
        ...(Array.isArray(roleRemovalIndices) && roleRemovalIndices.length ? { roleRemovalIndices } : {}),
        ...(cc ? { cc } : {}),
        ...(Array.isArray(labels) && labels.length ? { labels } : {}),   // BoldSign tags
        ...(onBehalfOf ? { onBehalfOf } : {}),
      }
      const data = await boldsign(`/template/send?templateId=${encodeURIComponent(templateId)}`, { method: 'POST', json: payload })

      if (deal_id) {
        await svc.from('boldsign_documents').insert([{
          deal_id,
          agent_id:      actor.agent.id,
          document_id:   data.documentId,
          signer_name:   roles.map(r => r.signerName).filter(Boolean).join(', '),
          signer_email:  roles.map(r => r.signerEmail).filter(Boolean).join(', '),
          document_name: documentName || emailSubject || 'Document',
          subject:       emailSubject || null,
          signers:       roles,
          status:        'sent',
        }])
      }
      return res.json({ documentId: data.documentId, envelopeId: data.documentId, status: 'sent' })
    }

    // Like template-send, but returns an embedded BoldSign "prepare" URL where
    // the agent can move/add/remove field placements before clicking Send. The
    // document stays a draft until they send; the Sent webhook flips it to 'sent'.
    if (body.action === 'template-embed-url') {
      const { templateId, deal_id, roles, emailSubject, message, cc, documentName, labels, redirectUrl, roleRemovalIndices } = body
      if (!templateId)     return res.status(400).json({ error: 'templateId required' })
      if (!roles?.length)  return res.status(400).json({ error: 'roles required' })

      const svc        = getServiceClient()
      const onBehalfOf = await resolveOnBehalfOf(svc, actor.agent.id)
      const payload = {
        title:          documentName || emailSubject || 'Please sign this document',
        message:        message || 'Please review and sign.',
        roles,
        sendViewOption: 'PreparePage',   // land on the field-placement editor
        showToolbar:    true,
        redirectUrl:    redirectUrl || '',
        ...(Array.isArray(roleRemovalIndices) && roleRemovalIndices.length ? { roleRemovalIndices } : {}),
        ...(cc ? { cc } : {}),
        ...(Array.isArray(labels) && labels.length ? { labels } : {}),
        ...(onBehalfOf ? { onBehalfOf } : {}),
      }
      const data = await boldsign(`/template/createEmbeddedRequestUrl?templateId=${encodeURIComponent(templateId)}`, { method: 'POST', json: payload })

      // A draft document may be created immediately; track it so status updates
      // land when the agent finishes and BoldSign fires the Sent webhook.
      if (deal_id && data.documentId) {
        await svc.from('boldsign_documents').insert([{
          deal_id,
          agent_id:      actor.agent.id,
          document_id:   data.documentId,
          signer_name:   roles.map(r => r.signerName).filter(Boolean).join(', '),
          signer_email:  roles.map(r => r.signerEmail).filter(Boolean).join(', '),
          document_name: documentName || emailSubject || 'Document',
          subject:       emailSubject || null,
          signers:       roles,
          status:        'draft',
        }])
      }
      return res.json({ url: data.sendUrl || data.embeddedSendUrl || data.url || null, documentId: data.documentId || null })
    }

    return res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}

// ─── BoldSign webhook handler ──────────────────────────────────────────────────
// BoldSign POSTs document lifecycle events (Sent, Viewed, Signed, Completed,
// Declined, Revoked, Expired) to the registered callback URL as:
//   { event: { eventType, environment, ... }, data: { documentId, status, ... } }
//
// Register webhook (one time) in the BoldSign dashboard → Settings → API →
// Webhooks, pointed at https://<your-domain>/api/boldsign. Then "Reveal" the
// endpoint's signing secret and set BOLDSIGN_WEBHOOK_SECRET so inbound events
// are HMAC-verified (X-BoldSign-Signature) — unverified events are ignored.
//
async function handleWebhook(req, res) {
  // Reject forged/replayed events when a signing secret is configured. We still
  // answer 200 so BoldSign doesn't retry-storm a request we're deliberately
  // ignoring; we simply don't process it.
  const verdict = verifyWebhookSignature(req.rawBody || '', req.headers['x-boldsign-signature'])
  if (verdict === 'invalid') {
    return res.status(200).json({ received: true, ignored: 'signature verification failed' })
  }

  let supabase
  try { supabase = getServiceClient() }
  catch (e) { return res.status(200).json({ received: true, error: e.message }) }

  try {
    const body = req.body || {}

    // Defensive extraction — accept the documented { event, data } shape as well
    // as any flatter variant.
    const eventName =
      body?.event?.eventType ||
      body?.event?.type      ||
      body?.eventType        ||
      ''

    const doc =
      body?.data          ||
      body?.data?.document ||
      body?.document       ||
      body

    const documentId = doc?.documentId || doc?.id || body?.documentId
    const rawStatus  = doc?.status || eventName
    if (!documentId) return res.status(200).json({ received: true, note: 'No document id' })

    const status      = normalizeStatus(rawStatus)
    const completedAt = toIso(doc?.completedDate || doc?.signedDate || null)

    const { data: record } = await supabase
      .from('boldsign_documents')
      .select('*, deals(id, agent_id, title)')
      .eq('document_id', documentId)
      .maybeSingle()

    if (!record) return res.status(200).json({ received: true, note: 'Document not tracked' })

    const patch = { status }
    if (completedAt) patch.completed_at = completedAt
    await supabase.from('boldsign_documents').update(patch).eq('document_id', documentId)

    if (status === 'completed') {
      // Download signed PDF + stash it in deal-documents storage so agents can
      // grab it without round-tripping the BoldSign API.
      try {
        const r = await boldsign(`/document/download?documentId=${encodeURIComponent(documentId)}`, { raw: true })
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

// (Closing packet generator moved to api/_handlers/closing-packet.js)
