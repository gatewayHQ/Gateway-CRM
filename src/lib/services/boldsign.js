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
export const sendDocument     = (p)          => call({ action: 'send', ...p })
export const documentEmbedUrl = (p)          => call({ action: 'document-embed-url', ...p })
export const signLink         = (p)          => call({ action: 'sign-link', ...p })
export const getDocStatus    = (documentId) => call({ action: 'status',   documentId })
export const downloadSigned  = (documentId) => call({ action: 'download', documentId })
export const downloadAudit   = (documentId) => call({ action: 'audit-download', documentId })
export const remindDocument  = (documentId) => call({ action: 'remind',   documentId })
export const deleteDocument  = (documentId) => call({ action: 'document-delete', documentId })
export const debugBoldsign   = ()           => call({ action: 'debug' })

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

// Which Form Library rows are actually sendable for e-signature: an entry
// qualifies once it carries a BoldSign template id and hasn't been deactivated.
//
// Callers pass raw `select('*')` rows on purpose. Naming the post-unification
// columns (boldsign_template_id / doc_type / field_tokens / active) in the
// select makes the whole query fail with 42703 on an install that hasn't run
// migration 0019 yet — which silently emptied the template list and hid the
// Send-from-Template button. Reading everything and filtering here can't fail
// that way. `active` is treated as true when the column/value is missing so a
// pre-0019 row still shows up. Also accepts rows from the retired
// `boldsign_templates` registry, which named the column `template_id`.
export function sendableTemplates(rows = []) {
  return (rows || [])
    .filter(r => r && r.active !== false && String(r.boldsign_template_id || r.template_id || '').trim())
    .map(r => ({
      template_id:  String(r.boldsign_template_id || r.template_id).trim(),
      name:         r.name || r.template_name || 'Untitled template',
      state:        r.state || '',
      doc_type:     r.doc_type || '',
      field_tokens: Array.isArray(r.field_tokens) ? r.field_tokens : [],
      source:       'library',
    }))
    .filter((t, i, all) => all.findIndex(o => o.template_id === t.template_id) === i)
    .sort((a, b) => a.name.localeCompare(b.name))
}

// Same shape, built from a raw BoldSign `/template/list` payload. Used as a
// fallback when the CRM catalog has nothing registered, so an agent can still
// send from a template that exists in BoldSign. Field names vary across BoldSign
// responses (templateId/documentId, templateName/documentName), hence the
// tolerant reads. No state/doc_type — those live only in the CRM catalog.
export function normalizeBoldsignTemplates(items = []) {
  return (items || [])
    .map(t => ({
      template_id:  String(t?.templateId || t?.documentId || t?.id || '').trim(),
      name:         t?.templateName || t?.documentName || t?.messageTitle || t?.name || 'Untitled template',
      state:        '',
      doc_type:     '',
      field_tokens: [],
      source:       'boldsign',
    }))
    .filter(t => t.template_id)
    .filter((t, i, all) => all.findIndex(o => o.template_id === t.template_id) === i)
    .sort((a, b) => a.name.localeCompare(b.name))
}

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
// The deal's gross commission rate, wherever it was entered: the admin's
// commissions row (passed in as deal.commission), the agent's own entry in
// comp_data, or a legacy column on the deal.
export function commissionRate(deal) {
  const candidates = [deal?.commission?.gross_pct, deal?.comp_data?.commission_pct, deal?.commission_pct]
  for (const c of candidates) {
    const n = Number(c)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

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
    // There is no deals.commission_pct column — the rate lives on the admin's
    // commissions row (back-office) or, when an agent entered it, in comp_data.
    // Reading only the column meant this token always came out blank.
    commission_pct:     commissionRate(deal) != null ? `${commissionRate(deal)}%` : '',
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
const CLIENT_ROLE_RE = /(seller|buyer|client|owner|purchaser|grantor|grantee|landlord|tenant|lessor|lessee|borrower|customer|signer|party)/

// Which side of the transaction a role belongs to, and whether it's a licensee
// row or a client row. "Broker" is deliberately NOT an agent keyword — that row
// is usually the broker of record, not the agent working the deal.
const BUYER_SIDE_RE  = /(buyer|purchaser|grantee|tenant|lessee|borrower)/
const SELLER_SIDE_RE = /(seller|owner|grantor|landlord|lessor)/
const AGENT_ROLE_RE  = /(agent|realtor)/

// party: 'agent' | 'client' | 'other'   side: 'buyer' | 'seller' | '' (either)
export function roleKind(name) {
  const n    = String(name || '').toLowerCase()
  const side = BUYER_SIDE_RE.test(n) ? 'buyer' : SELLER_SIDE_RE.test(n) ? 'seller' : ''
  if (AGENT_ROLE_RE.test(n))            return { party: 'agent',  side }
  if (side || CLIENT_ROLE_RE.test(n))   return { party: 'client', side }
  return { party: 'other', side: '' }
}

// Every licensee on the deal, in signing order: the deal's own agent first, then
// co-agents. Co-agents live on the linked property (`details.co_agent_ids`,
// set by the Properties drawer) — a deal-level `co_agent_ids` array is also
// honored for legacy rows. `activeAgent` is only a fallback for a deal with no
// agent set, so an admin opening someone else's deal doesn't replace the agent
// of record on the paperwork.
//
// Pure: resolves ids against the `agents` roster already loaded by the page —
// no extra query, so the co-agent simply appears with no UI to fill in.
export function resolveDealAgents({ deal = null, property = null, agents = [], activeAgent = null } = {}) {
  const byId = new Map((agents || []).filter(a => a?.id).map(a => [a.id, a]))
  const ids  = [
    deal?.agent_id,
    ...(property?.details?.co_agent_ids || []),
    ...(deal?.co_agent_ids || []),
  ].filter(Boolean)

  const out  = []
  const seen = new Set()
  const push = (a) => {
    if (!a) return
    const key = (a.email || a.name || '').toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ id: a.id, name: a.name || '', email: a.email || '' })
  }
  for (const id of [...new Set(ids)]) push(byId.get(id))
  if (!out.length) push(activeAgent)
  return out
}

// The deal's side of the transaction, used to route people to the matching
// template roles. Set on the Details tab (comp_data.transaction_type).
export const dealSide = (deal) => {
  const t = String(deal?.comp_data?.transaction_type || '').toLowerCase()
  return t === 'buyer' || t === 'seller' ? t : ''
}

// The deal's client-side signers in order: primary contact, linked additional
// contacts (co-buyers / spouses, each with their own email), then the primary's
// stored spouse_name as a last resort (name only — no email on file).
export function dealClientSigners({ contact = null, additionalContacts = [] } = {}) {
  const toPerson = c => ({ name: `${c?.first_name || ''} ${c?.last_name || ''}`.trim(), email: c?.email || '' })
  const people = []
  const seen   = new Set()
  const push = (p) => {
    if (!p.name && !p.email) return
    const key = (p.email || p.name).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    people.push(p)
  }
  if (contact) push(toPerson(contact))
  for (const c of (additionalContacts || [])) push(toPerson(c))
  if (!(additionalContacts || []).length && contact?.spouse_name) push({ name: contact.spouse_name, email: '' })
  return people
}

// Pre-fill a template's signer rows from everyone the CRM already knows about:
//   • agent-type roles → the deal's agent, then each co-agent, in order
//   • client-type roles → the primary contact, then each additional contact
//     (co-buyer / spouse), in order
//   • anything else keeps the template's own placeholder (r.defaultName/Email)
//
// When the deal's side is known (`side` — comp_data.transaction_type), people
// fill the roles on THEIR side first and generic roles second, and never the
// opposite side: a buyer-side deal must not drop the buyer into the template's
// Seller row. With no side on the deal, every client/agent role is eligible in
// template order (the pre-side behavior).
//
// Returns { [roleIndex]: { name, email } }. Pure — the agent can still edit any
// row before sending, and rows left blank are removed from the send.
export function seedSignersFromDeal({
  roles = [], contact = null, additionalContacts = [],
  activeAgent = null, agents = [], side = '',
} = {}) {
  const clients = dealClientSigners({ contact, additionalContacts })
  const licensees = ((agents || []).length ? agents : (activeAgent ? [activeAgent] : []))
    .filter(Boolean)
    .map(a => ({ name: a.name || '', email: a.email || '' }))
    .filter(a => a.name || a.email)

  const kinds = roles.map(r => ({ r, ...roleKind(r?.name) }))
  const out   = {}
  for (const { r } of kinds) out[r.index] = { name: r?.defaultName || '', email: r?.defaultEmail || '' }

  const fill = (party, queue) => {
    // Our side first, then side-agnostic roles ("Signer 1", "Listing Agent" on a
    // buyer deal); opposite-side roles are never auto-filled when we know the side.
    const eligible = side
      ? [...kinds.filter(k => k.party === party && k.side === side),
         ...kinds.filter(k => k.party === party && !k.side)]
      : kinds.filter(k => k.party === party)
    for (const k of eligible) {
      if (!queue.length) return
      out[k.r.index] = queue.shift()
    }
  }
  fill('agent',  [...licensees])
  fill('client', [...clients])
  return out
}
