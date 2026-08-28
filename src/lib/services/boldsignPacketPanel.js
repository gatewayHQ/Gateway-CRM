// ─────────────────────────────────────────────────────────────────────────────
// boldsignPacketPanel — the Prepare Draft Agreement panel's decisions.
//
// The panel asks the sender for the two choices a buyer packet cannot be sent
// without — which representation, which term — shows the policy row as state
// they rarely touch, and writes the result onto the template's checkboxes. It is
// meant to take under ten seconds, so nothing that is not a decision appears in
// it: no field ids, no page numbers, no boxes the sender does not choose.
//
// THE MAP IS THE SOURCE OF TRUTH, by instruction. `PACKET_FIELD_MAP` ties each
// decision to the BoldSign field ids from the verify table on PR #114. Boxes not
// named here are not sender decisions: they are left at whatever the template
// carries and no value is sent for them at all, so an unrecognized box can never
// be flipped by this panel.
//
// The ids were confirmed against a fixture of the packet, not against the live
// template — so `captionConflicts()` below re-checks each id against the caption
// actually read off the PDF at send time and reports any disagreement. It does
// not override the map (the map is authoritative), and it shows nothing to the
// sender; it exists so a template edit that moves a box surfaces as a warning
// instead of as a wrong term on a signed agreement.
// ─────────────────────────────────────────────────────────────────────────────
import { isTicked } from './boldsignSelections.js'

export const PACKET_FIELD_MAP = {
  representation: {
    required: true,
    options: [
      // The negative lookahead is the point: "exclusive" is a substring of
      // "non-exclusive", so a bare /exclusive/ accepts the sibling box's caption
      // and the cross-check goes quiet on exactly the swap it exists to catch.
      { key: 'exclusive',     label: 'Exclusive',     id: 'CheckBox1', expect: /^(?!.*non-?\s?exclusive).*\bexclusive\b/i },
      { key: 'non-exclusive', label: 'Non-exclusive', id: 'CheckBox2', expect: /non-?\s?exclusive/i },
    ],
  },
  term: {
    required: true,
    options: [
      { key: 'close', label: 'Until the deal closes', id: 'CheckBox8', expect: /continue\s+until\s+clos|until\s+closing/i },
      { key: 'fixed', label: 'Ends on a fixed date',  id: 'CheckBox9', expect: /ends?\s+at\s+11:?59|and\s+ends\s+at\b/i },
    ],
  },
  // Shown collapsed, as state. The packet is authored with 3 and 4 on.
  policy: [
    { id: 'CheckBox4', label: 'Single seller',    default: false, expect: /single\s+seller\s+agency/i },
    { id: 'CheckBox5', label: 'Single buyer',     default: false, expect: /single\s+buyer\s+agency/i },
    { id: 'CheckBox6', label: 'Appointed agency', default: true,  expect: /appointed\s+agency/i },
    { id: 'CheckBox7', label: 'Consensual dual',  default: true,  expect: /consensual\s+dual\s+agency/i },
  ],
  // Ticked on the template already, never shown, and NEVER SENT. See the note
  // on silent fields below: BoldSign reads an explicit "false" as an
  // instruction to clear the box, and sending "true" for a field whose id we
  // resolved wrongly is just as bad, so the safe handling of a box nobody
  // decides on this screen is to leave it out of the payload entirely.
  untouched: [{ id: 'CheckBox3', expect: /^(prospective\s+)?buyer\b/i }],
}

const REPRESENTATION = PACKET_FIELD_MAP.representation.options
const TERM = PACKET_FIELD_MAP.term.options

// Every field id this panel controls. A tick box outside this set is left alone.
// The ids this panel WRITES. CheckBox3 is deliberately not among them.
export const PACKET_FIELD_IDS = new Set([
  ...REPRESENTATION.map(o => o.id),
  ...TERM.map(o => o.id),
  ...PACKET_FIELD_MAP.policy.map(p => p.id),
])

export const isPacketField = (id) => PACKET_FIELD_IDS.has(String(id || ''))

// ── Ids come from the template, not from this file ───────────────────────────
// The map above names each decision's field, but BoldSign's id casing is not
// something to assume: one live packet reports a field whose NAME is `Checkbox1`
// and whose ID is `CheckBox1`, and the payload is addressed by id. A mismatched
// id is accepted with a 2xx and silently changes nothing — the box opens empty
// in the editor and there is no error to chase.
//
// So every canonical id is resolved against the ids the template actually
// reports, case-insensitively. A canonical id with no match resolves to nothing
// and is left out of the payload rather than sent on a guess.
const norm = (id) => String(id || '').trim().toLowerCase()

// Every entry the panel resolves, decision boxes and the untouched one alike.
const ALL_PACKET_ENTRIES = [
  ...REPRESENTATION, ...TERM,
  ...PACKET_FIELD_MAP.policy, ...PACKET_FIELD_MAP.untouched,
]

// THE CAPTION IS THE BINDING, NOT THE ID.
//
// The id map was written from a fixture and was wrong about the live packet:
// the sender picked Exclusive, the panel resolved it to `CheckBox1`, that id was
// not the exclusive box, and the decision went nowhere — a box left unticked on
// an agreement, with a 2xx and no warning.
//
// Ids cannot carry this. BoldSign auto-assigns them in PLACEMENT order, so they
// differ per template, shift when an admin moves a field, and say nothing about
// what the box means. The document already states what each box IS: the words
// printed beside it, captioned off the PDF by boldsignCaptions.js.
//
// So each entry is matched to the field whose printed caption its own `expect`
// pattern recognizes — the same patterns that used to only cross-check the map.
// A template that never saw this code, or one whose fields were re-placed
// yesterday, resolves correctly with no table to maintain.
//
// The canonical id stays as the fallback for a field the page could not caption
// (no PDF, an unparseable one, nothing printed beside the box), matched
// case-insensitively because BoldSign's casing is not ours to assume.
//
// Ambiguity is reported, never guessed past: two boxes captioned the same thing
// take the first in document order, and `ambiguous` names the rest so a template
// with a duplicated clause is visible instead of silently half-filled.
export function resolvePacketFieldIds({ fields = [] } = {}) {
  return resolvePacketFields({ fields }).ids
}

// The full resolution, with its provenance. `ids` maps canonical → the id the
// document actually uses; `by` says whether each came from the caption or the id
// fallback; `ambiguous` lists entries the page described more than once.
export function resolvePacketFields({ fields = [] } = {}) {
  const list = (fields || []).filter(f => f?.id)
  const byId = new Map(list.map(f => [norm(f.id), f.id]))

  // Document order, so an ambiguous match takes the first box on the paper.
  const ordered = [...list].sort((a, b) =>
    (Number(a.page ?? a.pageNumber) || 0) - (Number(b.page ?? b.pageNumber) || 0)
    || (Number(a.bounds?.y) || 0) - (Number(b.bounds?.y) || 0)
    || (Number(a.bounds?.x) || 0) - (Number(b.bounds?.x) || 0))

  const ids = {}
  const by = {}
  const ambiguous = {}
  const taken = new Set()

  // TWO PASSES, and the order is load bearing. Captions are resolved for every
  // entry FIRST, then the id fallback fills what is left.
  //
  // One pass let an id fallback steal a field a later entry would have matched by
  // caption: on a template where the box captioned "3. APPOINTED AGENCY" happens
  // to carry the id `Checkbox5`, the Single-buyer entry (canonical `CheckBox5`,
  // uncaptioned on that template) claimed it by id before Appointed agency was
  // ever considered — so the sender's policy row wrote to the wrong clause. The
  // page's own words outrank a coincidence of ids, always.
  for (const entry of ALL_PACKET_ENTRIES) {
    if (!entry.expect) continue
    const hits = ordered.filter(f =>
      String(f.caption || '').trim() && entry.expect.test(String(f.caption).trim()))
    // A box already claimed by another entry is not offered again: "exclusive"
    // and "non-exclusive" would otherwise compete for one field on a template
    // that captions only one of them.
    const free = hits.filter(f => !taken.has(norm(f.id)))
    if (!free.length) continue
    ids[entry.id] = free[0].id
    by[entry.id] = 'caption'
    taken.add(norm(free[0].id))
    if (free.length > 1) ambiguous[entry.id] = free.slice(1).map(f => f.id)
  }

  for (const entry of ALL_PACKET_ENTRIES) {
    if (ids[entry.id]) continue
    const fallback = byId.get(norm(entry.id))
    if (!fallback || taken.has(norm(fallback))) continue
    ids[entry.id] = fallback
    by[entry.id] = 'id'
    taken.add(norm(fallback))
  }

  return { ids, by, ambiguous }
}

// Canonical ids the template does not carry at all. Reported so a template that
// lost a box is visible, rather than a decision quietly going nowhere.
export function missingPacketFields({ fields = [] } = {}) {
  const resolved = resolvePacketFieldIds({ fields })
  return [...PACKET_FIELD_IDS].filter(id => !resolved[id])
}

const tickedIn = (fields, id) => {
  const f = (fields || []).find(x => norm(x?.id) === norm(id))
  return f ? isTicked(f.value) : null
}

// The panel's opening state, read from what the template already carries.
// Representation and term start unset unless the template has exactly one of the
// pair ticked — a template with both or neither ticked is not stating a choice,
// and pre-selecting one for the sender would be this panel deciding a term.
export function seedPacketState({ fields = [] } = {}) {
  // Through the resolver, so the state is read off the boxes the decisions
  // actually write to. Reading canonical ids here meant the panel opened showing
  // whatever field happened to share an id with the map — a different box.
  const { ids } = resolvePacketFields({ fields })
  const stateOf = (canonical) => (ids[canonical] ? tickedIn(fields, ids[canonical]) : null)

  const pick = (options) => {
    const on = options.filter(o => stateOf(o.id) === true)
    return on.length === 1 ? on[0].key : null
  }
  const policy = {}
  for (const p of PACKET_FIELD_MAP.policy) {
    const cur = stateOf(p.id)
    policy[p.id] = cur == null ? p.default : cur
  }
  return { representation: pick(REPRESENTATION), term: pick(TERM), policy }
}

// The decisions as field values. Every id the panel owns gets an explicit
// true/false so the send carries the choice; the mutex is structural — one
// option is on, its sibling is off — rather than something the sender maintains.
// The decisions as field values, keyed by the ids the TEMPLATE reports.
//
// Both sides of a mutex pair are always sent. That is what makes the pair
// mutually exclusive on the document: sending only the "on" side would leave
// yesterday's tick on the other box, and a packet claiming both exclusive and
// non-exclusive representation is worse than one claiming neither.
//
// Nothing else is included. A box this panel does not decide — CheckBox3, and
// every field behind the unnamed-fields toggle — is absent, not false, because
// BoldSign reads an explicit "false" as "clear the template's own tick".
export function packetTickValues({ representation = null, term = null, policy = {}, fields = null } = {}) {
  // With no field list, fall back to the canonical ids. Callers in the app
  // always pass fields; the fallback keeps the function usable on its own.
  const resolved = fields ? resolvePacketFieldIds({ fields }) : null
  const key = (id) => (resolved ? resolved[id] : id)

  const out = {}
  const set = (id, v) => { const k = key(id); if (k) out[k] = v }

  for (const o of REPRESENTATION) set(o.id, representation === o.key)
  for (const o of TERM) set(o.id, term === o.key)
  for (const p of PACKET_FIELD_MAP.policy) {
    set(p.id, policy?.[p.id] == null ? p.default : Boolean(policy[p.id]))
  }
  return out
}

// What is still missing before the packet can be placed or sent.
export function packetMissing({ representation = null, term = null } = {}) {
  const missing = []
  if (!representation) missing.push('Representation')
  if (!term) missing.push('Term')
  return missing
}

// True when the sender picked the fixed-date term, which is the only case with
// an end date to fill in.
export const wantsEndDate = (term) => term === 'fixed'

// Does the caption read off the PDF agree with the id this map assigns? Returns
// the disagreements — never shown to the sender, never used to override the map.
// A template edit that moves a box shows up here instead of silently locking the
// wrong term onto an agreement.
export function captionConflicts({ fields = [] } = {}) {
  // Only meaningful where the ID FALLBACK was used: a caption-resolved entry
  // agrees with the page by construction. This reports an id-matched field whose
  // printed caption says it is something else — the case the map gets wrong.
  const { by } = resolvePacketFields({ fields })
  const checks = ALL_PACKET_ENTRIES.filter(c => by[c.id] !== 'caption')
  const out = []
  for (const c of checks) {
    const f = (fields || []).find(x => norm(x?.id) === norm(c.id))
    const caption = String(f?.caption || '').trim()
    if (!f || !caption || !c.expect) continue          // nothing to check against
    if (!c.expect.test(caption)) out.push({ id: c.id, caption, expected: String(c.expect) })
  }
  return out
}

// ── The payload, checked before it goes ──────────────────────────────────────
// The panel's contract with the document, stated as assertions rather than left
// to be inferred from a diff: exactly one side of each pair is on, the policy
// row matches what the panel showed, and no field the panel does not own is
// present. Returns { rows, problems } — `rows` is [{ id, value }] in the shape
// BoldSign is addressed with, `problems` is empty when the payload is sound.
//
// This exists because the failure it catches is silent. BoldSign answers 2xx for
// a payload addressed to an id it does not have, and for one that clears a box
// the template had ticked; the only symptom is an editor that opens with the
// wrong boxes, long after the send screen has closed.
export function packetPayloadCheck({ representation = null, term = null, policy = {}, fields = [] } = {}) {
  const resolved = resolvePacketFieldIds({ fields })
  const values = packetTickValues({ representation, term, policy, fields })
  const rows = Object.entries(values).map(([id, v]) => ({ id, value: tickPayloadValue(v) }))

  const problems = []
  const on = (canonical) => {
    const id = resolved[canonical]
    return id ? values[id] === true : false
  }

  // Exactly one side of each pair.
  for (const [name, options] of [['Representation', REPRESENTATION], ['Term', TERM]]) {
    const lit = options.filter(o => on(o.id)).length
    if (lit !== 1) problems.push(`${name}: ${lit} of ${options.length} boxes are on — exactly one must be`)
  }

  // Both sides of each pair are present, or the other box keeps yesterday's tick.
  for (const o of [...REPRESENTATION, ...TERM]) {
    const id = resolved[o.id]
    if (!id) { problems.push(`${o.id} is not on this template — the choice would go nowhere`); continue }
    if (!(id in values)) problems.push(`${o.id} is missing from the payload — its box would keep its old value`)
  }

  // The policy row is what the panel showed.
  for (const p of PACKET_FIELD_MAP.policy) {
    const id = resolved[p.id]
    if (!id) continue
    const shown = policy?.[p.id] == null ? p.default : Boolean(policy[p.id])
    if (values[id] !== shown) problems.push(`${p.id} would be sent as ${values[id]} but the panel shows ${shown}`)
  }

  // Nothing the panel does not own.
  for (const u of PACKET_FIELD_MAP.untouched) {
    const id = resolved[u.id]
    if (id && id in values) problems.push(`${u.id} must not be sent — an explicit value clears the template's own tick`)
  }

  return { rows, problems }
}

// How a ticked box is addressed. Matches prefillFieldEntry/tickValue in
// boldsignFields.js, which is what actually builds the request — kept in one
// expression here so the debug line shows exactly what the payload carries.
// "on"/"off" is BoldSign's own spelling for a checkbox; "true" is silently
// ignored and leaves the box empty (see tickValue).
export const tickPayloadValue = (on) => (on ? 'on' : 'off')

// ── The tick state the document must end up in ───────────────────────────────
// Two things go wrong on the way from a template to a draft, and this is the one
// statement that settles both:
//
//   • a box the panel decided arrives unticked, and
//   • a box the TEMPLATE had ticked arrives cleared.
//
// Omitting a field was supposed to preserve it, and on the evidence it does not:
// a draft created from a template whose BUYER box is ticked came back with that
// box empty. Whatever the reason inside BoldSign, "say nothing and hope" is not
// a strategy that can be verified. So the CRM states the whole intended tick
// state instead, and the server reconciles the finished draft against it (see
// reconcileDocumentTicks in api/boldsign.js).
//
// Precedence: the panel's decisions win, because they are this packet's terms.
// Everything the template itself carries ticked is asserted as still ticked.
// A box that is neither is absent from the map and never touched — the panel has
// no opinion about it and an opinion is exactly what would clear it.
export function desiredTickState({ representation = null, term = null, policy = {}, fields = [] } = {}) {
  const out = {}
  // What the template already says. Only ticks — an unticked box the panel does
  // not own is left out, so nothing is ever cleared on this map's authority.
  for (const f of fields || []) {
    if (!f?.id) continue
    if (isTicked(f.value)) out[f.id] = true
  }
  // The panel's decisions, addressed by the ids the template reports.
  Object.assign(out, packetTickValues({ representation, term, policy, fields }))
  return out
}
