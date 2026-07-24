import { describe, it, expect } from 'vitest'
import { fetchVisibleDeals, fetchVisibleCommissions, fetchCoListedDealIds, fetchTaggedDeals } from '../deals.js'

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
        eq(column, value) { call.filters.push(['eq', column, value]); return chain },
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
  it('merges de-duplicated ids from participants and the legacy co_agent_ids column', async () => {
    const client = mockClient((call) =>
      call.table === 'commissions'
        ? { data: [{ deal_id: 'd1' }, { deal_id: 'd1' }, { deal_id: 'd2' }, { deal_id: null }], error: null }
        : { data: [{ id: 'd2' }, { id: 'd3' }], error: null })
    const { data } = await fetchCoListedDealIds(client, 'agent-1')
    expect([...data].sort()).toEqual(['d1', 'd2', 'd3'])
    expect(client.calls.map(c => c.table).sort()).toEqual(['commissions', 'deals'])
  })

  it('tolerates the legacy column being absent (fresh installs)', async () => {
    const client = mockClient((call) =>
      call.table === 'commissions'
        ? { data: [{ deal_id: 'd1' }], error: null }
        : { data: null, error: { message: 'column co_agent_ids does not exist' } })
    const { data, error } = await fetchCoListedDealIds(client, 'agent-1')
    expect(data).toEqual(['d1'])
    expect(error).toBeNull()
  })

  it('errors only when both sources fail', async () => {
    const client = mockClient(() => ({ data: null, error: { message: 'boom' } }))
    const { data, error } = await fetchCoListedDealIds(client, 'agent-1')
    expect(data).toEqual([])
    expect(error).toBeTruthy()
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
      if (call.filters.some(f => f[0] === 'contains')) return { data: [], error: null } // legacy co_agent_ids lookup
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

describe('fetchTaggedDeals', () => {
  it('returns own + co-listed deals scoped to the agent, newest first, with coAgentDealIds', async () => {
    const client = mockClient((call) => {
      if (call.table === 'commissions') return { data: [{ deal_id: 'co1' }], error: null }
      if (call.filters.some(f => f[0] === 'contains')) return { data: [], error: null } // legacy co_agent_ids lookup
      if (call.filters.some(f => f[0] === 'eq')) {
        return { data: [deal('own1', 'a1', '2026-06-01')], error: null } // owner query
      }
      // co-listed fetch by id
      const inFilter = call.filters.find(f => f[0] === 'in')
      expect(inFilter[2]).toEqual(['co1'])
      return { data: [deal('co1', 'other', '2026-06-05')], error: null }
    })
    const { data, coAgentDealIds } = await fetchTaggedDeals(client, { agentId: 'a1' })
    expect(data.map(d => d.id)).toEqual(['co1', 'own1']) // newest first
    expect(coAgentDealIds).toEqual(['co1'])
  })

  it('scopes the owner query with eq(agent_id) — never .in on team peers', async () => {
    const client = mockClient((call) =>
      call.table === 'commissions' ? { data: [], error: null } : { data: [], error: null })
    await fetchTaggedDeals(client, { agentId: 'a1' })
    const ownerCall = client.calls.find(c => c.table === 'deals' && c.filters.some(f => f[0] === 'eq'))
    expect(ownerCall.filters).toContainEqual(['eq', 'agent_id', 'a1'])
    expect(client.calls.some(c => c.filters.some(f => f[0] === 'in' && f[1] === 'agent_id'))).toBe(false)
  })

  it('still returns own deals when the co-listed lookup fails', async () => {
    const client = mockClient((call) => {
      if (call.table === 'commissions') return { data: null, error: { message: 'boom' } }
      // legacy co_agent_ids lookup (deals + .contains) also fails
      if (call.filters.some(f => f[0] === 'contains')) return { data: null, error: { message: 'boom' } }
      // owner query (deals + .eq) succeeds
      return { data: [deal('own1', 'a1', '2026-06-01')], error: null }
    })
    const { data, coAgentDealIds, error } = await fetchTaggedDeals(client, { agentId: 'a1' })
    expect(error).toBeNull()
    expect(data.map(d => d.id)).toEqual(['own1'])
    expect(coAgentDealIds).toEqual([])
  })

  it('returns empty without querying when there is no agent', async () => {
    const client = mockClient(() => { throw new Error('should not query') })
    const { data, coAgentDealIds } = await fetchTaggedDeals(client, { agentId: null })
    expect(data).toEqual([])
    expect(coAgentDealIds).toEqual([])
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
