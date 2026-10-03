// Which deals and listings the Pipeline board shows. Pure — no React, no I/O.

import { agentIdsOnDeal, propertyCoAgentIds } from '../../lib/coAgents.js'

// ─────────────────────────────────────────────────────────────────────────────
// Which deals belong on the Deals board.
//
// Everyone sees the deals RLS handed them; an ADMIN can narrow to one agent,
// and "that agent's deals" means the deals they are ON — not the ones they own.
// Filtering on `agent_id` alone showed a shared deal under the OWNER only, so
// an admin checking two agents who co-list a listing saw it on one pipeline and
// not the other, and read that as the deal failing to sync between them. Both
// agents' own logins showed it correctly the whole time, which is what makes
// this one so misleading: the tool used to diagnose the bug reported it.
export function dealsOnBoard({ deals = [], propertyMap = {}, isAdmin = false, agentFilter = 'all' } = {}) {
  if (!isAdmin || agentFilter === 'all') return deals
  return deals.filter(d => agentIdsOnDeal(d, propertyMap[d.property_id]).includes(agentFilter))
}

// ─────────────────────────────────────────────────────────────────────────────
// Which listings belong on the Listings board.
//
// "Mine" means the listings this agent is ON, not only the ones assigned to
// them. Migration 0055 made that the rule everywhere else — a co-agent named on
// a listing, or on a deal linked to it, is on that listing — but this board
// open-coded `assigned_agent_id === me`. So the second agent on a shared
// listing saw the DEAL on the Deals tab and no listing behind it on the
// Listings tab: the same class of bug 0055 fixed, a client-side
// reimplementation of the access rule that drifted from the rule.
//
// For a NON-ADMIN every deal in `deals` is already a deal they are on (RLS plus
// fetchVisibleDeals), so the property behind any of them is a listing they are
// on — no extra fetch is needed to answer it. An ADMIN sees the firm and can
// narrow to one agent, which asks "what is THEIR book" and so has to read the
// team off each deal explicitly.
export function listingsOnBoard({
  properties = [], deals = [], propertyMap = {}, isAdmin = false,
  agentFilter = 'all', activeAgentId = null,
} = {}) {
  if (!isAdmin || agentFilter === 'all') {
    if (isAdmin) return properties
    // No agent resolved yet: show nothing, not the firm. App gates the page on
    // a matched agent so this should not happen, but the old inline version
    // fell through to the unfiltered list here, which is the wrong way to fail.
    if (!activeAgentId) return []
    const behindMyDeals = new Set(deals.map(d => d.property_id).filter(Boolean))
    return properties.filter(p =>
      p.assigned_agent_id === activeAgentId
      || propertyCoAgentIds(p).includes(activeAgentId)
      || behindMyDeals.has(p.id))
  }
  const behindTheirDeals = new Set(
    deals.filter(d => agentIdsOnDeal(d, propertyMap[d.property_id]).includes(agentFilter))
         .map(d => d.property_id).filter(Boolean))
  return properties.filter(p =>
    p.assigned_agent_id === agentFilter
    || propertyCoAgentIds(p).includes(agentFilter)
    || behindTheirDeals.has(p.id))
}
