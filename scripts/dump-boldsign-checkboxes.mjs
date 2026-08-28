#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// dump-boldsign-checkboxes — what the send screen sees, and what it would write.
//
// WHY THIS EXISTS. The Prepare panel's checkbox behaviour has been debugged
// through screenshots, which is slow and has been wrong more than once. This
// prints the three things that settle it, for one template or one document:
//
//   1. every tickable field BoldSign reports — its id, page, role, and current
//      value (is it ticked on the template?);
//   2. the caption read off the PDF beside each box, which is what the panel
//      binds decisions to (src/lib/services/boldsignCaptions.js);
//   3. how each of the panel's decisions RESOLVES against this template, and the
//      exact payload the panel would send for a given choice.
//
// READ ONLY. Every call is a GET. Nothing is created, sent, or modified — safe to
// run against Live. The API key stays on the machine that runs it.
//
// Run:
//   BOLDSIGN_API_KEY=… node scripts/dump-boldsign-checkboxes.mjs --template=<id>
//   …--document=<id>          inspect a created draft instead of the template
//   …--rep=exclusive          which representation to simulate (default exclusive)
//   …--term=fixed             close | fixed (default close)
//   …--json                   machine-readable
// Exit: 0 printed, 2 could not run.
// ─────────────────────────────────────────────────────────────────────────────
import { extractPdfWords } from '../api/_lib/pdfText.js'
import { captionFields } from '../src/lib/services/boldsignCaptions.js'
import { isTickableField } from '../src/lib/services/boldsignFields.js'
import {
  resolvePacketFields, packetPayloadCheck, desiredTickState, seedPacketState,
} from '../src/lib/services/boldsignPacketPanel.js'

const API_BASE = process.env.BOLDSIGN_API_BASE || 'https://api.boldsign.com/v1'
const API_KEY  = process.env.BOLDSIGN_API_KEY

const argv = process.argv.slice(2)
const arg  = (name) => (argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || ''
const templateId = arg('template')
const documentId = arg('document')
const rep  = arg('rep')  || 'exclusive'
const term = arg('term') || 'close'
const asJson = argv.includes('--json')

async function boldsign(path, { raw = false } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-API-KEY': API_KEY, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return raw ? new Uint8Array(await res.arrayBuffer()) : await res.json()
}

// Flatten fields the same way api/boldsign.js `template-details` does, so what
// this prints is what the send screen actually receives.
function readFields(data) {
  const rawRoles = data.roles || data.signerRoles || data.templateRoles || data.signerDetails || []
  const raw = []
  for (const f of (data.formFields || data.fields || [])) raw.push(f)
  for (const [i, r] of rawRoles.entries()) {
    const idx = Number(r?.roleIndex ?? r?.index ?? i + 1)
    for (const f of (r?.formFields || r?.fields || [])) raw.push({ roleIndex: idx, ...f })
  }
  const seen = new Set()
  return raw.map(f => ({
    id:    f.id || f.fieldId || f.name,
    type:  f.fieldType || f.type,
    name:  f.name || '',
    label: f.label || f.placeholder || f.placeHolder || '',
    value: f.value != null ? String(f.value) : '',
    roleIndex: f.roleIndex != null ? Number(f.roleIndex) : null,
    page:  Number(f.pageNumber) || 1,
    bounds: f.bounds || null,
  })).filter(f => {
    if (!f.id || seen.has(f.id)) return false
    seen.add(f.id)
    return true
  })
}

async function main() {
  if (!API_KEY) {
    console.error('BOLDSIGN_API_KEY is not set. Run:\n'
      + '  BOLDSIGN_API_KEY=… node scripts/dump-boldsign-checkboxes.mjs --template=<id>')
    process.exit(2)
  }
  if (!templateId && !documentId) {
    console.error('Pass --template=<id> or --document=<id>.')
    process.exit(2)
  }

  const props = documentId
    ? await boldsign(`/document/properties?documentId=${encodeURIComponent(documentId)}`)
    : await boldsign(`/template/properties?templateId=${encodeURIComponent(templateId)}`)
  const fields = readFields(props)

  // Captions, exactly as the send screen derives them.
  let captions = {}
  let captionNote = ''
  try {
    const bytes = documentId
      ? await boldsign(`/document/download?documentId=${encodeURIComponent(documentId)}`, { raw: true })
      : await boldsign(`/template/download?templateId=${encodeURIComponent(templateId)}`, { raw: true })
    const { words, pages } = await extractPdfWords(bytes)
    if (!words.length) captionNote = 'the PDF parsed but carried no extractable text (a scan?)'
    else {
      // Bounds may not be points. Try the two mappings BoldSign uses and keep the
      // one that captions more boxes — the send screen resolves this from the
      // page size instead, but this is a diagnostic and more captions is better.
      let best = { captions: {}, scale: null }
      for (const scale of [1, 0.75]) {
        const scaled = fields.filter(f => f.bounds).map(f => ({
          id: f.id, page: f.page,
          bounds: {
            x: Number(f.bounds.x) * scale, y: Number(f.bounds.y) * scale,
            width: Number(f.bounds.width) * scale, height: Number(f.bounds.height) * scale,
          },
        }))
        const got = captionFields({ fields: scaled, words })
        if (Object.keys(got).length > Object.keys(best.captions).length) best = { captions: got, scale }
      }
      captions = best.captions
      captionNote = `${Object.keys(captions).length} of ${fields.length} fields captioned at scale ${best.scale} (pages: ${pages.length})`
    }
  } catch (err) {
    captionNote = `could not read the PDF: ${err.message}`
  }

  const withCaptions = fields.map(f => ({ ...f, caption: captions[f.id]?.caption || '' }))
  const ticks = withCaptions.filter(f => isTickableField(f.type))
  const { ids, by, ambiguous } = resolvePacketFields({ fields: withCaptions })
  const payload = packetPayloadCheck({ representation: rep, term, fields: withCaptions })
  const desired = desiredTickState({ representation: rep, term, fields: withCaptions })
  const seeded  = seedPacketState({ fields: withCaptions })

  if (asJson) {
    console.log(JSON.stringify({
      source: documentId ? { documentId } : { templateId },
      captionNote, fields: withCaptions, ticks, binding: { ids, by, ambiguous },
      simulated: { representation: rep, term }, payload, desired, seeded,
    }, null, 2))
    return
  }

  const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
  console.log(`\n${documentId ? 'DOCUMENT' : 'TEMPLATE'} ${documentId || templateId}`)
  console.log(`Captions: ${captionNote}`)
  console.log(`\nTICKABLE FIELDS (${ticks.length})`)
  console.log(`${pad('id', 22)} ${pad('pg', 3)} ${pad('role', 5)} ${pad('ticked', 7)} caption`)
  console.log('-'.repeat(100))
  for (const f of ticks.sort((a, b) => a.page - b.page || (a.bounds?.y || 0) - (b.bounds?.y || 0))) {
    console.log(`${pad(f.id, 22)} ${pad(f.page, 3)} ${pad(f.roleIndex ?? '-', 5)} ${pad(f.value ? f.value : '', 7)} ${f.caption || '(nothing printed beside it)'}`)
  }

  console.log(`\nHOW THE PANEL BINDS (simulating ${rep} + term ${term})`)
  for (const [canonical, id] of Object.entries(ids)) {
    console.log(`  ${pad(canonical, 12)} → ${pad(id, 22)} by ${by[canonical]}`)
  }
  const unresolved = ['CheckBox1', 'CheckBox2', 'CheckBox3', 'CheckBox4', 'CheckBox5', 'CheckBox6', 'CheckBox7', 'CheckBox8', 'CheckBox9']
    .filter(c => !ids[c])
  if (unresolved.length) console.log(`  UNRESOLVED (no box on this template): ${unresolved.join(', ')}`)
  for (const [c, others] of Object.entries(ambiguous)) console.log(`  AMBIGUOUS ${c}: also ${others.join(', ')}`)

  console.log(`\nPANEL WOULD OPEN AS: representation=${seeded.representation} term=${seeded.term} policy=${JSON.stringify(seeded.policy)}`)
  console.log(`\nDECISIONS SENT (${payload.rows.length}): ${payload.rows.map(r => `${r.id}=${r.value}`).join(' ') || '(none)'}`)
  if (payload.problems.length) for (const p of payload.problems) console.log(`  PROBLEM: ${p}`)
  console.log(`\nEVERY TICK SENT (${Object.keys(desired).length}): ${Object.entries(desired).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(' ') || '(none)'}`)
  console.log('')
}

main().catch(err => { console.error(`\nFailed: ${err.message}\n`); process.exit(2) })
