import { describe, it, expect } from 'vitest'
import { fetchVisibleDeals, fetchVisibleCommissions } from '../deals.js'

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

describe('fetchVisibleDeals', () => {
  // Visibility is enforced by RLS server-side, so the client just selects deals
  // ordered newest-first and never re-derives scope with client-side filters.
  it('selects all deals ordered by created_at, letting RLS scope the rows', async () => {
    const client = mockClient(() => ({ data: [deal('d1'), deal('d2')], error: null }))
    const { data } = await fetchVisibleDeals(client, { isAdmin: false, agentId: 'a1', dealAgentIds: ['a1', 'peer'] })
    expect(data).toHaveLength(2)
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].table).toBe('deals')
    // No client-side scoping filters — RLS does it in the database.
    expect(client.calls[0].filters.some(f => f[0] === 'in')).toBe(false)
    expect(client.calls[0].filters).toContainEqual(['order', 'created_at', { ascending: false }])
  })

  it('behaves the same for admins (RLS returns the full firm)', async () => {
    const client = mockClient(() => ({ data: [deal('d1')], error: null }))
    const { data } = await fetchVisibleDeals(client, { isAdmin: true, agentId: 'a1' })
    expect(data).toHaveLength(1)
    expect(client.calls).toHaveLength(1)
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
