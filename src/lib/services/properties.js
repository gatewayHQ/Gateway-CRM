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
// NOTE: `properties` is READABLE firm-wide in RLS — unlike contacts and deals,
// the database does not scope reads (the pickers and the duplicate-deal check
// in migration 0054 need the whole roster). These filters are the whole of a
// non-admin's property visibility, which is why every property read goes
// through here rather than being open-coded per page. WRITES are scoped by RLS
// to the agents on the listing (migration 0055).
//
// Which is also why the primary arm here is now the database's own answer:
// `app_visible_property_ids()`, the same function the deal-visibility model is
// built on. A client-side reimplementation of the rule is what let the deal
// stay visible while the listing behind it vanished.
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
 * The ids `app_visible_property_ids()` grants (migration 0055): assigned +
 * team-shared + co-agent + the listing behind any deal the agent is on. That
 * last arm is the one no client filter had — an agent added to a deal could
 * open it and find the property gone.
 *
 * Returns null, not [], when the function is absent (migration not applied, or
 * a client without `.rpc`), so callers fall back to their own arms instead of
 * reading it as "you may see nothing".
 */
export async function fetchGrantedPropertyIds(client) {
  if (typeof client?.rpc !== 'function') return null
  try {
    const { data, error } = await client.rpc('app_visible_property_ids')
    if (error) return null
    return (data || [])
      .map(row => (row && typeof row === 'object' ? Object.values(row)[0] : row))
      .filter(Boolean)
  } catch {
    return null
  }
}

/**
 * Every property the agent may see, newest first. Admins get the firm; everyone
 * else gets assigned + team-shared + co-agent + the listings behind their deals.
 */
export async function fetchVisibleProperties(client, { isAdmin, agentId, propertyAgentIds }) {
  if (isAdmin) {
    return client.from('properties').select('*').order('created_at', { ascending: false })
  }
  const owners = propertyAgentIds?.length ? propertyAgentIds : (agentId ? [agentId] : [])
  if (!owners.length && !agentId) return { data: [], error: null }

  const [ownRes, coRes, grantedIds] = await Promise.all([
    owners.length
      ? client.from('properties').select('*').in('assigned_agent_id', owners)
          .order('created_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    fetchCoAgentProperties(client, agentId),
    fetchGrantedPropertyIds(client),
  ])
  if (ownRes.error) return ownRes

  // Every arm is additive: a failed lookup must not cost the agent the
  // properties they own outright.
  const rows = [...(ownRes.data || [])]
  const seen = new Set(rows.map(p => p.id))
  for (const p of coRes.data || []) if (!seen.has(p.id)) { seen.add(p.id); rows.push(p) }

  const missing = (grantedIds || []).filter(id => !seen.has(id))
  if (missing.length) {
    const grantedRes = await client.from('properties').select('*').in('id', missing)
    for (const p of grantedRes.data || []) if (!seen.has(p.id)) { seen.add(p.id); rows.push(p) }
  }

  return { data: rows.sort(byNewest), error: null }
}
