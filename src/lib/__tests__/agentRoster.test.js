import { describe, it, expect } from 'vitest'
import {
  propertyCoAgentIds, dealCoAgentIds, propertyRosterIds, dealRosterIds,
  dealRoster, propertyRoster, dealAgentPayloadFromProperty,
  sameRoster, rosterNames, isRosterInherited,
} from '../agentRoster.js'

const A1 = { id: 'a1', name: 'Alex Primary',  email: 'alex@x.com' }
const A2 = { id: 'a2', name: 'Sam Co-Agent',  email: 'sam@x.com' }
const A3 = { id: 'a3', name: 'Pat Third',     email: 'pat@x.com' }
const AGENTS = [A1, A2, A3]

const dualProperty = {
  id: 'p1', assigned_agent_id: 'a1',
  details: { co_agent_ids: ['a2'] },
}

describe('reading co-agents off each record', () => {
  it('reads a property co-agent list out of details jsonb', () => {
    expect(propertyCoAgentIds(dualProperty)).toEqual(['a2'])
  })
  it('returns [] for a property with no details, no key, or a non-array value', () => {
    expect(propertyCoAgentIds(null)).toEqual([])
    expect(propertyCoAgentIds({ details: {} })).toEqual([])
    expect(propertyCoAgentIds({ details: { co_agent_ids: 'a2' } })).toEqual([])
  })
  it('reads a deal co-agent list out of the uuid[] column', () => {
    expect(dealCoAgentIds({ co_agent_ids: ['a2', 'a3'] })).toEqual(['a2', 'a3'])
    expect(dealCoAgentIds({})).toEqual([])           // column missing (pre-0024)
    expect(dealCoAgentIds({ co_agent_ids: null })).toEqual([])
  })
  it('puts the primary first on a property roster', () => {
    expect(propertyRosterIds(dualProperty)).toEqual(['a1', 'a2'])
  })
})

describe('dealRosterIds — the roster rule', () => {
  it('is primary + co-agents, primary first', () => {
    expect(dealRosterIds({ agent_id: 'a1', co_agent_ids: ['a2'] })).toEqual(['a1', 'a2'])
  })
  it('de-dupes a primary that also appears in co_agent_ids', () => {
    expect(dealRosterIds({ agent_id: 'a1', co_agent_ids: ['a1', 'a2'] })).toEqual(['a1', 'a2'])
  })
  it('drops null/empty ids', () => {
    expect(dealRosterIds({ agent_id: 'a1', co_agent_ids: [null, '', 'a2'] })).toEqual(['a1', 'a2'])
  })
  it('falls back to the property for a deal with no roster of its own (pre-fix deals)', () => {
    expect(dealRosterIds({ agent_id: 'a1' }, dualProperty)).toEqual(['a1', 'a2'])
  })
  it('prefers the deal roster over the property once the deal has one', () => {
    // Agent removed from the deal but still on the property — the deal wins, so
    // the property no longer rewrites deal history.
    expect(dealRosterIds({ agent_id: 'a1', co_agent_ids: ['a3'] }, dualProperty)).toEqual(['a1', 'a3'])
  })
  it('handles an unassigned deal', () => {
    expect(dealRosterIds({ agent_id: null, co_agent_ids: ['a2'] })).toEqual(['a2'])
    expect(dealRosterIds(null)).toEqual([])
  })
  it('flags an inherited (property-derived) roster', () => {
    expect(isRosterInherited({ agent_id: 'a1' }, dualProperty)).toBe(true)
    expect(isRosterInherited({ agent_id: 'a1', co_agent_ids: ['a2'] }, dualProperty)).toBe(false)
    expect(isRosterInherited({ agent_id: 'a1' }, null)).toBe(false)
  })
})

describe('dealRoster — resolving to agent records', () => {
  it('returns both agents, primary first', () => {
    expect(dealRoster({ agent_id: 'a1', co_agent_ids: ['a2'] }, AGENTS)).toEqual([A1, A2])
  })
  it('accepts the plain id→agent object the pages build with Object.fromEntries', () => {
    const map = Object.fromEntries(AGENTS.map(a => [a.id, a]))
    expect(dealRoster({ agent_id: 'a1', co_agent_ids: ['a2'] }, map)).toEqual([A1, A2])
  })
  it('accepts a Map', () => {
    const map = new Map(AGENTS.map(a => [a.id, a]))
    expect(dealRoster({ agent_id: 'a1', co_agent_ids: ['a2'] }, map)).toEqual([A1, A2])
  })
  it('drops ids with no matching agent record (agent deleted)', () => {
    expect(dealRoster({ agent_id: 'a1', co_agent_ids: ['gone'] }, AGENTS)).toEqual([A1])
  })
  it('resolves a property roster the same way', () => {
    expect(propertyRoster(dualProperty, AGENTS)).toEqual([A1, A2])
  })
})

describe('dealAgentPayloadFromProperty — Property → Deal conversion', () => {
  it('carries BOTH agents onto the deal', () => {
    expect(dealAgentPayloadFromProperty(dualProperty)).toEqual({
      agent_id: 'a1', co_agent_ids: ['a2'],
    })
  })

  it("uses the property's assignment as primary, NOT the acting user", () => {
    // The original bug: an admin (or the co-agent) clicking Start Deal became
    // the deal's agent and displaced the listing agent.
    expect(dealAgentPayloadFromProperty(dualProperty, { actingAgentId: 'a3' }))
      .toEqual({ agent_id: 'a1', co_agent_ids: ['a2'] })
  })

  it('falls back to the acting agent only when the property is unassigned', () => {
    const unassigned = { details: { co_agent_ids: ['a2'] } }
    expect(dealAgentPayloadFromProperty(unassigned, { actingAgentId: 'a3' }))
      .toEqual({ agent_id: 'a3', co_agent_ids: ['a2'] })
  })

  it('never lists the primary as its own co-agent', () => {
    const selfListed = { assigned_agent_id: 'a1', details: { co_agent_ids: ['a1', 'a2'] } }
    expect(dealAgentPayloadFromProperty(selfListed))
      .toEqual({ agent_id: 'a1', co_agent_ids: ['a2'] })
  })

  it('carries three or more agents', () => {
    const trio = { assigned_agent_id: 'a1', details: { co_agent_ids: ['a2', 'a3'] } }
    expect(dealAgentPayloadFromProperty(trio).co_agent_ids).toEqual(['a2', 'a3'])
  })

  it('produces an empty roster for a single-agent property', () => {
    expect(dealAgentPayloadFromProperty({ assigned_agent_id: 'a1', details: {} }))
      .toEqual({ agent_id: 'a1', co_agent_ids: [] })
  })

  it('de-dupes a co-agent listed twice on the property', () => {
    const dupe = { assigned_agent_id: 'a1', details: { co_agent_ids: ['a2', 'a2'] } }
    expect(dealAgentPayloadFromProperty(dupe).co_agent_ids).toEqual(['a2'])
  })
})

describe('sameRoster — transfer verification', () => {
  it('matches regardless of order', () => {
    expect(sameRoster(['a2', 'a3'], ['a3', 'a2'])).toBe(true)
  })
  it('detects a dropped agent — the silent-failure case', () => {
    expect(sameRoster(['a2', 'a3'], ['a2'])).toBe(false)
  })
  it('treats empty/undefined as equal', () => {
    expect(sameRoster([], undefined)).toBe(true)
  })
  it('ignores duplicates and nulls on either side', () => {
    expect(sameRoster(['a2', 'a2', null], ['a2'])).toBe(true)
  })
})

describe('rosterNames', () => {
  it('names the roster in order for toasts and audit lines', () => {
    expect(rosterNames(['a1', 'a2'], AGENTS)).toEqual(['Alex Primary', 'Sam Co-Agent'])
  })
  it('skips unknown ids rather than emitting blanks', () => {
    expect(rosterNames(['a1', 'gone'], AGENTS)).toEqual(['Alex Primary'])
  })
})
