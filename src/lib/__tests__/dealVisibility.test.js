import { describe, it, expect } from 'vitest'
import {
  REL, relationshipLabel, dealRelationship, isTaggedOn, partitionTaggedDeals,
} from '../dealVisibility.js'

const ME = 'agent-me'
const deal = (id, agent_id, extra = {}) => ({ id, agent_id, ...extra })

describe('dealRelationship', () => {
  it('marks the deal owner as primary', () => {
    expect(dealRelationship(deal('d1', ME), { agentId: ME })).toBe(REL.PRIMARY)
  })

  it('marks a deal in coAgentDealIds as co-agent (Set or array)', () => {
    expect(dealRelationship(deal('d1', 'other'), { agentId: ME, coAgentDealIds: new Set(['d1']) })).toBe(REL.CO_AGENT)
    expect(dealRelationship(deal('d1', 'other'), { agentId: ME, coAgentDealIds: ['d1'] })).toBe(REL.CO_AGENT)
  })

  it('detects the legacy co_agent_ids array on the deal', () => {
    expect(dealRelationship(deal('d1', 'other', { co_agent_ids: [ME] }), { agentId: ME })).toBe(REL.CO_AGENT)
  })

  it('detects a commission participant when rows are available (admin path)', () => {
    const commissions = [{ deal_id: 'd1', participants: [{ agent_id: ME }] }]
    expect(dealRelationship(deal('d1', 'other'), { agentId: ME, commissions })).toBe(REL.CO_AGENT)
  })

  it('reports BOTH when the agent is owner AND separately tagged', () => {
    expect(dealRelationship(deal('d1', ME, { co_agent_ids: [ME] }), { agentId: ME })).toBe(REL.BOTH)
  })

  it('returns NONE for a teammate deal the agent is not on', () => {
    expect(dealRelationship(deal('d1', 'other', { co_agent_ids: ['someone-else'] }), { agentId: ME })).toBe(REL.NONE)
  })

  it('is defensive against missing inputs', () => {
    expect(dealRelationship(null, { agentId: ME })).toBe(REL.NONE)
    expect(dealRelationship(deal('d1', ME), {})).toBe(REL.NONE)
    expect(dealRelationship(deal('d1', 'other', { co_agent_ids: null }), { agentId: ME })).toBe(REL.NONE)
  })
})

describe('isTaggedOn', () => {
  it('is true for primary and co-agent, false otherwise', () => {
    expect(isTaggedOn(deal('d1', ME), { agentId: ME })).toBe(true)
    expect(isTaggedOn(deal('d1', 'x'), { agentId: ME, coAgentDealIds: ['d1'] })).toBe(true)
    expect(isTaggedOn(deal('d1', 'x'), { agentId: ME })).toBe(false)
  })
})

describe('partitionTaggedDeals', () => {
  it('separates tagged deals from leaked ones and records each relationship', () => {
    const deals = [
      deal('own', ME),
      deal('co', 'other', { co_agent_ids: [ME] }),
      deal('leak', 'other'),
    ]
    const { tagged, leaked, byId } = partitionTaggedDeals(deals, { agentId: ME })
    expect(tagged.map(d => d.id)).toEqual(['own', 'co'])
    expect(leaked.map(d => d.id)).toEqual(['leak'])
    expect(byId.get('own')).toBe(REL.PRIMARY)
    expect(byId.get('co')).toBe(REL.CO_AGENT)
    expect(byId.get('leak')).toBe(REL.NONE)
  })

  it('handles an empty / nullish list', () => {
    expect(partitionTaggedDeals(null, { agentId: ME })).toEqual({ tagged: [], leaked: [], byId: new Map() })
  })
})

describe('relationshipLabel', () => {
  it('maps every relationship to a human label', () => {
    expect(relationshipLabel(REL.PRIMARY)).toBe('Primary agent')
    expect(relationshipLabel(REL.CO_AGENT)).toBe('Co-agent')
    expect(relationshipLabel(REL.BOTH)).toBe('Primary + co-agent')
    expect(relationshipLabel(REL.NONE)).toBe('Not tagged')
  })
})
