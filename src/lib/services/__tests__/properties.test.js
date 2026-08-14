// ─────────────────────────────────────────────────────────────────────────────
// Scoped property reads.
//
// Two things must hold once a team stops sharing properties:
//   1. A peer's properties disappear — the whole point of the flag.
//   2. A listing the agent is CO-AGENT on does not. Losing that was the trap:
//      the deal stays visible through deals.co_agent_ids while the property
//      behind it vanishes, and the agent splitting that commission can't open
//      the record they are working.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { fetchVisibleProperties } from '../properties.js'

const NIC = 'a-nic', STEPH = 'a-steph'

const OWN     = { id: 'p1', assigned_agent_id: NIC,   created_at: '2026-08-01' }
const CO      = { id: 'p2', assigned_agent_id: STEPH, created_at: '2026-08-03',
                  details: { co_agent_ids: [NIC] } }
const HERS    = { id: 'p3', assigned_agent_id: STEPH, created_at: '2026-08-02' }

// Minimal Supabase query-builder stand-in: records what was asked for and
// answers from a fixed table.
function client(rows, { failCoAgent = false, failOwn = false } = {}) {
  const calls = []
  return {
    calls,
    from() {
      const q = { _in: null, _contains: null }
      const builder = {
        select: () => builder,
        in: (col, ids) => { q._in = { col, ids }; return builder },
        contains: (col, val) => {
          q._contains = { col, val }
          calls.push(q)
          if (failCoAgent) return Promise.resolve({ data: null, error: { message: 'boom' } })
          const id = val.co_agent_ids[0]
          return Promise.resolve({
            data: rows.filter(r => (r.details?.co_agent_ids || []).includes(id)), error: null,
          })
        },
        order: () => {
          calls.push(q)
          if (failOwn) return Promise.resolve({ data: null, error: { message: 'boom' } })
          const data = q._in
            ? rows.filter(r => q._in.ids.includes(r[q._in.col]))
            : rows
          return Promise.resolve({ data, error: null })
        },
      }
      return builder
    },
  }
}

const ids = (res) => (res.data || []).map(p => p.id).sort()

describe('fetchVisibleProperties', () => {
  it('gives an admin the whole firm, unfiltered', async () => {
    const c = client([OWN, CO, HERS])
    expect(ids(await fetchVisibleProperties(c, { isAdmin: true, agentId: NIC, propertyAgentIds: [NIC] })))
      .toEqual(['p1', 'p2', 'p3'])
    expect(c.calls[0]._in).toBeNull()
  })

  it('drops a non-sharing peer’s properties but keeps a co-listing', async () => {
    const res = await fetchVisibleProperties(client([OWN, CO, HERS]),
      { isAdmin: false, agentId: NIC, propertyAgentIds: [NIC] })
    expect(ids(res)).toEqual(['p1', 'p2'])   // p3 — Steph's own book — is gone
  })

  it('includes a sharing peer’s properties when the flag is on', async () => {
    const res = await fetchVisibleProperties(client([OWN, CO, HERS]),
      { isAdmin: false, agentId: NIC, propertyAgentIds: [NIC, STEPH] })
    expect(ids(res)).toEqual(['p1', 'p2', 'p3'])
  })

  it('never double-counts a property that is both assigned and co-agented', async () => {
    const both = { ...OWN, details: { co_agent_ids: [NIC] } }
    const res = await fetchVisibleProperties(client([both]),
      { isAdmin: false, agentId: NIC, propertyAgentIds: [NIC] })
    expect(ids(res)).toEqual(['p1'])
  })

  it('returns newest first across both sources', async () => {
    const res = await fetchVisibleProperties(client([OWN, CO, HERS]),
      { isAdmin: false, agentId: NIC, propertyAgentIds: [NIC] })
    expect((res.data || []).map(p => p.id)).toEqual(['p2', 'p1'])  // 08-03 before 08-01
  })

  it('still returns owned properties when the co-agent lookup fails', async () => {
    const res = await fetchVisibleProperties(client([OWN, CO], { failCoAgent: true }),
      { isAdmin: false, agentId: NIC, propertyAgentIds: [NIC] })
    expect(ids(res)).toEqual(['p1'])
    expect(res.error).toBeNull()
  })

  it('surfaces a failure of the primary read rather than pretending it is empty', async () => {
    const res = await fetchVisibleProperties(client([OWN], { failOwn: true }),
      { isAdmin: false, agentId: NIC, propertyAgentIds: [NIC] })
    expect(res.error).toBeTruthy()
  })

  it('reads nothing when there is no agent and no scope', async () => {
    const res = await fetchVisibleProperties(client([OWN]), { isAdmin: false })
    expect(res.data).toEqual([])
  })
})
