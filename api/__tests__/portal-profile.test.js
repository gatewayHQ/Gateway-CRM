// ─────────────────────────────────────────────────────────────────────────────
// profile-save: the commission-split save path.
//
// Two failures put these tests here:
//   1. A blank split field arrived as '' and was coerced with `Number(x) || 0`,
//      silently turning a 70% agent into a 0% agent.
//   2. The `agents` privilege-guard trigger froze privileged columns for callers
//      it didn't recognize, so the UPDATE reported success while changing
//      nothing — the UI toasted "saved" and the number reverted on reload.
//
// sanitizeProfilePayload covers (1); verifyPrivilegedWrite (exercised through
// the handler) covers (2).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { sanitizeProfilePayload, verifyPrivilegedWrite, profileDbError } from '../portal.js'

describe('sanitizeProfilePayload — column whitelist', () => {
  it('drops privileged fields for a non-admin, however they are sent', () => {
    const { payload } = sanitizeProfilePayload(
      { name: 'Dana', is_admin: true, role: 'Office Admin', default_split_pct: 100, cap_amount: 0 },
      { isAdmin: false },
    )
    expect(payload).toEqual({ name: 'Dana' })
  })

  it('lets an admin through to the privileged columns', () => {
    const { payload } = sanitizeProfilePayload(
      { name: 'Dana', default_split_pct: 65, no_brokerage_split: false },
      { isAdmin: true },
    )
    expect(payload).toEqual({ name: 'Dana', default_split_pct: 65, no_brokerage_split: false })
  })

  it('ignores columns nobody may set from the client', () => {
    const { payload } = sanitizeProfilePayload(
      { auth_id: 'someone-else', id: 'x', created_at: '2020-01-01', name: 'Dana' },
      { isAdmin: true },
    )
    expect(payload).toEqual({ name: 'Dana' })
  })
})

describe('sanitizeProfilePayload — commission split validation', () => {
  it('accepts a numeric string from the number input', () => {
    expect(sanitizeProfilePayload({ default_split_pct: '65' }, { isAdmin: true }).payload)
      .toEqual({ default_split_pct: 65 })
  })

  it('treats an empty split as "clear it", not as 0% — the bug that ate an agent’s take', () => {
    expect(sanitizeProfilePayload({ default_split_pct: '' }, { isAdmin: true }).payload)
      .toEqual({ default_split_pct: null })
  })

  it('rejects a non-numeric split instead of coercing it to 0', () => {
    expect(sanitizeProfilePayload({ default_split_pct: 'seventy' }, { isAdmin: true }).error)
      .toMatch(/must be a number/i)
  })

  it('rejects an out-of-range split at both ends', () => {
    expect(sanitizeProfilePayload({ default_split_pct: 101 }, { isAdmin: true }).error).toMatch(/above 100/i)
    expect(sanitizeProfilePayload({ default_split_pct: -1 },  { isAdmin: true }).error).toMatch(/below 0/i)
  })

  it('keeps the boundaries legal', () => {
    expect(sanitizeProfilePayload({ default_split_pct: 0 },   { isAdmin: true }).payload.default_split_pct).toBe(0)
    expect(sanitizeProfilePayload({ default_split_pct: 100 }, { isAdmin: true }).payload.default_split_pct).toBe(100)
  })

  it('rejects a negative cap and clears a blank one', () => {
    expect(sanitizeProfilePayload({ cap_amount: -5 }, { isAdmin: true }).error).toMatch(/below 0/i)
    expect(sanitizeProfilePayload({ cap_amount: '' }, { isAdmin: true }).payload).toEqual({ cap_amount: null })
  })

  it('normalizes a blank cap anniversary to null so the date column stays valid', () => {
    expect(sanitizeProfilePayload({ cap_anniversary: '' }, { isAdmin: true }).payload)
      .toEqual({ cap_anniversary: null })
  })

  it('coerces the flags to real booleans', () => {
    const { payload } = sanitizeProfilePayload(
      { no_brokerage_split: 'yes', is_admin: 0 }, { isAdmin: true },
    )
    expect(payload).toEqual({ no_brokerage_split: true, is_admin: false })
  })
})

describe('profileDbError', () => {
  it('names the migration when the stage_labels column is missing (Postgres 42703)', () => {
    expect(profileDbError({ message: 'column "stage_labels" of relation "agents" does not exist' }))
      .toMatch(/migration 0027/)
  })

  it('names the migration for PostgREST’s schema-cache wording too (PGRST204)', () => {
    expect(profileDbError({ message: "Could not find the 'stage_labels' column of 'agents' in the schema cache" }))
      .toMatch(/migration 0027/)
  })

  it('names any other missing column and points at the migrations', () => {
    expect(profileDbError({ message: 'column cap_amount does not exist' }))
      .toMatch(/"cap_amount".*latest migration/i)
  })

  it('passes an unrelated error through untouched', () => {
    expect(profileDbError({ message: 'duplicate key value violates unique constraint' }))
      .toBe('duplicate key value violates unique constraint')
  })
})

describe('verifyPrivilegedWrite — catching a silently frozen UPDATE', () => {
  it('reports nothing when the row came back with what we asked for', () => {
    expect(verifyPrivilegedWrite(
      { default_split_pct: 65, no_brokerage_split: false },
      { default_split_pct: 65, no_brokerage_split: false, name: 'Dana' },
    )).toEqual([])
  })

  it('names the split when the trigger reverted it — the reported bug', () => {
    expect(verifyPrivilegedWrite(
      { default_split_pct: 65 },
      { default_split_pct: 70 },
    )).toEqual(['default_split_pct'])
  })

  it('names every frozen field at once', () => {
    expect(verifyPrivilegedWrite(
      { is_admin: true, default_split_pct: 80, cap_amount: 25000 },
      { is_admin: false, default_split_pct: 70, cap_amount: 25000 },
    )).toEqual(['is_admin', 'default_split_pct'])
  })

  it('does not cry wolf over Postgres numeric-to-string round-tripping', () => {
    expect(verifyPrivilegedWrite({ default_split_pct: 65 }, { default_split_pct: '65.00' })).toEqual([])
    expect(verifyPrivilegedWrite({ cap_amount: 25000 },     { cap_amount: '25000' })).toEqual([])
  })

  it('treats null and undefined as the same cleared value', () => {
    expect(verifyPrivilegedWrite({ cap_amount: null }, { cap_amount: null })).toEqual([])
    expect(verifyPrivilegedWrite({ cap_anniversary: null }, {})).toEqual([])
  })

  it('still catches a real change to null', () => {
    expect(verifyPrivilegedWrite({ cap_amount: null }, { cap_amount: 25000 })).toEqual(['cap_amount'])
  })

  it('ignores non-privileged fields entirely', () => {
    expect(verifyPrivilegedWrite({ name: 'Dana' }, { name: 'Someone Else' })).toEqual([])
  })
})

describe('sanitizeProfilePayload — stage labels', () => {
  it('is a self-service field: an ordinary agent may rename their own columns', () => {
    const { payload } = sanitizeProfilePayload(
      { stage_labels: { offer: 'LOI Out' } }, { isAdmin: false },
    )
    expect(payload).toEqual({ stage_labels: { offer: 'LOI Out' } })
  })

  it('re-normalizes server-side rather than trusting the client', () => {
    const { payload } = sanitizeProfilePayload(
      { stage_labels: { offer: '  LOI   Out ', bogus: 'Hack', lead: 'Lead' } },
      { isAdmin: false },
    )
    expect(payload.stage_labels).toEqual({ offer: 'LOI Out' })
  })

  it('turns a non-object into an empty map instead of writing junk to jsonb', () => {
    expect(sanitizeProfilePayload({ stage_labels: 'nope' }, { isAdmin: false }).payload)
      .toEqual({ stage_labels: {} })
  })
})
