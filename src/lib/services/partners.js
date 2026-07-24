// ─────────────────────────────────────────────────────────────────────────────
// Partner links — admin-controlled share-all pairs between agents (2026-07).
//
// Reads are open to members of a pair (and admins); WRITES ARE ADMIN-ONLY and
// enforced by RLS on agent_partners (migration 0025). The create/remove helpers
// here will simply fail for a non-admin at the database — the admin gate is not
// merely a hidden button. See docs/co-agent-visibility.md.
// ─────────────────────────────────────────────────────────────────────────────

// Rows are stored order-normalized (agent_a < agent_b). Comparing the canonical
// lowercase uuid strings matches Postgres's uuid ordering, so this satisfies the
// agent_partners_ordered check constraint.
function orderPair(x, y) {
  return x < y ? [x, y] : [y, x]
}

/** All partner links visible to the caller (RLS: their own pairs, or all for admins). */
export async function fetchPartnerLinks(client) {
  return client.from('agent_partners').select('*').order('created_at', { ascending: false })
}

/** Agent ids partnered with `agentId`, from a set of link rows (bidirectional). */
export function partnerAgentIds(links, agentId) {
  if (!agentId) return []
  const ids = new Set()
  for (const l of links || []) {
    if (l.agent_a === agentId) ids.add(l.agent_b)
    else if (l.agent_b === agentId) ids.add(l.agent_a)
  }
  return [...ids]
}

/**
 * Create a Partner link. Admin-only (RLS enforces it server-side).
 * @returns {Promise<{ data?: object, error?: object }>}
 */
export async function createPartnerLink(client, { agentA, agentB, createdBy } = {}) {
  if (!agentA || !agentB || agentA === agentB) {
    return { data: null, error: { message: 'Pick two different agents to link.' } }
  }
  const [a, b] = orderPair(agentA, agentB)
  return client.from('agent_partners')
    .insert([{ agent_a: a, agent_b: b, created_by: createdBy || null }])
    .select().single()
}

/** Remove a Partner link by id. Admin-only (RLS enforces it server-side). */
export async function removePartnerLink(client, id) {
  if (!id) return { data: null, error: { message: 'Missing link id.' } }
  return client.from('agent_partners').delete().eq('id', id)
}
