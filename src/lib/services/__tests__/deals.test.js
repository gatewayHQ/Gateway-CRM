import { describe, it, expect } from 'vitest'
import { fetchVisibleDeals, fetchVisibleCommissions, fetchCoListedDealIds } from '../deals.js'

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
        contains(column, value) { call.filters.push(['contains', column, value]); return chain },
        then(resolve, reject) { return Promise.resolve(handler(call)).then(resolve, reject) },
      }
      return chain
    },
  }
}

const deal = (id, agent_id, created_at) => ({ id, agent_id, created_at })

describe('fetchCoListedDealIds', () => {
  it('returns de-duplicated deal ids from participant containment', async () => {
    const client = mockClient(() => ({
      data: [{ deal_id: 'd1' }, { deal_id: 'd1' }, { deal_id: 'd2' }, { deal_id: null }],
      error: null,
    }))
    const { data } = await fetchCoListedDealIds(client, 'agent-1')
    expect(data).toEqual(['d1', 'd2'])
    expect(client.calls[0].table).toBe('commissions')
    expect(client.calls[0].filters[0][0]).toBe('contains')
  })

  it('returns empty without querying when there is no agent', async () => {
    const client = mockClient(() => { throw new Error('should not query') })
    const { data, error } = await fetchCoListedDealIds(client, null)
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

  it('non-admin: merges own/team deals with co-listed deals, deduped and sorted', async () => {
    const client = mockClient((call) => {
      if (call.table === 'commissions') return { data: [{ deal_id: 'own1' }, { deal_id: 'co1' }], error: null }
      const inFilter = call.filters.find(f => f[0] === 'in')
      if (inFilter?.[1] === 'agent_id') {
        return { data: [deal('own1', 'a1', '2026-06-01'), deal('own2', 'peer', '2026-06-03')], error: null }
      }
      // co-listed fetch by id — only the id NOT already owned
      expect(inFilter[2]).toEqual(['co1'])
      return { data: [deal('co1', 'other-agent', '2026-06-02')], error: null }
    })
    const { data } = await fetchVisibleDeals(client, {
      isAdmin: false, agentId: 'a1', dealAgentIds: ['a1', 'peer'],
    })
    expect(data.map(d => d.id)).toEqual(['own2', 'co1', 'own1']) // newest first
  })

  it('non-admin: scopes the owner query to the visible agent ids', async () => {
    const client = mockClient((call) =>
      call.table === 'commissions' ? { data: [], error: null } : { data: [], error: null })
    await fetchVisibleDeals(client, { isAdmin: false, agentId: 'a1', dealAgentIds: ['a1', 'peer'] })
    const dealsCall = client.calls.find(c => c.table === 'deals')
    expect(dealsCall.filters).toContainEqual(['in', 'agent_id', ['a1', 'peer']])
  })

  it('non-admin: still returns own deals when the co-listed lookup fails', async () => {
    const client = mockClient((call) =>
      call.table === 'commissions'
        ? { data: null, error: { message: 'boom' } }
        : { data: [deal('own1', 'a1', '2026-06-01')], error: null })
    const { data, error } = await fetchVisibleDeals(client, { isAdmin: false, agentId: 'a1', dealAgentIds: ['a1'] })
    expect(error).toBeNull()
    expect(data.map(d => d.id)).toEqual(['own1'])
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
