import { applyJsonCors, requireAgent, errorResponse, getServiceClient } from './_lib/auth.js'
import closingPacketHandler from './_handlers/closing-packet.js'
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

// Transient statuses worth retrying (rate limit + server/gateway errors).
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
// Exponential backoff with jitter; honor Retry-After (seconds) when present.
export function backoffMs(attempt, retryAfterSec) {
  if (retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 20000)
  return 400 * (2 ** attempt) + Math.floor(Math.random() * 250)   // 400/800/1600ms (+jitter)
}

// Central BoldSign client with idempotency + retry/backoff.
//   • idempotencyKey → sent as the `Idempotency-Key` header. Auto-generated for
//     write methods so an in-flight retry can't double-create if BoldSign honors
//     it. Retries reuse the SAME key (constant across the loop).
//   • Retries: network errors, 429, and 5xx. Writes are only retried because the
//     idempotency key makes them safe; GETs are always safe to retry.
export async function boldsign(path, { method = 'GET', form, json, raw = false, idempotencyKey, maxRetries = 3 } = {}) {
  const isWrite = method !== 'GET'
  const idem    = idempotencyKey || (isWrite ? crypto.randomUUID() : null)

  for (let attempt = 0; ; attempt++) {
    const headers = { 'X-API-KEY': API_KEY, Accept: 'application/json' }
    if (idem) headers['Idempotency-Key'] = idem
    let body
    if (form) {
      body = form                       // FormData — fetch sets the multipart boundary itself
    } else if (json !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(json)
    }

    let r
    try {
      r = await fetch(`${API_BASE}${path}`, { method, headers, body })
    } catch (netErr) {
      if (attempt < maxRetries) {
        const delay = backoffMs(attempt)
        console.warn(`[boldsign] network error on ${method} ${path} — retry ${attempt + 1}/${maxRetries} in ${delay}ms: ${netErr.message}`)
        await sleep(delay); continue
      }
      throw netErr
    }

    // Retry transient HTTP failures (bounded).
    if (!r.ok && RETRYABLE_STATUS.has(r.status) && attempt < maxRetries) {
      const delay = backoffMs(attempt, Number(r.headers.get('retry-after')) || 0)
      console.warn(`[boldsign] ${r.status} on ${method} ${path} — retry ${attempt + 1}/${maxRetries} in ${delay}ms`)
      await sleep(delay); continue
    }

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
}

// Pull a BoldSign PDF (signed document or audit trail) and archive it into the
// deal-documents bucket. Best-effort — returns { storagePath, size } or null.
async function archiveBoldsignPdf(supabase, { path, dealId, filename }) {
  try {
    const r = await boldsign(path, { raw: true })
    if (!r.ok) return null
    const buf = await r.arrayBuffer()
    const storagePath = `deal-${dealId}/${Date.now()}-${filename}`
    const { error } = await supabase.storage.from('deal-documents').upload(
      storagePath, Buffer.from(buf), { contentType: 'application/pdf', upsert: false }
    )
    return error ? null : { storagePath, size: buf.byteLength }
  } catch { return null }
}

// Record an archived BoldSign PDF in document_versions so it carries real CRM
// metadata (signer, completion date) instead of being just a bare storage
// object — mirrors what uploadDealDocument() does for manual uploads. Numbers
// the version per (deal_id, document_name) the same way that service does.
// Best-effort — never throws.
async function recordDocumentVersion(supabase, { dealId, documentName, storagePath, size, pinnedAs, note }) {
  try {
    const { data: existing } = await supabase
      .from('document_versions')
      .select('version_num')
      .eq('deal_id', dealId)
      .eq('document_name', documentName)
      .order('version_num', { ascending: false })
      .limit(1)
    const nextVersion = (existing?.[0]?.version_num || 0) + 1
    if (pinnedAs) {
      await supabase.from('document_versions')
        .update({ pinned_as: null })
        .eq('deal_id', dealId).eq('document_name', documentName).eq('pinned_as', pinnedAs)
    }
    await supabase.from('document_versions').insert([{
      deal_id: dealId, document_name: documentName, storage_path: storagePath,
      size, mime_type: 'application/pdf', version_num: nextVersion,
      pinned_as: pinnedAs || null, source: 'boldsign', note: note || null,
    }])
  } catch { /* best-effort — the storage upload already succeeded */ }
}

// ─── Field placement ─────────────────────────────────────────────────────────
// RETIRED: pixel/point coordinate auto-placement. It guessed field position from
// page dimensions read via pdf-lib, but BoldSign's `bounds` unit/origin couldn't
// be confirmed from the (WAF-blocked) docs — the guess was frequently off, and
// every real fix required manual coordinate tuning per document. That whole
// class of bug is gone now. Fields come from one of three places instead:
//   1. useTextTags: true — the PDF has `{{fieldType|signerIndex|required|label|
//      fieldId}}` text tags baked in; BoldSign scans and places fields itself.
//      See docs/boldsign-integration.md and text-tags/introduction.
//   2. signer.tabs — explicit, CALLER-supplied coordinates (not guessed). Kept
//      for integrations that already know exact placement.
//   3. Neither — for the embedded (PreparePage) send flow, the agent places
//      fields visually inside BoldSign. For the non-interactive `send` action
//      (no prepare step), this is rejected by requiresExplicitFieldPlacement()
//      below rather than silently guessing.
const FIELD_TYPES = {
  signature: 'Signature',
  initials:  'Initial',
  date:      'DateSigned',
  checkbox:  'CheckBox',
  text:      'TextBox',
}

// Build the BoldSign `Signers` entries. No coordinate guessing — only honors
// explicit signer.tabs if given; otherwise ships with no formFields.
export function buildSignerPayload(orderedSigners) {
  return orderedSigners.map((s, i) => {
    const entry = {
      name:         s.name,
      emailAddress: s.email,
      signerType:   'Signer',
      signerOrder:  Number(s.routingOrder || 1),
    }
    if (Array.isArray(s.tabs) && s.tabs.length) {
      entry.formFields = s.tabs.map((t, j) => ({
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
    }
    return entry
  })
}

// The non-interactive `send` action has no prepare step for the agent to place
// fields in, so it MUST get fields from text tags or explicit tabs — silently
// guessing coordinates is exactly the bug we retired. Returns an error string
// or null.
export function requiresExplicitFieldPlacement(signers, useTextTags) {
  if (useTextTags) return null
  const missing = (signers || []).find(s => !Array.isArray(s.tabs) || !s.tabs.length)
  if (missing) {
    return 'No field placement provided. Pass useTextTags: true (if the PDF has BoldSign text tags baked in) or tabs coordinates per signer — automatic placement was retired. For an interactive flow, use document-embed-url instead, where fields can be placed visually in BoldSign.'
  }
  return null
}

// BoldSign requires a non-empty Roles array when creating an embedded template
// — omitting it returns {"Roles":["Roles cannot be null or empty."]}. Default
// to a Seller/Listing-Agent pair matching our template convention (role 1 =
// client, role 2 = agent) if the caller doesn't specify roles; always produces
// a 1-based index per role.
export function normalizeTemplateRoles(roles) {
  const base = (Array.isArray(roles) && roles.length) ? roles : [{ name: 'Seller' }, { name: 'Listing Agent' }]
  return base.map((r, i) => ({ name: (r?.name || `Signer ${i + 1}`).trim(), index: Number(r?.index) || i + 1 }))
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

// Resolve the "send as this agent" email. Prefers the acting agent's OWN
// approved sender identity; falls back to the org's default identity (if one
// is set and approved) so admin/system sends still go out under a real,
// recognizable sender rather than the raw API account. Returns null (BoldSign
// account default) if neither is available. Uses the service client so it
// works regardless of caller RLS.
export async function resolveOnBehalfOf(supabase, agentId) {
  try {
    if (agentId) {
      const { data } = await supabase
        .from('boldsign_sender_identities')
        .select('email, status')
        .eq('agent_id', agentId)
        .maybeSingle()
      if (data?.status === 'approved') return data.email
    }
    const { data: fallback } = await supabase
      .from('boldsign_sender_identities')
      .select('email, status')
      .eq('is_default', true)
      .maybeSingle()
    return fallback?.status === 'approved' ? fallback.email : null
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
      const { signers, documentBase64, documentName, emailSubject, useTextTags, textTagDefinitions } = body
      if (!documentBase64) return res.status(400).json({ error: 'documentBase64 required' })
      const invalid = validateSigners(signers)
      if (invalid) return res.status(400).json({ error: invalid })
      // No prepare step here — fields must come from text tags or explicit tabs.
      const placementError = requiresExplicitFieldPlacement(signers, useTextTags)
      if (placementError) return res.status(400).json({ error: placementError })

      const orderedSigners = [...signers].sort((a, b) =>
        Number(a.routingOrder || 1) - Number(b.routingOrder || 1)
      )
      const hasOrder = orderedSigners.some(s => Number(s.routingOrder || 1) !== 1)

      const pdfBuffer     = Buffer.from(documentBase64, 'base64')
      const signerPayload = buildSignerPayload(orderedSigners)

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
      if (useTextTags) {
        form.append('UseTextTags', 'true')
        if (textTagDefinitions) form.append('TextTagDefinitions', JSON.stringify(textTagDefinitions))
      }
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
    // render in an iframe. If useTextTags is set, BoldSign auto-places fields
    // from the PDF's {{...}} tags; otherwise the agent places fields visually
    // in the PreparePage — no coordinates are guessed here either way.
    if (body.action === 'document-embed-url') {
      const { signers, documentBase64, documentName, emailSubject, redirectUrl, useTextTags, textTagDefinitions } = body
      if (!documentBase64) return res.status(400).json({ error: 'documentBase64 required' })
      const invalidEmbed = validateSigners(signers)
      if (invalidEmbed) return res.status(400).json({ error: invalidEmbed })

      const orderedSigners = [...signers].sort((a, b) => Number(a.routingOrder || 1) - Number(b.routingOrder || 1))
      const hasOrder      = orderedSigners.some(s => Number(s.routingOrder || 1) !== 1)
      const pdfBuffer     = Buffer.from(documentBase64, 'base64')
      const signerPayload = buildSignerPayload(orderedSigners)
      let onBehalfOf = null
      try { onBehalfOf = await resolveOnBehalfOf(getServiceClient(), actor.agent.id) } catch { /* default sender */ }

      const form = new FormData()
      form.append('Title',              documentName || 'Document')
      form.append('Message',            emailSubject || 'Please sign this document')
      form.append('EnableSigningOrder', String(hasOrder))
      appendSigners(form, signerPayload)
      form.append('SendViewOption',     'PreparePage')
      form.append('ShowToolbar',        'true')
      if (useTextTags) {
        form.append('UseTextTags', 'true')
        if (textTagDefinitions) form.append('TextTagDefinitions', JSON.stringify(textTagDefinitions))
      }
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

    if (body.action === 'audit-download') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      // Compliance audit trail (who/when/IP/hash). Ready once the doc completes.
      const r = await boldsign(`/document/downloadAuditLog?documentId=${encodeURIComponent(id)}`, { raw: true })
      if (!r.ok) return res.status(400).json({ error: 'Audit trail not available yet' })
      const buffer = await r.arrayBuffer()
      return res.json({ base64: Buffer.from(buffer).toString('base64'), contentType: 'application/pdf' })
    }

    if (body.action === 'remind') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      await boldsign(`/document/remind?documentId=${encodeURIComponent(id)}`, { method: 'POST', json: {} })
      return res.json({ ok: true })
    }

    // Delete a draft/unsigned/expired document to keep the Signatures tab tidy.
    // Deliberately refuses to delete a 'completed' record — that's the signed
    // legal record and shouldn't be casually removable from the CRM. BoldSign
    // requires a document be completed/revoked/declined before DELETE, so an
    // in-progress (draft/sent) document is revoked first.
    if (body.action === 'document-delete') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      const svc = getServiceClient()
      const { data: record } = await svc.from('boldsign_documents')
        .select('id, deal_id, agent_id, status, document_name').eq('document_id', id).maybeSingle()
      if (!record) return res.status(404).json({ error: 'Document not found' })
      if (record.status === 'completed') {
        return res.status(400).json({ error: 'Completed documents are the signed record and cannot be deleted here.' })
      }
      if (!actor.isAdmin && record.agent_id !== actor.agent.id) {
        return res.status(403).json({ error: 'Only the sender or an admin can delete this document' })
      }

      if (!['revoked', 'voided', 'declined'].includes(record.status)) {
        try { await boldsign(`/document/revoke?documentId=${encodeURIComponent(id)}`, { method: 'POST', json: { message: 'Removed from Gateway CRM' } }) }
        catch (e) { if (e.status !== 400) throw e }   // 400 here typically means "already not in progress" — fine
      }
      try { await boldsign(`/document/delete?documentId=${encodeURIComponent(id)}&deletePermanently=false`, { method: 'DELETE' }) }
      catch (e) { if (e.status !== 404) throw e }

      await svc.from('audit_log').insert([{
        table_name: 'boldsign_documents', record_id: record.id, deal_id: record.deal_id, actor_id: actor.agent.id,
        action: 'delete', old_values: { document_name: record.document_name, status: record.status },
        summary: `Removed unsigned document "${record.document_name || 'Document'}"`,
      }])
      await svc.from('boldsign_documents').delete().eq('id', record.id)
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

    // Full identity record from BoldSign — used to refresh a single row (e.g.
    // after the admin edits it) without a full list sync.
    if (body.action === 'identity-details') {
      if (!actor.isAdmin) return res.status(403).json({ error: 'Admin only' })
      if (!body.email) return res.status(400).json({ error: 'email required' })
      const data = await boldsign(`/senderIdentities/properties?email=${encodeURIComponent(body.email)}`)
      return res.json({
        email:  data.email,
        name:   data.name,
        status: normalizeIdentityStatus(data.status || data.approvalStatus),
      })
    }

    if (body.action === 'identity-update') {
      if (!actor.isAdmin) return res.status(403).json({ error: 'Admin only' })
      const { email, name } = body
      if (!email) return res.status(400).json({ error: 'email required' })
      if (!name || !name.trim()) return res.status(400).json({ error: 'name required' })
      await boldsign(`/senderIdentities/update?email=${encodeURIComponent(email)}`, {
        method: 'POST', json: { Name: name.trim() },
      })
      await getServiceClient().from('boldsign_sender_identities')
        .update({ name: name.trim(), updated_at: new Date().toISOString() })
        .eq('email', email)
      return res.json({ ok: true })
    }

    if (body.action === 'identity-delete') {
      if (!actor.isAdmin) return res.status(403).json({ error: 'Admin only' })
      if (!body.email) return res.status(400).json({ error: 'email required' })
      // Best-effort against BoldSign — proceed with the local delete even if it's
      // already gone there (e.g. removed directly in the BoldSign dashboard).
      try { await boldsign(`/senderIdentities/delete?email=${encodeURIComponent(body.email)}`, { method: 'DELETE' }) }
      catch (e) { if (e.status !== 404) throw e }
      await getServiceClient().from('boldsign_sender_identities').delete().eq('email', body.email)
      return res.json({ ok: true })
    }

    // Org-wide fallback sender for sends where the acting agent has no
    // approved identity of their own (e.g. admin/system-triggered sends).
    // Only one identity may be default at a time.
    if (body.action === 'identity-set-default') {
      if (!actor.isAdmin) return res.status(403).json({ error: 'Admin only' })
      if (!body.email) return res.status(400).json({ error: 'email required' })
      const svc = getServiceClient()
      await svc.from('boldsign_sender_identities').update({ is_default: false }).eq('is_default', true)
      const { error } = await svc.from('boldsign_sender_identities').update({ is_default: true }).eq('email', body.email)
      if (error) return res.status(400).json({ error: error.message })
      return res.json({ ok: true })
    }

    if (body.action === 'identity-sync') {
      if (!actor.isAdmin) return res.status(403).json({ error: 'Admin only' })
      const list  = await boldsign('/senderIdentities/list?page=1&pageSize=100')
      const items = list.result || list.identities || (Array.isArray(list) ? list : [])
      const svc   = getServiceClient()

      // Match BoldSign identities back to agents by email so we can INSERT rows
      // for identities that were registered directly in BoldSign (not via the
      // CRM "Register" button). Without this the panel shows those agents as
      // "Not Registered" forever — an update-only sync can't create the row it
      // needs to update. agent_id is NOT NULL, so an identity whose email maps
      // to no agent can only refresh an existing row, never create one.
      const { data: agents } = await svc.from('agents').select('id, email')
      const agentByEmail = new Map(
        (agents || []).filter(a => a.email).map(a => [a.email.toLowerCase(), a.id])
      )

      let matched = 0, inserted = 0, updated = 0
      const now = new Date().toISOString()
      for (const it of items) {
        const email = it.email || it.senderEmail
        if (!email) continue
        const status  = normalizeIdentityStatus(it.status || it.approvalStatus)
        const agentId = agentByEmail.get(email.toLowerCase())

        if (agentId) {
          matched++
          // Upsert keyed on agent_id (same conflict target as identity-create).
          // Only touch agent_id/email/name/status — leaving is_default and
          // created_at untouched so a locally-set default survives the sync.
          const { data: existing } = await svc.from('boldsign_sender_identities')
            .select('id').eq('agent_id', agentId).maybeSingle()
          await svc.from('boldsign_sender_identities').upsert({
            agent_id: agentId, email, name: it.name || null, status, updated_at: now,
          }, { onConflict: 'agent_id' })
          existing ? updated++ : inserted++
        } else {
          // No agent for this email — can't create a row (agent_id required),
          // but refresh status on any existing row that happens to match.
          const { data } = await svc.from('boldsign_sender_identities')
            .update({ status, updated_at: now }).eq('email', email).select('id')
          if (data?.length) updated++
        }
      }
      return res.json({ ok: true, count: items.length, matched, inserted, updated })
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
      const { templateId, title, documentTitle, documentBase64, documentName, documents, redirectUrl, useTextTags, textTagDefinitions, roles } = body
      if (templateId) {
        const data = await boldsign(`/template/getEmbeddedTemplateEditUrl?templateId=${encodeURIComponent(templateId)}`, {
          method: 'POST', json: { RedirectUrl: redirectUrl || '', ShowToolbar: true, ViewOption: 'PreparePage' },
        })
        return res.json({ url: data.editUrl || data.createUrl || data.url, templateId })
      }

      // A "package" template can hold several source PDFs (e.g. a listing
      // agreement + disclosures). BoldSign combines every `Files` entry into the
      // one template document, in order. Accept a `documents` array, falling
      // back to the single documentBase64 for older callers.
      const fileList = Array.isArray(documents) && documents.length
        ? documents
        : (documentBase64 ? [{ base64: documentBase64, name: documentName }] : [])
      if (!fileList.length) return res.status(400).json({ error: 'documents (or documentBase64) or templateId required' })

      const roleList = normalizeTemplateRoles(roles)
      const templateTitle = (title || 'New Template').trim()

      const form = new FormData()
      form.append('Title',         templateTitle)
      form.append('DocumentTitle', (documentTitle || templateTitle).trim())
      form.append('RedirectUrl',   redirectUrl || '')
      form.append('ShowToolbar',   'true')
      roleList.forEach((r, i) => {
        form.append(`Roles[${i}][name]`,  r.name)
        form.append(`Roles[${i}][index]`, String(r.index))
      })
      // Reproducible template prep: if the PDF has {{fieldType|signerIndex|...}}
      // text tags baked in, BoldSign auto-places the fields on create — the
      // embedded editor then opens for review/adjustment rather than blank prep.
      if (useTextTags) {
        form.append('UseTextTags', 'true')
        if (textTagDefinitions) form.append('TextTagDefinitions', JSON.stringify(textTagDefinitions))
      }
      // One repeated `Files` field per source PDF — BoldSign merges them into the
      // single template document in the order appended.
      fileList.forEach((d, i) => {
        if (!d?.base64) return
        form.append('Files', new Blob([Buffer.from(d.base64, 'base64')], { type: 'application/pdf' }), d.name || `document-${i + 1}.pdf`)
      })
      const data = await boldsign('/template/createEmbeddedTemplateUrl', { method: 'POST', form })
      return res.json({ url: data.createUrl, templateId: data.templateId, roles: roleList })
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
      // Archive the signed PDF AND the compliance audit trail into deal-documents
      // — no manual download + re-upload step. Both are best-effort; the audit
      // trail can lag the signed PDF, so if it isn't ready the agent can fetch
      // it on demand (action: 'audit-download'). Each is also recorded as a
      // document_versions row (source='boldsign') so it carries real metadata
      // (signer, completion date) instead of being a bare storage object, and
      // shows up like any other deal document.
      const baseName   = (record.document_name || 'document').replace(/\.pdf$/i, '')
      const signerNote = `Signed by ${record.signer_name || 'signer'} on ${(completedAt || new Date().toISOString()).slice(0, 10)}`

      const signed = await archiveBoldsignPdf(supabase, {
        path: `/document/download?documentId=${encodeURIComponent(documentId)}`,
        dealId: record.deal_id, filename: `signed-${baseName}.pdf`,
      })
      if (signed) {
        await recordDocumentVersion(supabase, {
          dealId: record.deal_id, documentName: `signed-${baseName}.pdf`,
          storagePath: signed.storagePath, size: signed.size,
          pinnedAs: 'signed', note: signerNote,
        })
      }

      const audit = await archiveBoldsignPdf(supabase, {
        path: `/document/downloadAuditLog?documentId=${encodeURIComponent(documentId)}`,
        dealId: record.deal_id, filename: `audit-${baseName}.pdf`,
      })
      if (audit) {
        await recordDocumentVersion(supabase, {
          dealId: record.deal_id, documentName: `audit-${baseName}.pdf`,
          storagePath: audit.storagePath, size: audit.size,
          note: `Compliance audit trail — ${signerNote}`,
        })
      }

      // Record whether the audit trail is on file so the UI can offer a manual
      // fetch if it wasn't ready at webhook time.
      await supabase.from('boldsign_documents')
        .update({ audit_trail_saved: Boolean(audit) })
        .eq('document_id', documentId)

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
