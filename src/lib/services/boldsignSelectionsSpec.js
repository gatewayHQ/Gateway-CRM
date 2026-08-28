// ─────────────────────────────────────────────────────────────────────────────
// BoldSign selections spec — PURE. No network, no fs, no browser globals.
//
// Turns a template's fields into the document an admin can actually name the
// packet's tick boxes from: every checkbox in the order it PRINTS, with its id,
// page, coordinates, role, current ticked state, and the boxes sharing its line.
//
// It runs in two places, which is why it lives here rather than in the script:
//   • scripts/boldsign-selections-spec.mjs — a whole-account sweep, run by
//     anyone holding the API key;
//   • api/boldsign.js, action `selections-spec` — the same sweep run by the
//     DEPLOYED CRM, which already holds the key, so an admin can download the
//     specs without the key being copied onto a laptop.
//
// The problem both exist to solve: BoldSign captions an unnamed box with its own
// auto id (`CheckBox1`, `CheckBox11`, `CheckBox4`) and returns fields in the
// order they were placed in the editor, which down a page is not the order they
// print in. Nothing in that list says which box is `(exclusive)` and which is
// `(non-exclusive)`, and ticking the wrong one locks the opposite term into an
// agreement somebody signs. Sorting by the fields' own geometry (see
// orderFieldsByPosition in ./boldsignFields.js) puts them back in the order the
// paper has them, which is the order a person can name them in.
//
// What this deliberately does NOT do is name a box. The words printed beside it
// are not in the API payload, so `short_label` comes out as TODO — a generated
// name that is plausible and wrong is the failure being designed out.
// ─────────────────────────────────────────────────────────────────────────────
import { isTickableField, orderFieldsByPosition, fieldPosition, fieldRows } from './boldsignFields.js'

// Roles + fields out of a `/template/properties` payload, flattened the same way
// `template-details` and scripts/audit-boldsign-templates.mjs flatten them:
// BoldSign returns fields at the top level AND nested under their role, and a
// field missed here is a box the spec never names.
export function readTemplateFields(data) {
  const rawRoles = data?.roles || data?.signerRoles || data?.templateRoles || []
  const roles = rawRoles.map((r, i) => ({
    index: Number(r.roleIndex ?? r.index ?? i + 1),
    name:  r.roleName || r.name || r.signerRole || `Role ${i + 1}`,
  }))

  const raw = []
  for (const f of (data?.formFields || data?.fields || [])) raw.push(f)
  for (const [i, r] of rawRoles.entries()) {
    const idx = Number(r?.roleIndex ?? r?.index ?? i + 1)
    for (const f of (r?.formFields || r?.fields || [])) raw.push({ roleIndex: idx, ...f })
  }

  const seen = new Set()
  const fields = raw.map(f => ({
    id:    f.id || f.fieldId || f.name,
    type:  f.fieldType || f.type,
    name:  f.name || '',
    label: f.label || f.placeholder || f.placeHolder || '',
    roleIndex: f.roleIndex != null ? Number(f.roleIndex) : (f.signerIndex != null ? Number(f.signerIndex) : null),
    page:   Number(f.pageNumber) || 1,
    bounds: f.bounds || null,
    value:  f.value != null ? String(f.value) : '',
  })).filter(f => {
    if (!f.id || seen.has(f.id)) return false
    seen.add(f.id)
    return true
  })

  return { roles, fields }
}

// A box counts as ALREADY SET when the template itself carries a ticked value —
// the state an agent sees printed before anybody touches the send screen. Same
// spellings the print path accepts (api/boldsign.js, isCheckedValue), because
// both are reading the same field off the same API.
const CHECKED = new Set(['true', 'on', 'yes', 'checked', '1', 'x'])
export const isAlreadySet = (v) => v === true || CHECKED.has(String(v ?? '').trim().toLowerCase())

// Boxes sharing one printed line are the strongest mutually-exclusive candidate
// the geometry can offer: a form writes "(exclusive) … (non-exclusive)" and
// "BUYER or SELLER" on one line. A CANDIDATE, never a conclusion — a line can
// just as easily hold two unrelated boxes — so the spec marks it for a human to
// confirm, and a box standing alone on its line gets no group at all.
export function mutexCandidates(tickFields) {
  const groups = new Map()
  let n = 0
  for (const row of fieldRows(tickFields)) {
    if (row.fields.length < 2) continue
    n += 1
    const key = `p${row.page}-row${n}`
    for (const f of row.fields) groups.set(f.id, key)
  }
  return groups
}

// Markdown table cells are pipe-delimited, so a caption containing a pipe would
// silently split into two columns and shift every value after it.
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|')

export function renderSpec({ template, roles = [], fields = [], today = new Date() } = {}) {
  const ticks = orderFieldsByPosition(fields.filter(f => isTickableField(f.type)))
  const mutex = mutexCandidates(ticks)
  const roleName = (i) => roles.find(r => r.index === Number(i))?.name || (i ? `Role ${i}` : 'unassigned')
  const unpositioned = ticks.filter(f => !fieldPosition(f))

  const rows = ticks.map((f, i) => {
    const pos = fieldPosition(f)
    const named = f.label || (f.name && f.name.toLowerCase() !== String(f.id).toLowerCase() ? f.name : '')
    return `| ${i + 1} | ${pos ? pos.page : '—'} | ${pos ? `${Math.round(pos.y)}, ${Math.round(pos.x)}` : '**no bounds**'} `
      + `| \`${esc(f.id)}\` | ${esc(named) || '—'} | ${esc(roleName(f.roleIndex))} `
      + `| ${isAlreadySet(f.value) ? '**yes**' : 'no'} | ${mutex.get(f.id) ? `\`${mutex.get(f.id)}\`` : '—'} | TODO | TODO |`
  })

  return `# ${template?.templateName || template?.name || 'Template'} — selections spec

- Template id: \`${template?.templateId || template?.id || 'unknown'}\`
- Tick boxes: **${ticks.length}**${unpositioned.length ? ` (${unpositioned.length} with no bounds — see below)` : ''}
- Already ticked in the template: **${ticks.filter(f => isAlreadySet(f.value)).length}**
- Generated ${today.toISOString().slice(0, 10)}

Rows are in **reading order** — page, then line, then left to right — which is the
order the boxes print, not the order BoldSign returns them in. Read the printed
form top to bottom and the rows line up with it one for one.

\`y, x\` is the box's top-left corner in BoldSign's own units, measured from the
top-left of the page. Two rows with the same \`y\` print on the same line.

| # | page | y, x | field_id | template's own name | role | already_set? | mutex candidate | short_label | owner |
|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n') || '| — | | | *no tick boxes on this template* | | | | | | |'}

**\`short_label\` and \`owner\` are left as TODO on purpose.** The words printed
beside a box are not in the API payload, so this cannot name a row without
guessing — and a plausible wrong name ("Exclusive" on the non-exclusive box) is
the failure that would reach a signed agreement. Open the packet next to this
table, name each row from the text beside it, and set \`owner\` to *sender locks*,
*locked on*, *locked off*, or *signer decides*.

Mutex candidates are boxes that print on the SAME LINE, which is how a form
normally writes alternatives. Confirm each against the printed text before
treating it as exclusive — a shared line is evidence, not proof.
${unpositioned.length ? `
**No bounds:** ${unpositioned.map(f => `\`${f.id}\``).join(', ')}. BoldSign returned these without
geometry, so they cannot be placed against the paper and are listed last. Click
each in the template editor to find it.
` : ''}`
}

// One document for a whole-account sweep. Each entry is { template, roles,
// fields }; templates with no tick box are dropped, because a spec listing
// nothing to select is a page an admin has to scroll past.
//
// `incomplete` says the template walk hit its runaway guard. It is stated at the
// TOP rather than omitted: a sweep that quietly stopped early looks exactly like
// an account with fewer templates, and an unlisted packet is one nobody knows to
// name.
export function renderSpecBundle(entries = [], { today = new Date(), incomplete = false } = {}) {
  const withTicks = entries.filter(e => (e?.fields || []).some(f => isTickableField(f.type)))
  const head = `# BoldSign selections specs

${withTicks.length} template${withTicks.length === 1 ? '' : 's'} with tick boxes, generated ${today.toISOString().slice(0, 10)}.
${incomplete ? `
**Incomplete.** The template listing stopped at its page guard, so this is not
every template in the account. Do not read a missing packet as one that has no
tick boxes.
` : ''}
${withTicks.map(e => `- ${e.template?.templateName || e.template?.name || e.template?.templateId}`).join('\n') || '- (none)'}
`
  if (!withTicks.length) return head
  return [head, ...withTicks.map(e => renderSpec({ ...e, today }))].join('\n\n---\n\n')
}
