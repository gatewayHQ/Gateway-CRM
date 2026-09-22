// ─────────────────────────────────────────────────────────────────────────────
// The Listings board, for an agent who shares a listing.
//
// Migration 0055 made "who is on this listing" the rule for access: its
// assigned agent, its co-agents, and anyone on a deal linked to it. This board
// open-coded `assigned_agent_id === me` instead, so the second agent on a
// shared listing saw the DEAL on the Deals tab and nothing behind it on the
// Listings tab — the deal looked parentless, and Start Deal looked available on
// a property they could not find.
//
// Same shape as the bug 0055 fixed: an access rule re-implemented in the
// browser, drifting from the rule. These pin it to the rule.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { listingsOnBoard, dealsOnBoard } from '../Pipeline.jsx'

const DANA = 'agent-dana'
const SAM  = 'agent-sam'

// Dana's listing, with Sam named on it, and the deal she started on it.
const shared   = { id: 'p-shared', assigned_agent_id: DANA, details: { co_agent_ids: [SAM] } }
// Dana's other listing — Sam is on neither it nor any deal of hers on it.
const private_ = { id: 'p-private', assigned_agent_id: DANA, details: {} }
// Sam's own listing.
const sams     = { id: 'p-sams', assigned_agent_id: SAM, details: {} }

const sharedDeal = { id: 'd-shared', property_id: 'p-shared', agent_id: DANA, co_agent_ids: [SAM] }

const properties  = [shared, private_, sams]
const propertyMap = Object.fromEntries(properties.map(p => [p.id, p]))

describe('listingsOnBoard — a non-admin agent', () => {
  it('shows a listing they are named on as a co-agent', () => {
    const out = listingsOnBoard({ properties, deals: [], propertyMap, activeAgentId: SAM })
    expect(out.map(p => p.id).sort()).toEqual(['p-sams', 'p-shared'])
  })

  it('shows the listing behind a deal they are on, even without being named on it', () => {
    // The deal was linked to the property later, so the listing's own co-agent
    // list never mentioned Sam. For a non-admin, a deal in state IS a deal they
    // are on, so the property behind it is theirs to see.
    const listingWithoutSam = { ...shared, details: {} }
    const out = listingsOnBoard({
      properties: [listingWithoutSam, private_],
      deals: [sharedDeal],
      propertyMap,
      activeAgentId: SAM,
    })
    expect(out.map(p => p.id)).toEqual(['p-shared'])
  })

  it('still hides a colleague\'s listing they are on no deal for', () => {
    const out = listingsOnBoard({ properties, deals: [sharedDeal], propertyMap, activeAgentId: SAM })
    expect(out.map(p => p.id)).not.toContain('p-private')
  })

  it('shows the owner their own listing, shared or not', () => {
    const out = listingsOnBoard({ properties, deals: [sharedDeal], propertyMap, activeAgentId: DANA })
    expect(out.map(p => p.id).sort()).toEqual(['p-private', 'p-shared'])
  })

  it('shows nothing rather than everything when there is no agent yet', () => {
    // A null agent during load must not fall through to the firm-wide list.
    expect(listingsOnBoard({ properties, deals: [], propertyMap, activeAgentId: null })).toEqual([])
  })

  it('tolerates a listing with no details blob', () => {
    expect(() => listingsOnBoard({
      properties: [{ id: 'p-bare', assigned_agent_id: DANA }], deals: [], propertyMap, activeAgentId: SAM,
    })).not.toThrow()
  })
})

describe('listingsOnBoard — an office admin', () => {
  it('sees the whole firm by default', () => {
    const out = listingsOnBoard({ properties, deals: [], propertyMap, isAdmin: true, activeAgentId: 'admin' })
    expect(out).toHaveLength(3)
  })

  it('narrowed to one agent, gets the listings THAT agent is on', () => {
    const out = listingsOnBoard({
      properties, deals: [sharedDeal], propertyMap, isAdmin: true, agentFilter: SAM, activeAgentId: 'admin',
    })
    expect(out.map(p => p.id).sort()).toEqual(['p-sams', 'p-shared'])
  })

  it('narrowed to the owner, still gets both of theirs', () => {
    const out = listingsOnBoard({
      properties, deals: [sharedDeal], propertyMap, isAdmin: true, agentFilter: DANA, activeAgentId: 'admin',
    })
    expect(out.map(p => p.id).sort()).toEqual(['p-private', 'p-shared'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The Deals board's admin filter — the third instance of the same mistake.
//
// An admin narrowing the pipeline to one agent was filtering on `agent_id`, so
// a shared deal appeared under its OWNER and nowhere else. Checking the two
// agents who co-list a property, an admin saw the deal on one pipeline and not
// the other, and read that as "their deals aren't syncing" — while both agents'
// own logins had it right all along. The tool used to diagnose the bug was
// reporting it.
// ─────────────────────────────────────────────────────────────────────────────
describe('dealsOnBoard', () => {
  const owned  = { id: 'd-owned',  property_id: 'p-private', agent_id: DANA, co_agent_ids: [] }
  const co     = { id: 'd-shared', property_id: 'p-shared',  agent_id: DANA, co_agent_ids: [SAM] }
  const deals  = [owned, co]

  it('hands a non-admin everything RLS gave them, unfiltered', () => {
    expect(dealsOnBoard({ deals, propertyMap, isAdmin: false, agentFilter: 'all' })).toEqual(deals)
  })

  it('shows an admin the whole firm by default', () => {
    expect(dealsOnBoard({ deals, propertyMap, isAdmin: true, agentFilter: 'all' })).toEqual(deals)
  })

  it('narrowed to the OWNER, shows both of their deals', () => {
    const out = dealsOnBoard({ deals, propertyMap, isAdmin: true, agentFilter: DANA })
    expect(out.map(d => d.id).sort()).toEqual(['d-owned', 'd-shared'])
  })

  // The bug: this returned [] before, so the co-agent's pipeline looked empty.
  it('narrowed to the CO-AGENT, shows the deal they share', () => {
    const out = dealsOnBoard({ deals, propertyMap, isAdmin: true, agentFilter: SAM })
    expect(out.map(d => d.id)).toEqual(['d-shared'])
  })

  it('counts an agent named on the LISTING but not on the deal row', () => {
    // The deal's cached column is behind its listing (a listing edited before
    // the sync triggers existed). RLS grants on the listing, so the board must
    // agree — otherwise the admin sees a gap that is not really there.
    const staleDeal = { id: 'd-stale', property_id: 'p-shared', agent_id: DANA, co_agent_ids: [] }
    const out = dealsOnBoard({ deals: [staleDeal], propertyMap, isAdmin: true, agentFilter: SAM })
    expect(out.map(d => d.id)).toEqual(['d-stale'])
  })

  it('does not invent a deal for an agent on neither the deal nor the listing', () => {
    const out = dealsOnBoard({ deals, propertyMap, isAdmin: true, agentFilter: 'agent-nobody' })
    expect(out).toEqual([])
  })
})
