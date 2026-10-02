import { describe, it, expect } from 'vitest'
import { gettingStartedSteps, myDealsFor } from '../GettingStarted.jsx'

const done = (steps) => steps.filter(s => s.done).map(s => s.id)

describe('gettingStartedSteps', () => {
  it('starts with nothing done', () => {
    expect(done(gettingStartedSteps({ agentId: 'a1' }))).toEqual([])
  })

  it('counts only the agent’s own records, not a colleague’s', () => {
    const steps = gettingStartedSteps({
      agentId: 'a1',
      contacts: [{ assigned_agent_id: 'a2' }],
      properties: [{ assigned_agent_id: 'a1' }],
      deals: [{ id: 'd1', agent_id: 'a2' }],
    })
    expect(done(steps)).toEqual(['property'])
  })

  it('counts a deal the agent is a co-agent on', () => {
    expect(myDealsFor([{ id: 'd1', agent_id: 'a2', co_agent_ids: ['a1'] }], 'a1')).toHaveLength(1)
  })

  it('marks Outlook and signatures from what the dashboard looked up', () => {
    const steps = gettingStartedSteps({ agentId: 'a1', outlookConnected: true, signatureSent: true })
    expect(done(steps)).toEqual(['outlook', 'signature'])
  })
})
