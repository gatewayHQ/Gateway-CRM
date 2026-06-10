#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check-enums — guards against the "violates check constraint" class of error.
//
// Parses the CHECK constraints in src/lib/schema.sql and asserts that every
// value the app offers (src/lib/enums.js) is accepted by the matching database
// constraint. If a form/filter/import list ever gains a value the database
// rejects, this fails CI with a clear message instead of letting an agent hit a
// raw Postgres error at insert time.
//
// What this does NOT cover: whether the migration has actually been applied to
// the *live* Supabase database. That axis (schema.sql vs. production) can't be
// checked without DB credentials — friendlyDbError() in src/lib/dbErrors.js is
// the runtime safety net for it, and applying migrations is a deploy step.
//
// Run: npm run check:enums
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  CONTACT_TYPES, CONTACT_STATUSES, CONTACT_SOURCES,
  PROPERTY_TYPES, PROPERTY_STATUSES,
} from '../src/lib/enums.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const schema = readFileSync(join(root, 'src/lib/schema.sql'), 'utf8')

// Return the body of `create table [if not exists] <name> ( ... )`, balancing
// nested parens (e.g. default uuid_generate_v4(), numeric(10,2)).
function tableBody(name) {
  const open = new RegExp(`create table(?:\\s+if not exists)?\\s+${name}\\s*\\(`, 'i').exec(schema)
  if (!open) throw new Error(`check-enums: could not locate "create table ${name}" in schema.sql`)
  let depth = 0
  const start = open.index + open[0].length - 1 // index of the opening "("
  for (let i = start; i < schema.length; i++) {
    if (schema[i] === '(') depth++
    else if (schema[i] === ')' && --depth === 0) return schema.slice(start + 1, i)
  }
  throw new Error(`check-enums: unbalanced parentheses parsing table ${name}`)
}

// Extract the allowed values from `<col> ... check (<col> in ('a','b', ...))`
// within a table body. Tolerant of the constraint spanning multiple lines.
function checkValues(body, col) {
  const m = new RegExp(`\\b${col}\\b[\\s\\S]*?check\\s*\\(\\s*${col}\\s+in\\s*\\(([^)]*)\\)`, 'i').exec(body)
  if (!m) throw new Error(`check-enums: no CHECK constraint found for column "${col}"`)
  return m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
}

const checks = [
  ['contacts.type',     CONTACT_TYPES,     checkValues(tableBody('contacts'), 'type')],
  ['contacts.status',   CONTACT_STATUSES,  checkValues(tableBody('contacts'), 'status')],
  ['contacts.source',   CONTACT_SOURCES,   checkValues(tableBody('contacts'), 'source')],
  ['properties.type',   PROPERTY_TYPES,    checkValues(tableBody('properties'), 'type')],
  ['properties.status', PROPERTY_STATUSES, checkValues(tableBody('properties'), 'status')],
]

let failed = false
for (const [name, appValues, dbValues] of checks) {
  const dbSet = new Set(dbValues)
  const missing = appValues.filter(v => !dbSet.has(v)) // app offers it, DB rejects it → INSERT FAILS
  if (missing.length) {
    failed = true
    console.error(`✗ ${name}: enums.js offers value(s) the schema.sql constraint rejects → ${JSON.stringify(missing)}`)
    console.error(`    enums.js: ${JSON.stringify(appValues)}`)
    console.error(`    schema:   ${JSON.stringify(dbValues)}`)
  } else {
    const appSet = new Set(appValues)
    const extra = dbValues.filter(v => !appSet.has(v)) // DB allows it, app never offers it → fine, just noted
    console.log(`✓ ${name}: ${appValues.length} value(s) all valid${extra.length ? `  (schema also allows ${JSON.stringify(extra)})` : ''}`)
  }
}

if (failed) {
  console.error('\nEnum drift detected. Add the value to the matching CHECK constraint in')
  console.error('src/lib/schema.sql (and ship a migration that applies it to the database)')
  console.error('before merging — otherwise inserts using that value will fail.')
  process.exit(1)
}
console.log('\nAll app enum lists are consistent with src/lib/schema.sql.')
