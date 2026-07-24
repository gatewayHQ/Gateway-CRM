import { describe, it, expect } from 'vitest'
import {
  REASON, ENTITY, reasonLabel, recordVisibility, isVisible, partitionVisible,
} from '../visibility.js'

const ME = 'agent-me'
const deal = (id, agent_id, extra = {}) => ({ id, agent_id, ...extra })
const contact = (id, assigned_agent_id, extra = {}) => ({ id, assigned_agent_id, ...extra })

describe('recordVisibility — deals', () => {
  it('OWN when the agent is the owner', () => {
    expect(recordVisibility(deal('d1', ME), { agentId: ME }).reason).toBe(REASON.OWN)
  })

  it('CO_AGENT via coAgentIds (Set or array) or the record co_agent_ids field', () => {
    expect(recordVisibility(deal('d1', 'x'), { agentId: ME, coAgentIds: new Set(['d1']) }).reason).toBe(REASON.CO_AGENT)
    expect(recordVisibility(deal('d1', 'x'), { agentId: ME, coAgentIds: ['d1'] }).reason).toBe(REASON.CO_AGENT)
    expect(recordVisibility(deal('d1', 'x', { co_agent_ids: [ME] }), { agentId: ME }).reason).toBe(REASON.CO_AGENT)
  })

  it('PARTNER when the owner is one of my partners, and returns the partner id', () => {
    const v = recordVisibility(deal('d1', 'nic'), { agentId: ME, partnerIds: ['nic'] })
    expect(v.reason).toBe(REASON.PARTNER)
    expect(v.partnerId).toBe('nic')
  })

  it('prefers the most personal reason: OWN > CO_AGENT > PARTNER', () => {
    // owner AND co-tagged AND (owner is self) → OWN
    expect(recordVisibility(deal('d1', ME, { co_agent_ids: [ME] }), { agentId: ME, partnerIds: [ME] }).reason).toBe(REASON.OWN)
    // co-tagged AND owner is a partner → CO_AGENT wins
    expect(recordVisibility(deal('d1', 'nic', { co_agent_ids: [ME] }), { agentId: ME, partnerIds: ['nic'] }).reason).toBe(REASON.CO_AGENT)
  })

  it('NONE for a stranger deal (not owned, tagged, or partnered)', () => {
    expect(recordVisibility(deal('d1', 'someone'), { agentId: ME, partnerIds: ['nic'] }).reason).toBe(REASON.NONE)
  })

  it('is defensive against missing inputs', () => {
    expect(recordVisibility(null, { agentId: ME }).reason).toBe(REASON.NONE)
    expect(recordVisibility(deal('d1', ME), {}).reason).toBe(REASON.NONE)
  })
})

describe('recordVisibility — contacts/properties use assigned_agent_id', () => {
  const ctx = { agentId: ME, ...ENTITY.contact, partnerIds: ['nic'] }
  it('OWN when assigned to me', () => {
    expect(recordVisibility(contact('c1', ME), ctx).reason).toBe(REASON.OWN)
  })
  it('PARTNER when assigned to my partner', () => {
    expect(recordVisibility(contact('c1', 'nic'), ctx).reason).toBe(REASON.PARTNER)
  })
  it('NONE when assigned to a non-partner', () => {
    expect(recordVisibility(contact('c1', 'stranger'), ctx).reason).toBe(REASON.NONE)
  })
})

describe('isVisible', () => {
  it('is true for own/co-agent/partner, false for none', () => {
    expect(isVisible(deal('d1', ME), { agentId: ME })).toBe(true)
    expect(isVisible(deal('d1', 'nic'), { agentId: ME, partnerIds: ['nic'] })).toBe(true)
    expect(isVisible(deal('d1', 'x'), { agentId: ME })).toBe(false)
  })
})

describe('partitionVisible', () => {
  it('splits visible from leaked and records each reason', () => {
    const deals = [
      deal('own', ME),
      deal('co', 'x', { co_agent_ids: [ME] }),
      deal('partner', 'nic'),
      deal('leak', 'stranger'),
    ]
    const { visible, leaked, byId } = partitionVisible(deals, { agentId: ME, partnerIds: ['nic'] })
    expect(visible.map(d => d.id)).toEqual(['own', 'co', 'partner'])
    expect(leaked.map(d => d.id)).toEqual(['leak'])
    expect(byId.get('own').reason).toBe(REASON.OWN)
    expect(byId.get('co').reason).toBe(REASON.CO_AGENT)
    expect(byId.get('partner')).toEqual({ reason: REASON.PARTNER, partnerId: 'nic' })
    expect(byId.get('leak').reason).toBe(REASON.NONE)
  })

  it('handles a nullish list', () => {
    expect(partitionVisible(null, { agentId: ME })).toEqual({ visible: [], leaked: [], byId: new Map() })
  })
})

describe('reasonLabel', () => {
  it('labels every reason', () => {
    expect(reasonLabel(REASON.OWN)).toBe('Yours')
    expect(reasonLabel(REASON.CO_AGENT)).toBe('Co-agent')
    expect(reasonLabel(REASON.PARTNER)).toBe('Partner')
    expect(reasonLabel(REASON.NONE)).toBe('Not visible')
  })
})
