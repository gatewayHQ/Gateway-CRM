// The Round Robin tab's "Next up" must name the agent assign_lead_round_robin()
// (migration 0037) will actually pick — otherwise an admin reorders the ring
// around a prediction the database does not share.
import { describe, it, expect } from 'vitest'
import { orderRing, nextUp } from '../leadRotation.js'

const agents = new Map([
  ['a', { name: 'Alice' }], ['b', { name: 'Bob' }], ['c', { name: 'Cara' }],
])
const m = (agent_id, sort_order = 0, active = true) => ({ agent_id, sort_order, active })

describe('lead rotation order', () => {
  it('orders by sort_order, then name — the SQL window order', () => {
    expect(orderRing([m('c'), m('a'), m('b')], agents).map(x => x.agent_id)).toEqual(['a', 'b', 'c'])
    expect(orderRing([m('a', 20), m('b', 10), m('c', 10)], agents).map(x => x.agent_id)).toEqual(['b', 'c', 'a'])
  })

  it('next up is the active member after the cursor, wrapping', () => {
    const ring = orderRing([m('a'), m('b'), m('c')], agents)
    expect(nextUp(ring, 'a')).toBe('b')
    expect(nextUp(ring, 'c')).toBe('a')
  })

  it('skips a paused agent', () => {
    const ring = orderRing([m('a'), m('b', 0, false), m('c')], agents)
    expect(nextUp(ring, 'a')).toBe('c')
  })

  it('restarts at the head when the cursor agent is paused or absent — as the SQL does', () => {
    const ring = orderRing([m('a'), m('b', 0, false), m('c')], agents)
    expect(nextUp(ring, 'b')).toBe('a')
    expect(nextUp(ring, null)).toBe('a')
  })

  it('nobody active → nobody next', () => {
    expect(nextUp([m('a', 0, false)], null)).toBeNull()
  })
})
