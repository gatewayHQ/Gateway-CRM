#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// One-time storage cleanup — delete the files of deals that no longer exist.
//
// Deleting a deal removes its database rows (documents, versions, closing
// packets and signatures all cascade), but NOT its files: everything under
// `deal-<id>/` in `deal-documents` and `closing-packets` stays in Storage,
// unreachable from the app and still counted against the plan's quota.
//
// This deletes those files and nothing else. A folder is removed only when no
// deal row with that id exists; files of live deals — old closing packets, MLS
// packs, signed copies — are never touched, whatever their age.
//
// Run locally (it needs the service key, which bypasses all security):
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/cleanup-deleted-deal-files.mjs
//     → preview only: prints each deleted deal's files and writes the full list
//       to deleted-deal-files.csv. Nothing is deleted.
//   ... node scripts/cleanup-deleted-deal-files.mjs --backup ./deal-files-backup --delete
//     → downloads every file into that folder first, then deletes it. A file
//       whose download fails is kept.
//   ... --delete without --backup deletes without keeping a copy.
//
// Safe to re-run: a second run finds only what has been orphaned since.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const BUCKETS = ['deal-documents', 'closing-packets']

// Every column that stores a path into those buckets. All of these rows cascade
// when their deal is deleted, so on a healthy database none of them points into
// a deleted deal's folder — but a live database has drifted from schema.sql
// before (migration 0029), and a file something still links to is never ours
// to delete.
export const PATH_COLUMNS = [
  { table: 'documents',          column: 'storage_path' },
  { table: 'document_versions',  column: 'storage_path' },
  { table: 'closing_packets',    column: 'storage_path' },
  { table: 'boldsign_documents', column: 'signed_storage_path' },
  { table: 'boldsign_documents', column: 'audit_storage_path' },
  { table: 'boldsign_documents', column: 'local_files', json: true },
]

const DEAL_FOLDER = /^deal-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const PAGE = 1000

// The script must run with the service key. With the anon key every `deals`
// read comes back EMPTY under RLS rather than failing — which would make every
// deal look deleted. Legacy keys are JWTs carrying their role; new-style keys
// say what they are in their prefix.
export function keyRole(key) {
  if (!key) return null
  if (key.startsWith('sb_secret_')) return 'service_role'
  if (key.startsWith('sb_publishable_')) return 'anon'
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'))
    return payload.role || null
  } catch { return null }
}

// Page through one prefix of a bucket. Folders come back with `id: null`.
async function listPage(supabase, bucket, prefix) {
  const out = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.storage.from(bucket)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
    if (error) throw new Error(`Could not list ${bucket}/${prefix}: ${error.message}`)
    out.push(...(data || []))
    if (!data || data.length < PAGE) return out
  }
}

async function listFiles(supabase, bucket, prefix) {
  const files = []
  for (const item of await listPage(supabase, bucket, prefix)) {
    const path = `${prefix}/${item.name}`
    if (item.id === null) files.push(...await listFiles(supabase, bucket, path))
    else files.push({ bucket, path, size: Number(item.metadata?.size) || 0 })
  }
  return files
}

// Which of these deal ids still have a row. Any error aborts the run: an id we
// could not check must never be treated as deleted.
async function existingDealIds(supabase, ids) {
  const found = new Set()
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const { data, error } = await supabase.from('deals').select('id').in('id', chunk)
    if (error) throw new Error(`Could not read deals: ${error.message}`)
    for (const row of data || []) found.add(String(row.id).toLowerCase())
  }
  return found
}

const missingTable = (error) =>
  error?.code === '42P01' || error?.code === 'PGRST205' || /does not exist|could not find the table/i.test(error?.message || '')

async function referencedPaths(supabase, log) {
  const paths = new Set()
  for (const { table, column, json } of PATH_COLUMNS) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from(table).select(column)
        .not(column, 'is', null).range(from, from + PAGE - 1)
      if (error) {
        if (missingTable(error)) { log(`  (no ${table} table — skipped)`); break }
        throw new Error(`Could not read ${table}.${column}: ${error.message}`)
      }
      for (const row of data || []) {
        const value = row[column]
        if (!json) { paths.add(value); continue }
        for (const f of Array.isArray(value) ? value : []) {
          const p = typeof f === 'string' ? f : f?.path
          if (p) paths.add(p)
        }
      }
      if (!data || data.length < PAGE) break
    }
  }
  return paths
}

/**
 * Find (and with `remove`, delete) every file filed under a deal that no longer
 * exists. Returns { folders, files, bytes, deleted, kept, failed, liveFolders }.
 *
 * @param {object}   supabase  a client created with the SERVICE key
 * @param {object}   opts
 * @param {boolean}  opts.remove    actually delete (default: preview)
 * @param {string}   opts.backupDir download each file here before deleting it
 * @param {Function} opts.log
 */
export async function sweepDeletedDealFiles(supabase, { remove = false, backupDir = null, log = console.log } = {}) {
  // 1. Every `deal-<uuid>` folder at the top of each bucket.
  const folders = []                                   // { bucket, dealId, prefix }
  for (const bucket of BUCKETS) {
    for (const item of await listPage(supabase, bucket, '')) {
      const m = item.id === null && item.name.match(DEAL_FOLDER)
      if (m) folders.push({ bucket, dealId: m[1].toLowerCase(), prefix: item.name })
    }
  }
  const ids = [...new Set(folders.map(f => f.dealId))]
  const live = await existingDealIds(supabase, ids)
  const orphanFolders = folders.filter(f => !live.has(f.dealId))
  const liveFolders = folders.length - orphanFolders.length

  // A project where NO folder belongs to a live deal is far more likely to be
  // the wrong project or the wrong key than a firm with no deals left.
  if (folders.length && liveFolders === 0) {
    throw new Error(`None of the ${folders.length} deal folders matches a deal in this database. ` +
      'Check SUPABASE_URL and that SUPABASE_SERVICE_KEY is the service_role key for the same project. Nothing was deleted.')
  }

  // 2. Every file inside them, minus anything a surviving row still links to.
  const refs = orphanFolders.length ? await referencedPaths(supabase, log) : new Set()
  const files = []
  for (const f of orphanFolders) files.push(...await listFiles(supabase, f.bucket, f.prefix))
  for (const f of files) f.action = refs.has(f.path) ? 'keep-referenced' : 'delete'
  const doomed = files.filter(f => f.action === 'delete')

  const result = {
    folders: orphanFolders.length, liveFolders,
    files, bytes: doomed.reduce((s, f) => s + f.size, 0),
    deleted: 0, kept: files.length - doomed.length, failed: [],
  }
  if (!remove) return result

  // 3. Back up, then delete — in that order, per file.
  const deletable = []
  for (const f of doomed) {
    if (!backupDir) { deletable.push(f); continue }
    const { data, error } = await supabase.storage.from(f.bucket).download(f.path)
    if (error || !data) { f.action = 'keep-backup-failed'; result.failed.push(f); continue }
    const dest = join(backupDir, f.bucket, f.path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, Buffer.from(await data.arrayBuffer()))
    deletable.push(f)
  }
  for (const bucket of BUCKETS) {
    const paths = deletable.filter(f => f.bucket === bucket).map(f => f.path)
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100)
      const inBatch = new Set(batch)
      const { error } = await supabase.storage.from(bucket).remove(batch)
      if (error) log(`  ! could not delete ${batch.length} file(s) from ${bucket}: ${error.message}`)
      else result.deleted += batch.length
      for (const f of deletable) {
        if (f.bucket !== bucket || !inBatch.has(f.path)) continue
        f.action = error ? 'delete-failed' : 'deleted'
        if (error) result.failed.push(f)
      }
    }
  }
  result.bytes = files.filter(f => f.action === 'deleted').reduce((s, f) => s + f.size, 0)
  return result
}

export const formatBytes = (b) =>
  b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB`
  : b >= 1048576  ? `${(b / 1048576).toFixed(1)} MB`
  : b >= 1024     ? `${Math.round(b / 1024)} KB`
  : `${b} B`

export function toCsv(files) {
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`
  return ['bucket,path,bytes,action', ...files.map(f => [f.bucket, q(f.path), f.size, f.action].join(','))].join('\n') + '\n'
}

async function main() {
  const argv = process.argv.slice(2)
  const remove = argv.includes('--delete')
  const bi = argv.indexOf('--backup')
  const backupDir = bi >= 0 ? argv[bi + 1] : null
  if (bi >= 0 && (!backupDir || backupDir.startsWith('--'))) { console.error('--backup needs a folder: --backup ./deal-files-backup'); process.exit(1) }

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY'); process.exit(1) }
  if (keyRole(key) !== 'service_role') {
    console.error('SUPABASE_SERVICE_KEY is not the service_role key (Project Settings → API). With any other key every deal looks deleted.')
    process.exit(1)
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } })
  console.log(remove ? `Deleting files of deleted deals${backupDir ? ` (backing up to ${backupDir})` : ' (NO backup)'}…` : 'Preview — nothing will be deleted.')

  const r = await sweepDeletedDealFiles(supabase, { remove, backupDir })

  const byFolder = new Map()
  for (const f of r.files) {
    const k = `${f.bucket}/${f.path.split('/')[0]}`
    const e = byFolder.get(k) || { files: 0, bytes: 0 }
    e.files++; e.bytes += f.size
    byFolder.set(k, e)
  }
  for (const [k, e] of [...byFolder].sort((a, b) => b[1].bytes - a[1].bytes)) {
    console.log(`  ${formatBytes(e.bytes).padStart(9)}  ${String(e.files).padStart(4)} file(s)  ${k}`)
  }
  await writeFile('deleted-deal-files.csv', toCsv(r.files))

  console.log(`\n${r.folders} deleted deal folder(s) · ${r.liveFolders} live deal folder(s) left alone`)
  if (r.kept) console.log(`${r.kept} file(s) kept: a surviving record still links to them (see the CSV)`)
  if (remove) {
    console.log(`Deleted ${r.deleted} file(s), ${formatBytes(r.bytes)} freed.`)
    if (r.failed.length) console.log(`${r.failed.length} file(s) NOT deleted — see the CSV (backup or delete failed).`)
    console.log('Supabase can take up to an hour to update the usage number.')
  } else {
    console.log(`Would delete ${r.files.length - r.kept} file(s), ${formatBytes(r.bytes)}.`)
    console.log('Full list: deleted-deal-files.csv. Re-run with --backup <folder> --delete to delete.')
  }
}

if (process.argv[1] && process.argv[1].endsWith('cleanup-deleted-deal-files.mjs')) {
  main().catch((e) => { console.error(`\n${e.message}`); process.exit(1) })
}
