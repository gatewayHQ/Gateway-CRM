import { describe, it, expect } from 'vitest'
import { findAgentForUser, resolveSignedInAgent } from '../agents.js'

const USER = { id: 'auth-1', email: 'Jane@Gateway.com' }

/** Supabase stub: `update` resolves with `updateResult`; a bare select returns `fresh`. */
function stubDb({ updateResult = { error: null }, fresh = [] } = {}) {
  const calls = { update: [] }
  const supabase = {
    from: () => ({
      update: (patch) => ({ eq: (col, val) => { calls.update.push({ patch, [col]: val }); return Promise.resolve(updateResult) } }),
      select: () => Promise.resolve({ data: fresh }),
    }),
  }
  return { supabase, calls }
}

describe('findAgentForUser', () => {
  it('prefers the row already claimed by this auth id', () => {
    const agents = [{ id: 'a1', email: 'jane@gateway.com' }, { id: 'a2', auth_id: 'auth-1' }]
    expect(findAgentForUser(agents, USER)).toEqual({ agent: agents[1], orphan: null })
  })
  it('offers an unclaimed row with the same email, case-insensitively', () => {
    const agents = [{ id: 'a1', email: 'jane@gateway.com' }]
    expect(findAgentForUser(agents, USER)).toEqual({ agent: null, orphan: agents[0] })
  })
  it('never offers a row someone else already claimed', () => {
    const agents = [{ id: 'a1', auth_id: 'other', email: 'jane@gateway.com' }]
    expect(findAgentForUser(agents, USER)).toEqual({ agent: null, orphan: null })
  })
  it('matches nothing without a user id', () => {
    expect(findAgentForUser([{ id: 'a1', email: 'jane@gateway.com' }], { email: 'jane@gateway.com' }))
      .toEqual({ agent: null, orphan: null })
  })
})

describe('resolveSignedInAgent', () => {
  it('returns an already-claimed agent without writing', async () => {
    const { supabase, calls } = stubDb()
    const agents = [{ id: 'a1', auth_id: 'auth-1' }]
    expect(await resolveSignedInAgent(supabase, agents, USER)).toEqual({ agent: agents[0], agents })
    expect(calls.update).toEqual([])
  })

  it('claims a pre-created agent by email', async () => {
    const { supabase, calls } = stubDb()
    const agents = [{ id: 'a1', email: 'jane@gateway.com' }]
    const res = await resolveSignedInAgent(supabase, agents, USER)
    expect(res.agent).toEqual({ id: 'a1', email: 'jane@gateway.com', auth_id: 'auth-1' })
    expect(calls.update).toEqual([{ patch: { auth_id: 'auth-1' }, id: 'a1' }])
  })

  it('re-reads the roster when the claim loses a race', async () => {
    const fresh = [{ id: 'a9', auth_id: 'auth-1' }]
    const { supabase } = stubDb({ updateResult: { error: { code: '23505' } }, fresh })
    const res = await resolveSignedInAgent(supabase, [{ id: 'a1', email: 'jane@gateway.com' }], USER)
    expect(res).toEqual({ agent: fresh[0], agents: fresh })
  })

  it('reports no agent when this user must onboard', async () => {
    const { supabase } = stubDb()
    expect((await resolveSignedInAgent(supabase, [], USER)).agent).toBeNull()
  })
})
