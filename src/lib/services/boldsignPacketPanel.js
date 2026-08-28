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
  // Ticked on every buyer packet and never shown: the client is the buyer.
  locked: [{ id: 'CheckBox3', value: true, expect: /^(prospective\s+)?buyer\b/i }],
}

const REPRESENTATION = PACKET_FIELD_MAP.representation.options
const TERM = PACKET_FIELD_MAP.term.options

// Every field id this panel controls. A tick box outside this set is left alone.
export const PACKET_FIELD_IDS = new Set([
  ...REPRESENTATION.map(o => o.id),
  ...TERM.map(o => o.id),
  ...PACKET_FIELD_MAP.policy.map(p => p.id),
  ...PACKET_FIELD_MAP.locked.map(l => l.id),
])

export const isPacketField = (id) => PACKET_FIELD_IDS.has(String(id || ''))

const tickedIn = (fields, id) => {
  const f = (fields || []).find(x => x?.id === id)
  return f ? isTicked(f.value) : null
}

// The panel's opening state, read from what the template already carries.
// Representation and term start unset unless the template has exactly one of the
// pair ticked — a template with both or neither ticked is not stating a choice,
// and pre-selecting one for the sender would be this panel deciding a term.
export function seedPacketState({ fields = [] } = {}) {
  const pick = (options) => {
    const on = options.filter(o => tickedIn(fields, o.id) === true)
    return on.length === 1 ? on[0].key : null
  }
  const policy = {}
  for (const p of PACKET_FIELD_MAP.policy) {
    const cur = tickedIn(fields, p.id)
    policy[p.id] = cur == null ? p.default : cur
  }
  return { representation: pick(REPRESENTATION), term: pick(TERM), policy }
}

// The decisions as field values. Every id the panel owns gets an explicit
// true/false so the send carries the choice; the mutex is structural — one
// option is on, its sibling is off — rather than something the sender maintains.
export function packetTickValues({ representation = null, term = null, policy = {} } = {}) {
  const out = {}
  for (const o of REPRESENTATION) out[o.id] = representation === o.key
  for (const o of TERM) out[o.id] = term === o.key
  for (const p of PACKET_FIELD_MAP.policy) {
    out[p.id] = policy?.[p.id] == null ? p.default : Boolean(policy[p.id])
  }
  for (const l of PACKET_FIELD_MAP.locked) out[l.id] = Boolean(l.value)
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
  const checks = [
    ...REPRESENTATION, ...TERM,
    ...PACKET_FIELD_MAP.policy, ...PACKET_FIELD_MAP.locked,
  ]
  const out = []
  for (const c of checks) {
    const f = (fields || []).find(x => x?.id === c.id)
    const caption = String(f?.caption || '').trim()
    if (!f || !caption || !c.expect) continue          // nothing to check against
    if (!c.expect.test(caption)) out.push({ id: c.id, caption, expected: String(c.expect) })
  }
  return out
}
