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
import { isTickableField } from '../src/lib/services/boldsignFields.js'
import { readTemplateFields, renderSpec } from '../src/lib/services/boldsignSelectionsSpec.js'

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

// The spec itself — how a template's boxes are read and rendered — lives in
// src/lib/services/boldsignSelectionsSpec.js, because api/boldsign.js runs the
// same sweep for admins who would rather not copy the API key onto a laptop.
// What is left here is the part only a command line does: paging the account and
// writing files.

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
    const { roles, fields } = readTemplateFields(props)
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
