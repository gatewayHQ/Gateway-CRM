// ─────────────────────────────────────────────────────────────────────────────
// The website round robin's order, as the browser shows it.
//
// The rotation itself runs in SQL — assign_lead_round_robin() (migration
// 0037). These mirror its rules exactly so the Round Robin tab's "Next up" is
// who will actually get the next lead. If that function's ordering or wrap
// rule changes, change these with it; src/lib/__tests__/leadRotation.test.js
// pins the shared behavior.
// ─────────────────────────────────────────────────────────────────────────────

/** The ring as the SQL orders it: sort_order, then name, then id. */
export function orderRing(members, agentsById) {
  return [...members].sort((a, b) =>
    (a.sort_order - b.sort_order)
    || String(agentsById.get(a.agent_id)?.name || '').localeCompare(String(agentsById.get(b.agent_id)?.name || ''))
    || String(a.agent_id).localeCompare(String(b.agent_id)))
}

/**
 * Who gets the next lead — the same rule as assign_lead_round_robin(): the
 * ring is the ACTIVE members only; the one after the cursor, wrapping. A cursor
 * that is not in that ring (paused, removed, or no lead yet) restarts it at
 * its head.
 */
export function nextUp(ordered, cursorAgentId) {
  const active = ordered.filter(m => m.active)
  if (!active.length) return null
  const at = active.findIndex(m => m.agent_id === cursorAgentId)
  return active[(at + 1) % active.length].agent_id
}

