import { describe, it, expect } from 'vitest'
import { friendlyDbError } from '../dbErrors.js'

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

  it('handles foreign-key and not-null violations', () => {
    expect(friendlyDbError({ code: '23503' })).toMatch(/linked record/i)
    expect(friendlyDbError({ code: '23502', message: 'null value in column "first_name"' }))
      .toMatch(/first name/i)
  })

  it('returns null for unrecognized errors so callers can fall back', () => {
    expect(friendlyDbError({ code: '42P01', message: 'relation does not exist' })).toBeNull()
  })
})
