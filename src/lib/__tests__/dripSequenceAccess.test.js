// ─────────────────────────────────────────────────────────────────────────────
// Drip sequences are private to their owner (migration 0060).
//
// Before 0060, sequences / sequence_steps / contact_sequences sat in the
// blanket `allow_all ... using (true)` loop: every agent could read, edit and
// delete every other agent's drip. Re-running schema.sql would silently put
// them back in that loop, so this pins them out of it.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const schema    = read('../schema.sql')
const migration = read('../../../migrations/0060_drip_sequences_per_agent.sql')
const code = (sql) => sql.replace(/--.*$/gm, '')

const DRIP_TABLES = ['sequences', 'sequence_steps', 'contact_sequences', 'email_log']

describe('drip sequence access', () => {
  it('none of the drip tables is in the allow_all loop any more', () => {
    const loop = code(schema).match(/foreach t in array array\[([\s\S]*?)\]\s*loop[\s\S]*?allow_all/i)
    expect(loop, 'allow_all loop not found').toBeTruthy()
    for (const t of DRIP_TABLES) expect(loop[1]).not.toContain(`'${t}'`)
  })

  for (const [label, sql] of [['schema.sql', schema], ['0060', migration]]) {
    it(`${label}: every drip table has an owner-scoped policy for authenticated`, () => {
      for (const [table, name] of [
        ['sequences', 'sequences_owner'], ['sequence_steps', 'sequence_steps_owner'],
        ['contact_sequences', 'contact_sequences_owner'], ['email_log', 'email_log_owner'],
      ]) {
        const re = new RegExp(`create policy ${name} on ${table}[^;]*to authenticated[^;]*app_my_agent_ids\\(\\)`, 'i')
        expect(code(sql), `${table}.${name}`).toMatch(re)
      }
    })

    it(`${label}: drops every existing policy on those tables by lookup, not by guessed name`, () => {
      expect(code(sql)).toMatch(/from pg_policies[\s\S]*tablename in \('sequences', 'sequence_steps', 'contact_sequences', 'email_log'\)/)
    })

    it(`${label}: auto-enroll is one sequence per lane PER AGENT`, () => {
      expect(code(sql)).toMatch(/drop index if exists idx_sequences_auto_enroll_lane/)
      expect(code(sql)).toMatch(/unique index if not exists idx_sequences_agent_auto_enroll\s+on sequences\(agent_id, auto_enroll_lane\)/)
    })

    it(`${label}: creates the last_sent_at column the runner writes`, () => {
      expect(code(sql)).toMatch(/alter table contact_sequences add column if not exists last_sent_at\s+timestamptz/)
    })
  }

  it('the old office-wide auto-enroll index is not recreated by schema.sql', () => {
    expect(code(schema)).not.toMatch(/create unique index if not exists idx_sequences_auto_enroll_lane/)
  })
})
