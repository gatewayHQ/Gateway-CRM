#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// audit-boldsign-templates — sweeps every BoldSign template in the account and
// reports the fields that will not behave the way the document reads.
//
// Two defects, both invisible from inside the BoldSign editor because both look
// perfectly fine there (see docs/boldsign-integration.md, "Prefilled data every
// signer must see"):
//
//   WRONG-NAME  A `Name` field used for somebody other than its own signer.
//               BoldSign always prints the assigned signer's name in a Name
//               field and silently discards any value sent for it, so an
//               "Appointed Agent" Name field sitting on the Seller role prints
//               the SELLER's name. Not a blank — a plausible wrong answer.
//               → delete it, place a Label in the same spot.
//
//   HIDDEN      A value we prefill sitting on a role-scoped field. BoldSign only
//               reveals a signer's fields to the other parties once that signer
//               has finished, so everyone ahead of them reads a blank.
//               → make it a Label, or accept sequential visibility and move it
//                 to the FIRST signer read-only.
//
// The send modal already reports both for the one template an agent is using.
// This is the account-wide sweep — run it after any template edit, and to build
// the remediation list in the first place.
//
// Read-only: it performs GETs and changes nothing. Field types cannot be changed
// through the API (or in the editor) at all, so remediation is by hand — the
// report prints the page and coordinates of each field so the replacement can be
// placed where the original was.
//
// Run:  BOLDSIGN_API_KEY=… node scripts/audit-boldsign-templates.mjs
//       …--json          machine-readable, for diffing between runs
//       …--all           also list the healthy fields, not just the defects
//       …--template=ID   audit one template instead of the whole account
// Exit: 0 clean, 1 defects found, 2 could not run (no key, API error).
// ─────────────────────────────────────────────────────────────────────────────
import {
  isSignerBoundField, isSharedField, isTickableField, isFillableField,
  fieldTokenKey, SHARED_PREFILL_TOKENS,
} from '../src/lib/services/boldsignFields.js'

const API_BASE = process.env.BOLDSIGN_API_BASE || 'https://api.boldsign.com/v1'
const API_KEY  = process.env.BOLDSIGN_API_KEY
const PAGE_SIZE = 50
const PAGE_LIMIT = 40          // same guard as listAllTemplates() in api/boldsign.js

const argv = process.argv.slice(2)
const asJson  = argv.includes('--json')
const showAll = argv.includes('--all')
const onlyTemplate = (argv.find(a => a.startsWith('--template=')) || '').split('=')[1] || null

async function boldsign(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'X-API-KEY': API_KEY, Accept: 'application/json' },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
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

// Roles + fields for one template, flattened the same way the app's
// `template-details` action does it: BoldSign returns a template's fields at the
// top level, but role-scoped ones can also come back nested on their role, and a
// field missed here is a field the audit never sees.
function readTemplate(data) {
  const rawRoles = data.roles || data.signerRoles || data.templateRoles || []
  const roles = rawRoles.map((r, i) => ({
    index: Number(r.roleIndex ?? r.index ?? i + 1),
    name:  r.roleName || r.name || r.signerRole || `Role ${i + 1}`,
  }))

  const raw = []
  for (const f of (data.formFields || data.fields || [])) raw.push(f)
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
    roleIndex: f.roleIndex != null ? Number(f.roleIndex)
      : (f.signerIndex != null ? Number(f.signerIndex) : null),
    page:   Number(f.pageNumber) || 1,
    bounds: f.bounds || null,
    isReadOnly: Boolean(f.isReadOnly),
  })).filter(f => {
    if (!f.id || seen.has(f.id)) return false
    seen.add(f.id)
    return true
  })

  return { roles, fields }
}

// One field → its verdict. Exported for scripts/__tests__.
//
// `firstRoleIndex` is the lowest role index in the template, i.e. who signs
// first on an in-order send — the one role on which a prefilled role-scoped
// field is defensible (every later signer sees it once they finish).
export function classifyField(field, { firstRoleIndex = 1, tokenKeys = SHARED_PREFILL_TOKENS } = {}) {
  const token = fieldTokenKey(field, tokenKeys)
  const owner = field.roleIndex == null ? firstRoleIndex : Number(field.roleIndex)

  if (isSignerBoundField(field.type)) {
    // A Name field carrying one of our tokens is a name we are TRYING to print.
    // BoldSign will print the assigned signer's name instead.
    if (token) {
      return {
        severity: 'wrong-name', token,
        why: `Name field captioned for \`${token}\` — BoldSign prints role ${owner}'s own name here and discards the value`,
        fix: `delete it and place a Label at the same coordinates, named \`${token}\``,
      }
    }
    // No token: most likely the signer's own name, which is what a Name field is
    // for. Flagged only under --all, and only as something to eyeball.
    return {
      severity: 'ok', token: '',
      why: `Name field on role ${owner} — fine if it is that signer's own name`,
      fix: '',
    }
  }

  if (isSharedField(field.type)) {
    return { severity: 'ok', token, why: 'Label — visible to every signer immediately, read-only', fix: '' }
  }

  if (isTickableField(field.type)) {
    // We cannot tell from the template whether an agent will pre-tick this — but
    // we can tell whether it would be VISIBLE if they did, and that is the part
    // the template controls.
    if (owner !== firstRoleIndex) {
      return {
        severity: 'hidden', token,
        why: `checkbox on role ${owner}, not the first signer — if we pre-tick it, nobody ahead of role ${owner} sees the selection`,
        fix: `move it to role ${firstRoleIndex} (sequential sends only), or show the resulting state as a Label`,
      }
    }
    return {
      severity: 'ok', token,
      why: `checkbox on the first signer — a pre-tick reaches later signers once role ${owner} signs`,
      fix: '',
    }
  }

  if (isFillableField(field.type) && token) {
    if (owner !== firstRoleIndex) {
      return {
        severity: 'hidden', token,
        why: `\`${token}\` on role ${owner}, not the first signer — everyone ahead of role ${owner} reads a blank`,
        fix: `make it a Label (visible to all, any order), or move it to role ${firstRoleIndex} read-only`,
      }
    }
    return {
      severity: 'review', token,
      why: `\`${token}\` on the first signer — visible to the others only after role ${owner} signs, and only on an in-order send`,
      fix: 'make it a Label if it must be legible regardless of signing order',
    }
  }

  return { severity: 'ok', token, why: `${field.type || 'field'} — the signer's own input`, fix: '' }
}

export function auditTemplate({ roles, fields }) {
  const firstRoleIndex = roles.length ? Math.min(...roles.map(r => r.index)) : 1
  const roleName = (i) => roles.find(r => r.index === Number(i))?.name || (i ? `Role ${i}` : 'unassigned')
  return fields.map(f => {
    const verdict = classifyField(f, { firstRoleIndex })
    return { ...f, ...verdict, role: roleName(f.roleIndex ?? firstRoleIndex) }
  })
}

const SEVERITY_ORDER = { 'wrong-name': 0, hidden: 1, review: 2, ok: 3 }
const BADGE = { 'wrong-name': 'WRONG NAME', hidden: 'HIDDEN', review: 'REVIEW', ok: 'ok' }

function main() {
  if (!API_KEY) {
    console.error('BOLDSIGN_API_KEY is not set. Copy it from Settings → BoldSign (or .env) and re-run:\n'
      + '  BOLDSIGN_API_KEY=… node scripts/audit-boldsign-templates.mjs')
    process.exit(2)
  }

  return (async () => {
    let list
    if (onlyTemplate) {
      list = { templates: [{ templateId: onlyTemplate, templateName: onlyTemplate }], complete: true }
    } else {
      list = await listTemplates()
      if (!list.complete) {
        console.warn(`! template list hit the ${PAGE_LIMIT}-page guard — this report may be incomplete\n`)
      }
    }

    const report = []
    for (const t of list.templates) {
      const id = t.templateId || t.id
      if (!id) continue
      const props = await boldsign(`/template/properties?templateId=${encodeURIComponent(id)}`)
      const parsed = readTemplate(props)
      report.push({
        templateId: id,
        name: props.templateName || props.title || t.templateName || t.title || id,
        roles: parsed.roles,
        fields: auditTemplate(parsed),
      })
    }

    const defects = report.flatMap(t => t.fields.filter(f => f.severity !== 'ok'))

    if (asJson) {
      console.log(JSON.stringify({ templates: report, defectCount: defects.length }, null, 2))
      process.exit(defects.length ? 1 : 0)
    }

    for (const t of report) {
      const rows = t.fields
        .filter(f => showAll || f.severity !== 'ok')
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.page - b.page)
      if (!rows.length) continue

      console.log(`\n━━ ${t.name}`)
      console.log(`   ${t.templateId}   roles: ${t.roles.map(r => `${r.index}=${r.name}`).join(', ') || '(none)'}`)
      for (const f of rows) {
        const where = f.bounds
          ? `p${f.page} @ ${Math.round(f.bounds.x)},${Math.round(f.bounds.y)} ${Math.round(f.bounds.width)}×${Math.round(f.bounds.height)}`
          : `p${f.page}`
        const caption = f.label || f.name || f.id
        console.log(`   [${BADGE[f.severity]}] ${caption}  (${f.type}, ${f.role}, ${where})`)
        console.log(`        ${f.why}`)
        if (f.fix) console.log(`        FIX: ${f.fix}`)
      }
    }

    const counts = defects.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }), {})
    console.log(`\n━━ ${report.length} template(s) audited`)
    console.log(`   wrong name: ${counts['wrong-name'] || 0}   hidden: ${counts.hidden || 0}   review: ${counts.review || 0}`)
    if (!defects.length) console.log('   clean — every prefilled value reaches every signer it should.')
    else console.log('\n   Remediation is by hand in BoldSign: a placed field\'s type cannot be changed,\n'
      + '   so delete each one and place the replacement at the coordinates above.\n'
      + '   See docs/boldsign-integration.md → "Remediating a template".')

    process.exit(defects.length ? 1 : 0)
  })().catch(err => {
    console.error(`\nAudit could not complete: ${err.message}`)
    process.exit(2)
  })
}

// Importable for tests without firing the sweep.
if (process.argv[1] && process.argv[1].endsWith('audit-boldsign-templates.mjs')) main()
