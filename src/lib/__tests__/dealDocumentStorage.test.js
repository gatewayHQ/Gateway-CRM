// ─────────────────────────────────────────────────────────────────────────────
// Deal documents follow the deal — migration 0049.
//
// THE BUG THIS GUARDS. Two agents on one deal: the assigned agent uploaded
// contracts and saw them; the co-agent opened the same deal and the Documents
// tab said "No documents yet."
//
// Every other deal child (documents, document_versions, boldsign_documents,
// closing_packets, transaction_steps) is scoped in SQL that lives in this
// repository and reads `app_visible_deal_ids()`. The Documents tab reads none
// of them — it lists the `deal-documents` storage bucket directly, and
// `storage.objects` row policies decide what comes back. Those policies were
// never in this repository at all: the bucket was made by hand in the Supabase
// dashboard, whose default template is `owner = auth.uid()`. Under that rule
// the uploader sees their files and nobody else does, and because storage
// FILTERS denied rows instead of erroring, the co-agent's screen looked like an
// empty deal rather than a refusal.
//
// These assertions read schema.sql and the migration as text. They cannot prove
// Postgres behavior — scripts/db-verify does that against a real database — but
// they do fail the build the moment the bucket policies drift back out of
// version control, which is the failure mode that produced the bug.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const schema    = read('../schema.sql')
const migration = read('../../../migrations/0049_deal_document_storage_rls.sql')

/** The body of one `create policy "<name>" on storage.objects …;` statement. */
function storagePolicy(sql, name) {
  const re = new RegExp(
    `create\\s+policy\\s+"${name.replace(/[-:\s]/g, m => `\\${m}`)}"\\s+on\\s+storage\\.objects([\\s\\S]*?);`,
    'i'
  )
  return sql.match(re)?.[1] ?? null
}

// The four commands the browser can issue against a deal's files, and the one
// read the closing-packet download needs.
const DEAL_DOC_POLICIES = [
  'deal-documents: read',
  'deal-documents: upload',
  'deal-documents: update',
  'deal-documents: delete',
]

describe.each([
  ['src/lib/schema.sql (fresh installs)', schema],
  ['migrations/0049 (existing databases)', migration],
])('%s', (_label, sql) => {
  it('creates the deal-documents bucket, private', () => {
    const insert = sql.match(/insert into storage\.buckets[\s\S]*?values \('deal-documents'[\s\S]*?;/i)
    expect(insert, 'deal-documents bucket is not created here').toBeTruthy()
    expect(insert[0]).toMatch(/'deal-documents',\s*'deal-documents',\s*false/i)
    // `do nothing` would leave a bucket someone flipped public in the dashboard
    // public forever — executed contracts readable by URL with no session.
    expect(insert[0], 'a re-run must also CLOSE a bucket that went public')
      .toMatch(/do update set public = false/i)
  })

  it.each(DEAL_DOC_POLICIES)('%s is scoped to the deal, not the uploader', (name) => {
    const body = storagePolicy(sql, name)
    expect(body, `policy "${name}" is missing`).toBeTruthy()
    expect(body, `${name} must be authenticated-only`).toMatch(/\bto\s+authenticated\b/i)
    expect(body).toMatch(/bucket_id = 'deal-documents'/)
    // The whole fix in one line: the same visibility source every other deal
    // child already uses.
    expect(body, `${name} must defer to app_visible_deal_ids()`)
      .toMatch(/app_storage_deal_id\(name\) in \(select app_visible_deal_ids\(\)\)/)
    expect(body, `${name} must let office admins through`).toMatch(/app_is_admin\(\)/)
    // The rule that caused the outage. It must never come back.
    expect(body, `${name} must not scope by uploader — that is the original bug`)
      .not.toMatch(/owner/i)
  })

  it('parses the deal id out of the path every writer agrees on', () => {
    const fn = sql.match(/create or replace function app_storage_deal_id\(object_name text\)[\s\S]*?\$\$([\s\S]*?)\$\$/i)
    expect(fn, 'app_storage_deal_id() not defined').toBeTruthy()
    expect(fn[0]).toMatch(/\^deal-/)
    expect(fn[0], 'must match a uuid, so a crafted prefix cannot widen access')
      .toMatch(/\[0-9a-fA-F\]\{8\}-/)
    expect(sql).toMatch(/grant execute on function app_storage_deal_id\(text\) to authenticated/i)
  })

  it('closing packets follow the deal and stay read-only for agents', () => {
    const body = storagePolicy(sql, 'closing-packets: read')
    expect(body, 'closing-packets read policy is missing').toBeTruthy()
    expect(body).toMatch(/for select to authenticated/i)
    expect(body).toMatch(/app_storage_deal_id\(name\) in \(select app_visible_deal_ids\(\)\)/)
    // Packets are built with the service key and pointed at by the audit log;
    // an agent must not be able to rewrite one.
    for (const cmd of ['insert', 'update', 'delete']) {
      expect(storagePolicy(sql, `closing-packets: ${cmd}`), `agents must not ${cmd} closing packets`).toBeNull()
    }
  })

  it('form packets stay a shared catalog — every agent reads, admins write', () => {
    // Blank state forms live at `IA/seller/…`: there is no deal to scope to,
    // and scoping them by uploader would hide the Iowa listing agreement from
    // everyone but whoever uploaded it.
    expect(storagePolicy(sql, 'form-packets: read')).toMatch(/for select to authenticated/i)
    for (const name of ['form-packets: admin write', 'form-packets: admin update', 'form-packets: admin delete']) {
      const body = storagePolicy(sql, name)
      expect(body, `${name} is missing`).toBeTruthy()
      // Mirrors migration 0030, which made the form_packets TABLE admin-write
      // while this bucket stayed open to every agent.
      expect(body, `${name} must be admin-only`).toMatch(/app_is_admin\(\)/)
    }
  })

  it('retires the hand-made policies by exact name only', () => {
    // Named drops are safe. Guessing at policy bodies and dropping whatever
    // matches is how an upload starts failing at 2am, so anything else is left
    // in place and reported by the migration's verification query.
    expect(sql).toMatch(/drop policy if exists "agents_deal_docs" on storage\.objects/i)
    expect(sql).toMatch(/drop policy if exists "Give users access to own folder[^"]*" on storage\.objects/i)
  })
})

describe('migration 0049 only', () => {
  it('reconciles the co-agents the property→deal conversion dropped', () => {
    // The other half of "she is on the deal but cannot see it": the deal page
    // falls back to the linked property to DISPLAY co-agents (coAgents.js), but
    // RLS only reads deals.co_agent_ids. Until those agree, the card names an
    // agent the database has never heard of.
    expect(migration).toMatch(/update deals d/i)
    expect(migration).toMatch(/details->'co_agent_ids'/)
    // Idempotent: only deals whose array is still empty are touched.
    expect(migration).toMatch(/coalesce\(array_length\(d2\.co_agent_ids, 1\), 0\) = 0/)
  })

  it('runs in one transaction', () => {
    expect(migration).toMatch(/^begin;/m)
    expect(migration).toMatch(/^commit;/m)
  })
})

describe('the storage policies are declared after their dependencies', () => {
  it('app_visible_deal_ids() exists before the policies that call it', () => {
    // Postgres resolves function names when a policy is CREATED. Moving this
    // block up beside the campaign buckets breaks a fresh install with
    // "function app_visible_deal_ids() does not exist".
    const fnAt     = schema.search(/create or replace function app_visible_deal_ids\(\)/i)
    const policyAt = schema.search(/create policy "deal-documents: read"/i)
    expect(fnAt).toBeGreaterThan(-1)
    expect(policyAt).toBeGreaterThan(fnAt)
  })
})
