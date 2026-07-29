import { describe, it, expect } from 'vitest'
import { friendlyDbError, isUnknownColumnError } from '../dbErrors.js'

describe('friendlyDbError', () => {
  it('returns null when there is no error', () => {
    expect(friendlyDbError(null)).toBeNull()
    expect(friendlyDbError(undefined)).toBeNull()
  })

  it('names the field for a known check-constraint violation (the original bug)', () => {
    const err = {
      code: '23514',
      message: 'new row for relation "contacts" violates check constraint "contacts_status_check"',
    }
    const msg = friendlyDbError(err)
    expect(msg).toMatch(/Status/)
    expect(msg).toMatch(/migration/i)
    // Must not leak the raw SQL constraint name to the user.
    expect(msg).not.toMatch(/contacts_status_check/)
  })

  it('falls back to a generic check-constraint message for unmapped constraints', () => {
    const msg = friendlyDbError({
      code: '23514',
      message: 'violates check constraint "some_other_check"',
    })
    expect(msg).toMatch(/isn't accepted by the database/i)
  })

  it('detects a duplicate email', () => {
    const msg = friendlyDbError({
      code: '23505',
      message: 'duplicate key value violates unique constraint "contacts_email_key"',
    })
    expect(msg).toMatch(/email already exists/i)
  })

  it('explains a duplicate BoldSign template link instead of leaking the constraint name', () => {
    const msg = friendlyDbError({
      code: '23505',
      message: 'duplicate key value violates unique constraint "uq_form_packets_boldsign_tid"',
    })
    expect(msg).toMatch(/already linked to another form packet/i)
    expect(msg).not.toMatch(/uq_form_packets/)
  })

  it('handles foreign-key and not-null violations', () => {
    expect(friendlyDbError({ code: '23503' })).toMatch(/linked record/i)
    expect(friendlyDbError({ code: '23502', message: 'null value in column "first_name"' }))
      .toMatch(/first name/i)
  })

  it('returns null for unrecognized errors so callers can fall back', () => {
    expect(friendlyDbError({ code: '42P01', message: 'relation does not exist' })).toBeNull()
  })
})

describe('isUnknownColumnError — detecting an unapplied migration', () => {
  it('matches 42703 undefined_column for the named column', () => {
    const err = { code: '42703', message: 'column "co_agent_ids" of relation "deals" does not exist' }
    expect(isUnknownColumnError(err, 'co_agent_ids')).toBe(true)
  })

  it("matches PostgREST's schema-cache shape (PGRST204)", () => {
    const err = { code: 'PGRST204', message: "Could not find the 'co_agent_ids' column of 'deals' in the schema cache" }
    expect(isUnknownColumnError(err, 'co_agent_ids')).toBe(true)
  })

  it('does not match a DIFFERENT unknown column', () => {
    const err = { code: '42703', message: 'column "portal_token" does not exist' }
    expect(isUnknownColumnError(err, 'co_agent_ids')).toBe(false)
  })

  it('matches any unknown column when none is named', () => {
    expect(isUnknownColumnError({ code: '42703', message: 'column "x" does not exist' })).toBe(true)
  })

  it('does not match unrelated errors — a retry must not swallow a real failure', () => {
    expect(isUnknownColumnError({ code: '23505', message: 'duplicate key value' }, 'co_agent_ids')).toBe(false)
    expect(isUnknownColumnError({ code: '23503' })).toBe(false)
    expect(isUnknownColumnError(null)).toBe(false)
  })
})
