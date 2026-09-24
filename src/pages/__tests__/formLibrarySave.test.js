// Form Library save() against a database that is behind on migrations.
//
// This is where multi-file packets lost their files. With `storage_paths`
// (0022) missing, the save retried without it and succeeded: all five PDFs
// were in the bucket, the row named one, and the admin was told "Form packet
// added". The retry also fired on ANY missing-column error — it matched the
// error code, not the column — so a missing `required` (0028) stripped the file
// list too.
import { describe, it, expect } from 'vitest'
import { upsertPacketRow } from '../FormLibrary.jsx'

const FIVE = ['Purchase Agreement', 'Bill of Sale', 'Groundwater Hazard', 'Radon Disclosure', 'Lead Paint Addendum']
  .map((n, i) => ({ path: `IA/buyer/1723000000000-${i}-${n}.pdf`, name: `${n}.pdf` }))
const payload = (files) => ({
  state: 'IA', transaction_type: 'buyer', name: 'Iowa Buyer Contract Package',
  storage_path: files[0]?.path || null, storage_paths: files, required: false,
})

// A table missing `columns`; answers the way PostgREST does, naming the first one it meets.
function dbMissing(...columns) {
  const writes = []
  const upsert = async (body) => {
    writes.push(body)
    const missing = columns.find(c => c in body)
    if (missing) {
      return { data: null, error: { code: 'PGRST204', message: `Could not find the '${missing}' column of 'form_packets' in the schema cache` } }
    }
    return { data: [{ id: 'row-1', ...body }], error: null }
  }
  return { upsert, writes }
}

describe('upsertPacketRow', () => {
  it('writes every file when the database is current', async () => {
    const db = dbMissing()
    const { data, error, notice } = await upsertPacketRow(db.upsert, payload(FIVE))
    expect(error).toBeNull()
    expect(notice).toBe('')
    expect(data[0].storage_paths).toHaveLength(5)
    expect(db.writes).toHaveLength(1)
  })

  it('refuses a multi-file packet rather than recording file 1 of it', async () => {
    const db = dbMissing('storage_paths')
    const { error } = await upsertPacketRow(db.upsert, payload(FIVE))
    expect(error.message).toMatch(/5 PDFs.*migration 0022.*not changed/)
    // Nothing written without the file list.
    expect(db.writes.every(w => 'storage_paths' in w)).toBe(true)
  })

  it('still saves a one-file packet without storage_paths — storage_path is the whole of it', async () => {
    const db = dbMissing('storage_paths')
    const { data, error } = await upsertPacketRow(db.upsert, payload(FIVE.slice(0, 1)))
    expect(error).toBeNull()
    expect(data[0].storage_path).toBe(FIVE[0].path)
    expect('storage_paths' in data[0]).toBe(false)
  })

  it('drops only `required` when that is the column missing — the file list stays', async () => {
    const db = dbMissing('required')
    const { data, error, notice } = await upsertPacketRow(db.upsert, payload(FIVE))
    expect(error).toBeNull()
    expect(data[0].storage_paths).toHaveLength(5)
    expect('required' in data[0]).toBe(false)
    expect(notice).toMatch(/migration 0028/)
  })

  it('copes with both migrations missing, in either order the database reports them', async () => {
    for (const order of [['storage_paths', 'required'], ['required', 'storage_paths']]) {
      const one = await upsertPacketRow(dbMissing(...order).upsert, payload(FIVE.slice(0, 1)))
      expect(one.error).toBeNull()
      const many = await upsertPacketRow(dbMissing(...order).upsert, payload(FIVE))
      expect(many.error.message).toMatch(/migration 0022/)
    }
  })

  it('passes any other error straight through, untouched', async () => {
    const writes = []
    const upsert = async (body) => { writes.push(body); return { data: null, error: { code: '42501', message: 'new row violates row-level security policy for table "form_packets"' } } }
    const { error } = await upsertPacketRow(upsert, payload(FIVE))
    expect(error.code).toBe('42501')
    expect(writes).toHaveLength(1)
  })
})
