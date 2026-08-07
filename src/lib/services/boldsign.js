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
export const sendDocument     = (p)          => call({ action: 'send', ...p })
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
// A printable copy of the document as it stands right now — the pages BoldSign
// holds plus an appended signing summary (who signs what, on which page). Resolves
// { url, filename, fieldCount }: a short-lived signed storage URL, never base64,
// because a serverless response caps at 4.5 MB and a scanned packet exceeds it.
export const documentPrintUrl = (documentId) => call({ action: 'document-print', documentId })
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
// Maps our fixed label/id tokens to values pulled from the deal + its property
// and primary contact. Only tokens the template actually declares get sent.
// The canonical token → value map from a deal's context. Field IDs on a
// template that match one of these keys get auto-filled.
export function crmTokenValues({ deal, property, contact, agent } = {}) {
  const money = (n) => (n != null && n !== '' ? `$${Number(n).toLocaleString()}` : '')
  const fullAddr = [property?.address, property?.city, property?.state, property?.zip].filter(Boolean).join(', ')
  const dealComm = describeDealCommission(deal)
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
