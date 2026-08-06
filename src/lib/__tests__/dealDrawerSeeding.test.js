import { describe, it, expect } from 'vitest'
import { dealContactIdsFor } from '../../pages/Pipeline.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// The tab-switch bug, in one sentence: a re-fetch that changed nothing handed the
// deal drawer a NEW ARRAY, the seeding effect treated that as a change, and
// setTab() threw the agent out of the Signatures tab — taking the open BoldSign
// editor with it.
//
// The fix depends on this function's OUTPUT (a sorted id list joined into a key)
// instead of the array's identity, so these tests are the regression guard.
// ─────────────────────────────────────────────────────────────────────────────
const key = (rows, dealId) => dealContactIdsFor(rows, dealId).join(',')

describe('dealContactIdsFor', () => {
  const rows = [
    { deal_id: 'deal-1', contact_id: 'c-zeta' },
    { deal_id: 'deal-2', contact_id: 'c-other' },
    { deal_id: 'deal-1', contact_id: 'c-alpha' },
  ]

  it('returns only the contacts linked to that deal', () => {
    expect(dealContactIdsFor(rows, 'deal-1')).toEqual(['c-alpha', 'c-zeta'])
    expect(dealContactIdsFor(rows, 'deal-2')).toEqual(['c-other'])
  })

  it('sorts, so the same people in a different order are the same key', () => {
    // Postgres does not promise row order without ORDER BY, so two identical
    // re-fetches can legitimately come back in different orders. Unsorted, that
    // alone would look like a change and reset the drawer.
    const reordered = [rows[2], rows[1], rows[0]]
    expect(key(reordered, 'deal-1')).toBe(key(rows, 'deal-1'))
  })

  it('produces an identical key for a DIFFERENT array with the same contents', () => {
    // This is the actual bug: App's loader rebuilds `dealContacts` on every run, so
    // the array identity changes while the data does not. The key must not.
    const refetched = rows.map(r => ({ ...r }))
    expect(refetched).not.toBe(rows)
    expect(key(refetched, 'deal-1')).toBe(key(rows, 'deal-1'))
  })

  it('DOES change when a contact is genuinely added or removed', () => {
    // The guard must not overshoot: a real change still has to re-seed the drawer.
    const added = [...rows, { deal_id: 'deal-1', contact_id: 'c-new' }]
    expect(key(added, 'deal-1')).not.toBe(key(rows, 'deal-1'))

    const removed = rows.filter(r => r.contact_id !== 'c-zeta')
    expect(key(removed, 'deal-1')).not.toBe(key(rows, 'deal-1'))
  })

  it('is empty for a deal that has not been saved yet', () => {
    // A brand-new deal has no id, so there is nothing to look up — and reading the
    // whole table for `undefined` would seed every deal's contacts into it.
    expect(dealContactIdsFor(rows, null)).toEqual([])
    expect(dealContactIdsFor(rows, undefined)).toEqual([])
  })

  it('tolerates missing rows and malformed entries', () => {
    expect(dealContactIdsFor(null, 'deal-1')).toEqual([])
    expect(dealContactIdsFor([{ deal_id: 'deal-1' }, null, { contact_id: 'x' }], 'deal-1')).toEqual([])
  })
})
