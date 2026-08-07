// ─────────────────────────────────────────────────────────────────────────────
// RLS policy hygiene — guards the fix in migration 0027.
//
// A policy written without a `TO <role>` clause applies to PUBLIC, which in
// Supabase includes `anon` — and the anon key ships in the browser bundle. That
// is how eight tables (properties, templates, teams, team_splits, and the four
// mailing tables) ended up anonymously readable AND writable, including the
// street addresses in mailing_recipients.
//
// This test fails the build if a role-less policy is ever added back.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const schema = readFileSync(
  fileURLToPath(new URL('../schema.sql', import.meta.url)),
  'utf8'
)

// Policies that are INTENTIONALLY reachable by anonymous callers, with why.
const INTENTIONAL_PUBLIC = new Set([
  // The external website tracking snippet (generated in Settings.jsx) posts
  // these with the anon key from the customer's own site.
  'public_insert',
  // Landing pages render campaign images straight from the public bucket.
  'campaign-images: public read',
])

/** Every `create policy` statement, with its name and full body. */
function parsePolicies(sql) {
  const out = []
  const re = /create\s+policy\s+"?([^"\s]+)"?\s+on\s+"?([a-z_.]+)"?([\s\S]*?);/gi
  let m
  while ((m = re.exec(sql)) !== null) {
    out.push({ name: m[1], table: m[2], body: m[3] })
  }
  return out
}

describe('RLS policy hygiene (migration 0027)', () => {
  const policies = parsePolicies(schema)

  it('finds the policy statements to check', () => {
    expect(policies.length).toBeGreaterThan(15)
  })

  it('no policy is missing a TO role clause (a role-less policy means anon)', () => {
    const roleless = policies
      .filter(p => !INTENTIONAL_PUBLIC.has(p.name))
      .filter(p => !/\bto\s+(authenticated|anon|public|service_role)/i.test(p.body))
      .map(p => `${p.table}.${p.name}`)

    expect(roleless, `Policies without a TO clause default to PUBLIC (anon can read/write). ` +
      `Add "to authenticated": ${roleless.join(', ')}`).toEqual([])
  })

  it('the eight tables closed by 0027 are authenticated-only', () => {
    const closed = [
      'properties', 'templates', 'teams', 'team_splits',
      'mailings', 'mailing_recipients', 'mailing_scans', 'mailing_leads',
    ]
    for (const table of closed) {
      const forTable = policies.filter(p => p.table === table)
      expect(forTable.length, `no policy found for ${table}`).toBeGreaterThan(0)
      for (const p of forTable) {
        expect(p.body, `${table}.${p.name} must be scoped to authenticated`)
          .toMatch(/\bto\s+authenticated/i)
      }
    }
  })

  it('agents is no longer anonymously readable', () => {
    expect(schema).not.toMatch(/create policy\s+"?agents_public_read"?\s+on\s+agents\s+for select using \(true\)/i)
    const agentsRead = policies.find(p => p.name === 'agents_read_authenticated')
    expect(agentsRead, 'expected agents_read_authenticated policy').toBeDefined()
    expect(agentsRead.body).toMatch(/\bto\s+authenticated/i)
  })

  it('agents_public exposes only the ten columns the landing pages render', () => {
    const view = schema.match(/create or replace view agents_public as([\s\S]*?);/i)
    expect(view, 'agents_public view not found in schema.sql').toBeTruthy()

    const select = view[1]
    // Comp-plan and identity columns must never reach an anonymous caller.
    for (const forbidden of [
      'cap_amount', 'cap_anniversary', 'default_split_pct', 'no_brokerage_split',
      'is_admin', 'auth_id', 'twilio_sid', 'twilio_number', 'nav_hidden',
    ]) {
      expect(select, `agents_public must not expose ${forbidden}`)
        .not.toMatch(new RegExp(`\\b${forbidden}\\b`))
    }
    // `select *` would silently re-expose every future column added to agents.
    expect(select, 'agents_public must list columns explicitly, never select *')
      .not.toMatch(/select\s+\*/i)
  })
})
