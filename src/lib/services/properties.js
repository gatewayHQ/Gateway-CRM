// ─────────────────────────────────────────────────────────────────────────────
// Scoped property reads.
//
// A non-admin sees properties ASSIGNED to themselves or to a team peer who
// shares properties (team_splits.share_properties), plus any property they are
// CO-AGENT on — the same "own + shared + co-listed" shape deals already use
// (src/lib/services/deals.js).
//
// The co-agent arm matters once a team turns sharing off: an agent who splits a
// commission on one listing should still see that listing, without seeing the
// other agent's whole book. Co-agents are picked on the property and carried to
// the deal at conversion (src/lib/coAgents.js), so without this the deal stayed
// visible while the property behind it vanished.
//
// NOTE: `properties` is `allow_all_authenticated` in RLS — unlike contacts and
// deals, the database does not scope it. These filters are the whole of a
// non-admin's property visibility, which is why every property read goes
// through here rather than being open-coded per page.
// ─────────────────────────────────────────────────────────────────────────────

const byNewest = (a, b) => new Date(b.created_at) - new Date(a.created_at)

// Properties where this agent is named as a co-agent. Stored in the `details`
// blob (details.co_agent_ids), matched with jsonb containment so the filter
// runs in Postgres rather than by pulling the table down.
async function fetchCoAgentProperties(client, agentId) {
  if (!agentId) return { data: [], error: null }
  const { data, error } = await client.from('properties').select('*')
    .contains('details', { co_agent_ids: [agentId] })
  return { data: data || [], error }
}

/**
 * Every property the agent may see, newest first.
 * Admins get the firm; everyone else gets assigned + team-shared + co-agent.
 */
export async function fetchVisibleProperties(client, { isAdmin, agentId, propertyAgentIds }) {
  if (isAdmin) {
    return client.from('properties').select('*').order('created_at', { ascending: false })
  }
  const owners = propertyAgentIds?.length ? propertyAgentIds : (agentId ? [agentId] : [])
  if (!owners.length) return { data: [], error: null }

  const [ownRes, coRes] = await Promise.all([
    client.from('properties').select('*').in('assigned_agent_id', owners)
      .order('created_at', { ascending: false }),
    fetchCoAgentProperties(client, agentId),
  ])
  if (ownRes.error) return ownRes

  // Co-listing is additive: a failed lookup must not cost the agent the
  // properties they own outright.
  const seen = new Set((ownRes.data || []).map(p => p.id))
  const extra = (coRes.data || []).filter(p => !seen.has(p.id))
  if (!extra.length) return ownRes
  return { data: [...(ownRes.data || []), ...extra].sort(byNewest), error: null }
}
