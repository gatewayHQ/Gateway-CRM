import { describe, it, expect } from 'vitest'
import {
  TID_CONSTRAINT,
  normalizeTemplateId,
  isTemplateIdConflictError,
  describeTemplateIdConflict,
  escapeLikePattern,
  findPacketByTemplateId,
} from '../formPackets.js'

describe('normalizeTemplateId', () => {
  it('strips whitespace a paste from the BoldSign UI carries', () => {
    expect(normalizeTemplateId('  8f1c2b40-1e3a-4f9b-9d21-aa0b1c2d3e4f\n')).toBe('8f1c2b40-1e3a-4f9b-9d21-aa0b1c2d3e4f')
    expect(normalizeTemplateId('8f1c2b40 -1e3a')).toBe('8f1c2b40-1e3a')
  })
  it('strips a non-breaking space (copied out of a table cell)', () => {
    expect(normalizeTemplateId(' abc ')).toBe('abc')
  })
  it('returns null for blank input so the column stays NULL, never an empty string', () => {
    // '' is a *value* — under the partial unique index the second blank packet
    // would collide with the first.
    expect(normalizeTemplateId('')).toBeNull()
    expect(normalizeTemplateId('   ')).toBeNull()
    expect(normalizeTemplateId(null)).toBeNull()
    expect(normalizeTemplateId(undefined)).toBeNull()
  })
})

describe('isTemplateIdConflictError', () => {
  it('recognizes the unique violation on the template-id index', () => {
    expect(isTemplateIdConflictError({
      code: '23505',
      message: `duplicate key value violates unique constraint "${TID_CONSTRAINT}"`,
    })).toBe(true)
  })
  it('recognizes it when the constraint name only appears in details/constraint', () => {
    expect(isTemplateIdConflictError({ code: '23505', message: 'duplicate key', constraint: TID_CONSTRAINT })).toBe(true)
    expect(isTemplateIdConflictError({ code: '23505', message: 'dup', details: `Key ... ${TID_CONSTRAINT}` })).toBe(true)
  })
  it('does not claim unrelated unique violations or other errors', () => {
    expect(isTemplateIdConflictError({ code: '23505', message: 'duplicate key value violates unique constraint "uq_something_else"' })).toBe(false)
    expect(isTemplateIdConflictError({ code: '42703', message: 'column storage_paths does not exist' })).toBe(false)
    expect(isTemplateIdConflictError(null)).toBe(false)
    expect(isTemplateIdConflictError(undefined)).toBe(false)
  })
})

describe('describeTemplateIdConflict', () => {
  it('names the packet that already owns the id', () => {
    const msg = describeTemplateIdConflict('tid-1', {
      id: 'p1', name: 'Iowa Listing Agreement', state: 'IA', transaction_type: 'seller', active: true,
    })
    expect(msg).toContain('Iowa Listing Agreement')
    expect(msg).toContain('IA · seller')
    expect(msg).not.toContain('disabled')
  })
  it('flags a disabled row — the auto-discovered draft case an admin cannot see in the send picker', () => {
    const msg = describeTemplateIdConflict('tid-1', {
      id: 'p1', name: 'Iowa Listing Agreement', state: 'IA', transaction_type: 'seller', active: false,
    })
    expect(msg).toContain('disabled')
  })
  it('still says something useful when the owning row could not be read', () => {
    expect(describeTemplateIdConflict('tid-1', null)).toContain('tid-1')
  })
})

describe('escapeLikePattern', () => {
  it('neutralizes LIKE and PostgREST wildcards', () => {
    expect(escapeLikePattern('a%b_c*d')).toBe('a\\%b\\_c\\*d')
  })
  it('leaves a plain GUID untouched', () => {
    expect(escapeLikePattern('8f1c2b40-1e3a-4f9b')).toBe('8f1c2b40-1e3a-4f9b')
  })
})

// Minimal chainable Supabase stub — records the query it was asked to build.
function stubClient(result) {
  const calls = { filters: [] }
  const q = {
    select() { return q },
    ilike(col, val) { calls.filters.push(['ilike', col, val]); return q },
    neq(col, val) { calls.filters.push(['neq', col, val]); return q },
    limit() { return q },
    then(resolve) { return Promise.resolve(result).then(resolve) },
  }
  return { calls, from(table) { calls.table = table; return q } }
}

describe('findPacketByTemplateId', () => {
  it('matches case-insensitively so a re-paste in different casing is caught', async () => {
    const client = stubClient({ data: [{ id: 'p1', name: 'Iowa Listing' }], error: null })
    const { row, error } = await findPacketByTemplateId(client, ' 8F1C2B40 ')
    expect(client.calls.table).toBe('form_packets')
    expect(client.calls.filters).toContainEqual(['ilike', 'boldsign_template_id', '8F1C2B40'])
    expect(row.id).toBe('p1')
    expect(error).toBeNull()
  })
  it('excludes the row being edited, so re-saving a linked packet is not a conflict', async () => {
    const client = stubClient({ data: [], error: null })
    const { row } = await findPacketByTemplateId(client, 'tid-1', { excludeId: 'p1' })
    expect(client.calls.filters).toContainEqual(['neq', 'id', 'p1'])
    expect(row).toBeNull()
  })
  it('short-circuits on a blank id without querying', async () => {
    const client = stubClient({ data: [{ id: 'nope' }], error: null })
    const { row } = await findPacketByTemplateId(client, '  ')
    expect(client.calls.table).toBeUndefined()
    expect(row).toBeNull()
  })
  it('reports a lookup error instead of pretending there is no conflict', async () => {
    const client = stubClient({ data: null, error: { message: 'boom' } })
    const { row, error } = await findPacketByTemplateId(client, 'tid-1')
    expect(row).toBeNull()
    expect(error.message).toBe('boom')
  })
})
