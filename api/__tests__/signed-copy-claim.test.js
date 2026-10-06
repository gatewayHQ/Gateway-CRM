/**
 * WHO SENDS THE SIGNED COPY (claimSignedCopy / releaseSignedCopy in
 * api/boldsign.js, migration 0064).
 *
 * Agents stopped getting the signed-copy email because it went out only from
 * the webhook delivery that moved the row to 'completed'. A Refresh status
 * pressed after the last signature, or a first delivery that timed out while
 * archiving, got there first — and every later delivery found the transition
 * already made and stayed silent. The claim is the email's own ledger: any
 * completion delivery may take it, exactly one does.
 */
import { describe, it, expect } from 'vitest'
import { claimSignedCopy, releaseSignedCopy } from '../boldsign.js'

// One boldsign_documents row behind a compare-and-set-capable stub.
function fakeDb(row, { updateError = null } = {}) {
  const writes = []
  return {
    row, writes,
    from: () => {
      let patch = null
      const conds = []
      const run = () => {
        if (updateError) return { data: null, error: updateError }
        const hit = conds.every(([col, val, op]) => op === 'is' ? row[col] === val : row[col] === val)
        if (hit) { Object.assign(row, patch); writes.push(patch) }
        return { data: hit ? [{ id: row.id }] : [], error: null }
      }
      const chain = {
        update: (p) => { patch = p; return chain },
        eq: (col, val) => { conds.push([col, val]); return chain },
        is: (col, val) => { conds.push([col, val, 'is']); return chain },
        select: () => Promise.resolve(run()),
        then: (res, rej) => Promise.resolve(run()).then(res, rej),
      }
      return chain
    },
  }
}

const row = (over = {}) => ({ id: 'r1', document_id: 'doc-1', deal_id: 'deal-1', status: 'completed', signed_copy_emailed_at: null, ...over })

describe('claiming the signed-copy email', () => {
  it('lets a delivery that did NOT make the transition send — the case that was lost', async () => {
    const r = row()
    const db = fakeDb({ ...r })
    expect(await claimSignedCopy(db, r, { advanced: false })).toBe(true)
    expect(db.row.signed_copy_emailed_at).toBeTruthy()
  })

  it('lets exactly one of two concurrent deliveries send', async () => {
    const r = row()
    const db = fakeDb({ ...r })
    const [a, b] = await Promise.all([
      claimSignedCopy(db, r, { advanced: true }),
      claimSignedCopy(db, r, { advanced: false }),
    ])
    expect([a, b].filter(Boolean)).toHaveLength(1)
  })

  it('does not send again once the copy has gone out', async () => {
    const r = row({ signed_copy_emailed_at: '2026-10-01T00:00:00Z' })
    expect(await claimSignedCopy(fakeDb({ ...r }), r, { advanced: true })).toBe(false)
  })

  it('never sends for a document with no deal', async () => {
    const r = row({ deal_id: null })
    expect(await claimSignedCopy(fakeDb({ ...r }), r, { advanced: true })).toBe(false)
  })

  it('keeps the old rule on a database without migration 0064', async () => {
    const r = row(); delete r.signed_copy_emailed_at
    expect(await claimSignedCopy(fakeDb({ ...r }), r, { advanced: true })).toBe(true)
    expect(await claimSignedCopy(fakeDb({ ...r }), r, { advanced: false })).toBe(false)
  })

  it('falls back to the old rule when the claim cannot be written', async () => {
    const r = row()
    const db = fakeDb({ ...r }, { updateError: { message: 'boom' } })
    expect(await claimSignedCopy(db, r, { advanced: true })).toBe(true)
    expect(await claimSignedCopy(db, r, { advanced: false })).toBe(false)
  })

  it('gives the claim back after a failed send, so the next delivery retries', async () => {
    const r = row()
    const db = fakeDb({ ...r })
    expect(await claimSignedCopy(db, r, { advanced: true })).toBe(true)
    await releaseSignedCopy(db, r)
    expect(db.row.signed_copy_emailed_at).toBeNull()
    expect(await claimSignedCopy(db, r, { advanced: false })).toBe(true)
  })
})
