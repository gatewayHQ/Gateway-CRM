// ─────────────────────────────────────────────────────────────────────────────
// Scoped deal/commission reads shared by every page that (re)loads them.
//
// Visibility model (decided 2026-06, enforced in the DB by migration 0011):
//   • An agent sees deals they OWN, deals of TEAM PEERS who share deals
//     (team_splits.share_deals), and deals they are CO-LISTED on — i.e. they
//     appear as a paid participant in commissions.participants.
//   • Commissions follow the deal.
//   • Admins (office admin / transaction coordinator) see everything.
//
// Before this, App.jsx fetched deals by owner only (a co-listed agent couldn't
// see a deal they were paid on unless they shared a team with the owner), and
// Commission.jsx's refresh re-fetched deals/commissions UNSCOPED — overwriting
// the scoped state with firm-wide data for any agent who clicked Refresh.
// Centralizing the scoped read here keeps every load consistent and matches
// what RLS enforces once migration 0011 Phase B is live.
// ─────────────────────────────────────────────────────────────────────────────

// Supabase .in() lists travel in the request URL — chunk them so a large book
// of business can't overflow it.
const IN_CHUNK = 150

async function selectInChunks(client, table, column, ids, order) {
  const out = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    let q = client.from(table).select('*').in(column, ids.slice(i, i + IN_CHUNK))
    if (order) q = q.order(order.column, { ascending: order.ascending })
    const { data, error } = await q
    if (error) return { data: null, error }
    out.push(...(data || []))
  }
  return { data: out, error: null }
}

// IDs of every deal the agent is TAGGED on (primary or additional) — the
// canonical visibility source after migration 0024 (deal_agents). Being tagged
// is what grants sight of a deal + its property, contacts, and commissions.
export async function fetchTaggedDealIds(client, agentId) {
  if (!agentId) return { data: [], error: null }
  const { data, error } = await client
    .from('deal_agents').select('deal_id').eq('agent_id', agentId)
  if (error) return { data: [], error }
  return { data: [...new Set((data || []).map(r => r.deal_id).filter(Boolean))], error: null }
}

// Every deal the agent may see, newest first.
//   • Admin  → the whole firm.
//   • Others → deals they are tagged on (deal_agents). We ALSO fetch by
//     agent_id as a safety net so a freshly-created deal is never missing
//     before its primary tag lands (trigger/app both write it, but this keeps
//     the list correct even if one lags). Team-override deals are included by
//     RLS when a team opts in; the client list stays a subset/superset-safe
//     union of what the agent owns or is tagged on.
// Works whether or not RLS Phase B is active — visibility is enforced by the
// tag query here, not by trusting an unscoped select('*').
export async function fetchVisibleDeals(client, { isAdmin, agentId }) {
  if (isAdmin) {
    return client.from('deals').select('*').order('created_at', { ascending: false })
  }
  const [ownRes, tagRes] = await Promise.all([
    agentId
      ? client.from('deals').select('*').eq('agent_id', agentId).order('created_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    fetchTaggedDealIds(client, agentId),
  ])
  if (ownRes.error) return ownRes
  const ownIds = new Set((ownRes.data || []).map(d => d.id))
  const extraIds = (tagRes.data || []).filter(id => !ownIds.has(id))
  if (!extraIds.length) return ownRes
  const extraRes = await selectInChunks(client, 'deals', 'id', extraIds)
  if (extraRes.error) return ownRes
  const merged = [...(ownRes.data || []), ...extraRes.data]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  return { data: merged, error: null }
}

// The deal_agents tag rows for a set of visible deals — used to render the
// "who's on this deal" chips straight from the source of truth.
export async function fetchDealAgentTags(client, dealIds) {
  if (!dealIds?.length) return { data: [], error: null }
  const out = []
  for (let i = 0; i < dealIds.length; i += 150) {
    const { data, error } = await client
      .from('deal_agents').select('deal_id,agent_id,role')
      .in('deal_id', dealIds.slice(i, i + 150))
    if (error) return { data: out, error }
    out.push(...(data || []))
  }
  return { data: out, error: null }
}

// Commissions for exactly the deals the caller can see. Admins fetch all.
export async function fetchVisibleCommissions(client, { isAdmin, dealIds }) {
  if (isAdmin) return client.from('commissions').select('*')
  if (!dealIds?.length) return { data: [], error: null }
  return selectInChunks(client, 'commissions', 'deal_id', dealIds)
}
