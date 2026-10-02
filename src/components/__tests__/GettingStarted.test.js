import { describe, it, expect } from 'vitest'
import { gettingStartedSteps, isNewAgent, myDealsFor } from '../GettingStarted.jsx'

const done = (steps) => steps.filter(s => s.done).map(s => s.id)

describe('isNewAgent — who sees the card', () => {
  it('shows for an agent with no deals of their own', () => {
    expect(isNewAgent({ agentId: 'a1', deals: [{ id: 'd1', agent_id: 'a2' }] })).toBe(true)
  })
  it('never shows for an agent who has had a deal — even a closed or lost one', () => {
    expect(isNewAgent({ agentId: 'a1', deals: [{ id: 'd1', agent_id: 'a1', stage: 'closed' }] })).toBe(false)
    expect(isNewAgent({ agentId: 'a1', deals: [{ id: 'd1', agent_id: 'a1', stage: 'lost' }] })).toBe(false)
  })
  it('counts a deal the agent is a co-agent on', () => {
    expect(isNewAgent({ agentId: 'a1', deals: [{ id: 'd1', agent_id: 'a2', co_agent_ids: ['a1'] }] })).toBe(false)
  })
  it('never shows for an office admin', () => {
    expect(isNewAgent({ agentId: 'a1', isAdmin: true, deals: [] })).toBe(false)
  })
  it('needs an agent', () => {
    expect(isNewAgent({ agentId: null, deals: [] })).toBe(false)
  })
})

describe('gettingStartedSteps', () => {
  it('starts with nothing done', () => {
    expect(done(gettingStartedSteps({ agentId: 'a1' }))).toEqual([])
  })

  it('counts only the agent’s own records, not a colleague’s', () => {
    const steps = gettingStartedSteps({
      agentId: 'a1',
      contacts: [{ assigned_agent_id: 'a2' }],
      properties: [{ assigned_agent_id: 'a1' }],
    })
    expect(done(steps)).toEqual(['property'])
  })

  it('marks Outlook from what the dashboard looked up', () => {
    expect(done(gettingStartedSteps({ agentId: 'a1', outlookConnected: true }))).toEqual(['outlook'])
  })

  it('ends at the first deal', () => {
    const steps = gettingStartedSteps({ agentId: 'a1', deals: [{ id: 'd1', agent_id: 'a1' }] })
    expect(steps.at(-1).id).toBe('deal')
    expect(steps.at(-1).done).toBe(true)
    expect(myDealsFor([{ id: 'd1', agent_id: 'a1' }], 'a1')).toHaveLength(1)
  })
})
