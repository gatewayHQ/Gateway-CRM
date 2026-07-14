import { describe, it, expect } from 'vitest'
import { fetchVisibleDeals, fetchVisibleCommissions, fetchCoListedDealIds, syncPropertyStatusForStage } from '../deals.js'

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
        update(values) { call.filters.push(['update', values]); return chain },
        order(column, opts) { call.filters.push(['order', column, opts]); return chain },
        in(column, values) { call.filters.push(['in', column, values]); return chain },
        eq(column, value) { call.filters.push(['eq', column, value]); return chain },
        neq(column, value) { call.filters.push(['neq', column, value]); return chain },
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

describe('syncPropertyStatusForStage', () => {
  const linkedDeal = { id: 'd1', property_id: 'p1' }

  it.each(['under-contract', 'psa', 'due-diligence'])(
    'marks the linked property pending when the deal enters %s', async (stage) => {
      const client = mockClient(() => ({ data: [{ id: 'p1' }], error: null }))
      const res = await syncPropertyStatusForStage(client, linkedDeal, stage)
      expect(res).toEqual({ updated: true, propertyId: 'p1', status: 'pending' })
      expect(client.calls[0].table).toBe('properties')
      expect(client.calls[0].filters).toContainEqual(['update', { status: 'pending' }])
      expect(client.calls[0].filters).toContainEqual(['eq', 'id', 'p1'])
      // idempotence guard: rows already pending are excluded from the update
      expect(client.calls[0].filters).toContainEqual(['neq', 'status', 'pending'])
    })

  it('does nothing for stages that are not under contract', async () => {
    const client = mockClient(() => { throw new Error('should not query') })
    for (const stage of ['lead', 'offer', 'closed', 'lost', 'active']) {
      expect(await syncPropertyStatusForStage(client, linkedDeal, stage)).toEqual({ updated: false })
    }
  })

  it('does nothing when the deal has no linked property', async () => {
    const client = mockClient(() => { throw new Error('should not query') })
    expect(await syncPropertyStatusForStage(client, { id: 'd1' }, 'under-contract')).toEqual({ updated: false })
    expect(await syncPropertyStatusForStage(client, null, 'under-contract')).toEqual({ updated: false })
  })

  it('reports updated:false when the property was already pending', async () => {
    const client = mockClient(() => ({ data: [], error: null }))
    const res = await syncPropertyStatusForStage(client, linkedDeal, 'under-contract')
    expect(res.updated).toBe(false)
  })

  it('surfaces the error without throwing when the update fails', async () => {
    const client = mockClient(() => ({ data: null, error: { message: 'boom' } }))
    const res = await syncPropertyStatusForStage(client, linkedDeal, 'under-contract')
    expect(res.updated).toBe(false)
    expect(res.error).toBeTruthy()
  })
})
