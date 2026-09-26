import { describe, it, expect } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepDeletedDealFiles, keyRole, toCsv } from '../cleanup-deleted-deal-files.mjs'

// The rule the owner set (2026-09-25): delete ONLY the files of deals that have
// been deleted. Every test below is either that rule or a way it could go wrong
// and take a live deal's paperwork with it.

const LIVE = '11111111-1111-1111-1111-111111111111'
const GONE = '22222222-2222-2222-2222-222222222222'

// In-memory stand-in for the parts of supabase-js the script uses.
function fakeSupabase({ objects, deals, rows = {}, failDownload = [], failDeals = false }) {
  const store = Object.fromEntries(Object.entries(objects).map(([b, files]) => [b, new Map(Object.entries(files))]))
  const removed = []

  const list = (bucket, prefix, { limit, offset }) => {
    const base = prefix ? `${prefix}/` : ''
    const seen = new Map()
    for (const [path, size] of store[bucket] || []) {
      if (!path.startsWith(base)) continue
      const [head, ...rest] = path.slice(base.length).split('/')
      if (!seen.has(head)) seen.set(head, rest.length ? { name: head, id: null } : { name: head, id: path, metadata: { size } })
    }
    const items = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
    return { data: items.slice(offset, offset + limit), error: null }
  }

  const query = (table) => {
    let ids = null, col = null, notNull = null, range = [0, Infinity]
    const q = {
      select(c) { col = c; return q },
      in(_c, v) { ids = v; return q },
      not(c) { notNull = c; return q },
      range(a, b) { range = [a, b]; return q },
      then(resolve) {
        if (table === 'deals') {
          if (failDeals) return resolve({ data: null, error: { message: 'boom' } })
          return resolve({ data: deals.filter(id => ids.includes(id)).map(id => ({ id })), error: null })
        }
        if (!(table in rows)) return resolve({ data: null, error: { code: 'PGRST205', message: `Could not find the table ${table}` } })
        const all = rows[table].filter(r => r[notNull] != null).map(r => ({ [col]: r[col] }))
        return resolve({ data: all.slice(range[0], range[1] + 1), error: null })
      },
    }
    return q
  }

  return {
    removed, store,
    from: query,
    storage: {
      from: (bucket) => ({
        list: async (prefix, opts) => list(bucket, prefix, opts),
        download: async (path) => failDownload.includes(path) || !store[bucket].has(path)
          ? { data: null, error: { message: 'nope' } }
          : { data: new Blob([`bytes of ${path}`]), error: null },
        remove: async (paths) => {
          for (const p of paths) { store[bucket].delete(p); removed.push(`${bucket}/${p}`) }
          return { data: paths, error: null }
        },
      }),
    },
  }
}

const baseline = () => ({
  deals: [LIVE],
  objects: {
    'deal-documents': {
      [`deal-${LIVE}/100-psa.pdf`]: 1000,
      [`deal-${LIVE}/mls/200-pack.pdf`]: 3000,
      [`deal-${GONE}/100-lease.pdf`]: 5000,
      [`deal-${GONE}/signed-psa-abcd.pdf`]: 7000,
      [`deal-${GONE}/print/ab-review.pdf`]: 900,
      'stray-top-level.pdf': 50,
      'deal-not-a-uuid/x.pdf': 60,
    },
    'closing-packets': {
      [`deal-${LIVE}/closing-packet-1.pdf`]: 9000,
      [`deal-${GONE}/closing-packet-1.pdf`]: 8000,
    },
  },
  rows: { documents: [], document_versions: [], closing_packets: [], boldsign_documents: [] },
})

describe('sweepDeletedDealFiles', () => {
  it('previews by default: lists the deleted deal’s files, deletes nothing', async () => {
    const sb = fakeSupabase(baseline())
    const r = await sweepDeletedDealFiles(sb, { log: () => {} })
    expect(r.files.map(f => `${f.bucket}/${f.path}`).sort()).toEqual([
      `closing-packets/deal-${GONE}/closing-packet-1.pdf`,
      `deal-documents/deal-${GONE}/100-lease.pdf`,
      `deal-documents/deal-${GONE}/print/ab-review.pdf`,
      `deal-documents/deal-${GONE}/signed-psa-abcd.pdf`,
    ])
    expect(r.bytes).toBe(5000 + 7000 + 900 + 8000)
    expect(sb.removed).toEqual([])
  })

  it('with remove, deletes exactly those files — every live deal file survives', async () => {
    const sb = fakeSupabase(baseline())
    const r = await sweepDeletedDealFiles(sb, { remove: true, log: () => {} })
    expect(r.deleted).toBe(4)
    expect(sb.removed.every(p => p.includes(`deal-${GONE}/`))).toBe(true)
    expect([...sb.store['deal-documents'].keys()]).toEqual([
      `deal-${LIVE}/100-psa.pdf`, `deal-${LIVE}/mls/200-pack.pdf`, 'stray-top-level.pdf', 'deal-not-a-uuid/x.pdf',
    ])
    expect([...sb.store['closing-packets'].keys()]).toEqual([`deal-${LIVE}/closing-packet-1.pdf`])
  })

  it('keeps a file a surviving record still links to', async () => {
    const opts = baseline()
    opts.rows.boldsign_documents = [{ signed_storage_path: `deal-${GONE}/signed-psa-abcd.pdf`, audit_storage_path: null, local_files: null }]
    opts.rows.document_versions  = [{ storage_path: `deal-${GONE}/100-lease.pdf` }]
    const sb = fakeSupabase(opts)
    const r = await sweepDeletedDealFiles(sb, { remove: true, log: () => {} })
    expect(r.kept).toBe(2)
    expect(sb.removed).not.toContain(`deal-documents/deal-${GONE}/signed-psa-abcd.pdf`)
    expect(sb.removed).not.toContain(`deal-documents/deal-${GONE}/100-lease.pdf`)
  })

  it('reads links out of the local_files manifest too', async () => {
    const opts = baseline()
    opts.rows.boldsign_documents = [{ local_files: [{ kind: 'split_part', path: `deal-${GONE}/print/ab-review.pdf` }] }]
    const r = await sweepDeletedDealFiles(fakeSupabase(opts), { log: () => {} })
    expect(r.files.find(f => f.path.endsWith('ab-review.pdf')).action).toBe('keep-referenced')
  })

  it('backs each file up before deleting it, and keeps any file it could not back up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deal-files-'))
    const sb = fakeSupabase({ ...baseline(), failDownload: [`deal-${GONE}/100-lease.pdf`] })
    const r = await sweepDeletedDealFiles(sb, { remove: true, backupDir: dir, log: () => {} })
    expect(await readFile(join(dir, 'closing-packets', `deal-${GONE}`, 'closing-packet-1.pdf'), 'utf8'))
      .toBe(`bytes of deal-${GONE}/closing-packet-1.pdf`)
    expect(sb.store['deal-documents'].has(`deal-${GONE}/100-lease.pdf`)).toBe(true)
    expect(r.failed.map(f => f.action)).toEqual(['keep-backup-failed'])
    expect(r.deleted).toBe(3)
  })

  it('refuses to run when no folder matches a live deal — wrong project or wrong key', async () => {
    const sb = fakeSupabase({ ...baseline(), deals: [] })
    await expect(sweepDeletedDealFiles(sb, { remove: true, log: () => {} })).rejects.toThrow(/Nothing was deleted/)
    expect(sb.removed).toEqual([])
  })

  it('aborts, deleting nothing, when deals cannot be read', async () => {
    const sb = fakeSupabase({ ...baseline(), failDeals: true })
    await expect(sweepDeletedDealFiles(sb, { remove: true, log: () => {} })).rejects.toThrow(/Could not read deals/)
    expect(sb.removed).toEqual([])
  })

  it('pages through buckets with more than one page of folders', async () => {
    const opts = baseline()
    for (let i = 0; i < 1200; i++) {
      const id = `33333333-3333-3333-3333-${String(i).padStart(12, '0')}`
      opts.objects['deal-documents'][`deal-${id}/a.pdf`] = 1
    }
    const r = await sweepDeletedDealFiles(fakeSupabase(opts), { log: () => {} })
    expect(r.folders).toBe(1200 + 2)   // + the deleted deal's folder in each bucket
  })
})

describe('keyRole', () => {
  const jwt = (role) => `x.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.y`
  it('accepts only the service key', () => {
    expect(keyRole(jwt('service_role'))).toBe('service_role')
    expect(keyRole('sb_secret_abc')).toBe('service_role')
    expect(keyRole(jwt('anon'))).toBe('anon')
    expect(keyRole('sb_publishable_abc')).toBe('anon')
    expect(keyRole('garbage')).toBe(null)
  })
})

describe('toCsv', () => {
  it('quotes paths so a comma in a file name cannot shift columns', () => {
    expect(toCsv([{ bucket: 'deal-documents', path: 'deal-x/a, "b".pdf', size: 5, action: 'delete' }]))
      .toBe('bucket,path,bytes,action\ndeal-documents,"deal-x/a, ""b"".pdf",5,delete\n')
  })
})
