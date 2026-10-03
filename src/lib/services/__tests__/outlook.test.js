// The Outlook status view shows an office admin EVERY agent's connection.
// These tests reproduce that: an unfiltered `.maybeSingle()` over several rows
// errors (PostgREST refuses), which is how admins saw "Not connected" once a
// second agent connected. Reads must filter to the signed-in agent.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// What the view returns to an office admin: everyone's rows.
const ROWS = [
  { agent_id: 'admin-1', email: 'boss@gw.com', status: 'connected' },
  { agent_id: 'agent-2', email: 'amy@gw.com', status: 'error' },
]
let currentAgentId = 'admin-1'
let rpcError = null

function query() {
  let rows = ROWS
  const q = {
    select: () => q,
    eq: (col, val) => { rows = rows.filter(r => r[col] === val); return q },
    // PostgREST: more than one row is an error for maybeSingle.
    maybeSingle: () => Promise.resolve(rows.length > 1
      ? { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
      : { data: rows[0] ?? null, error: null }),
  }
  return q
}

vi.mock('../../supabase.js', () => ({
  supabase: {
    rpc: (name) => Promise.resolve(name === 'app_current_agent_id'
      ? { data: rpcError ? null : currentAgentId, error: rpcError }
      : { data: null, error: { message: 'unknown rpc' } }),
    from: () => query(),
  },
}))

const { fetchOutlookConnection, fetchOutlookConnectionStatus, outlookState, isOutlookConnected } = await import('../outlook.js')

beforeEach(() => { currentAgentId = 'admin-1'; rpcError = null })

describe('Outlook connection reads', () => {
  it('reads only the signed-in agent’s row, even when an admin can see several', async () => {
    const { data, error } = await fetchOutlookConnection()
    expect(error).toBeNull()
    expect(data).toMatchObject({ agent_id: 'admin-1', status: 'connected' })
    expect((await fetchOutlookConnectionStatus()).data.status).toBe('connected')
  })

  it('returns the right row for another agent', async () => {
    currentAgentId = 'agent-2'
    expect((await fetchOutlookConnection()).data).toMatchObject({ agent_id: 'agent-2', status: 'error' })
  })

  it('returns no row (not an error) when the agent never connected', async () => {
    currentAgentId = 'agent-3'
    expect(await fetchOutlookConnection()).toEqual({ data: null, error: null })
  })

  it('passes a failure to resolve the agent through as an error', async () => {
    rpcError = { message: 'JWT expired' }
    const { data, error } = await fetchOutlookConnection()
    expect(data).toBeNull()
    expect(error.message).toBe('JWT expired')
  })
})

describe('outlookState', () => {
  it('means the same thing on every screen', () => {
    expect(outlookState({ status: 'connected' })).toBe('connected')
    expect(outlookState({ status: 'error' })).toBe('error')
    expect(outlookState({ status: 'disconnected' })).toBe('none')
    expect(outlookState(null)).toBe('none')
    expect(isOutlookConnected({ status: 'error' })).toBe(false)
    expect(isOutlookConnected({ status: 'connected' })).toBe(true)
  })
})
