import { applyJsonCors, requireAgent, errorResponse, getServiceClient, getUserClient, SUPABASE_URL } from './_lib/auth.js'
import closingPacketHandler from './_handlers/closing-packet.js'
import { sendEmail, emailConfigured, appBaseUrl, brandedEmail, brandedEmailText } from './_lib/email.js'
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
      // Keep BoldSign's per-field validation map, not just its summary line. A
      // message like "SignerName or SignerEmail is missing in roles" says nothing
      // about WHICH role; the `errors` object does, and losing it turned a
      // one-look diagnosis into guesswork.
      const summary = data?.error
                   || data?.message
                   || (data?.errors && JSON.stringify(data.errors))
                   || `BoldSign API ${r.status}`
      const detail = (data?.errors && (data?.error || data?.message))
        ? ` — ${JSON.stringify(data.errors)}`
        : ''
      // Full body to the function log; 4xx is never retried, so this is the only
      // record of what BoldSign objected to.
      console.error(`[boldsign] ${r.status} on ${method} ${path}: ${text?.slice(0, 2000)}`)
      const err = new Error(`${summary}${detail}`)
      err.status = r.status
      err.data   = data
      throw err
    }
    return data
  }
}

const DEAL_BUCKET = 'deal-documents'

// ─── Document bytes ───────────────────────────────────────────────────────────
// A send used to carry its PDF as base64 inside the JSON request body. Vercel
// caps a serverless request at 4.5 MB and base64 adds ~33%, so anything over
// roughly 3.3 MB of PDF failed with a bare platform 413 — which is most real
// scanned disclosure packets. The bytes now stay in storage and are streamed to
// BoldSign server-side, where no such cap applies.
//
// Three accepted forms, in priority order:
//   1. documentUrl   — a short-lived signed storage URL the BROWSER minted. This
//      is the primary path: the browser could only sign an object its own RLS
//      lets it read, so authorization is inherently the caller's and no server
//      credentials are involved at all.
//   2. documentPath  — read with the CALLER'S credentials (never the service
//      key, which would happily return another agent's deal documents).
//   3. documentBase64 — small/legacy callers.
//
// SECURITY: both caller-supplied forms are constrained.
//   • documentUrl must be a signed-object URL on THIS Supabase project's
//     deal-documents bucket — a strict prefix match, so this cannot be turned
//     into a request against an arbitrary or internal host (SSRF).
//   • documentPath is shape-restricted to a single deal folder: no traversal,
//     no other bucket.
const DEAL_DOC_PATH_RE = /^deal-[0-9a-f-]{36}\/[^/\\]{1,255}$/i

function badRequest(message) { const e = new Error(message); e.status = 400; return e }

// BoldSign rejects a non-PDF with an opaque error, and the ad-hoc send modal's
// drag-and-drop bypasses its own `accept=".pdf"` filter. Check the magic bytes
// and say something useful instead.
function assertPdf(buffer, label) {
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw badRequest(`"${label || 'That file'}" is not a PDF. Convert it to PDF and try again.`)
  }
  if (!buffer.length) throw badRequest('The document is empty.')
  return buffer
}

// Exported for unit tests: is this a signed URL on our own deal-documents bucket?
export function isOwnSignedStorageUrl(url, supabaseUrl = SUPABASE_URL) {
  const prefix = `${String(supabaseUrl).replace(/\/$/, '')}/storage/v1/object/sign/${DEAL_BUCKET}/`
  return typeof url === 'string' && url.startsWith(prefix)
}

async function resolveDocumentBytes(req, { documentUrl, documentPath, documentBase64, documentName }) {
  if (documentUrl) {
    if (!isOwnSignedStorageUrl(documentUrl)) {
      throw badRequest('documentUrl must be a signed URL for this project\'s deal-documents bucket')
    }
    let r
    try { r = await fetch(documentUrl) }
    catch (e) { throw badRequest(`Could not read that document from storage: ${e.message}`) }
    if (!r.ok) throw badRequest(`Could not read that document from storage (HTTP ${r.status}) — the link may have expired`)
    return assertPdf(Buffer.from(await r.arrayBuffer()), documentName)
  }
  if (documentPath) {
    if (!DEAL_DOC_PATH_RE.test(documentPath)) {
      throw badRequest('documentPath must be a deal document path (deal-<uuid>/<filename>)')
    }
    const asCaller = getUserClient(req)
    const { data, error } = await asCaller.storage.from(DEAL_BUCKET).download(documentPath)
    if (error || !data) {
      throw badRequest(`Could not read that document from storage${error?.message ? `: ${error.message}` : ''}`)
    }
    return assertPdf(Buffer.from(await data.arrayBuffer()), documentName || documentPath.split('/').pop())
  }
  if (documentBase64) {
    return assertPdf(Buffer.from(documentBase64, 'base64'), documentName)
  }
  throw badRequest('documentUrl, documentPath or documentBase64 required')
}

// ─── Archiving ────────────────────────────────────────────────────────────────
// ─── Template listing ─────────────────────────────────────────────────────────
// BoldSign's /template/list is paginated at 100 max. Reading only page 1 and
// treating it as the complete set is dangerous: the nightly drift sync
// DEACTIVATES any catalog entry whose template is "missing", so the moment the
// account passed 100 templates every packet on page 2+ would be silently
// switched off and vanish from the send picker.
//
// Returns { templates, complete }. `complete: false` means the walk was cut
// short (runaway guard) and callers MUST NOT infer absence from it.
const TEMPLATE_PAGE_SIZE = 100
const TEMPLATE_PAGE_LIMIT = 50            // 5,000 templates — a runaway guard, not a real limit

export async function listAllTemplates() {
  const templates = []
  for (let page = 1; page <= TEMPLATE_PAGE_LIMIT; page++) {
    const data  = await boldsign(`/template/list?page=${page}&pageSize=${TEMPLATE_PAGE_SIZE}`)
    const batch = data.result || data.templates || []
    templates.push(...batch)
    if (batch.length < TEMPLATE_PAGE_SIZE) return { templates, complete: true }
  }
  console.warn(`[boldsign] template list hit the ${TEMPLATE_PAGE_LIMIT}-page guard — treating as incomplete`)
  return { templates, complete: false }
}

// Pull a BoldSign PDF (signed document or audit trail) and archive it into the
// deal-documents bucket. Best-effort — returns { storagePath, size } or null.
//
// The path is DETERMINISTIC (derived from the document id, not Date.now()) and
// upserted. Two consequences, both deliberate:
//   • a webhook redelivery overwrites the same object instead of adding another
//     copy of an 8 MB PDF to storage on every retry;
//   • the row can record exactly where ITS file lives, so the UI stops guessing
//     by filename — which returned the wrong PDF whenever a deal had more than
//     one signed document.
// The document-id suffix keeps the name readable while staying unique.
export function archivePath({ dealId, documentId, baseName, kind }) {
  const slug = String(baseName || 'document')
    .replace(/\.pdf$/i, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'document'
  return `deal-${dealId}/${kind}-${slug}-${String(documentId).slice(0, 8)}.pdf`
}

async function archiveBoldsignPdf(supabase, { path, storagePath }) {
  try {
    const r = await boldsign(path, { raw: true })
    if (!r.ok) return null
    const buf = await r.arrayBuffer()
    if (!buf.byteLength) return null
    const { error } = await supabase.storage.from(DEAL_BUCKET).upload(
      storagePath, Buffer.from(buf), { contentType: 'application/pdf', upsert: true }
    )
    if (error) {
      console.error(`[boldsign] archive upload failed for ${storagePath}: ${error.message}`)
      return null
    }
    return { storagePath, size: buf.byteLength }
  } catch (e) {
    console.error(`[boldsign] archive failed for ${storagePath}: ${e.message}`)
    return null
  }
}

// Record an archived BoldSign PDF in document_versions so it carries real CRM
// metadata (signer, completion date) instead of being just a bare storage
// object — mirrors what uploadDealDocument() does for manual uploads. Numbers
// the version per (deal_id, document_name) the same way that service does.
// Best-effort — never throws.
async function recordDocumentVersion(supabase, { dealId, documentName, storagePath, size, pinnedAs, note }) {
  try {
    // Idempotence: the archive path is deterministic, so a webhook redelivery
    // arrives with a storage_path we've already recorded. Without this guard
    // each retry added another version row (v1, v2, v3…) for the same bytes and
    // moved the 'signed' pin around.
    const { data: already } = await supabase
      .from('document_versions')
      .select('id')
      .eq('deal_id', dealId)
      .eq('storage_path', storagePath)
      .limit(1)
    if (already?.length) return

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
    const { error: insertErr } = await supabase.from('document_versions').insert([{
      deal_id: dealId, document_name: documentName, storage_path: storagePath,
      size, mime_type: 'application/pdf', version_num: nextVersion,
      pinned_as: pinnedAs || null, source: 'boldsign', note: note || null,
    }])
    // The catch below only fires on a THROWN error, and the supabase client
    // returns its errors instead of throwing — so a rejected insert used to leave
    // no trace at all. The PDF is safely in storage either way, but without this
    // row the document never appears in the deal's Documents tab, which for a
    // signed contract reads as "the signature vanished".
    if (insertErr) {
      console.error(`[boldsign] CRITICAL: document_versions insert failed for ${storagePath}: ${insertErr.message}`)
    }
  } catch (e) {
    // Best-effort by design — the storage upload already succeeded, and a
    // metadata-only problem must never 500 a webhook (BoldSign would retry).
    // Logged so a persistent failure is greppable in the function logs instead
    // of invisible forever.
    console.error(`[boldsign] recordDocumentVersion failed for ${storagePath}: ${e.message}`)
  }
}

// ─── Send tracking ────────────────────────────────────────────────────────────
// One boldsign_documents row per send, written server-side with the service key
// on EVERY send path (ad-hoc and template) before the caller is handed a send
// URL. Returns true on success; the caller decides whether an untracked send is
// acceptable (it isn't — an untracked document gets emailed to a client and then
// silently never updates, archives, or appears in the Signatures tab).
//
// `signers` is the normalized signer array; both naming conventions are accepted
// because the ad-hoc flow uses {name,email} and the template flow uses
// {signerName,signerEmail}.
export async function trackDocument(supabase, { dealId, agentId, documentId, signers, documentName, subject, status }) {
  const list  = Array.isArray(signers) ? signers : []
  const names = list.map(s => s?.name || s?.signerName).filter(Boolean)
  const mails = list.map(s => s?.email || s?.signerEmail).filter(Boolean)
  const { error } = await supabase.from('boldsign_documents').insert([{
    deal_id:       dealId,
    agent_id:      agentId || null,
    document_id:   documentId,
    signer_name:   names.join(', '),
    signer_email:  mails.join(', '),
    document_name: documentName || 'Document',
    subject:       subject || null,
    signers:       list,
    status:        status || 'sent',
  }])
  if (error) {
    console.error(`[boldsign] FAILED to track document ${documentId} on deal ${dealId}: ${error.message}`)
    return false
  }
  return true
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
      const { signers, documentUrl, documentPath, documentBase64, documentName, emailSubject, useTextTags, textTagDefinitions, deal_id } = body
      const invalid = validateSigners(signers)
      if (invalid) return res.status(400).json({ error: invalid })
      // No prepare step here — fields must come from text tags or explicit tabs.
      const placementError = requiresExplicitFieldPlacement(signers, useTextTags)
      if (placementError) return res.status(400).json({ error: placementError })

      const orderedSigners = [...signers].sort((a, b) =>
        Number(a.routingOrder || 1) - Number(b.routingOrder || 1)
      )
      const hasOrder = orderedSigners.some(s => Number(s.routingOrder || 1) !== 1)

      const pdfBuffer     = await resolveDocumentBytes(req, { documentUrl, documentPath, documentBase64, documentName })
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

      // Track it against the deal so status updates, archiving and the
      // Signatures tab all work — this path previously created a document
      // BoldSign knew about and the CRM did not.
      if (deal_id && data.documentId) {
        await trackDocument(getServiceClient(), {
          dealId: deal_id, agentId: actor.agent.id, documentId: data.documentId,
          signers: orderedSigners, documentName: documentName || 'Document',
          subject: emailSubject || null, status: 'sent',
        })
      }

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
      const { signers, documentUrl, documentPath, documentBase64, documentName, emailSubject, redirectUrl, useTextTags, textTagDefinitions, deal_id } = body
      const invalidEmbed = validateSigners(signers)
      if (invalidEmbed) return res.status(400).json({ error: invalidEmbed })

      const orderedSigners = [...signers].sort((a, b) => Number(a.routingOrder || 1) - Number(b.routingOrder || 1))
      const hasOrder      = orderedSigners.some(s => Number(s.routingOrder || 1) !== 1)
      const pdfBuffer     = await resolveDocumentBytes(req, { documentUrl, documentPath, documentBase64, documentName })
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
      const url  = data.sendUrl || data.embeddedSendUrl || data.url || null

      // Track the draft HERE, before returning the URL. This used to be an
      // unchecked insert in the browser after the URL came back, which lost
      // documents two ways: a failed insert left a document BoldSign would
      // email with no CRM record at all, and an agent who clicked Send quickly
      // could have the Sent webhook arrive first — it found no row, returned
      // 200, and BoldSign never redelivered, so the document was stuck
      // untracked forever. Server-side and ordered before the URL, neither can
      // happen. Matches what template-embed-url already did.
      let tracked = false
      if (deal_id && data.documentId) {
        tracked = await trackDocument(getServiceClient(), {
          dealId: deal_id, agentId: actor.agent.id, documentId: data.documentId,
          signers: orderedSigners, documentName: documentName || 'Document',
          subject: emailSubject || null, status: 'draft',
        })
        if (!tracked) {
          // Don't leave an untrackable draft behind for the agent to trip over.
          // It has not been sent to anyone at this point.
          try { await boldsign(`/document/delete?documentId=${encodeURIComponent(data.documentId)}&deletePermanently=true`, { method: 'DELETE' }) }
          catch { /* best-effort cleanup */ }
          return res.status(500).json({
            error: 'Could not record this document against the deal, so it was not opened for sending. Nothing was sent — please try again.',
          })
        }
      }
      return res.json({ url, documentId: data.documentId || null, tracked })
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

    // Signed PDF / compliance audit trail. Returns a short-lived SIGNED STORAGE
    // URL, never base64 — a Vercel function response is capped at 4.5 MB, so
    // base64 made any signed packet over ~3.3 MB undownloadable. The webhook
    // normally archived it already; if not (audit trail lagging, webhook missed,
    // pre-existing row), fetch from BoldSign, archive it now, and hand back a
    // URL to that. Either way the row records where ITS file is, so nothing is
    // resolved by filename guessing.
    if (body.action === 'download' || body.action === 'audit-download') {
      const isAudit = body.action === 'audit-download'
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })

      const svc = getServiceClient()
      // Tolerate a database where the archive-path columns aren't there yet, so
      // the app and the SQL bundle can be deployed in either order: fall back to
      // the base columns and take the fetch-from-BoldSign path below.
      let { data: record, error: recErr } = await svc.from('boldsign_documents')
        .select('id, deal_id, document_name, signed_storage_path, audit_storage_path')
        .eq('document_id', id).maybeSingle()
      if (recErr) {
        console.warn(`[boldsign] archive-path columns unavailable (${recErr.message}) — falling back; apply 2026-07-31_boldsign_hardening.sql`)
        ;({ data: record } = await svc.from('boldsign_documents')
          .select('id, deal_id, document_name')
          .eq('document_id', id).maybeSingle())
      }
      if (!record) return res.status(404).json({ error: 'Document not found' })
      if (!record.deal_id) return res.status(400).json({ error: 'This document is not attached to a deal' })

      const column  = isAudit ? 'audit_storage_path' : 'signed_storage_path'
      const sign    = (path) => svc.storage.from(DEAL_BUCKET).createSignedUrl(path, 300, { download: path.split('/').pop() })

      // 1. Already archived → sign the stored copy.
      if (record[column]) {
        const { data, error } = await sign(record[column])
        if (data?.signedUrl) return res.json({ url: data.signedUrl, filename: record[column].split('/').pop() })
        console.warn(`[boldsign] stored ${column} unreadable (${error?.message}) — re-archiving ${id}`)
      }

      // 2. Not archived (or the object went missing) → pull, archive, sign.
      const storagePath = archivePath({
        dealId: record.deal_id, documentId: id,
        baseName: record.document_name, kind: isAudit ? 'audit' : 'signed',
      })
      const archived = await archiveBoldsignPdf(svc, {
        path: isAudit
          ? `/document/downloadAuditLog?documentId=${encodeURIComponent(id)}`
          : `/document/download?documentId=${encodeURIComponent(id)}`,
        storagePath,
      })
      if (!archived) {
        return res.status(400).json({
          error: isAudit
            ? 'Audit trail not available yet — BoldSign generates it shortly after the last signature.'
            : 'Completed PDF not available yet.',
        })
      }
      const { error: pathErr } = await svc.from('boldsign_documents').update({
        [column]: archived.storagePath,
        ...(isAudit ? { audit_trail_saved: true } : {}),
      }).eq('id', record.id)
      if (pathErr) console.warn(`[boldsign] could not record ${column} for ${id}: ${pathErr.message}`)

      const { data } = await sign(archived.storagePath)
      if (!data?.signedUrl) return res.status(500).json({ error: 'Archived the file but could not create a download link' })
      return res.json({ url: data.signedUrl, filename: archived.storagePath.split('/').pop() })
    }

    // Nudge outstanding signers. Records the nudge so the nightly auto-reminder
    // sweep and the UI both know when this document was last chased.
    if (body.action === 'remind') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      const svc = getServiceClient()
      const { data: record } = await svc.from('boldsign_documents')
        .select('id, status, reminder_count').eq('document_id', id).maybeSingle()
      if (record && !['sent', 'delivered'].includes(record.status)) {
        return res.status(400).json({ error: `This document is ${record.status} — there is nobody left to remind.` })
      }
      await boldsign(`/document/remind?documentId=${encodeURIComponent(id)}`, { method: 'POST', json: {} })
      if (record) {
        await svc.from('boldsign_documents').update({
          last_reminded_at: new Date().toISOString(),
          reminder_count:   (record.reminder_count || 0) + 1,
        }).eq('id', record.id)
      }
      return res.json({ ok: true, remindedAt: new Date().toISOString() })
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
      if (!email)   return res.status(400).json({ error: 'email required' })
      // agent_id is NOT NULL and is the upsert's conflict target. Passing null
      // (as this did on `agentId || null`) violated the constraint, and because
      // the result was never inspected the API still answered { ok: true } —
      // BoldSign emailed the agent an approval link while the CRM kept showing
      // "not registered", so admins re-invited in a loop and every send from
      // that agent went out from the raw API account instead of their name.
      if (!agentId) return res.status(400).json({ error: 'agentId required — an identity must belong to an agent' })

      await boldsign('/senderIdentities/create', { method: 'POST', json: { Name: name || email, Email: email } })

      const svc = getServiceClient()
      const { error } = await svc.from('boldsign_sender_identities').upsert({
        agent_id: agentId, email, name: name || null,
        status: 'pending', updated_at: new Date().toISOString(),
      }, { onConflict: 'agent_id' })
      if (error) {
        // BoldSign accepted the invitation but we couldn't record it. Say so
        // plainly — silence here is what made this bug invisible for so long.
        return res.status(500).json({
          error: `BoldSign sent the approval email to ${email}, but the CRM could not save the identity: ${error.message}`,
        })
      }
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
      const { templates, complete } = await listAllTemplates()
      return res.json({ templates, complete })
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

      // Already sent at this point, so a tracking failure can't be undone by
      // deleting the document — surface it instead of failing silently, and tell
      // the agent the client DOES have it.
      let tracked = true
      if (deal_id && data.documentId) {
        tracked = await trackDocument(svc, {
          dealId: deal_id, agentId: actor.agent.id, documentId: data.documentId,
          signers: roles, documentName: documentName || emailSubject || 'Document',
          subject: emailSubject || null, status: 'sent',
        })
      }
      return res.json({
        documentId: data.documentId, envelopeId: data.documentId, status: 'sent', tracked,
        ...(tracked ? {} : { warning: 'Sent to the signers, but it could not be recorded on this deal — it will not appear in the Signatures tab. Tell your admin.' }),
      })
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
        const tracked = await trackDocument(svc, {
          dealId: deal_id, agentId: actor.agent.id, documentId: data.documentId,
          signers: roles, documentName: documentName || emailSubject || 'Document',
          subject: emailSubject || null, status: 'draft',
        })
        if (!tracked) {
          try { await boldsign(`/document/delete?documentId=${encodeURIComponent(data.documentId)}&deletePermanently=true`, { method: 'DELETE' }) }
          catch { /* best-effort cleanup of the untrackable draft */ }
          return res.status(500).json({
            error: 'Could not record this document against the deal, so it was not opened for sending. Nothing was sent — please try again.',
          })
        }
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
// ─── Signature lifecycle announcements ───────────────────────────────────────
// An agent finds out that a client signed, declined, or let a request expire in
// exactly two places: the in-app notification bell and their inbox. Both are
// built from ONE copy function so they can never drift, and so the wording only
// has to be got right once.
//
// Email matters more than it looks: before this existed, a completed signature
// wrote an `agent_notifications` row and nothing else, so an agent who wasn't
// looking at the CRM at that moment simply never learned their deal had moved.
// That is the gap that trains a team to chase signatures over text message.

/** Statuses worth interrupting an agent for. Anything else is bookkeeping. */
const NOTIFIABLE = new Set(['completed', 'declined', 'expired'])

/**
 * Copy for one signature event, shared by the in-app row and the email.
 * Pure — takes plain values, returns plain strings. Unit-tested.
 */
export function signatureEventCopy({ status, documentName, dealTitle, signerName, completedAt }) {
  if (!NOTIFIABLE.has(status)) return null

  const doc      = documentName || 'Document'
  const deal     = dealTitle    || 'your deal'
  const signer   = signerName   || 'the signer'
  const someone  = signerName   || 'A signer'
  const dateOnly = (completedAt || '').slice(0, 10)

  if (status === 'completed') {
    return {
      type:    'document_signed',
      title:   'Document Signed',
      message: `"${doc}" for ${deal} has been fully signed by ${signer}. The signed copy has been saved to the deal's Documents tab.`,
      subject: `Signed: "${doc}" — ${deal}`,
      eyebrow: 'Signature complete',
      // Semantic green: this one is good news and should read that way at a glance.
      accent:  '#2f7d4f',
      headline: `"${doc}" is fully signed.`,
      rows: [
        { label: 'Deal',      value: deal },
        { label: 'Signed by', value: signerName || '' },
        { label: 'Completed', value: dateOnly },
      ],
      note: "The signed copy and its compliance audit trail have been saved to the deal's Documents tab automatically — there's nothing to download and re-upload.",
    }
  }

  if (status === 'declined') {
    return {
      type:    'document_declined',
      title:   'Document Declined',
      message: `${someone} declined "${doc}" for ${deal}. Follow up with them and send a corrected copy.`,
      subject: `Action needed: ${someone} declined "${doc}"`,
      eyebrow: 'Action needed',
      accent:  '#b3382c',
      headline: `${someone} declined "${doc}".`,
      rows: [
        { label: 'Deal',        value: deal },
        { label: 'Declined by', value: signerName || '' },
      ],
      note: 'Reach out to them before resending. Once you know what needs to change, send a corrected copy from the deal\'s Signatures tab.',
    }
  }

  return {
    type:    'document_expired',
    title:   'Signature Request Expired',
    message: `"${doc}" for ${deal} expired before everyone signed. Send it again to restart.`,
    subject: `Action needed: "${doc}" expired before signing`,
    eyebrow: 'Action needed',
    accent:  '#95681d',
    headline: `"${doc}" expired before everyone signed.`,
    rows: [
      { label: 'Deal',        value: deal },
      { label: 'Sent to',     value: signerName || '' },
    ],
    note: 'Nobody signed in time, so the request closed itself. Send it again from the deal\'s Signatures tab to restart.',
  }
}

/**
 * Render the agent email for a signature event. Separated from sending so the
 * subject/body can be asserted in tests without a Resend key.
 */
export function buildSignatureEmail(copy, baseUrl) {
  if (!copy) return null
  const shell = {
    eyebrow: copy.eyebrow,
    headline: copy.headline,
    accent:  copy.accent,
    rows:    copy.rows,
    note:    copy.note,
    ctaLabel: 'Open Gateway CRM',
    ctaUrl:   baseUrl || '',
    footNote: 'You received this because you are the agent on this deal.',
  }
  return {
    subject: copy.subject,
    html:    brandedEmail(shell),
    text:    brandedEmailText({ headline: copy.headline, rows: copy.rows, note: copy.note, ctaUrl: baseUrl || '' }),
  }
}

/**
 * Write the in-app notification AND email the agent for one signature event.
 *
 * Entirely best-effort: every failure is logged and swallowed. A webhook that
 * throws here would return non-200, BoldSign would redeliver, and the retry
 * would re-run the archive work — so a notification problem must never be
 * allowed to become a duplicate-archive problem.
 */
async function announceSignatureEvent(supabase, { status, record, documentId, completedAt, deal }) {
  const agentId = deal?.agent_id
  if (!agentId) return

  const copy = signatureEventCopy({
    status,
    documentName: record.document_name,
    dealTitle:    deal.title,
    signerName:   record.signer_name,
    completedAt,
  })
  if (!copy) return

  // 1. In-app notification (the bell + realtime toast).
  const { error: notifErr } = await supabase.from('agent_notifications').insert([{
    agent_id:    agentId,
    deal_id:     record.deal_id,
    envelope_id: documentId,
    title:       copy.title,
    message:     copy.message,
    type:        copy.type,
  }])
  if (notifErr) {
    console.error(`[boldsign] agent_notifications insert failed for ${documentId}: ${notifErr.message}`)
  }

  // 2. Email. Skipped silently when this deployment has no mail provider —
  //    that's a valid state (preview builds), not an error worth logging loudly.
  if (!emailConfigured()) return

  const { data: agent, error: agentErr } = await supabase
    .from('agents')
    .select('email, name')
    .eq('id', agentId)
    .maybeSingle()
  if (agentErr) {
    console.error(`[boldsign] could not load agent ${agentId} for signature email: ${agentErr.message}`)
    return
  }
  if (!agent?.email) {
    console.warn(`[boldsign] agent ${agentId} has no email — skipping ${status} notification for ${documentId}`)
    return
  }

  const mail = buildSignatureEmail(copy, appBaseUrl())
  // The idempotency key only binds on Resend — Graph has no equivalent. The real
  // guard against a double-send is the status gate in handleWebhook, which skips
  // announcing when the row already sits at the incoming status.
  const result = await sendEmail({
    to: agent.email, subject: mail.subject, html: mail.html, text: mail.text,
    idempotencyKey: `boldsign-${status}-${documentId}`,
  })
  if (!result.ok) {
    console.error(`[boldsign] signature email (${status}) to ${agent.email} failed: ${result.error || result.reason}`)
  }
}

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
    if (!documentId) {
      console.error('[boldsign] webhook with no document id — payload shape may have changed', { eventName })
      return res.status(200).json({ received: true, note: 'No document id' })
    }

    const status      = normalizeStatus(rawStatus)
    const completedAt = toIso(doc?.completedDate || doc?.signedDate || null)

    const { data: record } = await supabase
      .from('boldsign_documents')
      .select('*, deals(id, agent_id, title)')
      .eq('document_id', documentId)
      .maybeSingle()

    if (!record) {
      // Every CRM send path now writes its row server-side BEFORE handing out a
      // send URL, so this should only be a document created directly in the
      // BoldSign dashboard. Logged loudly because the alternative reading is
      // that a send path regressed — and BoldSign will not redeliver after a 200.
      console.error(`[boldsign] webhook for untracked document ${documentId} (${eventName}) — not created by this CRM, or a send path failed to track`)
      return res.status(200).json({ received: true, note: 'Document not tracked' })
    }

    // IDEMPOTENCE GATE. BoldSign redelivers on any non-2xx, and this handler
    // does enough work (two PDF downloads + two uploads) to exceed the function
    // timeout on a large packet — which guaranteed a retry, which previously
    // duplicated every archive, version row and notification. Completed is
    // terminal: once recorded, later deliveries are acknowledged and dropped.
    if (record.status === 'completed' && status === 'completed') {
      return res.status(200).json({ received: true, documentId, status, note: 'Already processed' })
    }

    // Was this row ALREADY at the incoming status? BoldSign redelivers on any
    // non-2xx, and can send the same terminal event more than once. The gate
    // above only covers completed→completed; a repeated 'declined' would
    // otherwise re-notify the agent every time. Resend's idempotency key used to
    // absorb that, but Microsoft Graph has no equivalent, so the guard has to
    // live here rather than in the transport.
    const alreadyAtStatus = record.status === status

    const patch = { status }
    if (completedAt) patch.completed_at = completedAt
    const { error: statusErr } = await supabase
      .from('boldsign_documents').update(patch).eq('document_id', documentId)
    if (statusErr) {
      // This is the one failure in this handler that silently strands a document.
      // The supabase client RETURNS errors rather than throwing, so this never
      // reached the catch block below: the write failed, the handler carried on,
      // answered 200, and BoldSign — which stops redelivering after a 200 — never
      // told us again. The row stays 'sent' forever while the client has actually
      // signed, and the Signatures tab shows an outstanding document that isn't.
      console.error(`[boldsign] CRITICAL: status update to '${status}' failed for ${documentId}: ${statusErr.message}`)
    }

    // A decline or expiry needs the agent's attention as much as a completion
    // does — previously both updated the row and told nobody, so a declined
    // listing agreement sat silently and an expired one was indistinguishable
    // from one the agent had cancelled themselves.
    if ((status === 'declined' || status === 'expired') && !alreadyAtStatus) {
      await announceSignatureEvent(supabase, {
        status, record, documentId, completedAt, deal: record.deals,
      })
    }

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

      // A document not attached to a deal has nowhere to be archived — the old
      // code happily uploaded to a "deal-null/" folder no deal would ever list.
      if (!record.deal_id) {
        console.warn(`[boldsign] completed document ${documentId} has no deal_id — skipping archive`)
        return res.status(200).json({ received: true, documentId, status, note: 'No deal to archive into' })
      }

      const signed = await archiveBoldsignPdf(supabase, {
        path: `/document/download?documentId=${encodeURIComponent(documentId)}`,
        storagePath: archivePath({ dealId: record.deal_id, documentId, baseName, kind: 'signed' }),
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
        storagePath: archivePath({ dealId: record.deal_id, documentId, baseName, kind: 'audit' }),
      })
      if (audit) {
        await recordDocumentVersion(supabase, {
          dealId: record.deal_id, documentName: `audit-${baseName}.pdf`,
          storagePath: audit.storagePath, size: audit.size,
          note: `Compliance audit trail — ${signerNote}`,
        })
      }

      // Record WHERE each file landed, not just that it did. The Signatures tab
      // resolves a download from these columns; it used to pattern-match
      // "signed-" against the deal's whole storage folder and returned the first
      // hit, i.e. the wrong contract on any deal with more than one signed doc.
      const { error: pathErr } = await supabase.from('boldsign_documents')
        .update({
          audit_trail_saved:   Boolean(audit),
          ...(signed ? { signed_storage_path: signed.storagePath } : {}),
          ...(audit  ? { audit_storage_path:  audit.storagePath }  : {}),
        })
        .eq('document_id', documentId)
      if (pathErr) {
        // Non-fatal: the PDFs are archived and the download path re-resolves
        // them on demand. Almost always "column does not exist" on a database
        // that hasn't had 2026-07-31_boldsign_hardening.sql applied yet.
        console.warn(`[boldsign] could not record archive paths for ${documentId}: ${pathErr.message}`)
        await supabase.from('boldsign_documents')
          .update({ audit_trail_saved: Boolean(audit) })
          .eq('document_id', documentId)
      }

      await announceSignatureEvent(supabase, {
        status, record, documentId, completedAt, deal: record.deals,
      })
    }

    return res.status(200).json({ received: true, documentId, status })
  } catch (err) {
    return res.status(200).json({ received: true, error: err.message })
  }
}

// (Closing packet generator moved to api/_handlers/closing-packet.js)
