import { describe, it, expect } from 'vitest'
import { fetchVisibleDeals, fetchVisibleCommissions, fetchTaggedDealIds, fetchDealAgentTags } from '../deals.js'

// Minimal supabase-shaped mock: routes each from(table) call through `handler`
// and records the chained filters so assertions can inspect them.
function mockClient(handler) {
  const calls = []
  return {
    calls,
    from(table) {
      const call = { table, filters: [] }
      calls.push(call)
      const chain = {
        select() { return chain },
        order(column, opts) { call.filters.push(['order', column, opts]); return chain },
        in(column, values) { call.filters.push(['in', column, values]); return chain },
        eq(column, value) { call.filters.push(['eq', column, value]); return chain },
        contains(column, value) { call.filters.push(['contains', column, value]); return chain },
        then(resolve, reject) { return Promise.resolve(handler(call)).then(resolve, reject) },
      }
      return chain
    },
  }
}

const deal = (id, agent_id, created_at) => ({ id, agent_id, created_at })

describe('fetchTaggedDealIds', () => {
  it('returns de-duplicated deal ids the agent is tagged on', async () => {
    const client = mockClient((call) => {
      expect(call.table).toBe('deal_agents')
      expect(call.filters).toContainEqual(['eq', 'agent_id', 'agent-1'])
      return { data: [{ deal_id: 'd1' }, { deal_id: 'd1' }, { deal_id: 'd2' }, { deal_id: null }], error: null }
    })
    const { data } = await fetchTaggedDealIds(client, 'agent-1')
    expect([...data].sort()).toEqual(['d1', 'd2'])
  })

  it('returns empty (no error) when the tag lookup fails', async () => {
    const client = mockClient(() => ({ data: null, error: { message: 'boom' } }))
    const { data, error } = await fetchTaggedDealIds(client, 'agent-1')
    expect(data).toEqual([])
    expect(error).toBeTruthy()
  })

  it('returns empty without querying when there is no agent', async () => {
    const client = mockClient(() => { throw new Error('should not query') })
    const { data, error } = await fetchTaggedDealIds(client, null)
    expect(data).toEqual([])
    expect(error).toBeNull()
  })
})

describe('fetchVisibleDeals', () => {
  it('admin: fetches all deals unscoped', async () => {
    const client = mockClient(() => ({ data: [deal('d1'), deal('d2')], error: null }))
    const { data } = await fetchVisibleDeals(client, { isAdmin: true, agentId: 'a1' })
    expect(data).toHaveLength(2)
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].filters.some(f => f[0] === 'in')).toBe(false)
  })

  it('non-admin: merges own deals with tagged deals, deduped and sorted newest-first', async () => {
    const client = mockClient((call) => {
      if (call.table === 'deal_agents') return { data: [{ deal_id: 'own1' }, { deal_id: 'tag1' }], error: null }
      const inFilter = call.filters.find(f => f[0] === 'in')
      if (inFilter?.[1] === 'id') {
        // tagged fetch by id — only the id NOT already owned
        expect(inFilter[2]).toEqual(['tag1'])
        return { data: [deal('tag1', 'other-agent', '2026-06-02')], error: null }
      }
      // own deals (eq agent_id)
      expect(call.filters).toContainEqual(['eq', 'agent_id', 'a1'])
      return { data: [deal('own1', 'a1', '2026-06-01'), deal('own2', 'a1', '2026-06-03')], error: null }
    })
    const { data } = await fetchVisibleDeals(client, { isAdmin: false, agentId: 'a1' })
    expect(data.map(d => d.id)).toEqual(['own2', 'tag1', 'own1'])
  })

  it('non-admin: scopes the owner query to the agent id', async () => {
    const client = mockClient(() => ({ data: [], error: null }))
    await fetchVisibleDeals(client, { isAdmin: false, agentId: 'a1' })
    const dealsCall = client.calls.find(c => c.table === 'deals')
    expect(dealsCall.filters).toContainEqual(['eq', 'agent_id', 'a1'])
  })

  it('non-admin: still returns own deals when the tag lookup fails', async () => {
    const client = mockClient((call) =>
      call.table === 'deal_agents'
        ? { data: null, error: { message: 'boom' } }
        : { data: [deal('own1', 'a1', '2026-06-01')], error: null })
    const { data, error } = await fetchVisibleDeals(client, { isAdmin: false, agentId: 'a1' })
    expect(error).toBeNull()
    expect(data.map(d => d.id)).toEqual(['own1'])
  })
})

describe('fetchDealAgentTags', () => {
  it('returns empty without querying when there are no deal ids', async () => {
    const client = mockClient(() => { throw new Error('should not query') })
    const { data } = await fetchDealAgentTags(client, [])
    expect(data).toEqual([])
  })

  it('chunks large deal-id lists and flattens tag rows', async () => {
    const ids = Array.from({ length: 301 }, (_, i) => `d${i}`)
    const client = mockClient((call) => {
      const [, , values] = call.filters.find(f => f[0] === 'in')
      return { data: values.map(v => ({ deal_id: v, agent_id: 'a', role: 'primary' })), error: null }
    })
    const { data } = await fetchDealAgentTags(client, ids)
    expect(data).toHaveLength(301)
    expect(client.calls.length).toBe(3)
  })
})

describe('fetchVisibleCommissions', () => {
  it('admin: fetches all commissions', async () => {
    const client = mockClient(() => ({ data: [{ id: 'c1' }], error: null }))
    const { data } = await fetchVisibleCommissions(client, { isAdmin: true })
    expect(data).toHaveLength(1)
    expect(client.calls[0].filters.some(f => f[0] === 'in')).toBe(false)
  })

  it('non-admin: fetches only commissions for the visible deals', async () => {
    const client = mockClient((call) => {
      const [, column, values] = call.filters.find(f => f[0] === 'in')
      expect(column).toBe('deal_id')
      return { data: values.map(v => ({ deal_id: v })), error: null }
    })
    const { data } = await fetchVisibleCommissions(client, { isAdmin: false, dealIds: ['d1', 'd2'] })
    expect(data).toHaveLength(2)
  })

  it('non-admin with no deals: returns empty without querying', async () => {
    const client = mockClient(() => { throw new Error('should not query') })
    const { data } = await fetchVisibleCommissions(client, { isAdmin: false, dealIds: [] })
    expect(data).toEqual([])
  })

  it('chunks large id lists across multiple requests', async () => {
    const ids = Array.from({ length: 301 }, (_, i) => `d${i}`)
    const client = mockClient((call) => {
      const [, , values] = call.filters.find(f => f[0] === 'in')
      return { data: values.map(v => ({ deal_id: v })), error: null }
    })
    const { data } = await fetchVisibleCommissions(client, { isAdmin: false, dealIds: ids })
    expect(data).toHaveLength(301)
    expect(client.calls.length).toBe(3) // 150 + 150 + 1
  })
})
