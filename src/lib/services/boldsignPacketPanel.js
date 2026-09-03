// ─────────────────────────────────────────────────────────────────────────────
// boldsignPacketPanel — the decisions a packet asks its sender for.
//
// WHAT A PANEL IS. Some agreements cannot be sent until the sender has decided
// something that lives on the form as a tick box: which representation, which
// term, which agency policy. Those are terms of the agreement, not the signer's
// input, so the send screen asks for them directly — as radios and toggles —
// and writes the answer onto the template's own checkboxes.
//
// WHY THIS IS DATA AND NOT A CONSTANT. It used to be one hard-coded map of
// field ids (`CheckBox1` … `CheckBox9`) applied to EVERY template the send
// screen opened. Those ids are not names an admin chose: BoldSign auto-assigns
// `CheckBox1`, `CheckBox2`, … on every template it creates, so the ids are not
// unique to the packet the map was written for. Registering a second template
// with checkboxes — a seller listing agreement, a disclosure — meant the buyer
// packet's Representation/Term/Policy answers were written onto that template's
// first nine boxes, silently, as locked terms of a signed agreement. The same
// map also gated BOTH send buttons on Representation and Term, so a listing
// agreement could not be saved as a draft until the agent answered two buyer-
// agency questions that did not apply to it.
//
// So a panel is now declared PER PACKET (`form_packets.signing_panel`, migration
// 0043) and is only ever applied to the template it was declared for.
//
// TWO MODES, AND THE DIFFERENCE MATTERS.
//   • DECLARED  — the packet row carries a `signing_panel`. An admin has
//     asserted that these ids mean these things on this template, so a
//     validation failure is BLOCKING: the send stops and names the field.
//     Silently dropping a panel an admin declared would send the agreement
//     without the terms it exists to set.
//   • INFERRED  — no declaration, but a built-in panel matches the packet's
//     (state, transaction_type). It is applied ONLY if it validates completely
//     against the live template: every id present, tickable, and captioned the
//     way the panel expects. Nobody asserted it, so a validation failure means
//     "this isn't that packet" and the panel is simply not shown. This is what
//     keeps the Iowa buyer packet working on a database where 0043 has not been
//     applied yet, without ever reaching another template by accident.
//
// Everything here is a pure function of its arguments — no network, no Supabase,
// no browser globals — so the same rules run in the send screen, in tests, and
// in scripts/audit-boldsign-templates.mjs.
// ─────────────────────────────────────────────────────────────────────────────
import { isTicked } from './boldsignSelections.js'

// ── Spec shape ───────────────────────────────────────────────────────────────
// A panel is { version, key, groups: [...] }. Three kinds of group:
//
//   choice  — radios. Exactly one option is on; every sibling is written off.
//             `required: true` blocks the send until one is picked.
//   toggles — independent checkboxes shown as state, each with its own default.
//   fixed   — never rendered; each option is written at its stated value. The
//             "this is a buyer packet, so the BUYER box is ticked" case.
//
// Every option names ONE `fieldId` and may carry `expect`, a regex SOURCE STRING
// (not a RegExp — a panel round-trips through jsonb) matched against the caption
// read off the page. That cross-check is the only thing standing between a
// template edit and a wrong term on a signed agreement, so it is validated at
// load time and, for a declared panel, it blocks.
export const PANEL_GROUP_KINDS = Object.freeze(['choice', 'toggles', 'fixed'])

// Compile a stored regex source without letting a bad one take the screen down.
// An uncompilable pattern is reported as a spec defect, not thrown.
function compileExpect(src) {
  if (src == null || src === '') return { re: null, error: null }
  if (src instanceof RegExp) return { re: src, error: null }
  try { return { re: new RegExp(String(src), 'i'), error: null } }
  catch (err) { return { re: null, error: err.message } }
}

const str = (v) => String(v ?? '').trim()

/**
 * Validate and normalize a stored panel spec.
 *
 * Returns { panel, errors }. `panel` is null when the spec is unusable — an
 * empty object, no groups, or every group malformed — so a caller can treat
 * "no panel" and "broken panel" the same way for rendering while still
 * reporting `errors` to whoever can fix them.
 *
 * Defects are collected rather than thrown: a panel with one bad group should
 * report that group, not cost the agent the whole send screen.
 */
export function normalizePanel(raw) {
  const errors = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { panel: null, errors: raw == null ? [] : [{ code: 'not_an_object' }] }
  }

  const key = str(raw.key) || 'panel'
  const groups = []
  const seenFieldIds = new Set()
  const seenGroupKeys = new Set()

  for (const [i, g] of (Array.isArray(raw.groups) ? raw.groups : []).entries()) {
    const gKey = str(g?.key) || `group_${i + 1}`
    const kind = PANEL_GROUP_KINDS.includes(str(g?.kind)) ? str(g.kind) : null
    if (!kind) { errors.push({ code: 'bad_group_kind', group: gKey, kind: str(g?.kind) }); continue }
    if (seenGroupKeys.has(gKey)) { errors.push({ code: 'duplicate_group', group: gKey }); continue }

    const options = []
    for (const [j, o] of (Array.isArray(g?.options) ? g.options : []).entries()) {
      const fieldId = str(o?.fieldId ?? o?.id)
      if (!fieldId) { errors.push({ code: 'option_without_field', group: gKey, index: j }); continue }
      // One field, one meaning. Two options pointing at the same box would make
      // the mutex incoherent and the written value order-dependent.
      if (seenFieldIds.has(fieldId)) { errors.push({ code: 'duplicate_field', group: gKey, fieldId }); continue }
      seenFieldIds.add(fieldId)

      const { re, error } = compileExpect(o?.expect)
      if (error) errors.push({ code: 'bad_expect', group: gKey, fieldId, message: error })

      options.push({
        key:     str(o?.key) || fieldId,
        label:   str(o?.label) || fieldId,
        fieldId,
        expect:  re,
        // `toggles` only. `fixed` uses `value`.
        default: Boolean(o?.default),
        value:   o?.value === undefined ? true : Boolean(o.value),
        // A CRM token this option makes relevant — the fixed-date term reveals
        // the end-date input. Kept as a token key so the modal stays generic.
        revealToken: str(o?.revealToken) || null,
      })
    }
    if (!options.length) { errors.push({ code: 'group_without_options', group: gKey }); continue }
    if (kind === 'choice' && options.length < 2) {
      errors.push({ code: 'choice_needs_two_options', group: gKey })
      continue
    }

    groups.push({
      key: gKey,
      kind,
      label: str(g?.label) || gKey,
      required: kind === 'choice' ? g?.required !== false : false,
      collapsed: Boolean(g?.collapsed),
      help: str(g?.help) || '',
      options,
    })
  }

  if (!groups.length) return { panel: null, errors }
  return { panel: { version: Number(raw.version) || 1, key, groups }, errors }
}

/** Every field id this panel writes to. A box outside this set is left alone. */
export function panelFieldIds(panel) {
  const out = new Set()
  for (const g of panel?.groups || []) for (const o of g.options) out.add(o.fieldId)
  return out
}

export const isPanelField = (panel, id) => panelFieldIds(panel).has(str(id))

// ── Validation against the live template ─────────────────────────────────────
// A panel is a claim about a specific document. This checks the claim against
// what BoldSign actually reports for the template the agent selected.
//
// Severity is the whole point:
//   blocking — the panel would write to a field that does not exist, is not a
//              tick box, or whose printed meaning contradicts the panel. Any of
//              those puts a wrong term on an agreement.
//   warning  — the page carries no caption for the box, so the cross-check
//              could not run. Real (scanned forms, image-only pages) and not a
//              reason to stop a send.
const TICKABLE = new Set(['checkbox', 'radiobutton', 'radio'])

export function validatePanel({ panel, fields = [] } = {}) {
  const blocking = []
  const warnings = []
  if (!panel) return { ok: true, blocking, warnings }

  const byId = new Map((fields || []).filter(f => f?.id).map(f => [String(f.id), f]))

  for (const g of panel.groups) {
    for (const o of g.options) {
      const f = byId.get(o.fieldId)
      if (!f) {
        blocking.push({ code: 'missing_field', group: g.key, groupLabel: g.label, option: o.label, fieldId: o.fieldId })
        continue
      }
      if (!TICKABLE.has(String(f.type || '').toLowerCase().replace(/[\s_-]+/g, ''))) {
        blocking.push({ code: 'not_tickable', group: g.key, groupLabel: g.label, option: o.label, fieldId: o.fieldId, type: String(f.type || 'unknown') })
        continue
      }
      if (!o.expect) { warnings.push({ code: 'unverifiable', group: g.key, option: o.label, fieldId: o.fieldId }); continue }
      const caption = str(f.caption)
      if (!caption) { warnings.push({ code: 'no_caption', group: g.key, option: o.label, fieldId: o.fieldId }); continue }
      if (!o.expect.test(caption)) {
        blocking.push({
          code: 'caption_conflict', group: g.key, groupLabel: g.label,
          option: o.label, fieldId: o.fieldId, caption,
        })
      }
    }
  }
  return { ok: blocking.length === 0, blocking, warnings }
}

/**
 * Pick the panel that applies to a packet, and say how confident that is.
 *
 * Returns { panel, source, validation, specErrors }:
 *   source 'declared' — from `form_packets.signing_panel`. Validation failures
 *                       are the caller's to surface and block on.
 *   source 'builtin'  — a built-in candidate that validated CLEANLY against
 *                       this template. Anything less and it is not returned at
 *                       all, because nobody asserted it applies here.
 *   source null       — no panel. The send proceeds with no decisions asked and
 *                       no tick boxes written; the template's own values stand.
 */
export function resolvePanel({ packet, fields = [] } = {}) {
  const declared = normalizePanel(packet?.signing_panel)
  if (declared.panel) {
    return {
      panel: declared.panel,
      source: 'declared',
      validation: validatePanel({ panel: declared.panel, fields }),
      specErrors: declared.errors,
    }
  }

  const candidate = builtInPanelFor(packet)
  if (candidate) {
    const validation = validatePanel({ panel: candidate, fields })
    // Cleanly validated means: nothing blocking AND every option was actually
    // checked against a caption. An inferred panel that could not be verified
    // is not applied — "probably the Iowa packet" is not good enough to lock
    // terms onto an agreement nobody declared it for.
    if (validation.ok && !validation.warnings.length) {
      return { panel: candidate, source: 'builtin', validation, specErrors: [] }
    }
  }
  return { panel: null, source: null, validation: { ok: true, blocking: [], warnings: [] }, specErrors: declared.errors }
}

// ── State ────────────────────────────────────────────────────────────────────
// Panel state is `{ [groupKey]: value }` — an option key for a choice group, a
// { fieldId: boolean } map for toggles. `fixed` groups hold no state: their
// value is in the spec.

/**
 * The panel's opening state, read from what the template already carries.
 *
 * A choice group starts UNSET unless the template has exactly one of its
 * options ticked. Both ticked, or neither, is not the form stating a choice,
 * and pre-selecting one for the sender would be this panel deciding a term of
 * the agreement on their behalf.
 */
export function seedPanelState({ panel, fields = [] } = {}) {
  const state = {}
  if (!panel) return state
  // THREE answers, not two. A box the template does not have and a box the
  // template carries with no value at all are both the form SAYING NOTHING, and
  // must fall through to the spec's default. Collapsing them to `false` — which
  // is what `isTicked(undefined)` does — reads silence as a deliberate "off",
  // so a packet authored with appointed agency on opened with it switched off
  // and the agent had to know to turn it back on.
  const tickedIn = (id) => {
    const f = (fields || []).find(x => x?.id === id)
    if (!f) return null
    if (f.value == null || String(f.value).trim() === '') return null
    return isTicked(f.value)
  }
  for (const g of panel.groups) {
    if (g.kind === 'choice') {
      const on = g.options.filter(o => tickedIn(o.fieldId) === true)
      state[g.key] = on.length === 1 ? on[0].key : null
    } else if (g.kind === 'toggles') {
      const map = {}
      for (const o of g.options) {
        const cur = tickedIn(o.fieldId)
        map[o.fieldId] = cur == null ? o.default : cur
      }
      state[g.key] = map
    }
  }
  return state
}

/**
 * The decisions as field values — every id the panel owns gets an explicit
 * true/false, so the choice travels with the send instead of being left to
 * whoever opens the document. The mutex is structural: one option on means
 * every sibling off, with no state the sender has to reconcile.
 *
 * Writes NOTHING for a field the panel does not own.
 */
export function panelTickValues({ panel, state = {} } = {}) {
  const out = {}
  if (!panel) return out
  for (const g of panel.groups) {
    if (g.kind === 'choice') {
      const picked = state?.[g.key]
      for (const o of g.options) out[o.fieldId] = picked === o.key
    } else if (g.kind === 'toggles') {
      const map = state?.[g.key] || {}
      for (const o of g.options) out[o.fieldId] = map[o.fieldId] == null ? o.default : Boolean(map[o.fieldId])
    } else {
      for (const o of g.options) out[o.fieldId] = Boolean(o.value)
    }
  }
  return out
}

/** Required choice groups with nothing picked — what still blocks the send. */
export function panelMissing({ panel, state = {} } = {}) {
  if (!panel) return []
  return panel.groups
    .filter(g => g.kind === 'choice' && g.required && !state?.[g.key])
    .map(g => g.label)
}

/**
 * CRM tokens the current answers make relevant — the fixed-date term reveals
 * the representation end date, and only then. Returned as token keys so the
 * send screen stays generic and a new panel needs no code change here.
 */
export function revealedTokens({ panel, state = {} } = {}) {
  const out = []
  if (!panel) return out
  for (const g of panel.groups) {
    if (g.kind !== 'choice') continue
    const picked = state?.[g.key]
    for (const o of g.options) if (o.revealToken && picked === o.key) out.push(o.revealToken)
  }
  return out
}

/** One sentence per blocking defect, in words the person reading them can act on. */
export function describePanelProblem(p) {
  switch (p?.code) {
    case 'missing_field':
      return `This form no longer has the box "${p.option}" (${p.fieldId}) that ${p.groupLabel} is set up to tick.`
    case 'not_tickable':
      return `"${p.option}" (${p.fieldId}) is a ${p.type} on this form, not a tick box, so ${p.groupLabel} cannot be set from here.`
    case 'caption_conflict':
      return `"${p.option}" is set up to tick ${p.fieldId}, but that box is printed beside “${p.caption}” on the page — they no longer agree.`
    default:
      return `${p?.groupLabel || 'This form'} could not be verified against the document (${p?.code || 'unknown'}).`
  }
}

// ── Built-in panels ──────────────────────────────────────────────────────────
// Declared here, in code, for two reasons: they seed migration 0043, and they
// are the inferred fallback described at the top of this file — applied only to
// a template that validates against them completely.
//
// The Iowa buyer agency packet. Field ids and printed meanings come from the
// verify table in docs/ia-buyer-packet-selections.md; the `expect` patterns are
// what re-checks each id against the page at send time.
export const IA_BUYER_AGENCY_PANEL = Object.freeze({
  version: 1,
  key: 'ia_buyer_agency_v1',
  groups: [
    {
      key: 'representation', kind: 'choice', label: 'Representation', required: true,
      options: [
        // The negative lookahead is the point: "exclusive" is a substring of
        // "non-exclusive", so a bare /exclusive/ accepts the sibling box's
        // caption and the cross-check goes quiet on exactly the swap it exists
        // to catch.
        { key: 'exclusive',     label: 'Exclusive',     fieldId: 'CheckBox1',  expect: '^(?!.*non-?\\s?exclusive).*\\bexclusive\\b' },
        { key: 'non-exclusive', label: 'Non-exclusive', fieldId: 'CheckBox11', expect: 'non-?\\s?exclusive' },
      ],
    },
    // NO TERM GROUP. It used to map Term A/B onto CheckBox8 and CheckBox9, and
    // docs/ia-buyer-packet-selections.md records those as two boxes on PAGE 9 —
    // out of scope, and ALREADY TICKED on the template. Ticking them as "the term
    // of this agreement" would have written a term onto the wrong clause of a
    // signed agreement. The spec's resolution is that §6.A / §6.B become **Labels**
    // carrying an `X` (see "Term A/B as Labels" in that doc), which is a template
    // change; until it is made there is no honest checkbox for the term and this
    // panel does not invent one.
    {
      key: 'policy', kind: 'toggles', label: 'Policy', collapsed: true,
      help: 'The packet is authored with appointed agency and consensual dual agency on.',
      options: [
        { key: 'single_seller', label: 'Single seller',    fieldId: 'CheckBox12', default: false, expect: 'single\\s+seller\\s+agency' },
        { key: 'single_buyer',  label: 'Single buyer',     fieldId: 'CheckBox13', default: false, expect: 'single\\s+buyer\\s+agency' },
        { key: 'appointed',     label: 'Appointed agency', fieldId: 'CheckBox6',  default: true,  expect: 'appointed\\s+agency' },
        { key: 'dual',          label: 'Consensual dual',  fieldId: 'CheckBox7',  default: true,  expect: 'consensual\\s+dual\\s+agency' },
      ],
    },
    {
      // Ticked on every buyer packet and never shown: the client is the buyer.
      key: 'party', kind: 'fixed',
      options: [{ key: 'buyer', label: 'Party: Buyer', fieldId: 'CheckBox2', value: true, expect: '^(prospective\\s+)?buyer\\b' }],
    },
  ],
})

// Which built-in panel, if any, is a CANDIDATE for a packet. Candidacy is not
// application: resolvePanel() only uses it if it validates cleanly against the
// live template, so a second Iowa buyer packet with different boxes gets no
// panel rather than the wrong one.
const BUILT_IN_BY_SCOPE = [
  { state: 'IA', transactionType: 'buyer', panel: IA_BUYER_AGENCY_PANEL },
]

export function builtInPanelFor(packet) {
  const state = String(packet?.state || '').trim().toUpperCase()
  const type  = String(packet?.transaction_type || '').trim().toLowerCase()
  const hit = BUILT_IN_BY_SCOPE.find(b => b.state === state && b.transactionType === type)
  return hit ? normalizePanel(hit.panel).panel : null
}
