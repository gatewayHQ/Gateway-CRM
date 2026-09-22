// ─────────────────────────────────────────────────────────────────────────────
// schema.sql runs TOP TO BOTTOM on a fresh database.
//
// Postgres resolves a trigger's function at CREATE TRIGGER time, so a function
// declared after the first trigger that executes it does not exist yet — and
// `create trigger` fails. On an EXISTING database nothing goes wrong, because
// the function is already there from the last run, which is why this kind of
// break stays invisible for months: it only ever bites a fresh install.
//
// It had bitten two: `set_updated_at()` was declared ~650 lines below the
// ms_graph_connections and contact_email_sync triggers that call it, so on any
// database built from this file those two triggers were silently never created
// and both tables' `updated_at` stayed frozen at insert time.
//
// This test reads the file the way Postgres does — in order — and fails if any
// trigger executes a function this file has not defined yet.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const schema = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8')

/** Character offset of each `create [or replace] function <name>` in the file. */
function definitionOffsets(sql) {
  const out = new Map()
  const re = /create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_.]+)\s*\(/gi
  let m
  while ((m = re.exec(sql)) !== null) {
    const name = m[1].toLowerCase()
    // Keep the EARLIEST definition: that is the one a fresh run reaches first.
    if (!out.has(name)) out.set(name, m.index)
  }
  return out
}

/** Character offset of each `execute function <name>()` inside a CREATE TRIGGER. */
function triggerUses(sql) {
  const out = []
  const re = /execute\s+(?:function|procedure)\s+([a-z0-9_.]+)\s*\(/gi
  let m
  while ((m = re.exec(sql)) !== null) {
    out.push({ name: m[1].toLowerCase(), at: m.index })
  }
  return out
}

describe('schema.sql declares every trigger function before the trigger that uses it', () => {
  const defined = definitionOffsets(schema)
  const uses = triggerUses(schema)

  it('finds triggers to check', () => {
    expect(uses.length).toBeGreaterThan(3)
  })

  it('no trigger executes a function defined later in the file', () => {
    const tooLate = uses
      .filter(u => defined.has(u.name) && defined.get(u.name) > u.at)
      .map(u => u.name)

    expect([...new Set(tooLate)], 'On a FRESH database these triggers fail with ' +
      '"function does not exist" and are silently never created. Move the ' +
      'function definition above its first use.').toEqual([])
  })

  it('no trigger executes a function this file never defines', () => {
    // A function created by hand in a dashboard panel, or by a migration only,
    // leaves a fresh install without the trigger and nobody the wiser.
    const undefinedFns = uses
      .filter(u => !defined.has(u.name))
      .map(u => u.name)

    expect([...new Set(undefinedFns)],
      'schema.sql must be self-contained: define these, or drop the trigger.').toEqual([])
  })

  it('set_updated_at specifically is defined before the first trigger that calls it', () => {
    // The regression this test was written for, named so a future move is loud.
    const firstUse = uses.find(u => u.name === 'set_updated_at')
    expect(firstUse, 'expected at least one set_updated_at trigger').toBeTruthy()
    expect(defined.get('set_updated_at')).toBeLessThan(firstUse.at)
  })
})
