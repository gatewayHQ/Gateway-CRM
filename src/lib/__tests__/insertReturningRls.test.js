// ─────────────────────────────────────────────────────────────────────────────
// A row you may create, you may read back — migration 0057.
//
// THE BUG THESE GUARD: the app saves with `.insert().select()`, i.e. INSERT ...
// RETURNING, and Postgres checks a returned row against the policy's USING as
// well as its WITH CHECK. A USING that only asks "is this id in
// app_visible_*_ids()" can never pass for the row being inserted: those
// functions read a snapshot taken before it existed. Adding a contact as a
// non-admin failed with "new row violates row-level security policy".
//
// So USING must carry the same row-local arms WITH CHECK accepts new rows on.
// The behaviour itself is proven against Postgres by
// scripts/db-verify/rls_matrix.sql ("reads back own new ...").
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const BOTH = {
  '0057_insert_returning_rls.sql': read('../../../migrations/0057_insert_returning_rls.sql'),
  'schema.sql':                    read('../schema.sql'),
}

// The USING clause of `create policy <name> ...`, up to its `with check`.
const usingOf = (sql, name) => {
  const m = sql.match(new RegExp(`create policy ${name} on \\w+ for all to authenticated\\s*\\n\\s*using\\s*\\(([\\s\\S]*?)\\)\\s*\\n\\s*with check`))
  return m && m[1]
}

describe.each([
  ['contacts_agent_scope', /assigned_agent_id in \(select app_visible_agent_ids\('contacts'\)\)/, 'app_visible_contact_ids'],
  ['deals_agent_scope',    /agent_id in \(select app_visible_agent_ids\('deals'\)\)/,             'app_visible_deal_ids'],
])('%s can judge a row that is being inserted', (policy, ownerArm, lookup) => {
  for (const [file, sql] of Object.entries(BOTH)) {
    const using = usingOf(sql, policy)

    it(`${file}: has a USING clause`, () => {
      expect(using, `${file}: ${policy} not found`).toBeTruthy()
    })

    it(`${file}: USING accepts admins and the row's own agent without a lookup`, () => {
      expect(using).toMatch(/app_is_admin\(\)/)
      expect(using).toMatch(ownerArm)
    })

    it(`${file}: USING still reads the derived list for everything else`, () => {
      expect(using).toMatch(new RegExp(`id in \\(select ${lookup}\\(\\)\\)`))
    })
  }
})
