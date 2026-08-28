#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// boldsign-selections-spec — writes one selections spec per BoldSign template,
// listing every tick box in the order it PRINTS, so each row can be named
// against the paper instead of guessed at.
//
// The problem it solves: BoldSign captions an unnamed box with its auto id
// (`CheckBox1`, `CheckBox11`, `CheckBox4`) and returns fields in the order they
// were placed in the editor, which is not the order they appear on the page. An
// agency packet reaches the send screen as fourteen rows reading
// "Checkbox1 · CheckBox1", none of which says whether it is the "(exclusive)"
// box or the "(non-exclusive)" one. Naming them from that list is a coin flip,
// and calling it wrong locks the opposite term into a signed agreement.
//
// `bounds` settles it. BoldSign measures from the top-left of the page, so
// sorting by page, then line, then left-to-right (orderFieldsByPosition, shared
// with the send screen) produces the same sequence a person reads the form in.
// Print that next to the printed form and every row is identifiable by
// inspection — no clicking through the editor, no guessing from ids.
//
// What it CANNOT do: read the words printed beside a box. The PDF's text is not
// in the API payload, so `short_label` is emitted as a TODO for a human (or an
// agent with the packet open) to fill in. That is deliberate — a generated name
// would be exactly the plausible-but-wrong artifact this whole file exists to
// prevent.
//
// Read-only: GETs only, changes nothing in BoldSign.
//
// Run:  BOLDSIGN_API_KEY=… npm run selections:spec
//       …-- --template=ID    just one template
//       …-- --out=DIR        default docs/boldsign-selections
//       …-- --stdout         print instead of writing files
// Exit: 0 wrote specs, 2 could not run (no key, API error).
// ─────────────────────────────────────────────────────────────────────────────
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isTickableField, orderFieldsByPosition, fieldPosition, fieldRows } from '../src/lib/services/boldsignFields.js'

const API_BASE = process.env.BOLDSIGN_API_BASE || 'https://api.boldsign.com/v1'
const API_KEY  = process.env.BOLDSIGN_API_KEY
const PAGE_SIZE = 50
const PAGE_LIMIT = 40

const argv = process.argv.slice(2)
const onlyTemplate = (argv.find(a => a.startsWith('--template=')) || '').split('=')[1] || null
const outDir       = (argv.find(a => a.startsWith('--out=')) || '').split('=')[1] || 'docs/boldsign-selections'
const toStdout     = argv.includes('--stdout')

async function boldsign(p) {
  const res = await fetch(`${API_BASE}${p}`, { headers: { 'X-API-KEY': API_KEY, Accept: 'application/json' } })
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${p} → HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
  return text ? JSON.parse(text) : {}
}

async function listTemplates() {
  const out = []
  for (let page = 1; page <= PAGE_LIMIT; page++) {
    const data  = await boldsign(`/template/list?page=${page}&pageSize=${PAGE_SIZE}`)
    const batch = data.result || data.templates || []
    out.push(...batch)
    if (batch.length < PAGE_SIZE) return { templates: out, complete: true }
  }
  return { templates: out, complete: false }
}

// Roles + fields, flattened exactly the way `template-details` and the audit
// script flatten them: BoldSign returns fields at the top level AND nested under
// their role, and a field missed here is a box the spec never names.
export function readTemplate(data) {
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
// the state an agent sees printed on the PDF before anybody touches the send
// screen. Same spellings the print path accepts (api/boldsign.js,
// isCheckedValue), because both are reading the same field off the same API.
const CHECKED = new Set(['true', 'on', 'yes', 'checked', '1', 'x'])
export const isAlreadySet = (v) => v === true || CHECKED.has(String(v ?? '').trim().toLowerCase())

// Rows sharing one printed line are the strongest mutually-exclusive candidate
// the geometry can offer: forms put "(exclusive) … (non-exclusive)" and
// "BUYER or SELLER" on one line. It is a CANDIDATE, never a conclusion — a row
// can just as easily be two unrelated boxes — so the spec marks it for a human
// to confirm, one group per line, and single-box lines get no group at all.
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

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|')

export function renderSpec({ template, roles, fields }) {
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
- Generated by \`npm run selections:spec\` on ${new Date().toISOString().slice(0, 10)}

Rows are in **reading order** — page, then line, then left to right — which is the
order the boxes print, not the order BoldSign returns them in. Read the printed
form top to bottom and the rows line up with it one for one.

\`y, x\` is the box's top-left corner in BoldSign's own units, measured from the
top-left of the page. Two rows with the same \`y\` print on the same line.

| # | page | y, x | field_id | template's own name | role | already_set? | mutex candidate | short_label | owner |
|---|---|---|---|---|---|---|---|---|---|
${rows.join('\n') || '| — | | | *no tick boxes on this template* | | | | | | |'}

**\`short_label\` and \`owner\` are left as TODO on purpose.** The words printed
beside a box are not in the API payload, so this script cannot name a row without
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

async function main() {
  if (!API_KEY) {
    console.error('BOLDSIGN_API_KEY is not set. Copy it from Settings → BoldSign (or .env) and re-run:\n'
      + '  BOLDSIGN_API_KEY=… npm run selections:spec')
    process.exit(2)
  }

  let templates
  try {
    if (onlyTemplate) {
      templates = [{ templateId: onlyTemplate, templateName: onlyTemplate }]
    } else {
      const list = await listTemplates()
      templates = list.templates
      if (!list.complete) console.warn(`More than ${PAGE_SIZE * PAGE_LIMIT} templates — only the first page range was read.`)
    }
  } catch (e) {
    console.error(`Could not list templates: ${e.message}`)
    process.exit(2)
  }

  if (!toStdout) await mkdir(outDir, { recursive: true })
  const written = []

  for (const t of templates) {
    const id = t.templateId || t.id
    if (!id) continue
    let props
    try {
      props = await boldsign(`/template/properties?templateId=${encodeURIComponent(id)}`)
    } catch (e) {
      console.error(`${id}: ${e.message}`)
      continue
    }
    const { roles, fields } = readTemplate(props)
    const template = { templateId: id, templateName: props.templateName || props.name || t.templateName || id }
    if (!fields.some(f => isTickableField(f.type))) continue    // nothing to select on this one

    const md = renderSpec({ template, roles, fields })
    if (toStdout) { console.log(md); console.log('\n---\n'); continue }

    const slug = String(template.templateName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'template'
    const file = path.join(outDir, `${slug}-${String(id).slice(0, 8)}.md`)
    await writeFile(file, md)
    written.push(file)
  }

  if (written.length) console.log(`Wrote ${written.length} spec${written.length === 1 ? '' : 's'}:\n${written.map(f => `  ${f}`).join('\n')}`)
  else if (!toStdout) console.log('No template carries a tick box — nothing to spec.')
}

if (import.meta.url === `file://${process.argv[1]}`) main()
