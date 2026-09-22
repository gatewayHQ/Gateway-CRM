import { describe, it, expect } from 'vitest'
import {
  propertyCoAgentIds,
  coAgentIdsForNewDeal,
  dealCoAgentIds,
  agentIdsOnDeal,
  isMissingCoAgentColumn,
} from '../coAgents.js'

const property = (co_agent_ids) => ({ id: 'p1', details: { co_agent_ids } })

describe('propertyCoAgentIds', () => {
  it('reads the ids out of the details blob', () => {
    expect(propertyCoAgentIds(property(['a2', 'a3']))).toEqual(['a2', 'a3'])
  })

  it('returns [] for a property with no co-agents, no details, or none at all', () => {
    expect(propertyCoAgentIds(property([]))).toEqual([])
    expect(propertyCoAgentIds({ id: 'p1' })).toEqual([])
    expect(propertyCoAgentIds(null)).toEqual([])
  })

  it('tolerates a non-array value left by an older write', () => {
    expect(propertyCoAgentIds({ details: { co_agent_ids: 'a2' } })).toEqual([])
  })
})

describe('coAgentIdsForNewDeal', () => {
  it('carries the property co-agents onto the deal', () => {
    expect(coAgentIdsForNewDeal(property(['a2', 'a3']), 'a1')).toEqual(['a2', 'a3'])
  })

  it('never lists the primary agent as their own co-agent', () => {
    expect(coAgentIdsForNewDeal(property(['a1', 'a2']), 'a1')).toEqual(['a2'])
  })

  it('de-duplicates and drops blanks', () => {
    expect(coAgentIdsForNewDeal(property(['a2', 'a2', null, '']), 'a1')).toEqual(['a2'])
  })

  it('is empty for an unassigned property with no co-agents', () => {
    expect(coAgentIdsForNewDeal(property([]), null)).toEqual([])
  })
})

describe('dealCoAgentIds', () => {
  // The bug this union exists for: the deal's column is a copy taken at
  // conversion, so an agent added to the LISTING afterwards is only ever on the
  // property. A "prefer the deal column" read showed one name while
  // app_visible_deal_ids() granted both — the card said shared, the database
  // said private, and nobody could see why.
  it('unions the deal column with the listing, so a later addition is not lost', () => {
    const deal = { agent_id: 'a1', co_agent_ids: ['a2'] }
    expect(dealCoAgentIds(deal, property(['a9']))).toEqual(['a2', 'a9'])
  })

  it('de-duplicates an agent recorded on both the deal and the listing', () => {
    const deal = { agent_id: 'a1', co_agent_ids: ['a2'] }
    expect(dealCoAgentIds(deal, property(['a2']))).toEqual(['a2'])
  })

  it('reads the linked property for deals converted before 0025', () => {
    const deal = { agent_id: 'a1', co_agent_ids: [] }
    expect(dealCoAgentIds(deal, property(['a2', 'a3']))).toEqual(['a2', 'a3'])
  })

  it('treats a missing column (undefined) the same as an empty one', () => {
    expect(dealCoAgentIds({ agent_id: 'a1' }, property(['a2']))).toEqual(['a2'])
  })

  it('excludes the primary agent from either source', () => {
    expect(dealCoAgentIds({ agent_id: 'a1', co_agent_ids: ['a1', 'a2'] })).toEqual(['a2'])
    expect(dealCoAgentIds({ agent_id: 'a1' }, property(['a1']))).toEqual([])
  })

  it('returns [] with no property to read', () => {
    expect(dealCoAgentIds({ agent_id: 'a1' })).toEqual([])
    expect(dealCoAgentIds(null)).toEqual([])
  })
})

describe('agentIdsOnDeal', () => {
  it('puts the primary agent first, then the co-agents', () => {
    const deal = { agent_id: 'a1', co_agent_ids: ['a3', 'a2'] }
    expect(agentIdsOnDeal(deal)).toEqual(['a1', 'a3', 'a2'])
  })

  it('never repeats an agent who is on the deal twice', () => {
    expect(agentIdsOnDeal({ agent_id: 'a1', co_agent_ids: ['a1', 'a2', 'a2'] })).toEqual(['a1', 'a2'])
  })

  it('handles an unassigned deal', () => {
    expect(agentIdsOnDeal({ agent_id: null, co_agent_ids: ['a2'] })).toEqual(['a2'])
  })

  // The listing agent is granted the deal by app_visible_deal_ids() whoever
  // started it, so the card has to name them or the UI is out of step again —
  // this time on the deal a colleague started on your own listing.
  it("includes the listing's assigned agent, who holds the property", () => {
    const deal = { agent_id: 'a1', co_agent_ids: [] }
    const listing = { ...property([]), assigned_agent_id: 'a7' }
    expect(agentIdsOnDeal(deal, listing)).toEqual(['a1', 'a7'])
  })

  it('does not repeat the listing agent when they also own the deal', () => {
    const deal = { agent_id: 'a1', co_agent_ids: ['a2'] }
    const listing = { ...property([]), assigned_agent_id: 'a1' }
    expect(agentIdsOnDeal(deal, listing)).toEqual(['a1', 'a2'])
  })

  it('names everyone on the listing and the deal, once each', () => {
    const deal = { agent_id: 'a1', co_agent_ids: ['a2'] }
    const listing = { ...property(['a2', 'a3']), assigned_agent_id: 'a4' }
    expect(agentIdsOnDeal(deal, listing)).toEqual(['a1', 'a2', 'a3', 'a4'])
  })
})

describe('isMissingCoAgentColumn', () => {
  it('recognizes the pre-migration schema error', () => {
    expect(isMissingCoAgentColumn({ message: "column deals.co_agent_ids does not exist" })).toBe(true)
  })

  it('leaves every other failure to the caller', () => {
    expect(isMissingCoAgentColumn({ message: 'permission denied for table deals' })).toBe(false)
    expect(isMissingCoAgentColumn(null)).toBe(false)
  })
})

// Regression guard for the crash that took the pipeline board down: the helper
// was originally exported as `dealAgentIds`, which is ALSO the name of an
// unrelated prop (an array of agent ids) that App.jsx threads into PipelinePage
// and CommissionPage. The import was shadowed by the prop inside the component,
// so calling it blew up with "not a function" the moment the board rendered.
describe('module surface', () => {
  it('does not export names that collide with the shared props of its callers', async () => {
    const mod = await import('../coAgents.js')
    const PROP_NAMES = ['dealAgentIds', 'visibleAgentIds', 'activeAgent', 'isAdmin', 'agents', 'deal', 'db']
    expect(Object.keys(mod).filter(name => PROP_NAMES.includes(name))).toEqual([])
  })
})
