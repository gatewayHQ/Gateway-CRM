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
import { fullAddress, streetLine, propertyUnit } from '../address.js'

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

// ── Which field types may carry a lock ───────────────────────────────────────
// BoldSign rejects `IsReadOnly` outright on some types, with:
//
//   "IsReadOnly property is not supported for the Signature, Initial,
//    Attachment, Date signed, Hyperlink, Title, Formula, Drawing and Company
//    form fields."
//
// It is a hard failure on the WHOLE send, not a warning about the one field. So
// a single Title or Company box with a value in it takes the entire packet down,
// and the agent is told about a property they never set on a field they may not
// know exists.
//
// Two of these are reachable from our own send screen: **Company** and **Title**
// are in FILLABLE_FIELD_TYPES, because they are legitimately values an agent
// fills in (the brokerage, the signer's role on the agreement), so both are
// rendered as inputs and both used to be stamped read-only like everything else.
// Any agency packet with a brokerage box hit this.
//
// The value still goes out. Only the lock is dropped, because BoldSign will not
// grant it on these types under any payload. A prefilled Company the signer
// could technically retype is worth incomparably more than a packet that refuses
// to send. Where a value must be BOTH locked and legible to every party, the
// answer is the one this whole file keeps arriving at: put it in the template as
// a **Label**, which takes a lock and is common to the document.
//
// ALLOWLIST, NOT A DENYLIST. This was first written as the nine refused types,
// which is the same thing today and the wrong shape for tomorrow: BoldSign adds
// field types, and a new one that does not take a lock would pass a denylist
// silently and break the send exactly the way Signature and Company did. An
// unknown type now defaults to NOT sending the property, which is always safe,
// because omitting `isReadOnly` cannot produce this error while sending it can.
//
// Membership is "we prefill this type AND BoldSign does not refuse a lock on it":
//   • TextBox / Dropdown / CheckBox / RadioButton — confirmed supported.
//   • EditableDate and Email — in FILLABLE_FIELD_TYPES, so an agent can fill
//     them and expects the value to stay put. Neither appears in BoldSign's
//     refusal list, and note that the refused "Date signed" (DateSigned) is a
//     DIFFERENT type: it is stamped by BoldSign at signing and is not one we
//     ever prefill. Dropping these two would quietly unlock a date or an email
//     the agent had set, which is a regression rather than a fix.
//   • Label — see below.
//
// Company and Title are absent on purpose. Both ARE in FILLABLE_FIELD_TYPES (an
// agent legitimately fills in a brokerage or a signer's role, and both render as
// inputs on the send screen), so both used to be stamped read-only like
// everything else, and any agency packet with a brokerage box was refused.
//
// The value still goes out for a type that is not here. Only the lock is
// dropped, since BoldSign will not grant it under any payload. A prefilled
// Company the signer could retype is worth incomparably more than a packet that
// refuses to send. Where a value must be BOTH locked and legible to every party,
// the answer is the one this whole file keeps arriving at: put it in the
// template as a Label, which takes a lock and is common to the document.
//
// LABEL is included, on evidence rather than assumption. It is absent from
// BoldSign's refusal list, which enumerated nine types precisely, and
// mergeSharedFormFields() has been stamping every shared Label read-only in
// production since the shared-field work shipped. Were Label refused, every send
// carrying shared data would fail with this same message rather than one packet.
// If a Label-only template ever does produce it, omitting the property for Label
// is the next thing to try and costs nothing: a Label is read-only by
// construction, so the flag is belt-and-braces rather than load-bearing.
//
// Matched with spacing and casing removed, so `RadioButton`, `radio button` and
// `radio_button` are one type. `radio` is listed separately because
// TICKABLE_FIELD_TYPES accepts that spelling too.
export const READONLY_SUPPORTED_FIELD_TYPES = new Set([
  'textbox', 'text', 'label', 'dropdown',
  'checkbox', 'radiobutton', 'radio',
  'editabledate', 'email',
])
export const supportsReadOnly = (t) =>
  READONLY_SUPPORTED_FIELD_TYPES.has(String(t || '').toLowerCase().replace(/[^a-z]/g, ''))

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
  // The lock is conditional; the value is not. BoldSign refuses `IsReadOnly` on
  // a handful of types and fails the ENTIRE send when it sees one, so on those
  // the property is omitted rather than sent as false: the message says the
  // property "is not supported", which reads as presence rather than value.
  // See READONLY_UNSUPPORTED_FIELD_TYPES.
  const lock = supportsReadOnly(field?.type) ? { isReadOnly: true } : {}
  if (isTickableField(field?.type)) {
    if (value !== true && value !== false) return null      // left to the signer
    return { id, value: tickValue(value), ...lock }
  }
  const v = String(value ?? '').trim()
  if (!v) return null
  return { id, value: v, ...lock }
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

/**
 * The same list, but split by side, for a deal that represents BOTH parties
 * (migration 0040).
 *
 * WHY THIS EXISTS. dealClientList() returns one flat list of "our clients",
 * which is the right answer while a deal has one client side — the primary, then
 * the additional contacts. On a both-sided deal it is actively dangerous: the
 * flat list is drawn from `deals.contact_id` plus the additional contacts, so
 * the OTHER side's primary is not in it at all, and a template whose roles read
 * [Seller, Buyer] filled the Buyer row from whatever came next — a co-buyer if
 * there was one, a co-OWNER if there wasn't. Pre-filled, plausible, and the
 * wrong party on a signature line, which is the exact failure NON_CLIENT_ROLE_RE
 * below was written to stop in the agent slots.
 *
 * @param {Array} buyerClients   contact rows on the buyer side, primary first
 * @param {Array} sellerClients  contact rows on the seller side, primary first
 * @returns {{ buyer: Array, seller: Array, all: Array }} people ({name, email}),
 *   `all` being the side-agnostic pool: seller side first (the party the
 *   listing, title and price belong to), then buyer, deduped by name+email.
 */
export function dealClientSides({ buyerClients = [], sellerClients = [] } = {}) {
  const listFor = (rows) => {
    const [primary, ...rest] = rows || []
    return dealClientList({ contact: primary || null, additionalContacts: rest })
  }
  const buyer  = listFor(buyerClients)
  const seller = listFor(sellerClients)
  const seen = new Set()
  const all = []
  for (const p of [...seller, ...buyer]) {
    const key = `${p.name}|${p.email}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    all.push(p)
  }
  return { buyer, seller, all }
}

// Which side of the transaction the deal's own clients sit on, or null when the
// deal does not say. Read from `comp_data.transaction_type`, the same value the
// Form Library filters templates by ('buyer' | 'seller' | 'lease' | 'general').
//
// The CRM has no buyer table and no seller table. A deal has CLIENTS
// (`deals.contact_id` + `deal_contacts`) and this one field saying which side of
// the table they are on; the other side is not stored anywhere. So this is the
// only thing that can tell a template captioned "Buyer" whether our client is
// actually the buyer.
//
// 'lease' and 'general' resolve to null rather than being forced onto a side. A
// lease has a lessor and a lessee, not a buyer and a seller, and 'general' means
// nobody recorded it. See the side-aware tokens in crmTokenValues() for what a
// null does, and why a blank is the right answer rather than a guess.
//
// 'both' (migration 0040) also resolves to null, and that is now the right
// answer rather than a gap: on a both-sided deal there is no single side "our
// clients" are on, and the side-aware tokens below no longer need one — they
// read the per-side lists (`buyerClients` / `sellerClients`) instead, which say
// exactly who each party is. This function is only consulted when those lists
// are absent, i.e. a one-sided deal.
export function dealClientSide(deal) {
  const t = String(deal?.comp_data?.transaction_type || '').trim().toLowerCase()
  return (t === 'buyer' || t === 'seller') ? t : null
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
// `agents` is the agent-side people in ROLE ORDER, i.e. orderAgentSigners()'
// output. `agent` (the appointed agent) is kept as its own argument because it
// is what every existing caller passes; the two never disagree, since
// appointedAgent() is orderAgentSigners()[0] in each of their branches.
export function crmTokenValues({ deal, property, contact, additionalContacts = [], buyerClients = null, sellerClients = null, agent, agents = [], today = '' } = {}) {
  const money = (n) => (n != null && n !== '' ? `$${Number(n).toLocaleString()}` : '')
  // Composed through src/lib/address.js so a suite (migration 0042) prints on
  // the agreement exactly as it reads in the CRM — a listing agreement for
  // "Suite 120" must not describe the whole building.
  const fullAddr = fullAddress(property)
  const dealComm = describeDealCommission(deal)
  // On a both-sided deal (migration 0040) the per-side lists are passed in and
  // `clients` is their union — without them the OTHER side's primary is missing
  // from every side-agnostic token, `client_names` included.
  const sided    = buyerClients || sellerClients
  const sides    = sided ? dealClientSides({ buyerClients: buyerClients || [], sellerClients: sellerClients || [] }) : null
  const clients  = sided ? sides.all : dealClientList({ contact, additionalContacts })
  const side     = dealClientSide(deal)
  // Who to print on a line captioned BUYER or SELLER. With per-side lists that
  // is simply that side's people. Without them the CRM knows only which side
  // "our clients" are on, so the other side's lines stay blank — see the note at
  // the side-aware tokens below for why a blank beats a guess.
  const buyerParties  = sided ? sides.buyer  : (side === 'buyer'  ? clients : [])
  const sellerParties = sided ? sides.seller : (side === 'seller' ? clients : [])
  // Dates reach an agreement as text, and "2026-08-15" on a signature page reads
  // like a database export. The CRM stores ISO, so the new date tokens below are
  // formatted on the way out. Parsed by hand rather than through `new Date()`,
  // which would shift a bare YYYY-MM-DD by the reader's timezone and can print
  // the day before the one on the deal.
  const usDate = (v) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '').trim())
    return m ? `${m[2]}/${m[3]}/${m[1]}` : String(v || '').trim()
  }
  // The representation period: how long the broker acts for this client. Held on
  // the deal as the listing window, which is the same span under a different
  // name on a buyer agreement.
  const retainerStart = deal?.comp_data?.listing_start || ''
  const retainerEnd   = deal?.comp_data?.listing_end || deal?.expected_close_date || ''

  // ── Per-deal terms that have no column of their own ────────────────────────
  // Protection period, the property types a buyer is looking for, the areas they
  // are looking in, escrow and lender details: all of these are terms of ONE
  // agreement rather than facts about the property, and none has a column.
  //
  // They are read out of `deals.comp_data`, the jsonb the deal already uses for
  // listing_start / listing_end / state / transaction_type. That means every id
  // below is wired end to end TODAY with no migration: a blank one renders as a
  // named, empty box on the send screen for the agent to fill once, and the same
  // id fills itself the moment the value is stored on the deal. Adding a Deal
  // page input later is then a UI change with no template work behind it.
  const term = (key) => String(deal?.comp_data?.[key] ?? '').trim()

  // Whole months between two ISO dates, as a string, or '' when either is
  // missing. Counted on the calendar rather than by dividing days, because
  // "12 months" on an agreement means the same day next year, not 365 days.
  const monthsBetween = (fromIso, toIso) => {
    const a = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fromIso || '').trim())
    const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(toIso || '').trim())
    if (!a || !b) return ''
    let months = (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]))
    // An end date earlier in the month than the start has not completed that
    // month yet: 01 Aug to 15 Aug next year is 12 months, 01 Aug to 15 Jul is 11.
    if (Number(b[3]) < Number(a[3])) months -= 1
    return months > 0 ? String(months) : ''
  }

  // The FLAT-FEE dollar amount, and blank unless this deal actually IS a flat
  // fee. Distinct from commission_amount below, which prints a dollar figure
  // EITHER way — including the computed equivalent on a percentage deal — which
  // is exactly right for a form with one settled number and exactly wrong for a
  // form that offers the broker two separate blanks, one for a flat fee and one
  // for a percentage: that form needs the flat-fee blank to read empty when the
  // deal is percentage-based, not a dollar figure that was never a flat fee.
  // comp_data can override for a flat amount the deal's own entry does not carry
  // (a packet naming a different figure than the Details tab).
  const brokerFlatFee = () => {
    if (term('broker_compensation_flat')) return term('broker_compensation_flat')
    return dealComm && dealComm.type === 'flat' ? money(dealComm.flat) : ''
  }

  // "this __ day of ________, 20__" is three blanks on the page, so it is three
  // ids here as well as one combined one. Split off the agreement date so the
  // parts can never disagree with the whole.
  const agreementIso = deal?.comp_data?.listing_start || today
  const agParts = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(agreementIso || '').trim())
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
  return {
    property_address:   streetLine(property) || deal?.prop_address || '',
    property_unit:      propertyUnit(property),
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
    // ── Side-aware party names ─────────────────────────────────────────────
    // Everything above is side-AGNOSTIC: `client_name` and its `seller_name`
    // alias both mean "our client", whoever that is, and they fill the same on
    // a listing and on a buyer representation agreement. That is right for a
    // form with one "Client" line, and wrong for a form that says BUYER.
    //
    // These fill from the side they name. On a ONE-SIDED deal only our own side
    // can be filled: our clients are the sellers, the buyers are the other side
    // of the table, and the CRM stores nothing about them. Printing our seller's
    // name on a line captioned "Buyer" is the same silent, plausible,
    // wrong-name failure that SIGNER_BOUND_FIELD_TYPES exists to prevent, and it
    // is worse than a blank: a blank is visible on the send screen as an empty
    // box the agent can fill in by hand before sending, and a Label field stays
    // editable there precisely so they can.
    //
    // A deal with no transaction_type recorded reads as "unknown side", so it
    // gets the blank too rather than a coin flip.
    //
    // On a BOTH-sided deal (migration 0040) the CRM does store the other party,
    // so both halves fill from their own side's list — no blank, no guess.
    buyer_1_name:       buyerParties[0]?.name || '',
    buyer_2_name:       buyerParties[1]?.name || '',
    // The canonical Label ids address these four. Same values as the two above,
    // under one consistent family covering both sides, because `seller_2_name`
    // was already taken by the side-AGNOSTIC alias and could not be reused
    // without changing what it means for templates already in production.
    party_buyer_1:      buyerParties[0]?.name  || '',
    party_buyer_2:      buyerParties[1]?.name  || '',
    party_seller_1:     sellerParties[0]?.name || '',
    party_seller_2:     sellerParties[1]?.name || '',

    // ── Property ───────────────────────────────────────────────────────────
    // `property_city_state_zip` is the second line of an address block, which is
    // how a Label captioned "City, State ZIP" is laid out on a form. Built from
    // the parts so a missing zip does not leave a dangling comma.
    property_city_state_zip: [property?.city, [property?.state, property?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    property_county:    property?.county || '',
    property_mls:       property?.mls_number || '',
    property_type:      property?.type || '',

    // ── Dates ──────────────────────────────────────────────────────────────
    // `today` is passed in rather than read here, so this function stays pure
    // and its output stays testable. A caller that omits it gets a blank, which
    // is the same "nothing to say" a missing deal field produces.
    agreement_date:     usDate(deal?.comp_data?.listing_start || today),
    // How long the broker represents this client. Named for what a buyer
    // agreement calls it; the deal stores it as the listing window.
    retainer_start_date: usDate(retainerStart),
    retainer_end_date:   usDate(retainerEnd),
    // How long the representation runs, as a NUMBER OF MONTHS, for the
    // "for a term of ___ months" blank. Derived from the start and end dates
    // rather than stored beside them, so the sentence and the expiry date on the
    // same page cannot disagree; comp_data overrides for a term worded in the
    // agreement as something other than whole months.
    agreement_term_months: term('agreement_term_months') || monthsBetween(retainerStart, retainerEnd),
    offer_expiration:    usDate(retainerEnd),
    closing_date_us:     usDate(deal?.expected_close_date),
    listing_start_us:    usDate(retainerStart),
    listing_end_us:      usDate(retainerEnd),
    // The three blanks of "this __ day of ______, 20__".
    agreement_day:       agParts ? String(Number(agParts[3])) : '',
    agreement_month:     agParts ? MONTHS[Number(agParts[2]) - 1] : '',
    // TWO digits, because the form pre-prints "20" and the blank that follows it
    // takes only the last two. A four-digit year there reads "202026".
    agreement_year:      agParts ? agParts[1].slice(2) : '',
    // The whole year, for a form that prints the blank on its own.
    agreement_year_full: agParts ? agParts[1] : '',

    // ── Buyer representation terms ─────────────────────────────────────────
    protection_period_days: term('protection_period_days'),
    property_types_sought:  term('property_types_sought'),
    search_area:            term('search_area') || [property?.city, property?.county].filter(Boolean).join(', '),
    // The percentage lives on `commission_pct` already, blank on a flat-fee
    // deal for the identical reason: BrokerCompensationLabelPct is a literal
    // alias of that same token in CANONICAL_LABEL_TOKENS, not a second value to
    // keep in sync.
    broker_compensation_flat: brokerFlatFee(),
    // The agent a broker appoints IN ADDITION to the primary one. Falls back to
    // the deal's second agent, which is who it usually is.
    additional_agent_name:  term('additional_agent_name') || agents?.[1]?.name || '',
    // Blank unless an additional agent actually exists. `additional_agent_date`
    // used to fall back to `agreementIso` (today, or the listing start) whether
    // or not `additional_agent_name` resolved to anyone — so the "this __ day of
    // ______, 20__" blanks in the ADDITIONAL APPOINTED AGENT section filled
    // themselves in on every deal, including ones with no second agent, while the
    // name beside them correctly stayed blank. The date is only ever meaningful
    // once there is a name to pair it with.
    additional_agent_date:  (term('additional_agent_name') || agents?.[1]?.name)
      ? usDate(term('additional_agent_date') || agreementIso)
      : '',

    // ── Purchase agreement / escrow ────────────────────────────────────────
    earnest_money:          term('earnest_money'),
    down_payment:           term('down_payment'),
    financing_type:         term('financing_type'),
    possession_date:        usDate(term('possession_date')),
    inspection_deadline:    usDate(term('inspection_deadline')),
    loan_approval_deadline: usDate(term('loan_approval_deadline')),
    title_company:          term('title_company'),
    lender_name:            term('lender_name'),
    lender_institution:     term('lender_institution'),

    // ── Listing / disclosure / MLS ─────────────────────────────────────────
    listing_exclusivity:    term('listing_exclusivity'),
    year_built:             term('year_built'),
    mls_new_price:          term('mls_new_price'),
    change_effective_date:  usDate(term('change_effective_date')),
    close_date:         deal?.expected_close_date || '',
    // The deal's agent, NOT necessarily the sender — see appointedAgent().
    agent_name:         agent?.name || '',
    agent_email:        agent?.email || '',
    // The SECOND agent-side person on the deal: a co-listing agent, or whoever
    // else `dealAgentList()` found. For templates with two named agent lines.
    // Taken from the same ordered list the signature rows are seeded from, so
    // the agent printed in the body and the agent in the second signature row
    // can never be two different people.
    agent_2_name:       agents?.[1]?.name || '',
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

// ── Canonical Label field ids (the template-side half of the contract) ───────
// The tokens above are the CRM's own vocabulary. The BoldSign templates use a
// different one: PascalCase ids ending in `Label`, one fixed id per category of
// data, reused across every template (a field id only has to be unique WITHIN a
// template, so the same id can mean the same thing account-wide, which is what
// keeps this code template-agnostic).
//
// The two spellings do NOT meet in the middle on their own. `normalizeTokenKey`
// collapses case and separators, which is why `Agent_Name` and `agent name` are
// already one token, but `Agent1NameLabel` has no separators to collapse: it
// normalizes to `agent1namelabel` and matches nothing. A template authored
// exactly to the convention therefore rendered every one of these as an empty
// box on the send screen and sent no value for it. Not a wrong name, a blank,
// with nothing on screen saying why.
//
// This table is the bridge, and it is deliberately an explicit list rather than
// a derived pattern: a wrong entry here prints a real person's name under the
// wrong caption, which is the failure this whole module is built to make
// impossible, and a table can be read against the template and checked.
//
// Only ids the CRM can actually source are listed. The convention covers a much
// wider vocabulary (entities, licence numbers, lender, the financial terms, the
// staff selections that replace checkboxes); none of those has a column in this
// schema yet. An id added here without a real token behind it would resolve to
// `undefined`, match nothing, and quietly send nothing, so the list grows only
// when the data does.
export const CANONICAL_LABEL_TOKENS = {
  // ── Parties ────────────────────────────────────────────────────────────────
  Agent1NameLabel:  'agent_name',
  Agent2NameLabel:  'agent_2_name',
  Buyer1NameLabel:  'party_buyer_1',
  Buyer2NameLabel:  'party_buyer_2',
  Seller1NameLabel: 'party_seller_1',
  Seller2NameLabel: 'party_seller_2',
  BrokerageNameLabel: 'broker_name',

  // ── Property ───────────────────────────────────────────────────────────────
  PropertyAddressLabel:      'property_address',
  PropertyCityStateZipLabel: 'property_city_state_zip',
  PropertyNameLabel:         'property_full',
  PropertyCountyLabel:       'property_county',
  PropertyTypeLabel:         'property_type',
  MlsNumberLabel:            'property_mls',

  // ── Money ──────────────────────────────────────────────────────────────────
  PurchasePriceLabel:    'list_price',
  ListPriceLabel:        'list_price',
  CommissionRateLabel:   'commission_pct',
  CommissionAmountLabel: 'commission_amount',

  // ── Dates ──────────────────────────────────────────────────────────────────
  AgreementDateLabel:    'agreement_date',
  ClosingDateLabel:      'closing_date_us',
  OfferExpirationLabel:  'offer_expiration',
  // The representation period on a buyer agreement: how long the broker acts
  // for this client. Both the bare spelling an admin is likely to type and the
  // `...Label` form are listed, because the convention says every id ends in
  // `Label` and these two were named without it on the live packet.
  RetainerDate1:         'retainer_start_date',
  RetainerDate2:         'retainer_end_date',
  RetainerDate1Label:    'retainer_start_date',
  RetainerDate2Label:    'retainer_end_date',
  RetainerStartLabel:    'retainer_start_date',
  RetainerEndLabel:      'retainer_end_date',
  // Preferred spellings for the same two dates on a Buyer Agency Agreement,
  // which calls the period a term rather than a retainer. Same values; the
  // wording is whatever the form in front of the admin uses.
  AgreementStartDateLabel: 'retainer_start_date',
  AgreementEndDateLabel:   'retainer_end_date',
  AgreementTermMonthsLabel:'agreement_term_months',
  // "this __ day of ________, 20__" is three blanks on the page, so it is three
  // ids. AgreementDateLabel is the same date as one value, for forms that print
  // it whole.
  AgreementDayLabel:     'agreement_day',
  AgreementMonthLabel:   'agreement_month',
  AgreementYearLabel:     'agreement_year',
  AgreementYearFullLabel: 'agreement_year_full',

  // ── Buyer agreement terms ──────────────────────────────────────────────────
  AdditionalAgentNameLabel: 'additional_agent_name',
  AdditionalAgentDateLabel: 'additional_agent_date',
  ProtectionPeriodDaysLabel: 'protection_period_days',
  PropertyTypesSoughtLabel:  'property_types_sought',
  SearchAreaLabel:           'search_area',
  // Split in two, one blank per number a Buyer Agency form actually offers:
  // "a flat fee of $______ OR ______% of the gross sales price". Sending a
  // combined sentence into a form that already prints its own wording around
  // the blank duplicates or contradicts the template's own text; two bare
  // numbers, each blank when it does not apply to this deal, is what the form
  // needs. BrokerCompensationLabelPct is `commission_pct` under another name —
  // same value, so the two can never disagree, the same pattern as
  // AgreementEndDateLabel aliasing retainer_end_date above.
  BrokerCompensationLabel:    'broker_compensation_flat',
  BrokerCompensationLabelPct: 'commission_pct',

  // ── Purchase agreement / escrow ────────────────────────────────────────────
  EarnestMoneyLabel:        'earnest_money',
  DownPaymentLabel:         'down_payment',
  FinancingTypeLabel:       'financing_type',
  PossessionDateLabel:      'possession_date',
  InspectionDeadlineLabel:  'inspection_deadline',
  LoanApprovalDeadlineLabel:'loan_approval_deadline',
  TitleCompanyLabel:        'title_company',
  LenderNameLabel:          'lender_name',
  LenderInstitutionLabel:   'lender_institution',

  // ── Listing / disclosure / MLS ─────────────────────────────────────────────
  ListingStartDateLabel:    'listing_start_us',
  ListingEndDateLabel:      'listing_end_us',
  ListingExclusivityLabel:  'listing_exclusivity',
  YearBuiltLabel:           'year_built',
  NewListPriceLabel:        'mls_new_price',
  ChangeEffectiveDateLabel: 'change_effective_date',
}

// Canonical ids are matched with separators removed ENTIRELY, not merely
// normalized, so `Agent1NameLabel`, `agent1namelabel` and `Agent1_Name_Label`
// are all the same id. These are typed by hand in BoldSign's editor and the
// convention's own casing is the only thing distinguishing the words.
//
// Kept as a separate collapse rather than loosening `normalizeTokenKey`:
// that function decides every CRM token match in the app and in the account-wide
// audit script, so widening it has a far larger blast radius than a four-entry
// table needs.
const squashFieldKey = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')

const CANONICAL_ALIASES = Object.fromEntries(
  Object.entries(CANONICAL_LABEL_TOKENS).map(([id, token]) => [squashFieldKey(id), token]),
)

// ── Repeated instances of the same logical field ─────────────────────────────
// BoldSign form-field IDs are unique per template, so a value that has to print
// TWICE on one document — the buyer's name in the opening paragraph and again
// on the signature page, the property address on page 1 and the acknowledgment
// page — needs a second field with a DIFFERENT id. The convention: append
// `_2`, `_3`, ... to the primary id. `Buyer1NameLabel_2` is the second instance
// of `Buyer1NameLabel`; both resolve to the identical value.
//
// The suffix is stripped ONLY as a last resort, after the id has already failed
// to match under its own spelling and through CANONICAL_ALIASES. That ordering
// is load-bearing: `RetainerDate2` is itself a real, distinct canonical id (the
// agreement's END date — see CANONICAL_LABEL_TOKENS) and must keep meaning that,
// never get read as "second instance of RetainerDate1". Because the alias table
// is tried first and matches `RetainerDate2` outright, stripping never runs for
// it. A field that is genuinely unrecognized under any spelling only then gets
// the suffix peeled off and tried again.
//
// Underscore + digits only (`_2`, not a bare trailing `2`), so a canonical id
// that happens to end in a digit — `RetainerDate1`, `Agent2NameLabel` — is never
// ambiguous with a repeat instance. Bare-digit suffixes are not supported and
// should not be authored.
const REPEAT_SUFFIX_RE = /_\d+$/

// Which CRM token this field means, or '' when it is not one of ours. Accepts a
// field object or a bare id string.
export function fieldTokenKey(field, tokenKeys = SHARED_PREFILL_TOKENS) {
  const candidates = (typeof field === 'string' || field == null)
    ? [field]
    : [field.id, field.name, field.label]
  for (const c of candidates) {
    const key = normalizeTokenKey(c)
    if (key && tokenKeys.has(key)) return key
    // Not one of ours under its own spelling. Try the canonical table before
    // moving on: a field named `Agent1NameLabel` is correctly authored, it just
    // names its data in the template's vocabulary instead of the CRM's.
    const alias = CANONICAL_ALIASES[squashFieldKey(c)]
    if (alias && tokenKeys.has(alias)) return alias
  }
  // Neither matched under its real spelling. Try again with a trailing repeat
  // suffix removed, so `Buyer1NameLabel_2` and `Buyer1NameLabel_3` resolve to
  // whatever `Buyer1NameLabel` itself resolves to, without a second entry in
  // any table. This runs LAST, after every exact/alias attempt above, so a
  // canonical id that legitimately ends in digits is never reinterpreted.
  for (const c of candidates) {
    const raw = typeof c === 'string' ? c.trim() : ''
    if (!REPEAT_SUFFIX_RE.test(raw)) continue
    const base = raw.replace(REPEAT_SUFFIX_RE, '')
    const key = normalizeTokenKey(base)
    if (key && tokenKeys.has(key)) return key
    const alias = CANONICAL_ALIASES[squashFieldKey(base)]
    if (alias && tokenKeys.has(alias)) return alias
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

// ── Fields that only exist for a party who may not be on this deal ───────────
// A co-buyer's name, an additional agent's name and appointment date: real on
// SOME deals and simply absent on others. Leaving the value blank (which
// crmTokenValues() already does) is correct for what gets FILLED, but BoldSign
// still shows the field itself — an unfilled Label renders as a visible blue
// "Label" placeholder chip in the editor, which reads as a leftover artifact
// rather than a term that doesn't apply to this deal. So beyond leaving these
// blank, a field naming one of these tokens is dropped from the draft outright
// (see conditionalFieldsToRemove / editDocumentFields) whenever this deal has
// nothing to put there.
export const CONDITIONAL_PARTY_TOKENS = new Set([
  'party_buyer_2', 'additional_agent_name', 'additional_agent_date',
])

// Ids of fields to remove from a freshly created draft: they name one of
// CONDITIONAL_PARTY_TOKENS above, and this deal's resolved value for that
// token is blank. Never returns a field whose token DID resolve to a value —
// only ones with nothing to show.
export function conditionalFieldsToRemove({ fields = [], values = {} } = {}) {
  return (fields || [])
    .filter(f => f?.id && CONDITIONAL_PARTY_TOKENS.has(fieldTokenKey(f)))
    .filter(f => !String(values?.[f.id] ?? '').trim())
    .map(f => f.id)
}

// Tokens that print a PARTY's name — the client, their co-buyer/co-seller. An
// agreement that goes out with these blank names nobody, which is the one gap on
// this screen that is never acceptable to ship silently.
const PARTY_NAME_TOKENS = new Set([
  'client_name', 'client_names', 'client_2_name',
  'seller_name', 'seller_names', 'seller_2_name',
  'buyer_1_name', 'buyer_2_name',
  'party_buyer_1', 'party_buyer_2', 'party_seller_1', 'party_seller_2',
])

/**
 * Fields on this template that are meant to print a party's name and resolved to
 * nothing — plus whether the template names such a field at all.
 *
 * WHY THIS EXISTS. An Appointed Agency Agreement came back from a real send with
 * the literal word "Label" on both lines where the client's name belongs, while
 * the brokerage name and the appointed agent's name filled in correctly. Those
 * two fill from the agent and a constant; the client's name fills from the deal's
 * linked CONTACT. So a deal with no contact linked produces exactly that page,
 * and nothing on the send screen said so — the agent could only conclude the CRM
 * had stopped pulling data over.
 *
 * Two different faults look identical on the page and need different fixes, so
 * they are reported apart:
 *   `empty`     — the template asks for a party name and the deal has nobody to
 *                 put there. Link a contact to the deal.
 *   `noneNamed` — no field on this template carries a party-name token at all, so
 *                 nothing can ever fill those lines. The TEMPLATE needs naming
 *                 (an admin job) — see the Label guidance in
 *                 docs/boldsign-integration.md.
 */
export function partyNameGaps({ fields = [], values = {} } = {}) {
  const named = (fields || []).filter(f => f?.id && PARTY_NAME_TOKENS.has(fieldTokenKey(f)))
  const empty = named.filter(f => !String(values?.[f.id] ?? '').trim())
  return { empty, noneNamed: named.length === 0, named }
}

// ── Empty Labels must not reach the client ───────────────────────────────────
// BoldSign renders an unfilled **Label** as its own placeholder — the literal
// word "Label" — printed on the page. On an Appointed Agency Agreement that put
// the word "Label" on the two lines where the client's name belongs, which reads
// as a broken form rather than a blank one.
//
// CONDITIONAL_PARTY_TOKENS above already removed three specific ones (the
// co-buyer, the second appointed agent). That was too narrow by construction: it
// only covered fields the CRM knows a token for, and the fields that print
// "Label" are exactly the ones nothing filled — including every Label the
// template author never named, which no token list can enumerate.
//
// So the rule is about the VALUE, not the token: any Label going out with nothing
// in it is removed from the draft. Removing an empty Label loses nothing a signer
// would have seen (a Label is read-only — no signer could have typed in it) and
// leaves the printed line blank, exactly as the paper form is.
//
// Labels ONLY. A signer-fillable box left empty is the signer's to complete and
// must stay on the document.
export function emptyLabelsToRemove({ fields = [], values = {} } = {}) {
  return (fields || [])
    .filter(f => f?.id && isSharedField(f.type))
    .filter(f => !String(values?.[f.id] ?? '').trim())
    .map(f => f.id)
}

// ── Fields nobody configured ─────────────────────────────────────────────────
// BoldSign auto-names a placed field by type plus a counter: `Label1`,
// `Checkbox2`, `Name3`, `EditableDate1`. That id is all the send screen has to
// show when the admin never typed a name or a caption in the template editor.
//
// A real packet has a lot of these. One live agency template renders 27 Label
// boxes captioned `Label1` through `Label27` plus 14 tick boxes captioned
// `Checkbox1`, none of which tell the agent what they are for or what belongs in
// them. Buried in that list are the three fields that DO matter, and the whole
// screen becomes something to scroll past rather than read, which is the
// opposite of what a review-before-send step is for.
//
// So a field counts as unconfigured when ALL of these hold:
//   • it matches no CRM token, so nothing fills it automatically;
//   • it has no name and no label, so there is no caption but the raw id;
//   • that id is one of BoldSign's auto-assigned type+counter names.
//
// All three matter. A hand-named field is always shown even if it matches no
// token (the name is the admin telling the agent what to put there), and a field
// carrying a token is always shown even if its id is auto-assigned, which is the
// normal case for a Label whose NAME carries the token.
//
// These are HIDDEN BEHIND A TOGGLE, never dropped: the agent can still open them
// and type, and a checkbox nobody named is still a term of the agreement they
// may need to tick.
const AUTO_FIELD_ID_RE = /^(label|textbox|text|checkbox|radiobutton|radio|name|email|company|title|date|editabledate|datesigned|signature|initial|initials|dropdown|hyperlink|attachment|image|formula|drawing)\d+$/i

export function isUnconfiguredField(field) {
  if (!field?.id) return true
  if (fieldTokenKey(field)) return false
  // A caption read off the PDF counts as a name. The page itself says what this
  // box is ("exclusive", "3. APPOINTED AGENCY"), which is the thing the agent
  // needed in order to decide it — so a captioned field belongs in the list by
  // default, not folded away behind the toggle with the genuinely nameless ones.
  if (String(field.caption || '').trim()) return false
  const id = String(field.id).trim()
  // BoldSign fills `name` with the auto id when nobody typed one, so a bare
  // `name` is not evidence that anybody named this field. Comparing against the
  // id is what separates "the admin called this Earnest money" from "BoldSign
  // called this Label7". Without this the rule matched almost nothing and the
  // screen stayed as long as it ever was.
  const named = String(field.name || '').trim()
  if (named && named.toLowerCase() !== id.toLowerCase()) return false
  if (String(field.label || '').trim()) return false
  return AUTO_FIELD_ID_RE.test(id)
}

// Date-ish fields, which want a date picker rather than a free-text box. Either
// BoldSign says so by type, or the CRM token behind the field does: a template
// date is usually a Label (read-only to the signer, filled by us), and a Label
// is just text as far as BoldSign is concerned.
const DATE_TOKEN_RE = /(^|_)(date|expiration)($|_)/
export function isDateField(field) {
  if (String(field?.type || '').toLowerCase() === 'editabledate') return true
  return DATE_TOKEN_RE.test(fieldTokenKey(field))
}

// MM/DD/YYYY (what goes on the document) ⇄ YYYY-MM-DD (what <input type="date">
// speaks). Both return '' rather than guessing when the input is not a full
// date, so a half-typed value never becomes a wrong one.
export function usDateToIso(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v || '').trim())
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : ''
}
export function isoDateToUs(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '').trim())
  return m ? `${m[2]}/${m[3]}/${m[1]}` : ''
}

// Role names that should be filled with the deal's client(s) rather than an
// agent. Broad on purpose so generic template roles ("Signer 1") still seed.
const CLIENT_ROLE_RE = /(seller|buyer|client|owner|purchaser|grantor|grantee|landlord|tenant|lessor|lessee|borrower|customer|signer)/

// Roles filled from the AGENTS on the deal.
const AGENT_ROLE_RE = /(agent|broker|realtor)/

// Which SIDE a client role belongs to, for a deal that represents both parties.
// Subsets of CLIENT_ROLE_RE, and both still subject to the NON_CLIENT veto below
// ("Buyer's Agent" matches BUYER_SIDE_ROLE_RE and must never take a client).
// A client role matching neither — "Client", "Signer 1" — is side-agnostic and
// draws from whoever is left, because the template is not saying which party it
// means and guessing is what this whole mechanism exists to avoid.
const SELLER_SIDE_ROLE_RE = /(seller|owner|grantor|lessor|landlord)/
const BUYER_SIDE_ROLE_RE  = /(buyer|purchaser|grantee|lessee|tenant|borrower)/

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
//
// BOTH SIDES (migration 0040). Pass `buyerClients` / `sellerClients` — contact
// rows per side, primary first — and a role naming a side takes that side's
// people: "Seller" gets the seller, "Buyer" gets the buyer, and neither can be
// filled from the other side's list no matter what order the roles are in. A
// side-agnostic client role ("Client", "Signer 1") still draws from the shared
// pool. Omit both and this behaves exactly as it always did, which is what every
// one-sided deal keeps doing.
export function seedSignersFromDeal({
  roles = [], contact = null, additionalContacts = [],
  buyerClients = null, sellerClients = null,
  activeAgent = null, dealAgents = [],
} = {}) {
  // Primary contact, then Additional Contacts (each with their own email), then
  // the stored spouse name as a last resort — see dealClientList, which the
  // printed `client_names` token also uses so the two never disagree.
  const sided  = buyerClients || sellerClients
  const sides  = sided ? dealClientSides({ buyerClients: buyerClients || [], sellerClients: sellerClients || [] }) : null
  const people = sided ? sides.all : dealClientList({ contact, additionalContacts })
  const agentSigners = orderAgentSigners({ activeAgent, dealAgents })

  // One cursor per pool. The shared pool skips anyone a side-specific role has
  // already taken, so [Seller, Buyer, Client] on a deal with one person per side
  // fills the first two and leaves the third on its placeholder rather than
  // repeating a name that is already signing above it.
  const cursors = { buyer: 0, seller: 0 }
  const taken = new Set()
  const keyOf = (p) => `${p.name}|${p.email}`.toLowerCase()

  const nextFrom = (pool, side) => {
    if (side) {
      while (cursors[side] < pool.length && taken.has(keyOf(pool[cursors[side]]))) cursors[side]++
      if (cursors[side] >= pool.length) return null
      const p = pool[cursors[side]++]
      taken.add(keyOf(p))
      return p
    }
    const p = pool.find(x => !taken.has(keyOf(x)))
    if (p) taken.add(keyOf(p))
    return p || null
  }

  const out = {}
  const placeholder = (r) => ({ name: r?.defaultName || '', email: r?.defaultEmail || '' })
  let agentIdx = 0
  for (const r of roles) {
    const n = String(r?.name || '').toLowerCase()
    if (AGENT_ROLE_RE.test(n)) {
      // Agent roles are only ever filled from the deal's agents. Falling through
      // to the client branch is what put a client's email in an agent's slot.
      const a = agentSigners[agentIdx]
      out[r.index] = a ? { name: a.name, email: a.email } : placeholder(r)
      if (a) agentIdx++
    } else if (!NON_CLIENT_ROLE_RE.test(n) && CLIENT_ROLE_RE.test(n)) {
      // A named side draws from that side ONLY. Its list running out leaves the
      // template's placeholder — a blank the sender can see and fill — rather
      // than borrowing the opposite party.
      const side = sided ? (SELLER_SIDE_ROLE_RE.test(n) ? 'seller' : BUYER_SIDE_ROLE_RE.test(n) ? 'buyer' : null) : null
      const person = nextFrom(side ? sides[side] : people, side)
      out[r.index] = person ? { ...person } : placeholder(r)
    } else {
      out[r.index] = placeholder(r)
    }
  }
  return out
}
