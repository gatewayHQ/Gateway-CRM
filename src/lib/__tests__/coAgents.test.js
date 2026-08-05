import { describe, it, expect } from 'vitest'
import {
  propertyCoAgentIds,
  coAgentIdsForNewDeal,
  dealCoAgentIds,
  dealAgentIds,
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
  it('prefers the deal column once the conversion has stamped it', () => {
    const deal = { agent_id: 'a1', co_agent_ids: ['a2'] }
    expect(dealCoAgentIds(deal, property(['a9']))).toEqual(['a2'])
  })

  it('falls back to the linked property for deals converted before 0025', () => {
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

  it('returns [] with no property to fall back on', () => {
    expect(dealCoAgentIds({ agent_id: 'a1' })).toEqual([])
    expect(dealCoAgentIds(null)).toEqual([])
  })
})

describe('dealAgentIds', () => {
  it('puts the primary agent first, then the co-agents', () => {
    const deal = { agent_id: 'a1', co_agent_ids: ['a3', 'a2'] }
    expect(dealAgentIds(deal)).toEqual(['a1', 'a3', 'a2'])
  })

  it('never repeats an agent who is on the deal twice', () => {
    expect(dealAgentIds({ agent_id: 'a1', co_agent_ids: ['a1', 'a2', 'a2'] })).toEqual(['a1', 'a2'])
  })

  it('handles an unassigned deal', () => {
    expect(dealAgentIds({ agent_id: null, co_agent_ids: ['a2'] })).toEqual(['a2'])
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
