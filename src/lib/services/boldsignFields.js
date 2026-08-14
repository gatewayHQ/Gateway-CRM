// ─────────────────────────────────────────────────────────────────────────────
// BoldSign field model — PURE. No network, no Supabase, no browser globals.
//
// Split out of boldsign.js so the same rules can run in three places:
//   • the browser (the send modal, via boldsign.js which re-exports all of this);
//   • Node scripts — scripts/audit-boldsign-templates.mjs sweeps every template
//     in the account for the defects below;
//   • anything server-side that needs to classify a field the same way.
// boldsign.js imports the Supabase browser client, which a plain `node` process
// cannot load, and that was the only thing keeping these rules unreachable
// outside the app.
//
// Everything here is a pure function of its arguments. The rules it encodes are
// BoldSign's, not ours — see docs/boldsign-integration.md, "Prefilled data every
// signer must see".
// ─────────────────────────────────────────────────────────────────────────────
import { describeDealCommission } from '../commission.js'

// Field types whose value an agent can pre-fill from the CRM (vs signer actions
// like Signature/Initial). Used to decide which template fields become inputs.
//
// `name` is NOT here, and that is the point of SIGNER_BOUND_FIELD_TYPES below.
export const FILLABLE_FIELD_TYPES = new Set(['textbox', 'text', 'label', 'dropdown', 'editabledate', 'company', 'title', 'email'])
export const isFillableField = (t) => FILLABLE_FIELD_TYPES.has(String(t || '').toLowerCase())

// ── Fields bound to the signer's own identity ────────────────────────────────
// A BoldSign **Name** field always renders the name of the signer it is assigned
// to. A value supplied for it in `existingFormFields` does NOT override that —
// BoldSign accepts the value and then ignores it. (Confirmed by BoldSign support.)
//
// That makes a Name field the worst possible home for a name that is not the
// assigned signer's own, because it fails SILENTLY and PLAUSIBLY: the send screen
// showed "Alex Agent" in the box, the payload carried it, BoldSign returned 200 —
// and the document reached the client with the SELLER's name printed on the
// appointed-agent line, because that is the role the field sat on. Nothing
// anywhere reported a problem. A blank would have been better; a wrong name on a
// licensing statement is the failure this set exists to make impossible.
//
// So a Name field is never prefilled (prefillFieldEntry returns null for one) and
// never offered as an input. Where a name other than the signer's own has to
// appear, the template needs a **Label** — see SHARED_FIELD_TYPES below.
// `signerBoundPrefillFields()` reports the templates that still get this wrong.
//
// Scope note: only `name` is listed. BoldSign's Email/Company/Title fields also
// seed from the signer's details, but support confirmed the override rule for
// Name specifically, so only Name is enforced here rather than guessed at.
export const SIGNER_BOUND_FIELD_TYPES = new Set(['name'])
export const isSignerBoundField = (t) => SIGNER_BOUND_FIELD_TYPES.has(String(t || '').toLowerCase())

// Boxes an agent ticks BEFORE the send — "Exclusive Agency", "Seller pays",
// "Cash offer". These were not offered anywhere in the CRM, so the only way to
// set one was inside BoldSign's own editor, where a sender's tick is a
// placement-time preview and NOT a value the signer inherits: the agent saw the
// box checked, sent it, and the client opened an unchecked form. Ticked here they
// travel as real field values, and (like every other CRM-supplied value) they go
// out read-only, so none of the signers can change what the agent decided.
//
// Read-only is NOT the same as visible, though. A CheckBox is a role-scoped
// field: read-only stops the assigned signer editing it, but the OTHER signers
// still cannot see it until that signer's turn comes. A box we tick is a term of
// the agreement rather than one signer's input, so where every party must see it
// straight away the template needs a Label instead — sharedDataOnSignerFields()
// reports the ones that would be hidden.
export const TICKABLE_FIELD_TYPES = new Set(['checkbox', 'radiobutton', 'radio'])
export const isTickableField = (t) => TICKABLE_FIELD_TYPES.has(String(t || '').toLowerCase())

// Every field the send screen discovers. Signer-bound types are included so they
// can be REPORTED (see signerBoundPrefillFields) — dropping them here would hide
// a misused Name field rather than fix it — but prefillFieldEntry still refuses
// to send a value for one.
export const isPrefillableField = (t) => isFillableField(t) || isTickableField(t) || isSignerBoundField(t)

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

// Split a template's fields into the three groups that behave differently at send
// time, so callers never have to re-derive the distinction:
//   • shared         — Label fields. One shared copy, visible to everyone at once.
//   • signerSpecific — role-scoped fields (Textbox, CheckBox, Email, …). Only the
//                      assigned signer sees them until they sign.
//   • signerBound    — Name fields. Not prefillable at all: BoldSign prints the
//                      assigned signer's own name and discards anything we send.
// Fields with no id, and signer actions like Signature/Initial, are dropped:
// there is nothing to prefill.
export function partitionPrefillFields(fields = []) {
  const shared = []
  const signerSpecific = []
  const signerBound = []
  for (const f of (fields || [])) {
    if (!f?.id || !isPrefillableField(f.type)) continue
    if (isSharedField(f.type))           shared.push(f)
    else if (isSignerBoundField(f.type)) signerBound.push(f)
    else                                 signerSpecific.push(f)
  }
  return { shared, signerSpecific, signerBound }
}

// Name fields a template is using to display something OTHER than the assigned
// signer's own name — the misuse that cannot be fixed from the send payload,
// because BoldSign discards the value rather than rejecting it.
//
// A field counts when either:
//   • it carries a CRM token (`agent_name`, `client_names`, `seller_2_name` …),
//     which says outright that it was meant to print a specific person; or
//   • the agent typed something into it on the send screen.
// A Name field with no token and no value is the legitimate case — the signer's
// own name, auto-filled by BoldSign — and is not reported.
//
// Empty is the healthy state. Anything returned needs the TEMPLATE changed:
// delete the Name field and place a **Label** in the same spot (BoldSign cannot
// change a placed field's type in the editor), then give the Label the CRM token
// as its name so it prefills. A Label is also visible to every signer at once,
// which a Name field assigned to one role never was.
export function signerBoundPrefillFields({ fields = [], values = {} } = {}) {
  return (fields || []).filter(f => {
    if (!f?.id || !isSignerBoundField(f.type)) return false
    return Boolean(String(values?.[f.id] ?? '').trim()) || isCrmToken(f)
  })
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

// Values WE supply that some party will NOT be able to see when they open the
// document. Returns the offending fields so the send modal can name them; empty
// is the healthy state.
//
// "Values we supply" is everything the sender decided rather than the signer:
// CRM deal data, anything the agent typed on the send screen, and — the case
// this used to miss entirely — a checkbox the agent pre-ticked. A pre-selected
// box is a TERM of the agreement, not the signer's own input, so "Exclusive
// Agency" ticked by us and sitting on the agent's role is exactly as invisible
// to the seller as a hidden price would be, and every bit as material. It was
// never reported because the old gate only looked at fields carrying a CRM
// token, and no checkbox ever does.
//
// There are two ways to get this right, and this only complains when neither
// holds:
//
//   1. A **Label**. Common to the document, visible to everyone from the moment
//      it is sent, in any order. Always fine, and always the safe answer.
//   2. A role-scoped field **assigned to the first signer, on an in-order send**.
//      BoldSign reveals a signer's fields to the remaining recipients once that
//      signer completes, so if the client signs first and carries the prefilled
//      details, everyone downstream sees them at the moment they are asked to
//      sign. This is the pattern our templates actually use — the data sits on
//      the buyer's role, read-only — and flagging it would train agents to
//      ignore the warning that matters. It only holds while the order is fixed:
//      it is NOT a substitute for a Label where the value must be legible to
//      everyone regardless of who signs when.
//
// So what is left is genuinely broken: a supplied value on a signer who is NOT
// first (nobody ahead of them sees it), or any role-scoped prefill on a parallel
// send (everyone opens at once, so nobody sees anybody else's fields).
//
// Name fields are not judged here — nothing we supply reaches them at all, which
// is a louder problem reported separately by signerBoundPrefillFields().
//
// A field naming no role rides on the anchor role, which is the first signer —
// so it is judged as if it were assigned there.
export function sharedDataOnSignerFields({ fields = [], values = {}, firstSignerIndex = null, inOrder = false } = {}) {
  return (fields || []).filter(f => {
    if (!f?.id || isSharedField(f.type)) return false
    if (!prefillFieldEntry(f, values?.[f.id])) return false
    const owner = f.roleIndex == null ? firstSignerIndex : Number(f.roleIndex)
    const carriedByFirstSigner = firstSignerIndex != null && owner === Number(firstSignerIndex)
    return !(inOrder && carriedByFirstSigner)
  })
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
  // A Name field prints the assigned signer's name no matter what we send, so an
  // entry for one is inert. Sending it anyway would put a value in the payload,
  // in the audit log and on the send screen that the document never shows — the
  // silent wrong-name failure described at SIGNER_BOUND_FIELD_TYPES.
  if (isSignerBoundField(field?.type)) return null
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

// ── Matching a template field to a CRM token ─────────────────────────────────
// A token is typed by hand in BoldSign's template editor, and there are three
// ways for it to arrive here — none of which we control:
//
//   • the field's **id**    — what the API addresses it by, but BoldSign
//                             AUTO-ASSIGNS these (`Label1`, `Label2`; those are
//                             the ids in BoldSign's own API examples), so a
//                             hand-typed token usually is NOT the id;
//   • the field's **name**  — the box an admin actually types into in the editor;
//   • the field's **label** — the caption shown on the document.
//
// Matching the id alone is why a template carefully labelled `client_names`
// arrived blank: it was addressed as `Label1`, matched nothing, and the send
// screen showed an empty box with no indication of why. All three are tried now,
// and the comparison is normalized — case, spaces, and dashes all collapse — so
// `Agent_Name`, `agent name` and `AGENT-NAME` are one token.
export const normalizeTokenKey = (s) => String(s || '').trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

// Which CRM token this field means, or '' when it is not one of ours. Accepts a
// field object or a bare id string.
export function fieldTokenKey(field, tokenKeys = SHARED_PREFILL_TOKENS) {
  const candidates = (typeof field === 'string' || field == null)
    ? [field]
    : [field.id, field.name, field.label]
  for (const c of candidates) {
    const key = normalizeTokenKey(c)
    if (key && tokenKeys.has(key)) return key
  }
  return ''
}

// The deal's value for a template field, by whichever of id/name/label carries
// the token. '' when the field isn't one of ours — that's a blank the agent
// fills in by hand, not an error.
export function fieldTokenValue(tokenVals, field) {
  const key = fieldTokenKey(field, new Set(Object.keys(tokenVals || {})))
  return key ? (tokenVals[key] || '') : ''
}

// Same lookup from a bare id — kept for callers that only have the string.
export const tokenValueFor = (tokenVals, fieldId) => fieldTokenValue(tokenVals, fieldId)

// Is this field one of ours, however it was spelled? Used to spot shared deal
// data sitting on a signer-private field.
export const isCrmToken = (field) => Boolean(fieldTokenKey(field))

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
