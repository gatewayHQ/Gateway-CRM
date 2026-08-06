import { applyJsonCors, requireAgent, errorResponse, getServiceClient, getUserClient, SUPABASE_URL } from './_lib/auth.js'
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

// ─── Document quality ─────────────────────────────────────────────────────────
// WHY TEMPLATE PDFs WERE BLURRY. Nothing in this app ever compressed a PDF — but
// "Build in BoldSign" used to carry the source files as base64 inside the JSON
// request body, and a serverless request is capped at 4.5 MB (base64 inflates by
// ~33%, so ~3.3 MB of PDF). A real Iowa listing packet with scanned disclosures
// is bigger than that, so the only way to get one through was to run it through a
// compressor until it fit — and every downstream view renders those degraded
// bytes forever: the embedded editor, the preview, the sent document, the signed
// PDF. No preview or DPI setting can recover detail the stored file no longer has.
//
// So template sources travel the same way send documents already do: the browser
// puts the ORIGINAL in the form-packets bucket and hands over a short-lived signed
// URL, and the bytes are streamed to BoldSign server-side where the 4.5 MB cap
// doesn't apply. The practical ceiling becomes BoldSign's own 25 MB per file
// instead of 3.3 MB — roughly 7× the headroom, which is the difference between
// "compress until the text goes soft" and "upload the original".
const PACKET_BUCKET = 'form-packets'
// <STATE>/<transaction_type>/<timestamp>-<i>-<filename> — the scheme FormLibrary
// uploads with. Shape-restricted for the same reason deal paths are: no traversal,
// no reaching into another bucket.
const PACKET_PATH_RE = /^[A-Z]{2}\/[a-z]+\/[^/\\]{1,255}$/
// BoldSign's own per-file ceiling. Mirrors MAX_SEND_BYTES in the client service.
const MAX_BOLDSIGN_FILE_BYTES = 25 * 1024 * 1024

export function formatByteSize(b) {
  const n = Number(b) || 0
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

// Shrink a PDF WITHOUT touching image or text quality: re-serialize through
// pdf-lib with object streams, which compresses the file's structure (the object
// table and cross-reference data) and drops orphaned objects. Images are copied
// byte-for-byte — there is no resampling here, on purpose. Rasterizing or
// re-encoding images is exactly the operation that produced the blurry packets
// this function exists to avoid; it can only be a last resort a human chooses,
// never something the pipeline does quietly.
//
// Returns { buffer, before, after, saved } — and the ORIGINAL buffer if the
// rewrite came out no smaller (or failed), so this can never make things worse.
export async function optimizePdfLossless(buffer, label) {
  const before = buffer.length
  try {
    const { PDFDocument } = await import('pdf-lib')
    // ignoreEncryption: a locked-down state form still needs to reach BoldSign;
    // if it truly can't be re-serialized the catch below returns it untouched.
    const doc   = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false })
    const bytes = await doc.save({ useObjectStreams: true })
    const out   = Buffer.from(bytes)
    if (out.length >= before) return { buffer, before, after: before, saved: 0 }
    return { buffer: out, before, after: out.length, saved: before - out.length }
  } catch (err) {
    console.warn(`[boldsign] lossless optimize skipped for ${label || 'document'}: ${err.message}`)
    return { buffer, before, after: before, saved: 0 }
  }
}

// Get a file under BoldSign's per-file limit without degrading it, or explain
// precisely why that isn't possible. Never silently rasterizes.
export async function fitForBoldSign(buffer, label) {
  if (buffer.length <= MAX_BOLDSIGN_FILE_BYTES) return { buffer, optimized: false }
  const { buffer: out, before, after, saved } = await optimizePdfLossless(buffer, label)
  if (after <= MAX_BOLDSIGN_FILE_BYTES) {
    console.log(`[boldsign] "${label}" losslessly reduced ${formatByteSize(before)} → ${formatByteSize(after)}`)
    return { buffer: out, optimized: saved > 0, before, after }
  }
  throw badRequest(
    `"${label || 'That file'}" is ${formatByteSize(after)} — BoldSign's limit is ${formatByteSize(MAX_BOLDSIGN_FILE_BYTES)}, `
    + 'and it cannot be reduced further without re-compressing the page images, which is what makes text blurry. '
    + 'Split the packet into two files instead — they can both be added to the same template.'
  )
}

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

// Exported for unit tests: is this a signed URL on one of OUR OWN buckets? The
// allow-list is explicit and defaults to deal-documents, so widening it for
// template sources can't accidentally widen it for sends — this is the check that
// stops a caller-supplied URL from turning the send payload into an SSRF.
export function isOwnSignedStorageUrl(url, supabaseUrl = SUPABASE_URL, buckets = [DEAL_BUCKET]) {
  if (typeof url !== 'string') return false
  const base = String(supabaseUrl).replace(/\/$/, '')
  return buckets.some(b => url.startsWith(`${base}/storage/v1/object/sign/${b}/`))
}

// `source` picks which bucket a caller may read from: 'deal' (a send, default) or
// 'packet' (a Form Library template source). Kept as a coarse switch rather than a
// free-form bucket name so no caller can name a bucket of its own.
async function resolveDocumentBytes(req, { documentUrl, documentPath, documentBase64, documentName, source = 'deal' }) {
  const bucket   = source === 'packet' ? PACKET_BUCKET : DEAL_BUCKET
  const pathRe   = source === 'packet' ? PACKET_PATH_RE : DEAL_DOC_PATH_RE
  const pathHint = source === 'packet' ? '<STATE>/<type>/<filename>' : 'deal-<uuid>/<filename>'
  if (documentUrl) {
    if (!isOwnSignedStorageUrl(documentUrl, SUPABASE_URL, [bucket])) {
      throw badRequest(`documentUrl must be a signed URL for this project's ${bucket} bucket`)
    }
    let r
    try { r = await fetch(documentUrl) }
    catch (e) { throw badRequest(`Could not read that document from storage: ${e.message}`) }
    if (!r.ok) throw badRequest(`Could not read that document from storage (HTTP ${r.status}) — the link may have expired`)
    return assertPdf(Buffer.from(await r.arrayBuffer()), documentName)
  }
  if (documentPath) {
    if (!pathRe.test(documentPath)) {
      throw badRequest(`documentPath must be a ${bucket} path (${pathHint})`)
    }
    const asCaller = getUserClient(req)
    const { data, error } = await asCaller.storage.from(bucket).download(documentPath)
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
    await supabase.from('document_versions').insert([{
      deal_id: dealId, document_name: documentName, storage_path: storagePath,
      size, mime_type: 'application/pdf', version_num: nextVersion,
      pinned_as: pinnedAs || null, source: 'boldsign', note: note || null,
    }])
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
export async function trackDocument(supabase, { dealId, agentId, documentId, signers, documentName, subject, status, templateId }) {
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
    // Which template this came from — the key a per-deal field layout hangs on
    // (see captureFieldLayout). Null for an ad-hoc PDF send.
    boldsign_template_id: templateId || null,
  }])
  if (error) {
    // A database without the column yet (0026 not applied) must not lose the
    // tracking row — an untracked document is the worst outcome in this file.
    // Retry once without it; the layout feature degrades, the send does not.
    if (/boldsign_template_id/.test(error.message || '')) {
      console.warn(`[boldsign] boldsign_template_id column missing — tracking ${documentId} without it; apply migration 0026`)
      const { error: retryErr } = await supabase.from('boldsign_documents').insert([{
        deal_id: dealId, agent_id: agentId || null, document_id: documentId,
        signer_name: names.join(', '), signer_email: mails.join(', '),
        document_name: documentName || 'Document', subject: subject || null,
        signers: list, status: status || 'sent',
      }])
      if (!retryErr) return true
      console.error(`[boldsign] FAILED to track document ${documentId} on deal ${dealId}: ${retryErr.message}`)
      return false
    }
    console.error(`[boldsign] FAILED to track document ${documentId} on deal ${dealId}: ${error.message}`)
    return false
  }
  return true
}

// ─── Printable copy (review on paper before sending) ─────────────────────────
// Agents want to read a packet on paper before it goes to a client — and the
// browser cannot do it for them: the document lives in a cross-origin iframe, so
// window.print() prints OUR page chrome, not BoldSign's canvas. The printable copy
// has to be built from BoldSign's own bytes.
//
// WHAT THIS DOES NOT DO: draw the field boxes onto the page. BoldSign's `bounds`
// origin and units could not be confirmed (their docs are WAF-blocked from here),
// and this file already retired one coordinate-guessing feature for exactly that
// reason — see "RETIRED: pixel/point coordinate auto-placement" below. A printout
// with signature boxes in almost-the-right-place is worse than none: it looks
// authoritative and is quietly wrong. Instead the copy carries a SIGNING SUMMARY
// page listing every field by page, signer and type, which is derived from data
// BoldSign states outright and so cannot be subtly incorrect.
//
// Appended rather than prepended: page 1 of the printout stays page 1 of the
// agreement, so a printed packet still matches what everyone refers to as "page 1".

// Per-signer order → a stable label. Colors are not used (this prints, often in
// black and white); the summary is ordered and labeled instead.
export function buildSigningSummary(props) {
  const signers = (props?.signerDetails || []).map((s, i) => {
    const rows = (s?.formFields || []).map(f => ({
      page:  Number(f?.pageNumber) || 1,
      type:  normalizeFieldType(f?.type || f?.fieldType) || String(f?.type || 'Field'),
      label: f?.label || f?.placeholder || '',
      value: f?.value || '',
      required: Boolean(f?.isRequired),
    })).sort((a, b) => a.page - b.page || a.type.localeCompare(b.type))
    return {
      order: Number(s?.order) || i + 1,
      role:  s?.signerRole || '',
      name:  s?.signerName || '',
      email: s?.signerEmail || '',
      fields: rows,
    }
  }).sort((a, b) => a.order - b.order)
  const total = signers.reduce((t, s) => t + s.fields.length, 0)
  return { signers, total }
}

// Draw the summary onto one or more appended US Letter pages. Plain Helvetica at
// 10-11pt: this is a working document an agent marks up, not a brand surface.
async function appendSigningSummary(pdfDoc, { summary, documentName, status }) {
  const { StandardFonts, rgb } = await import('pdf-lib')
  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold     = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const [W, H]   = [612, 792]
  const margin   = 54
  const ink      = rgb(0.1, 0.1, 0.12)
  const muted    = rgb(0.42, 0.44, 0.48)

  let page = pdfDoc.addPage([W, H])
  let y = H - margin
  const line = (text, { size = 10.5, f = font, color = ink, gap = 14, indent = 0 } = {}) => {
    // A new page when the current one runs out — a packet with many fields must not
    // silently lose the tail of its own summary.
    if (y < margin + 40) { page = pdfDoc.addPage([W, H]); y = H - margin }
    page.drawText(String(text).slice(0, 120), { x: margin + indent, y, size, font: f, color })
    y -= gap
  }

  line('SIGNING SUMMARY', { size: 15, f: bold, gap: 20 })
  line(documentName || 'Document', { size: 11, color: muted, gap: 12 })
  line(`Status: ${status || 'draft'} · ${summary.total} field${summary.total === 1 ? '' : 's'} across ${summary.signers.length} signer${summary.signers.length === 1 ? '' : 's'}`,
    { size: 10, color: muted, gap: 22 })

  if (!summary.total) {
    line('No fields have been placed yet.', { size: 11 })
    line('Nothing will be requested from a signer until fields are placed in BoldSign.', { size: 10, color: muted })
  }

  for (const s of summary.signers) {
    const who = [s.name, s.email && `<${s.email}>`].filter(Boolean).join(' ') || '(no signer assigned)'
    line(`${s.order}. ${s.role || 'Signer'} — ${who}`, { size: 11.5, f: bold, gap: 16 })
    if (!s.fields.length) {
      line('no fields assigned', { size: 10, color: muted, indent: 14, gap: 18 })
      continue
    }
    for (const f of s.fields) {
      const bits = [`Page ${f.page}`, f.type, f.label && `“${f.label}”`, f.value && `= ${f.value}`, !f.required && '(optional)']
        .filter(Boolean).join(' · ')
      line(bits, { size: 10, indent: 14, gap: 13 })
    }
    y -= 6
  }

  // Said once, at the end, where someone holding the paper will read it.
  if (y < margin + 30) { page = pdfDoc.addPage([W, H]); y = H - margin }
  page.drawText('Printed from Gateway CRM for review. This copy is not a signed record.',
    { x: margin, y: margin - 18, size: 8.5, font, color: muted })
  return pdfDoc
}

// Build the print copy: the document exactly as BoldSign holds it, plus the
// summary. Returns a Buffer. Throws with a usable message if BoldSign won't hand
// over the bytes.
export async function buildPrintablePdf({ pdfBytes, props, documentName }) {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true })
  await appendSigningSummary(doc, {
    summary: buildSigningSummary(props),
    documentName,
    status: normalizeStatus(props?.status),
  })
  return Buffer.from(await doc.save({ useObjectStreams: true }))
}

// ─── Per-deal field layouts ───────────────────────────────────────────────────
// Field placement happens inside BoldSign's embedded editor, and BoldSign keeps
// it on the DOCUMENT. So the arrangement an agent builds for a deal — the
// co-seller's initials on page 3, the label the Iowa packet needs typed in —
// lived exactly as long as that one draft. Send it, and the next packet for the
// same deal came back from the template with the template's defaults.
//
// These helpers move that arrangement into the CRM, per deal:
//   • CAPTURE reads it back from BoldSign (`/document/properties`), so what gets
//     stored is what the agent actually left behind rather than what the app
//     believes it sent.
//   • APPLY pushes it onto the next draft for that deal (`/document/edit`).
//
// Deliberately NOT saved back to the shared BoldSign template: `form_packets`
// entries are brokerage-wide and compliance-relevant, so one deal's arrangement
// must never rewrite the form every other deal sends.

// Field types BoldSign can re-create through /document/edit (EditFormField.
// fieldType). A field of any other type is dropped from a captured layout rather
// than stored — storing one would make the re-apply request fail as a whole and
// lose the entire arrangement, which is far worse than losing one exotic field.
const EDITABLE_FIELD_TYPES = Object.freeze([
  'Signature', 'Initial', 'CheckBox', 'TextBox', 'Label', 'DateSigned',
  'RadioButton', 'Image', 'Attachment', 'EditableDate', 'Hyperlink', 'Dropdown',
  'Title', 'Company', 'Formula', 'Drawing',
])
const FIELD_TYPE_BY_LOWER = new Map(EDITABLE_FIELD_TYPES.map(t => [t.toLowerCase(), t]))
// BoldSign reads back some types under a different spelling than it accepts on
// write. Mapped explicitly so a captured Textbox doesn't silently vanish.
const FIELD_TYPE_ALIASES = Object.freeze({
  textbox: 'TextBox', text: 'TextBox', checkbox: 'CheckBox', initials: 'Initial',
  datesigned: 'DateSigned', radiobutton: 'RadioButton', editabledate: 'EditableDate',
  signaturedate: 'DateSigned',
})
export function normalizeFieldType(type) {
  const key = String(type || '').trim().toLowerCase()
  return FIELD_TYPE_BY_LOWER.get(key) || FIELD_TYPE_ALIASES[key] || null
}

// Fonts are an enum on write; a value outside it fails the request. Anything
// unrecognized is simply omitted, leaving BoldSign's default.
const EDIT_FONTS = new Set(['Helvetica', 'Courier', 'TimesRoman', 'NotoSans', 'Carlito'])

const num = (v, fallback = null) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

// A database where migration 0026 hasn't been applied yet has no layouts table.
// That is a provisioning state, not a fault in the send the agent is doing — it
// must degrade to "this deal remembers nothing" with one actionable sentence,
// never a Postgres error string in a toast on every single send.
export function isMissingLayoutStorage(error) {
  const msg = String(error?.message || error || '')
  return error?.code === '42P01' || error?.code === 'PGRST205'
    || /deal_field_layouts/.test(msg) && /does not exist|schema cache|find the table/i.test(msg)
}
const LAYOUT_STORAGE_MISSING = 'field-layout storage is not set up on this database yet — ask your admin to run migrations/production/2026-08-06_deal_field_layouts.sql'

// One captured field, reduced to what re-creating it requires. Returns null for a
// field that can't be re-created (unknown type, or no position to put it back).
export function normalizeCapturedField(f) {
  const fieldType = normalizeFieldType(f?.type || f?.fieldType)
  if (!fieldType) return null
  const b = f?.bounds || {}
  const x = num(b.x), y = num(b.y), width = num(b.width), height = num(b.height)
  // Without bounds there is no placement to restore — and BoldSign would drop the
  // field at (0,0), stacking every such field in the page corner.
  if (x == null || y == null || !width || !height) return null

  const out = {
    id:         f?.id || f?.formFieldId || null,
    fieldType,
    pageNumber: num(f?.pageNumber, 1),
    bounds:     { x, y, width, height },
    isRequired: Boolean(f?.isRequired),
    isReadOnly: Boolean(f?.isReadOnly),
  }
  if (f?.value != null && f.value !== '')       out.value = String(f.value)
  if (f?.label)                                  out.label = String(f.label)
  if (f?.placeholder || f?.placeHolder)          out.placeHolder = String(f.placeholder || f.placeHolder)
  if (num(f?.fontSize))                          out.fontSize = num(f.fontSize)
  if (EDIT_FONTS.has(f?.font))                   out.font = f.font
  if (f?.groupName)                              out.groupName = String(f.groupName)
  if (f?.dateFormat)                             out.dateFormat = String(f.dateFormat)
  if (Array.isArray(f?.dropdownOptions) && f.dropdownOptions.length) out.dropdownOptions = f.dropdownOptions
  if (typeof f?.isBold === 'boolean')            out.isBoldFont = f.isBold
  if (typeof f?.isItalic === 'boolean')          out.isItalicFont = f.isItalic
  if (typeof f?.isUnderline === 'boolean')       out.isUnderLineFont = f.isUnderline
  return out
}

// A BoldSign document's properties → the layout we store on the deal.
// `dropped` is reported (not swallowed) so a form full of types we can't restore
// is visible in the logs instead of looking like a successful empty capture.
export function normalizeCapturedLayout(props) {
  const signers = []
  let dropped = 0
  for (const [i, s] of (props?.signerDetails || []).entries()) {
    const fields = []
    for (const f of (s?.formFields || [])) {
      const n = normalizeCapturedField(f)
      if (n) fields.push(n); else dropped++
    }
    signers.push({
      signerRole:  s?.signerRole || '',
      signerName:  s?.signerName || '',
      signerEmail: s?.signerEmail || '',
      order:       num(s?.order, i + 1),
      formFields:  fields,
    })
  }
  // Sender-filled "common" fields belong to no signer, and BoldSign's
  // /document/edit only accepts fields nested under a signer — so these are
  // recorded (they cost nothing, and describe the arrangement faithfully) but
  // they are NOT counted. `fieldCount` is what will actually come back next
  // time, and it is the number the agent is shown; inflating it with fields the
  // restore silently skips would make the feature look broken.
  const commonFields = []
  for (const f of (props?.commonFields || [])) {
    const n = normalizeCapturedField(f)
    if (n) commonFields.push(n); else dropped++
  }
  const fieldCount = signers.reduce((t, s) => t + s.formFields.length, 0)
  return { layout: { signers, commonFields }, fieldCount, dropped }
}

// Match a saved signer entry to a signer on the NEW document. Role first (the
// template's own role name — "Seller", "Listing Agent" — which is stable across
// sends even when the people change), then email, then position. Position alone
// is the last resort: it's right for the common case and wrong only if roles were
// reordered between sends, where role/email matching has already caught it.
export function matchLayoutSigner(saved, signerDetails = []) {
  const norm = (v) => String(v || '').trim().toLowerCase()
  const byRole = saved?.signerRole
    ? signerDetails.find(s => norm(s?.signerRole) && norm(s.signerRole) === norm(saved.signerRole))
    : null
  if (byRole) return byRole
  const byEmail = saved?.signerEmail
    ? signerDetails.find(s => norm(s?.signerEmail) === norm(saved.signerEmail))
    : null
  if (byEmail) return byEmail
  return signerDetails.find(s => num(s?.order) === num(saved?.order)) || null
}

// Turn a saved layout + the new document's signers into a /document/edit payload.
//
// THE SAVED LAYOUT IS AUTHORITATIVE for this deal: a field it names is moved to
// where the agent put it (Update) or created if the new draft lacks it (Add), and
// a field the new draft has that the layout does NOT name is removed — otherwise a
// field the agent deliberately deleted last time would reappear on every send.
//
// VALUES ARE NOT CLOBBERED. A field that already carries a value on the new draft
// keeps it: that value is the CRM's fresh prefill (list price, dates, names), and
// the saved layout's copy is by definition from the previous send. The saved value
// is only used to fill a field the new draft left EMPTY — which is exactly the
// hand-typed label case the layout exists to preserve.
//
// Returns null when there is nothing to do, so callers can skip the API call.
export function buildLayoutEditPayload({ layout, signerDetails = [] } = {}) {
  const savedSigners = layout?.signers || []
  if (!savedSigners.length && !(layout?.commonFields || []).length) return null

  const signers = []
  for (const saved of savedSigners) {
    const target = matchLayoutSigner(saved, signerDetails)
    if (!target?.id) continue

    const existing   = target.formFields || []
    const byId       = new Map(existing.filter(f => f?.id).map(f => [String(f.id), f]))
    const savedIds   = new Set((saved.formFields || []).map(f => f.id).filter(Boolean))
    const formFields = []

    for (const f of (saved.formFields || [])) {
      const live = f.id ? byId.get(String(f.id)) : null
      const { id, ...rest } = f
      const field = { editAction: live ? 'Update' : 'Add', ...(id ? { id } : {}), ...rest }
      // Live value wins — see VALUES ARE NOT CLOBBERED above.
      if (live?.value != null && live.value !== '') field.value = String(live.value)
      formFields.push(field)
    }
    // Fields on the new draft the agent had removed last time.
    for (const f of existing) {
      if (f?.id && !savedIds.has(String(f.id))) formFields.push({ editAction: 'Remove', id: f.id })
    }
    if (formFields.length) signers.push({ editAction: 'Update', id: target.id, formFields })
  }

  return signers.length ? { signers } : null
}

// Read a document's current arrangement out of BoldSign and store it against the
// deal. Never throws: a capture failure must not fail the send or the editing
// session it rode in on — the agent's document is unaffected either way.
// Returns { saved, fieldCount, reason? } for callers that want to report it.
export async function captureFieldLayout(supabase, { documentId, record, agentId }) {
  try {
    const props = await boldsign(`/document/properties?documentId=${encodeURIComponent(documentId)}`)
    const { layout, fieldCount, dropped } = normalizeCapturedLayout(props)
    if (dropped) console.warn(`[boldsign] layout capture for ${documentId}: dropped ${dropped} unrestorable field(s)`)

    const templateId = record?.boldsign_template_id || ''
    if (!record?.deal_id) return { saved: false, fieldCount, reason: 'not attached to a deal' }

    // An empty capture must not erase a good saved layout. BoldSign returns no
    // form fields for a document still processing, and an unconditional overwrite
    // there would silently wipe the arrangement it was meant to protect.
    if (!fieldCount) {
      const { data: existing, error: readErr } = await supabase.from('deal_field_layouts')
        .select('id, field_count').eq('deal_id', record.deal_id).eq('template_id', templateId).maybeSingle()
      if (isMissingLayoutStorage(readErr)) return { saved: false, fieldCount: 0, unavailable: true, reason: LAYOUT_STORAGE_MISSING }
      if (existing?.field_count) return { saved: false, fieldCount: 0, reason: 'no fields returned — kept the existing layout' }
    }

    const { error } = await supabase.from('deal_field_layouts').upsert([{
      deal_id:       record.deal_id,
      template_id:   templateId,
      document_name: record.document_name || null,
      layout,
      field_count:   fieldCount,
      captured_from: documentId,
      captured_by:   agentId || record.agent_id || null,
      updated_at:    new Date().toISOString(),
    }], { onConflict: 'deal_id,template_id' })
    if (error) {
      if (isMissingLayoutStorage(error)) {
        console.warn(`[boldsign] ${LAYOUT_STORAGE_MISSING}`)
        return { saved: false, fieldCount, unavailable: true, reason: LAYOUT_STORAGE_MISSING }
      }
      console.error(`[boldsign] layout capture upsert failed for ${documentId}: ${error.message}`)
      return { saved: false, fieldCount, reason: error.message }
    }
    return { saved: true, fieldCount }
  } catch (err) {
    console.error(`[boldsign] layout capture failed for ${documentId}: ${err.message}`)
    return { saved: false, fieldCount: 0, reason: err.message }
  }
}

// Apply a deal's saved layout to a freshly created draft. Also never throws: if
// this fails the draft simply opens with the template's default placement, which
// is the behavior that existed before layouts — a degraded send beats no send.
// Returns { applied, fieldCount, reason? }.
export async function applyFieldLayout(supabase, { documentId, dealId, templateId, onBehalfOf }) {
  try {
    if (!dealId || !documentId) return { applied: false, reason: 'missing deal or document' }
    const { data: saved, error } = await supabase.from('deal_field_layouts')
      .select('layout, field_count')
      .eq('deal_id', dealId).eq('template_id', templateId || '').maybeSingle()
    // A database without the table yet (migration not applied) reads as "this deal
    // remembers nothing" — the same quiet path as a deal with no saved layout, so
    // no send is decorated with a provisioning message the agent can't act on.
    if (isMissingLayoutStorage(error)) return { applied: false, reason: 'no saved layout' }
    if (error) return { applied: false, reason: error.message }
    if (!saved?.field_count) return { applied: false, reason: 'no saved layout' }

    // The new draft's signer ids are only knowable after it exists.
    const props = await boldsign(`/document/properties?documentId=${encodeURIComponent(documentId)}`)
    const payload = buildLayoutEditPayload({ layout: saved.layout, signerDetails: props?.signerDetails || [] })
    if (!payload) return { applied: false, reason: 'saved layout matched none of this document\'s signers' }

    await boldsign(`/document/edit?documentId=${encodeURIComponent(documentId)}`, {
      method: 'POST',
      json: { ...payload, ...(onBehalfOf ? { onBehalfOf } : {}) },
    })
    return { applied: true, fieldCount: saved.field_count }
  } catch (err) {
    console.error(`[boldsign] layout apply failed for ${documentId}: ${err.message}`)
    return { applied: false, reason: err.message }
  }
}

// ─── Draft editing ────────────────────────────────────────────────────────────
// Reopen an existing DRAFT document in BoldSign's embedded prepare editor, so an
// agent who navigated away (or closed the tab) mid-prep can pick up exactly where
// they left off and finish the send. Without this a draft was a dead end: the row
// showed in the Signatures tab with no way back into it, and the only "fix" was to
// delete it and start over.
//
// POST /document/createEmbeddedEditUrl?documentId=… → { editUrl }
//
// THE VIEW OPTION IS STATE-DEPENDENT. `sendViewOption` accepts 'FillingPage' or
// 'PreparePage', and BoldSign rejects the wrong one for the document's state:
//   "The embedded editing link cannot be generated when SendViewOption is set to
//    'PreparePage' because the document is in the draft state."
// So a draft opens on FillingPage — which is the page we actually want anyway: the
// document with its recipients and fields, ready to adjust and send. PreparePage
// is for a document that is already in flight. Rather than hard-wire the mapping
// off one observed message, a refusal that names SendViewOption retries with the
// other option, so neither state can dead-end.
//
// THE EDIT LOCK. A document that was opened for editing stays flagged as
// in-edit-mode on BoldSign's side. An agent who closed the browser instead of
// clicking Save/Send leaves that flag set, and the next createEmbeddedEditUrl for
// the same document comes back 400 — the exact agent, on the exact document, who
// most needs to get back in. So a 400 that ISN'T about the view option is treated
// as a possible stale lock: clear it with /document/cancelEditing and try once
// more. If the retry also fails, its error is what surfaces (a genuinely
// un-editable document still reports itself).
const EDIT_VIEW_OPTIONS = ['FillingPage', 'PreparePage']
const isViewOptionRefusal = (err) => /sendviewoption/i.test(err?.message || '')

export async function createDraftEditUrl({ documentId, redirectUrl, onBehalfOf, sendViewOption } = {}) {
  // Caller-preferred view first (if any), then the remaining option as fallback.
  const views = sendViewOption
    ? [sendViewOption, ...EDIT_VIEW_OPTIONS.filter(v => v !== sendViewOption)]
    : EDIT_VIEW_OPTIONS

  const editPath = `/document/createEmbeddedEditUrl?documentId=${encodeURIComponent(documentId)}`
  const ask = (view) => boldsign(editPath, {
    method: 'POST',
    json: {
      redirectUrl:           redirectUrl || '',
      sendViewOption:        view,
      showToolbar:           true,
      showSendButton:        true,
      showPreviewButton:     true,          // agents want to eyeball it before it goes
      showNavigationButtons: true,
      ...(onBehalfOf ? { onBehalfOf } : {}),
    },
  })
  const pick = (data) => data?.editUrl || data?.sendUrl || data?.url || null

  const clearEditLock = async () => {
    const qs = new URLSearchParams({ documentId })
    if (onBehalfOf) qs.set('onBehalfOf', onBehalfOf)
    try { await boldsign(`/document/cancelEditing?${qs.toString()}`, { method: 'POST', json: {} }); return true }
    catch { return false }
  }

  let lastErr
  for (const view of views) {
    try {
      return pick(await ask(view))
    } catch (err) {
      if (err.status !== 400) throw err
      lastErr = err
      if (isViewOptionRefusal(err)) continue            // wrong page for this state — try the other
      if (!await clearEditLock()) throw err             // not a lock we can clear — report as-is
      try {
        return pick(await ask(view))
      } catch (retryErr) {
        if (retryErr.status !== 400) throw retryErr
        lastErr = retryErr
        if (isViewOptionRefusal(retryErr)) continue      // lock cleared, view still wrong
        throw retryErr
      }
    }
  }
  throw lastErr
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

    // Which document row this action is about, and whether the caller may touch it:
    // the sender, an admin, or — for rows predating agent attribution (agent_id
    // null) — anyone whose own RLS lets them see the deal. Without that last
    // branch the draft features would skip exactly the older documents agents are
    // stuck on. Throws a tagged error the catch below turns into a status code.
    const resolveDocumentRecord = async (svc, documentId, { verb }) => {
      const base = 'id, deal_id, agent_id, status, document_name'
      let { data: record, error } = await svc.from('boldsign_documents')
        .select(`${base}, boldsign_template_id, signed_storage_path`)
        .eq('document_id', documentId).maybeSingle()
      // A database missing one of the newer columns must not turn every draft
      // action into a 404 — fall back to the columns that have always existed.
      if (error) {
        console.warn(`[boldsign] document row read fell back to base columns (${error.message})`)
        ;({ data: record } = await svc.from('boldsign_documents')
          .select(base).eq('document_id', documentId).maybeSingle())
      }
      if (!record) { const e = new Error('Document not found'); e.status = 404; throw e }
      let allowed = actor.isAdmin || (record.agent_id && record.agent_id === actor.agent.id)
      if (!allowed && !record.agent_id && record.deal_id) {
        const { data: visible } = await getUserClient(req)
          .from('deals').select('id').eq('id', record.deal_id).maybeSingle()
        allowed = Boolean(visible)
      }
      if (!allowed) {
        const e = new Error(`Only the sender or an admin can ${verb} this document`); e.status = 403; throw e
      }
      return record
    }

    // Save this deal's CURRENT field arrangement, read back from BoldSign, so the
    // next packet built for the deal opens the way the agent left this one. Called
    // when an editing session ends (draft saved, sent, or closed) and by the Sent
    // webhook. Deliberately answers 200 with { saved: false, reason } rather than
    // an error status when there is simply nothing to store — this rides along
    // with the agent's real work and must never present as a failed send.
    if (body.action === 'layout-capture') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      const svc    = getServiceClient()
      const record = await resolveDocumentRecord(svc, id, { verb: 'save the field layout for' })
      const result = await captureFieldLayout(svc, { documentId: id, record, agentId: actor.agent.id })
      return res.json({
        saved:      result.saved,
        fieldCount: result.fieldCount,
        templateId: record.boldsign_template_id || '',
        ...(result.unavailable ? { unavailable: true } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      })
    }

    // A printable copy of the document AS IT STANDS — available at any point before
    // the send, which is the whole point: an agent reviewing a listing packet wants
    // it on paper before a client ever sees it.
    //
    // Returns a short-lived signed storage URL, never base64: a serverless response
    // is capped at 4.5 MB and a scanned packet is bigger than that, so base64 would
    // work in testing and fail on exactly the documents worth printing.
    if (body.action === 'document-print') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })
      const svc    = getServiceClient()
      const record = await resolveDocumentRecord(svc, id, { verb: 'print' })
      if (!record.deal_id) return res.status(400).json({ error: 'This document is not attached to a deal' })

      const props = await boldsign(`/document/properties?documentId=${encodeURIComponent(id)}`)

      // BoldSign's /document/download is the only source of the current bytes. It is
      // NOT guaranteed to serve a document that hasn't been sent, so a refusal falls
      // back to the copy this deal already holds — for an ad-hoc send that is the
      // exact PDF that was uploaded, and for a completed document it's the archived
      // signed copy. Only when neither exists does this fail, and then it says which
      // door was locked rather than "could not print".
      let pdfBytes = null
      try {
        const r = await boldsign(`/document/download?documentId=${encodeURIComponent(id)}`, { raw: true })
        if (r.ok) {
          const buf = await r.arrayBuffer()
          if (buf.byteLength) pdfBytes = Buffer.from(buf)
        }
      } catch (err) {
        console.warn(`[boldsign] print: /document/download refused ${id} (${err.message}) — trying the deal's own copy`)
      }
      if (!pdfBytes) {
        const stored = record.signed_storage_path
        if (stored) {
          const { data } = await svc.storage.from(DEAL_BUCKET).download(stored)
          if (data) pdfBytes = Buffer.from(await data.arrayBuffer())
        }
      }
      if (!pdfBytes) {
        return res.status(400).json({
          error: 'BoldSign will not release this document\'s pages yet, and no copy is stored on the deal. '
            + 'Use Preview inside BoldSign to review it, or print it after sending.',
        })
      }

      const printable = await buildPrintablePdf({ pdfBytes, props, documentName: record.document_name })
      // A print artifact is a convenience copy, not a deal document: kept under a
      // `print/` prefix so it never appears in the Documents tab as if it were a
      // real filing, and overwritten each time rather than accumulating.
      const path = `deal-${record.deal_id}/print/${String(id).slice(0, 8)}-review.pdf`
      const { error: upErr } = await svc.storage.from(DEAL_BUCKET)
        .upload(path, printable, { contentType: 'application/pdf', upsert: true })
      if (upErr) return res.status(500).json({ error: `Could not prepare the print copy: ${upErr.message}` })

      const filename = `${String(record.document_name || 'document').replace(/\.pdf$/i, '')} (review).pdf`
      const { data: signed, error: signErr } = await svc.storage.from(DEAL_BUCKET)
        .createSignedUrl(path, 300, { download: filename })
      if (signErr || !signed?.signedUrl) {
        return res.status(500).json({ error: `Could not create a link to the print copy${signErr?.message ? `: ${signErr.message}` : ''}` })
      }
      return res.json({
        url:        signed.signedUrl,
        filename,
        status:     normalizeStatus(props?.status),
        fieldCount: buildSigningSummary(props).total,
      })
    }

    // Reopen a DRAFT for editing: hand back an embedded BoldSign prepare URL for a
    // document that already exists. This is the way back into a send an agent
    // started and walked away from — same signers, same field placement, still
    // unsent — instead of deleting the draft and rebuilding it from scratch.
    //
    // The CRM's own status is not trusted as the gate. A missed Sent webhook leaves
    // a row saying 'draft' for a document the client already has, and offering
    // "Edit" for that is a lie. BoldSign is asked what the document actually is,
    // the row is corrected from the answer, and only a real draft is opened.
    if (body.action === 'document-edit-url') {
      const id = body.envelopeId || body.documentId
      if (!id) return res.status(400).json({ error: 'documentId required' })

      const svc    = getServiceClient()
      const record = await resolveDocumentRecord(svc, id, { verb: 'edit' })

      const props  = await boldsign(`/document/properties?documentId=${encodeURIComponent(id)}`)
      const live   = normalizeStatus(props.status)
      if (live !== 'draft') {
        // Correct the row so the tab stops advertising a draft that isn't one.
        const patch = { status: live }
        const done  = toIso(props.completedDate || props.signedDate || null)
        if (done) patch.completed_at = done
        await svc.from('boldsign_documents').update(patch).eq('id', record.id)
        return res.status(400).json({
          error: live === 'completed'
            ? 'This document is already fully signed — it can no longer be edited.'
            : `This document is ${live}, not a draft, so it can no longer be edited. Its status here has been updated.`,
          status: live,
        })
      }

      // Edit as the identity the draft was CREATED under (the deal's sending
      // agent), not whoever happens to be clicking. BoldSign scopes a document to
      // its sender, and an admin reopening an agent's draft under their own
      // identity would either be refused or quietly change who the client hears
      // from mid-send.
      let onBehalfOf = null
      try { onBehalfOf = await resolveOnBehalfOf(svc, record.agent_id || actor.agent.id) } catch { /* account default */ }

      const url = await createDraftEditUrl({ documentId: id, redirectUrl: body.redirectUrl, onBehalfOf })
      if (!url) return res.status(502).json({ error: 'BoldSign did not return an edit URL for this draft' })
      return res.json({ url, documentId: id, status: 'draft' })
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

      // Resolve every source to bytes HERE, server-side. A `url`/`path` entry is
      // streamed from the form-packets bucket at full quality; `base64` is still
      // accepted for older callers but is capped by the platform's 4.5 MB request
      // limit — the cap that forced admins to compress packets until the text went
      // blurry (see "Document quality" at the top of this file).
      const resolved = []
      let optimizedAny = false
      for (const [i, d] of fileList.entries()) {
        const name = d?.name || `document-${i + 1}.pdf`
        const bytes = await resolveDocumentBytes(req, {
          documentUrl:    d?.url,
          documentPath:   d?.path,
          documentBase64: d?.base64,
          documentName:   name,
          source:         'packet',
        })
        // Only touched if it exceeds BoldSign's own per-file limit, and even then
        // only losslessly — never by re-compressing page images.
        const fitted = await fitForBoldSign(bytes, name)
        if (fitted.optimized) optimizedAny = true
        resolved.push({ name, bytes: fitted.buffer })
      }

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
      resolved.forEach(d => {
        form.append('Files', new Blob([d.bytes], { type: 'application/pdf' }), d.name)
      })
      const data = await boldsign('/template/createEmbeddedTemplateUrl', { method: 'POST', form })
      return res.json({
        url: data.createUrl, templateId: data.templateId, roles: roleList,
        // What actually reached BoldSign, so the admin can see the packet went up
        // at full size rather than wondering whether something shrank it.
        uploaded: resolved.map(d => ({ name: d.name, bytes: d.bytes.length })),
        ...(optimizedAny ? { optimized: true } : {}),
      })
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
          subject: emailSubject || null, status: 'sent', templateId,
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
      let layout = null
      if (deal_id && data.documentId) {
        const tracked = await trackDocument(svc, {
          dealId: deal_id, agentId: actor.agent.id, documentId: data.documentId,
          signers: roles, documentName: documentName || emailSubject || 'Document',
          subject: emailSubject || null, status: 'draft', templateId,
        })
        if (!tracked) {
          try { await boldsign(`/document/delete?documentId=${encodeURIComponent(data.documentId)}&deletePermanently=true`, { method: 'DELETE' }) }
          catch { /* best-effort cleanup of the untrackable draft */ }
          return res.status(500).json({
            error: 'Could not record this document against the deal, so it was not opened for sending. Nothing was sent — please try again.',
          })
        }
        // Restore this deal's own field arrangement over the template's defaults,
        // BEFORE the editor URL is handed back, so the packet opens already
        // arranged instead of asking the agent to redo last time's work. Failure
        // is reported, never fatal — the draft is still perfectly sendable with
        // the template's placement.
        layout = await applyFieldLayout(svc, {
          documentId: data.documentId, dealId: deal_id, templateId, onBehalfOf,
        })
      }
      return res.json({
        url: data.sendUrl || data.embeddedSendUrl || data.url || null,
        documentId: data.documentId || null,
        layoutApplied:    Boolean(layout?.applied),
        layoutFieldCount: layout?.applied ? layout.fieldCount : 0,
        ...(layout && !layout.applied && layout.reason && layout.reason !== 'no saved layout'
          ? { layoutWarning: `This deal's saved field layout could not be applied (${layout.reason}). The form opened with its default fields.` }
          : {}),
      })
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

    const patch = { status }
    if (completedAt) patch.completed_at = completedAt
    await supabase.from('boldsign_documents').update(patch).eq('document_id', documentId)

    // A SEND is the moment the arrangement is final: whatever the agent placed is
    // what the signers are looking at. Capture it against the deal here, not only
    // from the browser, so a send that happened after the tab was closed (or from
    // BoldSign's own UI) still teaches the next packet where the fields go.
    // Best-effort by contract — captureFieldLayout never throws, and this must not
    // put a webhook at risk of a retry storm.
    if (status === 'sent' && record.deal_id) {
      const captured = await captureFieldLayout(supabase, {
        documentId, record, agentId: record.agent_id,
      })
      if (captured.saved) console.log(`[boldsign] captured ${captured.fieldCount} field placement(s) for deal ${record.deal_id}`)
    }

    // A decline or expiry needs the agent's attention as much as a completion
    // does — previously both updated the row and told nobody, so a declined
    // listing agreement sat silently and an expired one was indistinguishable
    // from one the agent had cancelled themselves.
    if (status === 'declined' || status === 'expired') {
      const deal = record.deals
      if (deal?.agent_id) {
        const declined = status === 'declined'
        await supabase.from('agent_notifications').insert([{
          agent_id:    deal.agent_id,
          deal_id:     record.deal_id,
          envelope_id: documentId,
          title:       declined ? 'Document Declined' : 'Signature Request Expired',
          message:     declined
            ? `${record.signer_name || 'A signer'} declined "${record.document_name || 'Document'}" for ${deal.title || 'your deal'}. Follow up with them and send a corrected copy.`
            : `"${record.document_name || 'Document'}" for ${deal.title || 'your deal'} expired before everyone signed. Send it again to restart.`,
          type:        declined ? 'document_declined' : 'document_expired',
        }])
      }
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
