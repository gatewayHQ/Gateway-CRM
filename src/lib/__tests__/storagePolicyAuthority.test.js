// ─────────────────────────────────────────────────────────────────────────────
// Restrictive policies — migration 0051.
//
// Migration 0049 fixed the deal-documents policy and reasoned: "permissive
// policies OR together, so this only ever widens." True, and incomplete.
// Postgres has two kinds of policy:
//
//   PERMISSIVE  (default) — OR'd. Any one granting is enough. 0049's reasoning
//               holds, and a leftover can only widen.
//   RESTRICTIVE — AND'd with the result. ONE of them can veto every permissive
//               policy there is.
//
// So a leftover RESTRICTIVE `owner = auth.uid()` on deal-documents survives
// 0049 completely: the check becomes (deal is visible) AND (owner = me), and
// the co-agent still sees nothing — with the migration correctly applied and
// all four of its policies present. Measured on Postgres 16 against a deal with
// three files: co-agent sees 0 with it, 3 without.
//
// 0049 drops leftovers by four exact NAMES, so anything called something else
// survives. That is the hole these assertions hold shut.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const repair    = read('../../../migrations/0051_storage_policy_authority.sql')
const audit     = read('../../../migrations/0050_access_audit.sql')
const schema    = read('../schema.sql')
const diagnose  = read('../../../scripts/db-verify/deal_documents_diagnose.sql')

describe('migration 0051 — clearing the veto', () => {
  it('finds restrictive policies by DISCOVERY, not by name', () => {
    // Dropping by name is what let this one through: the next leftover will be
    // called something else.
    expect(repair).toMatch(/from pg_policies/i)
    expect(repair).toMatch(/permissive = 'RESTRICTIVE'/)
    expect(repair).toMatch(/drop policy %I on storage\.objects/i)
  })

  it('names every policy it drops — the change is never silent', () => {
    expect(repair).toMatch(/raise notice 'DROPPED restrictive policy/i)
  })

  it('leaves PERMISSIVE leftovers alone', () => {
    // They can only widen, and dropping one blind could remove access to an
    // object sitting outside any `deal-<uuid>/` prefix.
    expect(repair).toMatch(/LEFT IN PLACE: permissive policy/i)
    // The drop hint has to be runnable: `raise notice` has no %I, only format() does.
    expect(repair).toMatch(/quote_ident\(r\.policyname\)/)
    // `execute format(... %I ...)` is correct and stays; only a `raise notice`
    // carrying %I is the bug. Checked per statement, comments excluded, since
    // the file explains the trap in prose right next to the fix.
    const statements = repair
      .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
      .split(';')
    const bad = statements.filter(st => /raise\s+notice/i.test(st) && st.includes('%I'))
    expect(bad, 'raise notice has no %I — the printed drop statement would be mangled').toEqual([])
  })

  it('checks it can write storage policies BEFORE changing anything', () => {
    // storage.objects is owned by supabase_storage_admin; whether the SQL
    // editor's role may write policies on it varies by project. 0049 ran inside
    // begin/commit, so that one error rolled everything back with no clue why.
    expect(repair).toMatch(/pg_has_role\(current_user/)
    expect(repair).toMatch(/42501/)
    const guardAt = repair.search(/pg_has_role\(current_user/)
    const firstPolicyAt = repair.search(/create policy "deal-documents: read"/)
    expect(guardAt).toBeGreaterThan(-1)
    expect(firstPolicyAt).toBeGreaterThan(guardAt)
  })

  it('restates 0049 in full, so it stands alone if 0049 rolled back', () => {
    for (const fragment of [
      'app_storage_deal_id', 'deal-documents: read', 'deal-documents: upload',
      'deal-documents: update', 'deal-documents: delete', 'closing-packets: read',
    ]) {
      expect(repair, `0051 must restate ${fragment}`).toContain(fragment)
    }
    // And the backfill, which also never ran if 0049 rolled back.
    expect(repair).toMatch(/details->'co_agent_ids'/)
  })

  it('reports agents with no auth_id instead of guessing at one', () => {
    // A null auth_id resolves to no identity, so RLS hides everything from that
    // agent and no storage policy can help. Linking the wrong auth user hands
    // them somebody else's book of business, so it is reported, never repaired.
    expect(repair).toMatch(/auth_id is NULL/i)
    expect(repair).toMatch(/AGENT WITHOUT AN IDENTITY/)
    expect(repair, 'must never write auth_id on its own')
      .not.toMatch(/update agents set auth_id/i)
  })
})

describe.each([
  ['migrations/0050', audit],
  ['schema.sql', schema],
])('%s — the audit grades the two kinds of policy differently', (_label, sql) => {
  it('fails on ANY restrictive policy over a deal bucket', () => {
    expect(sql).toMatch(/r\.permissive = 'RESTRICTIVE'/)
    const block = sql.slice(sql.search(/r\.permissive = 'RESTRICTIVE'/))
    expect(block.slice(0, 400)).toMatch(/status := 'FAIL'/)
  })

  it('only warns on a permissive uploader-scoped leftover', () => {
    // Grading this a failure would be crying wolf: it cannot block anything.
    expect(sql).toMatch(/permissive policy scoping a deal bucket by uploader/i)
  })

  it('prints a runnable drop statement', () => {
    expect(sql).toMatch(/quote_ident\(r\.policyname\)/)
  })
})

describe('the paste-safe diagnostic', () => {
  // Comments, then single-quoted literals — the diagnostic prints `drop policy
  // …;` as advice, and a naive split on ';' would count that as a statement.
  const code = diagnose
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .replace(/'(?:[^']|'')*'/g, "''")

  it('is a single statement — the SQL editor shows only the last result', () => {
    expect(code.split(';').filter(chunk => chunk.trim().length).length).toBe(1)
  })

  it('uses no dollar-quoted block', () => {
    // The editor's statement splitter understands `$$` but not a custom `$tag$`
    // and cuts the script in half at the first `;` inside one — which is the
    // "syntax error at end of input / LINE 0" with nothing underneath it.
    expect(code).not.toMatch(/\$\w*\$/)
  })

  it('separates what RLS grants from what the card merely displays', () => {
    expect(diagnose).toMatch(/granted co-agents/)
    expect(diagnose).toMatch(/displayed-only via property/)
  })

  it('reports permissive vs restrictive, which is the decisive difference', () => {
    expect(diagnose).toMatch(/p\.permissive/)
    expect(diagnose).toMatch(/RESTRICTIVE/)
  })
})

describe('no migration uses a custom dollar-quote tag', () => {
  it('top-level function bodies use $$, which the SQL editor can split on', () => {
    // A `$audit$ … $audit$` body made migration 0050 unpastable: the editor cut
    // it at the first `;` inside and reported a syntax error at LINE 0.
    for (const [name, sql] of [['0050', audit], ['0051', repair], ['schema.sql', schema]]) {
      const tags = [...sql.matchAll(/^\s*(?:as|do)\s+(\$\w+\$)/gim)].map(m => m[1])
      const custom = tags.filter(t => t !== '$$')
      expect(custom, `${name} uses custom dollar tags the SQL editor cannot split: ${custom.join(', ')}`)
        .toEqual([])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The blind spot that hid the real cause — migration 0053.
//
// The rule actually in force on the production database was:
//
//     as restrictive for select to authenticated using (owner = auth.uid())
//
// with NO bucket clause. Every query written to investigate this — both
// diagnostics and the discovery loop in 0051 — filtered policies by whether
// their body mentioned 'deal-documents'. A bucket-agnostic policy matches
// nothing, so it never appeared in any output, and the database reported a
// clean bill of health while the uploader-only rule was in force.
//
// Reproduced exactly: uploader 3 of 3, co-agent 0 of 3, and the diagnostic
// printing nothing but "agents_deal_docs PERMISSIVE / ALL".
// ─────────────────────────────────────────────────────────────────────────────
describe('migration 0053 — one file, and no bucket filter on restrictive policies', () => {
  const one = read('../../../migrations/0053_deal_documents_one_fix.sql')

  it('examines EVERY policy on storage.objects, unfiltered, before changing any', () => {
    // Comments stripped: the header quotes the bad filter in prose while
    // explaining it, which is the point of the file, not a regression.
    const code = one.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    const before = code.slice(0, code.search(/drop policy/i))
    expect(before).toMatch(/from pg_policies where schemaname = 'storage' and tablename = 'objects'/i)
    expect(before, 'the first listing must carry no bucket predicate')
      .not.toMatch(/~ 'deal-documents/)
  })

  it('drops restrictive policies without filtering by bucket', () => {
    const loop = one.slice(one.search(/permissive = 'RESTRICTIVE'/))
    const dropAt = loop.search(/drop policy %I/)
    expect(dropAt).toBeGreaterThan(-1)
    // No bucket-name predicate between the RESTRICTIVE test and the drop.
    expect(loop.slice(0, dropAt)).not.toMatch(/deal-documents/)
  })

  it('prints a recreate statement for every policy it drops', () => {
    // Dropping a policy somebody may have created deliberately, without
    // recording how to put it back, is not a fix — it is a different outage.
    expect(one).toMatch(/To put it back: create policy/)
  })

  it('backfills co-agents BEFORE narrowing access', () => {
    // Storage is wide open on that database, so scoping to the deal TAKES
    // access away. Filling co_agent_ids first is what stops an agent losing a
    // document they can see today.
    const backfillAt = one.search(/co-agents: % deal\(s\) updated/)
    const narrowAt   = one.search(/create policy "deal-documents: read"/)
    expect(backfillAt).toBeGreaterThan(-1)
    expect(narrowAt).toBeGreaterThan(backfillAt)
  })

  it('merges co-agents rather than filling only an empty column', () => {
    expect(one).toMatch(/@> m\.ids and d\.co_agent_ids <@ m\.ids/)
    expect(one, 'fill-if-empty skips a partially populated deal')
      .not.toMatch(/where coalesce\(array_length\(d2\.co_agent_ids, 1\), 0\) = 0/)
  })

  it('stands alone — it supersedes 0049, 0051 and 0052', () => {
    for (const f of ['app_storage_deal_id', 'deal-documents: read', 'deal-documents: upload',
                     'deal-documents: update', 'deal-documents: delete', 'closing-packets: read',
                     "details->'co_agent_ids'"]) {
      expect(one, `0053 must contain ${f}`).toContain(f)
    }
  })
})

describe.each([
  ['migrations/0050', audit],
  ['schema.sql', schema],
])('%s — the audit no longer filters restrictive policies by bucket', (_label, sql) => {
  it('examines a restrictive policy whatever bucket it names, including none', () => {
    expect(sql).toMatch(/if r\.permissive <> 'RESTRICTIVE' and r\.body !~ 'deal-documents\|closing-packets' then/)
  })

  it('says so when the restrictive policy names no bucket', () => {
    expect(sql).toMatch(/names NO bucket so it applies to deal-documents too/)
  })
})
