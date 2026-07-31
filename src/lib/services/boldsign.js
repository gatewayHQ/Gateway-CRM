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

async function call(payload) {
  const res  = await fetch('/api/boldsign', {
    method: 'POST', headers: await authHeaders(), body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ── Documents (ad-hoc send flow) ─────────────────────────────────────────────
// A send takes `documentPath` (a deal-documents storage path) rather than
// base64. Vercel caps a function request at 4.5 MB and base64 inflates by ~33%,
// so inline bytes silently capped every send at ~3.3 MB of PDF — well under a
// normal scanned disclosure packet. Upload to storage first (see
// uploadSendablePdf) and pass the path; the API streams it to BoldSign.
export const sendDocument     = (p)          => call({ action: 'send', ...p })
export const documentEmbedUrl = (p)          => call({ action: 'document-embed-url', ...p })
export const signLink         = (p)          => call({ action: 'sign-link', ...p })
export const getDocStatus    = (documentId) => call({ action: 'status',   documentId })
// download/audit-download return { url, filename } — a short-lived signed
// storage URL, not base64, so size is not a factor and each document resolves
// to its OWN archived file.
export const downloadSigned  = (documentId) => call({ action: 'download', documentId })
export const downloadAudit   = (documentId) => call({ action: 'audit-download', documentId })
export const remindDocument  = (documentId) => call({ action: 'remind',   documentId })
export const deleteDocument  = (documentId) => call({ action: 'document-delete', documentId })
export const debugBoldsign   = ()           => call({ action: 'debug' })

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
export const identityDetails     = (email)      => call({ action: 'identity-details', email })
export const updateIdentity      = (email, name) => call({ action: 'identity-update', email, name })
export const deleteIdentity      = (email)      => call({ action: 'identity-delete', email })
export const setDefaultIdentity  = (email)      => call({ action: 'identity-set-default', email })
export const syncIdentities      = ()      => call({ action: 'identity-sync' })
export const resendIdentity      = (email) => call({ action: 'identity-resend', email })

// ── Templates ────────────────────────────────────────────────────────────────
export const listBoldsignTemplates = ()  => call({ action: 'template-list' })
export const templateEditorUrl     = (p) => call({ action: 'template-editor-url', ...p })
export const templateDetails       = (templateId) => call({ action: 'template-details', templateId })
export const sendFromTemplate      = (p) => call({ action: 'template-send', ...p })
export const templateEmbedUrl      = (p) => call({ action: 'template-embed-url', ...p })

// ── Text tags ─────────────────────────────────────────────────────────────────
// BoldSign auto-places a field when it finds `{{fieldType|signerIndex|required|
// label|fieldId}}` in the document text. Setting fieldId to a CRM token (see
// crmTokenValues below) unifies template prep with prefill — the same string
// both places the field and tells the CRM what to fill. See
// docs/boldsign-integration.md and developers.boldsign.com/text-tags.
export const TEXT_TAG_FIELD_TYPES = Object.freeze([
  'Signature', 'Initial', 'DateSigned', 'Textbox', 'CheckBox', 'RadioButton', 'Dropdown', 'Label',
])
export function buildTextTag({ fieldType, signerIndex = 1, required = false, label = '', fieldId = '' }) {
  return `{{${fieldType}|${signerIndex}|${required ? 'true' : 'false'}|${label}|${fieldId}}}`
}

// Field types whose value an agent can pre-fill from the CRM (vs signer actions
// like Signature/Initial). Used to decide which template fields become inputs.
export const FILLABLE_FIELD_TYPES = new Set(['textbox', 'text', 'label', 'dropdown', 'editabledate', 'company', 'name', 'title', 'email'])
export const isFillableField = (t) => FILLABLE_FIELD_TYPES.has(String(t || '').toLowerCase())

// Normalize a state value to a 2-letter code. Accepts existing codes (IA) or
// the full names of the states the brokerage operates in. Extend the map if you
// add states.
const STATE_CODES = { iowa: 'IA', 'south dakota': 'SD', nebraska: 'NE' }
export function normalizeState(s) {
  const v = String(s || '').trim()
  if (!v) return ''
  if (v.length === 2) return v.toUpperCase()
  return STATE_CODES[v.toLowerCase()] || v.toUpperCase()
}

// ── CRM → template field prefill ─────────────────────────────────────────────
// Maps our fixed label/id tokens to values pulled from the deal + its property
// and primary contact. Only tokens the template actually declares get sent.
// The canonical token → value map from a deal's context. Field IDs on a
// template that match one of these keys get auto-filled.
export function crmTokenValues({ deal, property, contact, agent } = {}) {
  const money = (n) => (n != null && n !== '' ? `$${Number(n).toLocaleString()}` : '')
  const fullAddr = [property?.address, property?.city, property?.state, property?.zip].filter(Boolean).join(', ')
  return {
    property_address:   property?.address || deal?.prop_address || '',
    property_full:      fullAddr,
    property_city:      property?.city || '',
    property_state:     property?.state || '',
    property_zip:       property?.zip || '',
    list_price:         money(property?.price ?? deal?.value),
    commission_pct:     deal?.commission_pct != null ? `${deal.commission_pct}%` : '',
    listing_start_date: deal?.comp_data?.listing_start || '',
    listing_end_date:   deal?.comp_data?.listing_end || deal?.expected_close_date || '',
    seller_name:        [contact?.first_name, contact?.last_name].filter(Boolean).join(' '),
    client_name:        [contact?.first_name, contact?.last_name].filter(Boolean).join(' '),
    close_date:         deal?.expected_close_date || '',
    agent_name:         agent?.name || '',
    agent_email:        agent?.email || '',
    broker_name:        agent?.brokerage || agent?.broker_name || '',
  }
}

export function buildPrefill(fieldTokens = [], ctx = {}) {
  const source = crmTokenValues(ctx)
  return (fieldTokens || [])
    .map(id => ({ id, value: source[id] }))
    .filter(f => f.value)                          // skip unknown/empty tokens
    .map(f => ({ ...f, isReadOnly: true }))        // CRM-owned values are locked
}

// Role names that should be filled with the deal's client(s) rather than the
// agent. Broad on purpose so generic template roles ("Signer 1") still seed.
const CLIENT_ROLE_RE = /(seller|buyer|client|owner|purchaser|grantor|grantee|landlord|tenant|lessor|lessee|borrower|customer|signer)/

// Pre-fill a template's signer rows from the deal's people:
//   • a role mentioning "agent" → the acting agent (first such role only)
//   • client-type roles → the deal's linked contact, then that contact's
//     spouse for a second client role (co-buyers / husband & wife)
//   • anything else keeps the template's own placeholder (r.defaultName/Email)
// Returns { [roleIndex]: { name, email } }. Pure — the agent can still edit any
// field before sending. Requires the deal to have a linked contact; with none,
// client roles fall back to the template placeholder (usually blank).
export function seedSignersFromDeal({ roles = [], contact = null, additionalContacts = [], activeAgent = null } = {}) {
  const toPerson = c => ({ name: `${c?.first_name || ''} ${c?.last_name || ''}`.trim(), email: c?.email || '' })
  const people = []
  if (contact && (contact.first_name || contact.last_name || contact.email)) people.push(toPerson(contact))
  // Real linked additional contacts (co-buyers / spouses) come next, in order —
  // these carry their own email, unlike the stored spouse_name below.
  for (const c of (additionalContacts || [])) {
    const p = toPerson(c)
    if (p.name || p.email) people.push(p)
  }
  // Fall back to the primary contact's stored spouse name (no email on file)
  // only when no real additional contacts are linked to the deal.
  if (!(additionalContacts || []).length && contact?.spouse_name) people.push({ name: contact.spouse_name, email: '' })
  const out = {}
  let usedAgent = false, personIdx = 0
  for (const r of roles) {
    const n = String(r?.name || '').toLowerCase()
    if (!usedAgent && /agent/.test(n) && activeAgent?.email) {
      out[r.index] = { name: activeAgent.name || '', email: activeAgent.email || '' }
      usedAgent = true
    } else if (CLIENT_ROLE_RE.test(n) && personIdx < people.length) {
      out[r.index] = { ...people[personIdx++] }
    } else {
      out[r.index] = { name: r?.defaultName || '', email: r?.defaultEmail || '' }
    }
  }
  return out
}
