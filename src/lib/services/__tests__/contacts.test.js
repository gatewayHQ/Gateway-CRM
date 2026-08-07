// ─────────────────────────────────────────────────────────────────────────────
// Contact upsert — identity matching and gap-filling.
//
// ColdCalls convert and Leads convert both blind-INSERTed, so the same owner
// reached twice became two contact rows each holding half the history. These
// cover the matching rules that stop that.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  normalizeEmail, contactIdentity, findExistingContact, upsertContact,
} from '../contacts.js'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const EXISTING = [
  { id: 'c1', first_name: 'Dana', last_name: 'Whitfield', email: 'Dana@Acme.com', phone: '+15155550123', tags: ['newsletter'] },
  { id: 'c2', first_name: 'Marcus', last_name: 'Reed', email: null, phone: '+16055551000', tags: [] },
]

/** Minimal supabase stub recording what the helper tried to do. */
function stubDb({ insertResult, updateResult } = {}) {
  const calls = { insert: [], update: [] }
  const api = {
    from: () => api,
    insert: (rows) => { calls.insert.push(rows); return api },
    update: (patch) => { calls.update.push(patch); return api },
    eq: () => api,
    select: () => api,
    single: async () => calls.update.length
      ? (updateResult ?? { data: { id: 'c1', ...calls.update[0] }, error: null })
      : (insertResult ?? { data: { id: 'new', ...calls.insert[0][0] }, error: null }),
  }
  return { api, calls }
}

describe('normalizeEmail', () => {
  it('lower-cases and trims', () => {
    expect(normalizeEmail('  Dana@Acme.COM ')).toBe('dana@acme.com')
  })
  it('treats blank as absent', () => {
    expect(normalizeEmail('')).toBeNull()
    expect(normalizeEmail('   ')).toBeNull()
    expect(normalizeEmail(null)).toBeNull()
  })
})

describe('contactIdentity', () => {
  it('prefers email, compared case-insensitively', () => {
    expect(contactIdentity({ email: 'A@B.com' })).toBe('email:a@b.com')
    expect(contactIdentity({ email: 'a@b.com' })).toBe(contactIdentity({ email: 'A@B.COM' }))
  })
  it('falls back to phone in E.164, so formatting differences are one person', () => {
    expect(contactIdentity({ phone: '(515) 555-0123' })).toBe(contactIdentity({ phone: '5155550123' }))
    expect(contactIdentity({ phone: '+1 515 555 0123' })).toBe('phone:+15155550123')
  })
  it('is null with neither — name alone must never merge two people', () => {
    expect(contactIdentity({ first_name: 'Dana', last_name: 'Whitfield' })).toBeNull()
    expect(contactIdentity({})).toBeNull()
  })
})

describe('findExistingContact', () => {
  it('matches on email regardless of case', () => {
    expect(findExistingContact(EXISTING, { email: 'dana@acme.com' })?.id).toBe('c1')
  })
  it('matches on a differently-formatted phone', () => {
    expect(findExistingContact(EXISTING, { phone: '(605) 555-1000' })?.id).toBe('c2')
  })
  it('returns null for someone genuinely new', () => {
    expect(findExistingContact(EXISTING, { email: 'nobody@else.com' })).toBeNull()
  })
  it('returns null when the incoming person has no identity at all', () => {
    expect(findExistingContact(EXISTING, { first_name: 'Dana' })).toBeNull()
  })
  it('does not match an identity-less existing row by accident', () => {
    const rows = [{ id: 'x', first_name: 'Ghost' }]
    expect(findExistingContact(rows, { first_name: 'Ghost' })).toBeNull()
  })
})

describe('upsertContact', () => {
  it('inserts when the person is new', async () => {
    const { api, calls } = stubDb()
    const r = await upsertContact(api, { first_name: 'New', email: 'new@x.com' }, EXISTING)
    expect(r.created).toBe(true)
    expect(r.error).toBeNull()
    expect(calls.insert).toHaveLength(1)
    expect(calls.update).toHaveLength(0)
  })

  it('normalizes email and phone before writing', async () => {
    const { api, calls } = stubDb()
    await upsertContact(api, { first_name: 'N', email: '  MiXeD@Case.COM ', phone: '(515) 555-9999' }, [])
    expect(calls.insert[0][0].email).toBe('mixed@case.com')
    expect(calls.insert[0][0].phone).toBe('+15155559999')
  })

  it('does not insert a duplicate when the person is already known', async () => {
    const { api, calls } = stubDb()
    const r = await upsertContact(api, { first_name: 'Dana', email: 'DANA@acme.com' }, EXISTING)
    expect(r.created).toBe(false)
    expect(calls.insert).toHaveLength(0)
  })

  it('fills only blank fields — a richer existing record is never downgraded', async () => {
    const { api, calls } = stubDb()
    await upsertContact(api, {
      first_name: 'Danielle',           // existing 'Dana' must win
      email: 'dana@acme.com',
      notes: 'Called about 1420 Grand', // existing is blank -> fills
    }, EXISTING)
    expect(calls.update).toHaveLength(1)
    expect(calls.update[0].notes).toBe('Called about 1420 Grand')
    expect(calls.update[0].first_name).toBeUndefined()
  })

  it('merges tags additively rather than replacing them', async () => {
    const { api, calls } = stubDb()
    await upsertContact(api, { email: 'dana@acme.com', tags: ['cold call'] }, EXISTING)
    expect(calls.update[0].tags).toEqual(['newsletter', 'cold call'])
  })

  it('skips the write entirely when there is nothing to add', async () => {
    const { api, calls } = stubDb()
    const r = await upsertContact(api, { email: 'dana@acme.com' }, EXISTING)
    expect(calls.update).toHaveLength(0)
    expect(calls.insert).toHaveLength(0)
    expect(r.created).toBe(false)
    expect(r.contact.id).toBe('c1')
  })

  it('surfaces an insert error as a string instead of throwing', async () => {
    const { api } = stubDb({ insertResult: { data: null, error: { message: 'boom' } } })
    const r = await upsertContact(api, { email: 'new@x.com' }, [])
    expect(r.error).toBe('boom')
    expect(r.contact).toBeNull()
  })

  it('treats a person with no email or phone as new every time', async () => {
    const { api, calls } = stubDb()
    const r = await upsertContact(api, { first_name: 'Walk', last_name: 'In' }, EXISTING)
    expect(r.created).toBe(true)
    expect(calls.insert).toHaveLength(1)
  })
})

describe('the conversion paths use the shared helper', () => {
  it.each([
    ['ColdCalls', '../../../pages/ColdCalls.jsx'],
    ['Leads',     '../../../pages/Leads.jsx'],
    ['QuickAdd',  '../../../pages/QuickAdd.jsx'],
  ])('%s converts through upsertContact, not a raw insert', (_name, rel) => {
    const src = read(rel)
    expect(src).toMatch(/upsertContact\(/)
    expect(src).not.toMatch(/from\('contacts'\)\.insert/)
  })

  it('QuickAdd captures a real source instead of hardcoding "other"', () => {
    const src = read('../../../pages/QuickAdd.jsx')
    expect(src).not.toMatch(/source: 'other'/)
    expect(src).toMatch(/CONTACT_SOURCES/)
  })
})
