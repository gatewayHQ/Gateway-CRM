import { describe, it, expect } from 'vitest'
import { partnerAgentIds, createPartnerLink, removePartnerLink, fetchPartnerLinks } from '../partners.js'

// Minimal supabase-shaped mock recording the table + chained ops.
function mockClient(handler = () => ({ data: null, error: null })) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, ops: [], payload: null }
      calls.push(call)
      const chain = {
        select() { call.ops.push('select'); return chain },
        order() { call.ops.push('order'); return Promise.resolve(handler(call)) },
        insert(rows) { call.ops.push('insert'); call.payload = rows; return chain },
        delete() { call.ops.push('delete'); return chain },
        eq(col, val) { call.ops.push(['eq', col, val]); return Promise.resolve(handler(call)) },
        single() { return Promise.resolve(handler(call)) },
      }
      return chain
    },
  }
}

describe('partnerAgentIds', () => {
  it('resolves partners bidirectionally and de-dupes', () => {
    const links = [
      { agent_a: 'me', agent_b: 'nic' },
      { agent_a: 'steph', agent_b: 'me' },
      { agent_a: 'x', agent_b: 'y' }, // unrelated
    ]
    expect(partnerAgentIds(links, 'me').sort()).toEqual(['nic', 'steph'])
  })
  it('returns [] for no agent or no links', () => {
    expect(partnerAgentIds([], 'me')).toEqual([])
    expect(partnerAgentIds([{ agent_a: 'a', agent_b: 'b' }], null)).toEqual([])
  })
})

describe('createPartnerLink', () => {
  it('order-normalizes the pair (agent_a < agent_b) to satisfy the DB constraint', async () => {
    const client = mockClient(() => ({ data: { id: 'p1' }, error: null }))
    await createPartnerLink(client, { agentA: 'zzz', agentB: 'aaa', createdBy: 'admin' })
    const call = client.calls.find(c => c.table === 'agent_partners')
    expect(call.payload).toEqual([{ agent_a: 'aaa', agent_b: 'zzz', created_by: 'admin' }])
  })
  it('rejects linking an agent to themselves or missing ids', async () => {
    const client = mockClient()
    expect((await createPartnerLink(client, { agentA: 'x', agentB: 'x' })).error).toBeTruthy()
    expect((await createPartnerLink(client, { agentA: 'x' })).error).toBeTruthy()
    expect(client.calls).toHaveLength(0) // never hit the DB
  })
})

describe('removePartnerLink', () => {
  it('deletes by id', async () => {
    const client = mockClient(() => ({ data: null, error: null }))
    await removePartnerLink(client, 'p1')
    const call = client.calls.find(c => c.table === 'agent_partners')
    expect(call.ops).toContain('delete')
    expect(call.ops).toContainEqual(['eq', 'id', 'p1'])
  })
  it('rejects a missing id without hitting the DB', async () => {
    const client = mockClient()
    expect((await removePartnerLink(client, null)).error).toBeTruthy()
    expect(client.calls).toHaveLength(0)
  })
})

describe('fetchPartnerLinks', () => {
  it('reads from agent_partners', async () => {
    const client = mockClient(() => ({ data: [{ id: 'p1' }], error: null }))
    const { data } = await fetchPartnerLinks(client)
    expect(data).toEqual([{ id: 'p1' }])
    expect(client.calls[0].table).toBe('agent_partners')
  })
})
