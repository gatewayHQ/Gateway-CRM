// ─────────────────────────────────────────────────────────────────────────────
// Per-dimension team visibility.
//
// The reported bug: a teammate whose "Properties" sharing was turned OFF still
// had every one of their properties visible to the rest of the team, because
// the property fetch was scoped by the CONTACTS list. Each flag must answer for
// its own dimension and nothing else — that is what these tests pin down.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { teamVisibleAgentIds } from '../teamVisibility.js'

const NIC = 'a-nic', STEPH = 'a-steph', EMMA = 'a-emma', OUTSIDER = 'a-out'

// Steph shares contacts and deals with the team, but NOT properties.
const SPLITS = [
  { team_id: 't1', agent_id: NIC,   share_contacts: true,  share_properties: true,  share_deals: true },
  { team_id: 't1', agent_id: STEPH, share_contacts: true,  share_properties: false, share_deals: true },
  { team_id: 't1', agent_id: EMMA,  share_contacts: false, share_properties: true,  share_deals: false },
  { team_id: 't2', agent_id: OUTSIDER, share_contacts: true, share_properties: true, share_deals: true },
]

describe('teamVisibleAgentIds', () => {
  it('drops a peer from the PROPERTIES list only — the reported bug', () => {
    const v = teamVisibleAgentIds(SPLITS, NIC)
    expect(v.properties).not.toContain(STEPH)   // ← what was broken
    expect(v.contacts).toContain(STEPH)         // still shared
    expect(v.deals).toContain(STEPH)            // still shared
  })

  it('keeps the three dimensions independent', () => {
    const v = teamVisibleAgentIds(SPLITS, NIC)
    expect(v.contacts.sort()).toEqual([NIC, STEPH].sort())
    expect(v.properties.sort()).toEqual([NIC, EMMA].sort())
    expect(v.deals.sort()).toEqual([NIC, STEPH].sort())
  })

  it('always includes the agent themselves, so the list is safe in an .in() filter', () => {
    const v = teamVisibleAgentIds([], NIC)
    expect(v).toEqual({ contacts: [NIC], properties: [NIC], deals: [NIC] })
  })

  it('never leaks an agent from another team', () => {
    const v = teamVisibleAgentIds(SPLITS, NIC)
    for (const list of Object.values(v)) expect(list).not.toContain(OUTSIDER)
  })

  it('treats a missing flag as shared — the column default, and pre-column databases', () => {
    const v = teamVisibleAgentIds([
      { team_id: 't1', agent_id: NIC },
      { team_id: 't1', agent_id: STEPH },
    ], NIC)
    expect(v.properties.sort()).toEqual([NIC, STEPH].sort())
  })

  it('shares only what is explicitly on when flags are mixed across two shared teams', () => {
    // Same peer on two teams: off anywhere is not enough — any shared team that
    // opts in still shares. This documents the union behavior rather than
    // leaving it to chance.
    const v = teamVisibleAgentIds([
      { team_id: 't1', agent_id: NIC },   { team_id: 't2', agent_id: NIC },
      { team_id: 't1', agent_id: STEPH, share_properties: false },
      { team_id: 't2', agent_id: STEPH, share_properties: true },
    ], NIC)
    expect(v.properties).toContain(STEPH)
  })

  it('handles a missing splits table without throwing', () => {
    expect(teamVisibleAgentIds(undefined, NIC).properties).toEqual([NIC])
    expect(teamVisibleAgentIds(null, NIC).contacts).toEqual([NIC])
  })
})
