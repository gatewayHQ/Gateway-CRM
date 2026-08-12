// ─────────────────────────────────────────────────────────────────────────────
// BoldSign client service — the single place the browser talks to /api/boldsign.
//
// Every call carries the Supabase access token as a Bearer header; the API's
// requireAgent()/requireAdmin() reject requests without it. Centralizing here
// fixes the class of bug where a caller forgot the token and got a 401.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { describeDealCommission } from '../commission.js'

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
export const remindDocument  = (documentId) => call({ action: 'remind',   documentId })
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

// Field types whose value an agent can pre-fill from the CRM (vs signer actions
// like Signature/Initial). Used to decide which template fields become inputs.
export const FILLABLE_FIELD_TYPES = new Set(['textbox', 'text', 'label', 'dropdown', 'editabledate', 'company', 'name', 'title', 'email'])
export const isFillableField = (t) => FILLABLE_FIELD_TYPES.has(String(t || '').toLowerCase())

// Boxes an agent ticks BEFORE the send — "Exclusive Agency", "Seller pays",
// "Cash offer". These were not offered anywhere in the CRM, so the only way to
// set one was inside BoldSign's own editor, where a sender's tick is a
// placement-time preview and NOT a value the signer inherits: the agent saw the
// box checked, sent it, and the client opened an unchecked form. Ticked here they
// travel as real field values, and (like every other CRM-supplied value) they go
// out read-only, so what the agent decided is what every signer sees and none of
// them can change it after the send.
export const TICKABLE_FIELD_TYPES = new Set(['checkbox', 'radiobutton', 'radio'])
export const isTickableField = (t) => TICKABLE_FIELD_TYPES.has(String(t || '').toLowerCase())

// Every field an agent can set a value for before sending.
export const isPrefillableField = (t) => isFillableField(t) || isTickableField(t)

// ── Shared (Label) fields vs signer-specific fields ──────────────────────────
// READ THIS BEFORE CHANGING HOW PREFILLED VALUES ARE ROUTED.
//
// BoldSign's default is that a form field assigned to a role is visible ONLY to
// that role's signer, and only becomes visible to the other recipients once that
// signer has finished signing. For a signer's OWN input that is correct. For
// prefilled deal data — the address, the price, the commission, the dates, the
// reference number — it is exactly wrong: the co-buyer who opens the packet
// first sees blanks wherever the listing agent's fields sit, and cannot read the
// document as a whole until somebody else signs.
//
// BoldSign's answer is the LABEL field. A Label is a COMMON field:
//   • every signer sees it the moment the document is sent, in any signing order;
//   • no signer can edit it — it is read-only by construction;
//   • its value is supplied at send time via `existingFormFields`, on ONE role
//     (we use the first filled one), because it is not scoped to a role at all.
// See https://support.boldsign.com/kb/article/19096/prefill-form-fields-to-be-visible-to-both-signers-when-using-templates-via-api
//
// The rule for template authors: anything every party must be able to read
// immediately goes in the template as a **Label**, never as a Textbox/Name/Email
// assigned to a role. The rule for this code: every Label value is routed to the
// first filled role's `existingFormFields`, whatever roleIndex the template
// happens to carry on it. `buildPrefillFields()` below is the only place that
// decides, and `sharedDataOnSignerFields()` reports templates that still put
// shared data on a role-scoped field so the template can be fixed.
export const SHARED_FIELD_TYPES = new Set(['label'])
export const isSharedField = (t) => SHARED_FIELD_TYPES.has(String(t || '').toLowerCase())

// Split a template's fields into the two groups that behave differently at send
// time, so callers never have to re-derive the distinction:
//   • shared         — Label fields. One shared copy, visible to everyone at once.
//   • signerSpecific — role-scoped fields (Textbox, CheckBox, Name, Email, …).
//                      Only the assigned signer sees them until they sign.
// Fields with no id, and signer actions like Signature/Initial, are dropped:
// there is nothing to prefill.
export function partitionPrefillFields(fields = []) {
  const shared = []
  const signerSpecific = []
  for (const f of (fields || [])) {
    if (!f?.id || !isPrefillableField(f.type)) continue
    if (isSharedField(f.type)) shared.push(f)
    else signerSpecific.push(f)
  }
  return { shared, signerSpecific }
}

// Every CRM token describes the DEAL, not one signer's private input — the
// address, the price, the commission, the dates, the parties' own names. All of
// it is information each party is signing up to, so all of it must be legible to
// all of them from the moment the packet lands. Derived from crmTokenValues() so
// a new token is covered the day it is added.
export const SHARED_PREFILL_TOKENS = new Set(Object.keys(crmTokenValues()))

// Build the `existingFormFields` payload for a send, with Label values pulled out
// of the per-role lists and onto one shared list.
//
//   fields            — the template's fields (from `template-details`)
//   values            — fieldId → what the agent entered (text, or true/false/null)
//   filledRoleIndices — ORIGINAL template indices of the roles that have a signer
//   anchorRoleIndex   — which of those carries the shared values; defaults to the
//                       first, which is the convention in BoldSign's own docs
//
// Returns:
//   sharedFormFields — Label entries, for ONE role. Visible to every signer
//                      immediately, editable by none.
//   byRole           — { originalRoleIndex: entries[] } for the role-scoped
//                      fields, keyed by ORIGINAL index (buildTemplateRoles applies
//                      BoldSign's post-removal index shift afterwards).
//   sharedIds / signerScopedIds — what landed where, for the UI and for tests.
export function buildPrefillFields({ fields = [], values = {}, filledRoleIndices = [], anchorRoleIndex = null } = {}) {
  const filled = (filledRoleIndices || []).map(Number).filter(Number.isFinite)
  const anchor = filled.includes(Number(anchorRoleIndex)) ? Number(anchorRoleIndex) : filled[0]

  const sharedFormFields = []
  const byRole = {}
  const sharedIds = []
  const signerScopedIds = []

  // No signer, no send: there is no role for BoldSign to hang either list on, so
  // returning half a payload would only make an impossible send look prepared.
  if (anchor == null) return { sharedFormFields, byRole, sharedIds, signerScopedIds, anchorRoleIndex: null }

  for (const f of (fields || [])) {
    // prefillFieldEntry decides what (if anything) this field contributes: text
    // when the agent typed something, "true"/"false" for a box they ticked or
    // deliberately cleared, nothing at all when it is left to the signer. Every
    // entry it returns is read-only.
    const entry = prefillFieldEntry(f, values?.[f?.id])
    if (!entry) continue

    if (isSharedField(f.type)) {
      // A Label is common to the whole document. Its template roleIndex is
      // irrelevant — sending it on one role is what makes it visible to all.
      sharedFormFields.push(entry)
      sharedIds.push(entry.id)
      continue
    }

    // Role-scoped. Keep it on its own signer where the template says so; fall
    // back to the anchor role when the field names no role, or names one that
    // this send is dropping.
    const owner = (f.roleIndex && filled.includes(Number(f.roleIndex))) ? Number(f.roleIndex) : anchor
    if (owner == null) continue
    ;(byRole[owner] ||= []).push(entry)
    signerScopedIds.push(entry.id)
  }

  return { sharedFormFields, byRole, sharedIds, signerScopedIds, anchorRoleIndex: anchor ?? null }
}

// Templates the CRM cannot fix by itself: a field carrying shared deal data
// (a CRM token) that is NOT a Label, so BoldSign will hide it from everyone
// except its assigned signer until that signer is done. Returns the offending
// fields so the send modal can name them and an admin can convert them to Labels
// in the template. Empty is the healthy state.
export function sharedDataOnSignerFields({ fields = [], values = {} } = {}) {
  return (fields || []).filter(f => (
    f?.id
    && !isSharedField(f.type)
    && isCrmToken(f.id)
    && Boolean(prefillFieldEntry(f, values?.[f.id]))
  ))
}

// BoldSign wants a checkbox value as the string "true"/"false".
export const tickValue = (on) => (on ? 'true' : 'false')

// One field's contribution to a role's `existingFormFields`, or null when the
// agent left it for the signer to fill.
//
// A tickable field is three-state on purpose: unticked and "signer decides" are
// different instructions, and collapsing them would either lock every box the
// agent didn't touch or lose the deliberate "no" on a form where an unticked box
// is itself a term.
export function prefillFieldEntry(field, value) {
  const id = field?.id
  if (!id) return null
  if (isTickableField(field?.type)) {
    if (value !== true && value !== false) return null      // left to the signer
    return { id, value: tickValue(value), isReadOnly: true }
  }
  const v = String(value ?? '').trim()
  if (!v) return null
  return { id, value: v, isReadOnly: true }
}

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

// ── Template send payload ────────────────────────────────────────────────────
// Build BoldSign's `roles` array + `roleRemovalIndices` for a template send,
// from the roles the agent actually filled in.
//
// THE INDEX SHIFT. BoldSign applies roleRemovalIndices FIRST and then expects
// each supplied role's `roleIndex` to be its position in the REMAINING list —
// not its original index in the template. Observed directly:
//
//   roles [1,2]   + removals [3,4,5] → accepted  (nothing removed below 1 or 2)
//   roles [1,2,4] + removals [3,5]   → rejected: "SignerName or SignerEmail is
//                                      missing in roles"
//
// In the second case role 3 is dropped, so only three roles remain and index 4
// addresses nothing — the third remaining role ends up with no signer, which is
// exactly what BoldSign complains about. The bug only became reachable once a
// co-agent started being seeded into a middle role, leaving an interior gap.
//
// So: removal indices stay in the template's ORIGINAL numbering (that's how
// BoldSign identifies what to drop), while each surviving role's index is
// shifted down by the number of removed roles below it.
//
//   roles [1,2,4] + removals [3,5] → roles [1,2,3] + removals [3,5]
//
// Roles before the first removal keep their number, so a payload that works
// today is unchanged — the shift only affects the shape that currently fails.
//
// `fieldsByRole` is keyed by ORIGINAL role index (template field metadata is
// unaffected by removal), and is looked up before the shift is applied.
//
// `fieldsByRole` carries ONLY role-scoped fields — never Label values. A Label is
// common to the document rather than owned by a signer, so it travels as the
// send's top-level `sharedFormFields` and the API attaches it to the first role
// (see buildPrefillFields above and mergeSharedFormFields in api/boldsign.js).
export function buildTemplateRoles({ roleList = [], signers = {}, fieldsByRole = {}, inOrder = false } = {}) {
  const value = (idx, key) => String(signers?.[idx]?.[key] || '').trim()
  const filled = roleList.filter(r => value(r.index, 'name') && value(r.index, 'email'))
  const removed = roleList
    .filter(r => !filled.includes(r))
    .map(r => r.index)
    .sort((a, b) => a - b)

  const shift = (idx) => idx - removed.filter(x => x < idx).length

  const roles = filled.map((r, i) => ({
    roleIndex:    shift(r.index),
    signerName:   value(r.index, 'name'),
    signerEmail:  value(r.index, 'email'),
    // Equal signerOrder → BoldSign notifies everyone at once. Ascending → each
    // signer waits for the one before them.
    signerOrder:  inOrder ? i + 1 : 1,
    existingFormFields: fieldsByRole?.[r.index] || [],
  }))

  return { roles, roleRemovalIndices: removed, filledCount: filled.length }
}

// ── CRM → template field prefill ─────────────────────────────────────────────
// The people on the client side of a deal, in the order they belong on the
// agreement: the primary contact, then any Additional Contacts (co-buyer,
// spouse, co-owner), then — only when no real additional contact is linked —
// the primary contact's stored spouse name, which has no email of its own.
//
// Shared by seedSignersFromDeal() (who signs) and crmTokenValues() (whose names
// are printed in the body), so the signature rows and the parties clause can
// never disagree about who the clients are.
export function dealClientList({ contact, additionalContacts = [] } = {}) {
  const toPerson = c => ({ name: `${c?.first_name || ''} ${c?.last_name || ''}`.trim(), email: c?.email || '' })
  const people = []
  if (contact && (contact.first_name || contact.last_name || contact.email)) people.push(toPerson(contact))
  for (const c of (additionalContacts || [])) {
    const p = toPerson(c)
    if (p.name || p.email) people.push(p)
  }
  if (!(additionalContacts || []).length && contact?.spouse_name) people.push({ name: contact.spouse_name, email: '' })
  return people
}

// "Jane Doe" · "Jane Doe and John Doe" · "Jane Doe, John Doe and Acme LLC" —
// how a parties clause reads, rather than a comma-joined list.
export function joinNames(names = []) {
  const list = (names || []).map(n => String(n || '').trim()).filter(Boolean)
  if (list.length <= 1) return list[0] || ''
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

// The agent whose name belongs IN THE BODY of the agreement — the appointed
// agent, the listing agent — which is not always whoever clicked Send.
//
// This mirrors orderAgentSigners(), the rule the signer rows already follow: the
// acting agent only when they are actually on the deal, otherwise the deal's own
// first agent. Before this, `agent_name` was hard-wired to the acting agent, so
// an admin or transaction coordinator sending a packet on an agent's behalf
// printed THEIR name into the agreement — on an Appointed Agency form, that is a
// licensing statement about the wrong person — while the signature row three
// inches below correctly named the agent. Same question, two answers.
export function appointedAgent({ activeAgent = null, dealAgents = [] } = {}) {
  const key    = (a) => String(a?.email || a?.name || '').toLowerCase()
  const list   = (dealAgents || []).filter(a => a?.name || a?.email)
  const acting = (activeAgent?.name || activeAgent?.email) ? activeAgent : null
  if (!list.length) return acting
  if (acting && list.some(a => key(a) === key(acting))) return acting
  return list[0]
}

// Maps our fixed label/id tokens to values pulled from the deal + its property
// and primary contact. Only tokens the template actually declares get sent.
// The canonical token → value map from a deal's context. Field IDs on a
// template that match one of these keys get auto-filled.
export function crmTokenValues({ deal, property, contact, additionalContacts = [], agent } = {}) {
  const money = (n) => (n != null && n !== '' ? `$${Number(n).toLocaleString()}` : '')
  const fullAddr = [property?.address, property?.city, property?.state, property?.zip].filter(Boolean).join(', ')
  const dealComm = describeDealCommission(deal)
  const clients  = dealClientList({ contact, additionalContacts })
  return {
    property_address:   property?.address || deal?.prop_address || '',
    property_full:      fullAddr,
    property_city:      property?.city || '',
    property_state:     property?.state || '',
    property_zip:       property?.zip || '',
    list_price:         money(property?.price ?? deal?.value),
    // The agent's commission entry (deal Details tab). `commission_pct` stays
    // percentage-only — a flat-fee deal has no rate to print on the agreement —
    // while `commission_amount` is the dollar figure either way.
    commission_pct:     dealComm && dealComm.type === 'percent' ? `${dealComm.pct}%` : '',
    commission_amount:  dealComm ? money(dealComm.gross) : '',
    listing_start_date: deal?.comp_data?.listing_start || '',
    listing_end_date:   deal?.comp_data?.listing_end || deal?.expected_close_date || '',
    // The PRIMARY contact alone. A form with one signature line for "Client"
    // still wants one name.
    seller_name:        clients[0]?.name || '',
    client_name:        clients[0]?.name || '',
    // EVERY client, as a parties clause reads: "Jane Doe and John Doe". This is
    // the one to use on the "entered into by and between ______" line of an
    // agency agreement, where naming only the primary buyer misstates who is
    // bound by it.
    client_names:       joinNames(clients.map(c => c.name)),
    seller_names:       joinNames(clients.map(c => c.name)),
    // The co-buyer / spouse / co-owner on their own, for forms with a second
    // named line rather than one combined one.
    client_2_name:      clients[1]?.name || '',
    seller_2_name:      clients[1]?.name || '',
    close_date:         deal?.expected_close_date || '',
    // The deal's agent, NOT necessarily the sender — see appointedAgent().
    agent_name:         agent?.name || '',
    agent_email:        agent?.email || '',
    // No brokerage is stored on an agent today, so this is effectively always
    // blank: put the firm name in the template as fixed text instead.
    broker_name:        agent?.brokerage || agent?.broker_name || '',
  }
}

// Template field ids are typed by hand in BoldSign's editor, where `Agent_Name`,
// `agent_name` and `AGENT_NAME` all look like the same thing — and a mismatch
// fails silently as an empty box the agent has to retype on every send. Match
// case-insensitively so the id only has to be spelled right, not cased right.
export function tokenValueFor(tokenVals, fieldId) {
  if (!fieldId) return ''
  const direct = tokenVals?.[fieldId]
  if (direct) return direct
  const want = String(fieldId).trim().toLowerCase()
  for (const [k, v] of Object.entries(tokenVals || {})) {
    if (k.toLowerCase() === want) return v
  }
  return ''
}

// Is this field id one of ours, whatever its casing? Used to spot shared deal
// data sitting on a signer-private field.
export const isCrmToken = (fieldId) =>
  Boolean(fieldId) && SHARED_PREFILL_TOKENS.has(String(fieldId).trim().toLowerCase())

// Role names that should be filled with the deal's client(s) rather than an
// agent. Broad on purpose so generic template roles ("Signer 1") still seed.
const CLIENT_ROLE_RE = /(seller|buyer|client|owner|purchaser|grantor|grantee|landlord|tenant|lessor|lessee|borrower|customer|signer)/

// Roles filled from the AGENTS on the deal.
const AGENT_ROLE_RE = /(agent|broker|realtor)/

// Roles that must NEVER be seeded with a client, even when CLIENT_ROLE_RE
// matches them. This exists because CLIENT_ROLE_RE is substring-based and
// several professional roles contain a client keyword — most importantly
// "Buyer's Agent", which matches /buyer/. Before this guard, a template whose
// roles ran [Seller, Listing Agent, Buyer's Agent] seeded the CO-BUYER'S name
// and email into the buyer's-agent signature slot: the acting agent consumed
// the first agent role, so the second one fell through to the client branch.
// The row arrived pre-filled and plausible, and sending it asked a client to
// sign as their own agent. Worse, it was order-dependent — the same three roles
// in a different order behaved correctly, so it wouldn't reproduce reliably.
// A blank row is always the safer failure here.
const NON_CLIENT_ROLE_RE = /(agent|broker|realtor|attorney|escrow|title|lender|notary|witness)/

// The agents on a deal, in the order they should fill agent roles. Mirrors the
// "Agents on deal" card (src/pages/DealPage.jsx) so the send modal seeds exactly
// the people the deal page shows: primary agent, then legacy co_agent_ids, then
// commission participants, deduped.
//
// participantAgentIds is passed separately because commissions are admin-only
// under RLS — a non-admin simply gets [] for it and sees owner + co_agent_ids,
// which is the same thing the deal page shows them.
export function dealAgentList({ deal, agents = [], participantAgentIds = [] } = {}) {
  const ids = [deal?.agent_id, ...(deal?.co_agent_ids || []), ...(participantAgentIds || [])].filter(Boolean)
  const seen = new Set()
  const out  = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const a = (agents || []).find(x => x?.id === id)
    if (a && (a.name || a.email)) out.push({ id: a.id, name: a.name || '', email: a.email || '' })
  }
  return out
}

// Order the agent-side people for filling agent roles: the acting agent first
// when they are actually on the deal, then everyone else on it.
//
// When the acting agent is NOT on the deal — an admin or transaction coordinator
// sending on an agent's behalf — the deal's own agents fill the roles instead.
// The listing agent should sign the listing agreement, not the coordinator who
// happened to click Send.
export function orderAgentSigners({ activeAgent = null, dealAgents = [] } = {}) {
  const norm = (a) => ({ name: a?.name || '', email: a?.email || '' })
  const key  = (a) => String(a.email || a.name).toLowerCase()
  const list = (dealAgents || []).map(norm).filter(a => a.name || a.email)
  const acting = activeAgent && (activeAgent.name || activeAgent.email) ? norm(activeAgent) : null

  if (!list.length) return acting ? [acting] : []
  if (acting && list.some(a => key(a) === key(acting))) {
    return [acting, ...list.filter(a => key(a) !== key(acting))]
  }
  return list
}

// Pre-fill a template's signer rows from the deal's people:
//   • agent/broker/realtor roles → the agents ON THE DEAL, in order (see
//     orderAgentSigners). A co-listing agent fills the second agent role
//     instead of being left blank for the sender to type out every send.
//   • client-type roles → the deal's linked contact, then any additional
//     contacts, then that contact's stored spouse name (co-buyers / husband
//     & wife)
//   • anything else — and any professional role with no agent left to assign —
//     keeps the template's own placeholder (r.defaultName/Email)
// Returns { [roleIndex]: { name, email } }. Pure — the agent can still edit any
// field before sending. Requires the deal to have a linked contact; with none,
// client roles fall back to the template placeholder (usually blank).
export function seedSignersFromDeal({ roles = [], contact = null, additionalContacts = [], activeAgent = null, dealAgents = [] } = {}) {
  // Primary contact, then Additional Contacts (each with their own email), then
  // the stored spouse name as a last resort — see dealClientList, which the
  // printed `client_names` token also uses so the two never disagree.
  const people = dealClientList({ contact, additionalContacts })
  const agentSigners = orderAgentSigners({ activeAgent, dealAgents })

  const out = {}
  const placeholder = (r) => ({ name: r?.defaultName || '', email: r?.defaultEmail || '' })
  let personIdx = 0, agentIdx = 0
  for (const r of roles) {
    const n = String(r?.name || '').toLowerCase()
    if (AGENT_ROLE_RE.test(n)) {
      // Agent roles are only ever filled from the deal's agents. Falling through
      // to the client branch is what put a client's email in an agent's slot.
      const a = agentSigners[agentIdx]
      out[r.index] = a ? { name: a.name, email: a.email } : placeholder(r)
      if (a) agentIdx++
    } else if (!NON_CLIENT_ROLE_RE.test(n) && CLIENT_ROLE_RE.test(n) && personIdx < people.length) {
      out[r.index] = { ...people[personIdx++] }
    } else {
      out[r.index] = placeholder(r)
    }
  }
  return out
}
