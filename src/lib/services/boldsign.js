// ─────────────────────────────────────────────────────────────────────────────
// BoldSign client service — the single place the browser talks to /api/boldsign.
//
// Every call carries the Supabase access token as a Bearer header; the API's
// requireAgent()/requireAdmin() reject requests without it. Centralizing here
// fixes the class of bug where a caller forgot the token and got a 401.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession()
  return {
    'Content-Type': 'application/json',
    ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
  }
}

// A transport failure — fetch() rejecting rather than returning a response — used
// to reach the agent as the browser's bare "Failed to fetch", which names no cause
// and suggests no action. It is worth translating, because the causes are few,
// distinguishable, and each has a different fix:
//   • offline / dropped connection      → navigator.onLine says so outright
//   • a protected preview deployment    → /api/* redirects to the Vercel SSO login,
//     and a cross-origin redirect mid-fetch surfaces as exactly this rejection
//   • a blocking browser extension      → a privacy/ad blocker cancelling the POST
// The message names all three rather than guessing between them, since the browser
// deliberately hides which one it was (that's why the original error is so bare).
export function describeTransportFailure(err, { online = true, url = '/api/boldsign' } = {}) {
  if (!online) {
    return `No network connection — ${url} could not be reached. Reconnect and try again.`
  }
  return `Could not reach ${url} (${err?.message || 'network error'}). `
    + 'The request never reached the server, so nothing was sent. Common causes: you are on a '
    + 'protected preview deployment that requires a Vercel login, a browser extension is blocking '
    + 'the request, or a VPN/proxy dropped it. Open DevTools → Network and check the status on that '
    + 'row — a redirect to vercel.com means the first, "blocked" means the second.'
}

async function call(payload) {
  let res
  try {
    res = await fetch('/api/boldsign', {
      method: 'POST', headers: await authHeaders(), body: JSON.stringify(payload),
    })
  } catch (err) {
    throw new Error(describeTransportFailure(err, {
      online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
    }))
  }

  // A non-JSON body means something other than our handler answered — a platform
  // error page, an auth wall, a gateway timeout. Surfacing its status and a snippet
  // beats "HTTP 500" with no clue as to who produced it.
  const text = await res.text().catch(() => '')
  let data = {}
  try { data = text ? JSON.parse(text) : {} } catch {
    const snippet = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    throw new Error(`The server returned a non-JSON response (HTTP ${res.status})${snippet ? `: ${snippet}` : ''}`)
  }
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ── Documents (ad-hoc send flow) ─────────────────────────────────────────────
// A send takes `documentPath` (a deal-documents storage path) rather than
// base64. Vercel caps a function request at 4.5 MB and base64 inflates by ~33%,
// so inline bytes silently capped every send at ~3.3 MB of PDF — well under a
// normal scanned disclosure packet. Upload to storage first (see
// uploadSendablePdf) and pass the path; the API streams it to BoldSign.
export const documentEmbedUrl = (p)          => call({ action: 'document-embed-url', ...p })
// Reopen an unsent draft in BoldSign's embedded editor — the way back into a send
// that was started and abandoned (tab closed, agent switched screens). Returns
// { url } for the same document, signers and field placement intact.
export const documentEditUrl  = (p)          => call({ action: 'document-edit-url', ...p })
// Save the field arrangement an agent just built in BoldSign against the deal, so
// the next packet for that deal opens already arranged instead of reverting to the
// blank template's defaults. Resolves { saved, fieldCount, reason? } — `saved:
// false` is a normal outcome (nothing placed yet), not an error.
export const captureLayout    = (documentId) => call({ action: 'layout-capture', documentId })
// A downloadable PDF of the document as it stands right now — the pages BoldSign
// holds, with every filled field value drawn onto them and any interactive form
// flattened, plus an appended signing summary (who signs what, on which page).
// Resolves { url, filename, fieldCount }: a short-lived signed storage URL, never
// base64, because a serverless response caps at 4.5 MB and a scanned packet exceeds
// it. The wire action is still `document-print` — it fed a Print button before the
// browser's print dialog turned out to render these blank (see src/lib/savePdf.js).
export const documentPdfUrl   = (documentId) => call({ action: 'document-print', documentId })
// Put a prepared DRAFT in front of its signers — BoldSign's `draftSend`. This is
// the ONLY call in this file that sends anything: creating a draft, filling it,
// downloading it and reopening it are all deliberately non-sending, so an agent
// can prepare and print a packet without any risk of it reaching the client.
// Resolves { documentId, status: 'sent' }; rejects with a message worth showing
// (a signer with no email, no fields placed, a rate limit) and the draft is left
// exactly as it was.
export const sendDraft       = (documentId) => call({ action: 'draft-send', documentId })
export const getDocStatus    = (documentId) => call({ action: 'status',   documentId })
// download/audit-download return { url, filename } — a short-lived signed
// storage URL, not base64, so size is not a factor and each document resolves
// to its OWN archived file.
export const downloadSigned  = (documentId) => call({ action: 'download', documentId })
export const downloadAudit   = (documentId) => call({ action: 'audit-download', documentId })
// Nudge whoever still owes a signature. `signerEmails` targets specific people
// — the only ones an agent ever means to chase — and the API filters the list
// against the document's own signers before it reaches BoldSign. Omit it and
// the server reminds whoever the row still shows as outstanding, which on a
// sequential send is not the same thing as "everybody".
export const remindDocument  = (documentId, signerEmails) => call({ action: 'remind', documentId, ...(signerEmails?.length ? { signerEmails } : {}) })
export const deleteDocument  = (documentId) => call({ action: 'document-delete', documentId })

// ── Sendable-PDF upload ───────────────────────────────────────────────────────
// BoldSign accepts files well above what a serverless request body can carry, so
// the browser puts the PDF in the deal's own document folder (which it already
// has permission to write) and the API reads it back with the caller's
// credentials. Side benefit: the exact document that went out for signature is
// on the deal, not just in BoldSign.
export const SEND_BUCKET = 'deal-documents'
// BoldSign's own per-file ceiling. Checked here so an oversized file is refused
// with a real sentence instead of an opaque failure mid-send.
export const MAX_SEND_BYTES = 25 * 1024 * 1024

export function formatBytes(b) {
  if (!b) return '0 B'
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

// Validate + upload, returning the storage path to hand to the API.
// `supabase` is injected so this stays testable and the service module keeps no
// hidden dependency on a live client.
export async function uploadSendablePdf(supabase, { file, dealId }) {
  if (!file)   throw new Error('Select or upload a document')
  if (!dealId) throw new Error('This send is not attached to a deal')
  if (file.size > MAX_SEND_BYTES) {
    throw new Error(`"${file.name}" is ${formatBytes(file.size)} — BoldSign's limit is ${formatBytes(MAX_SEND_BYTES)}. Split it into two packets.`)
  }
  const looksPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf'
  if (!looksPdf) throw new Error(`"${file.name}" is not a PDF. Convert it first — BoldSign only signs PDFs here.`)

  // Same naming convention the Documents tab uses (timestamp prefix, stripped
  // for display), so a sent document looks native alongside manual uploads.
  const safeName = file.name.replace(/[^\w.\- ]+/g, '_')
  const path = `deal-${dealId}/${Date.now()}-${safeName}`
  const { error } = await supabase.storage.from(SEND_BUCKET).upload(path, file, {
    contentType: 'application/pdf', upsert: false,
  })
  if (error) throw new Error(`Could not upload "${file.name}": ${error.message}`)
  return { path, name: safeName }
}

// Hand the API a short-lived signed URL rather than a bare path. The browser can
// only sign an object its own RLS lets it read, so the API needs no credentials
// of its own to fetch it — and it doesn't depend on the anon key being present
// as a runtime (not just build-time) env var on the server.
export async function signSendableUrl(supabase, path) {
  const { data, error } = await supabase.storage.from(SEND_BUCKET).createSignedUrl(path, 600)
  if (error || !data?.signedUrl) {
    throw new Error(`Could not prepare that document for sending${error?.message ? `: ${error.message}` : ''}`)
  }
  return data.signedUrl
}

// ── Sender identities (admin) ────────────────────────────────────────────────
export const createIdentity      = (agentId, name, email) => call({ action: 'identity-create', agentId, name, email })
export const updateIdentity      = (email, name) => call({ action: 'identity-update', email, name })
export const deleteIdentity      = (email)      => call({ action: 'identity-delete', email })
export const setDefaultIdentity  = (email)      => call({ action: 'identity-set-default', email })
export const syncIdentities      = ()      => call({ action: 'identity-sync' })
export const resendIdentity      = (email) => call({ action: 'identity-resend', email })

// ── Templates ────────────────────────────────────────────────────────────────
export const templateEditorUrl     = (p) => call({ action: 'template-editor-url', ...p })
export const templateDetails       = (templateId) => call({ action: 'template-details', templateId })
export const sendFromTemplate      = (p) => call({ action: 'template-send', ...p })
export const templateEmbedUrl      = (p) => call({ action: 'template-embed-url', ...p })
// Save-as-Draft: build the document from a template with every CRM value already
// filled in, and STOP there — no editor, nothing sent. Resolves
// { documentId, status: 'draft', editUrl } and the draft is immediately
// downloadable as a filled PDF (documentPdfUrl), reopenable (documentEditUrl) and
// sendable when the agent chooses (sendDraft). Takes the same payload as
// templateEmbedUrl, but `deal_id` is required — a draft has to hang off a deal to
// be found again.
export const saveTemplateDraft     = (p) => call({ action: 'template-draft', ...p })

// ── Field model, prefill routing and CRM tokens ──────────────────────────────
// All of it lives in ./boldsignFields.js and is re-exported here unchanged, so
// every existing `from '.../services/boldsign.js'` import keeps working. The
// split is only about reachability: that module is pure and loads under plain
// Node (scripts/audit-boldsign-templates.mjs sweeps the account's templates with
// it), while this file imports the Supabase browser client and cannot.
export * from './boldsignFields.js'
// The Selections panel's rows — short labels derived from each box's printed
// caption, the sender's two-state choice, and the mutex groups it enforces.
export * from './boldsignSelections.js'
// The Prepare Draft Agreement panel: the decisions it asks for, and the field
// ids each one writes to.
export * from './boldsignPacketPanel.js'
// Per-signer state — who has signed, who has opened it, and who a reminder
// should actually go to. Shared with api/boldsign.js, which imports the same
// module directly (it is pure, like boldsignCaptions.js).
export * from './boldsignSigners.js'
