// ─────────────────────────────────────────────────────────────────────────────
// Duplicate-deal prevention — migration 0054.
//
// Two agents each had a deal on 102 7th St. SE: Steph's with 22 filled terms,
// 3 documents and a task, Emma's empty. Nothing failed to synchronise — they
// were two ROWS, and everything on a deal hangs off its id.
//
// The rule these assertions exist to hold: the check must reach the DATABASE.
// The deals in the browser are RLS-scoped, so Emma's client never contained
// Steph's deal — any client-side "does this property have a deal?" answers
// false for exactly the person about to create the duplicate.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { findOpenDealsOnProperty, requestDealAccess } from '../deals.js'

const rpcClient = (impl) => ({ rpc: async (fn, args) => impl(fn, args) })

describe('findOpenDealsOnProperty', () => {
  it('asks the database, not the in-memory deal list', async () => {
    let called = null
    const client = rpcClient((fn, args) => { called = { fn, args }; return { data: [], error: null } })
    await findOpenDealsOnProperty(client, 'prop-1', 'seller')
    expect(called.fn).toBe('app_open_deal_on_property')
    expect(called.args).toEqual({ p_property_id: 'prop-1', p_side: 'seller' })
  })

  it('returns the colleague deal the caller cannot otherwise see', async () => {
    const stephs = {
      deal_id: 'd1', title: '102 7th St. SE', stage: 'under-contract',
      side: 'seller', agent_id: 'a-steph', agent_name: 'Steph Dattolico',
    }
    const client = rpcClient(() => ({ data: [stephs], error: null }))
    const { deals, error } = await findOpenDealsOnProperty(client, 'prop-1', 'seller')
    expect(error).toBeNull()
    expect(deals).toEqual([stephs])
  })

  it('passes null for the side so "any side" is possible', async () => {
    let args = null
    const client = rpcClient((_fn, a) => { args = a; return { data: [], error: null } })
    await findOpenDealsOnProperty(client, 'prop-1')
    expect(args.p_side).toBeNull()
  })

  it('short-circuits with no property — a deal with no property cannot clash', async () => {
    let called = false
    const client = rpcClient(() => { called = true; return { data: [], error: null } })
    const { deals } = await findOpenDealsOnProperty(client, null, 'seller')
    expect(called).toBe(false)
    expect(deals).toEqual([])
  })

  it('treats a missing migration as "no duplicate", never as a block', async () => {
    // Code and migration ship independently. An agent must not be stopped from
    // starting a deal because a human has not pasted SQL yet — the same
    // degrade-and-continue rule the co-agent column uses.
    const client = rpcClient(() => ({ data: null, error: { message: 'Could not find the function public.app_open_deal_on_property' } }))
    const { deals, error, unavailable } = await findOpenDealsOnProperty(client, 'prop-1', 'seller')
    expect(deals).toEqual([])
    expect(error).toBeNull()
    expect(unavailable).toBe(true)
  })

  it('surfaces a real error rather than silently claiming no duplicate', async () => {
    const client = rpcClient(() => ({ data: null, error: { message: 'permission denied' } }))
    const { error, unavailable } = await findOpenDealsOnProperty(client, 'prop-1', 'seller')
    expect(error).toBe('permission denied')
    expect(unavailable).toBe(false)
  })
})

describe('requestDealAccess', () => {
  it('asks the owner and grants nothing itself', async () => {
    // A function that let an agent add THEMSELVES to any deal would be a
    // privilege escalation dressed up as a convenience. The only write here is
    // a notification to the deal's owner.
    let called = null
    const client = rpcClient((fn, args) => { called = { fn, args }; return { data: true, error: null } })
    const r = await requestDealAccess(client, 'd1')
    expect(called.fn).toBe('app_request_deal_access')
    expect(called.args).toEqual({ p_deal_id: 'd1' })
    expect(r.ok).toBe(true)
  })

  it('reports a refusal from the database', async () => {
    const client = rpcClient(() => ({ data: false, error: null }))
    const r = await requestDealAccess(client, 'd1')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('names the migration when the function is absent', async () => {
    const client = rpcClient(() => ({ data: null, error: { message: 'does not exist' } }))
    const r = await requestDealAccess(client, 'd1')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/0054/)
  })
})
