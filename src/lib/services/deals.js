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

import { isUnderContractStage } from '../stages.js'

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

// IDs of deals the agent is co-listed on, from both sources:
//   1. structured commission participants (jsonb containment:
//      participants @> [{"agent_id": "..."}]) — the canonical model, and
//   2. the legacy deals.co_agent_ids uuid[] that exists only in the original
//      production database (its query errors harmlessly where the column
//      doesn't exist, e.g. fresh installs).
// Returns an error only when BOTH sources fail.
export async function fetchCoListedDealIds(client, agentId) {
  if (!agentId) return { data: [], error: null }
  const [viaParticipants, viaLegacy] = await Promise.all([
    client.from('commissions').select('deal_id')
      .contains('participants', JSON.stringify([{ agent_id: agentId }])),
    client.from('deals').select('id').contains('co_agent_ids', [agentId]),
  ])
  const ids = new Set()
  if (!viaParticipants.error) for (const r of viaParticipants.data || []) { if (r.deal_id) ids.add(r.deal_id) }
  if (!viaLegacy.error) for (const r of viaLegacy.data || []) { if (r.id) ids.add(r.id) }
  const error = viaParticipants.error && viaLegacy.error ? viaParticipants.error : null
  return { data: [...ids], error }
}

// Every deal the agent may see, newest first. Admins get the firm; everyone
// else gets own + team-shared + co-listed, merged and de-duplicated.
export async function fetchVisibleDeals(client, { isAdmin, agentId, dealAgentIds }) {
  if (isAdmin) {
    return client.from('deals').select('*').order('created_at', { ascending: false })
  }
  const owners = dealAgentIds?.length ? dealAgentIds : (agentId ? [agentId] : [])
  const [ownRes, coRes] = await Promise.all([
    client.from('deals').select('*').in('agent_id', owners).order('created_at', { ascending: false }),
    fetchCoListedDealIds(client, agentId),
  ])
  if (ownRes.error) return ownRes
  // Co-listing is additive: if the participant lookup fails, still return the
  // agent's own deals rather than nothing.
  const ownIds = new Set((ownRes.data || []).map(d => d.id))
  const extraIds = (coRes.data || []).filter(id => !ownIds.has(id))
  if (!extraIds.length) return ownRes
  const extraRes = await selectInChunks(client, 'deals', 'id', extraIds)
  if (extraRes.error) return ownRes
  const merged = [...(ownRes.data || []), ...extraRes.data]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  return { data: merged, error: null }
}

// Commissions for exactly the deals the caller can see. Admins fetch all.
export async function fetchVisibleCommissions(client, { isAdmin, dealIds }) {
  if (isAdmin) return client.from('commissions').select('*')
  if (!dealIds?.length) return { data: [], error: null }
  return selectInChunks(client, 'commissions', 'deal_id', dealIds)
}

// When a deal enters an under-contract stage, its linked property goes
// 'pending' on the Properties board automatically (decided 2026-07, Daniel).
// Single implementation shared by every stage-change path: board drag
// (Pipeline.moveStage), the deal-page stage rail, and the deal drawer's Stage
// field. The .neq guard makes it idempotent, and callers treat a failure as
// non-fatal — the stage change itself has already succeeded.
export async function syncPropertyStatusForStage(client, deal, newStage) {
  if (!deal?.property_id || !isUnderContractStage(newStage)) return { updated: false }
  const { data, error } = await client
    .from('properties')
    .update({ status: 'pending' })
    .eq('id', deal.property_id)
    .neq('status', 'pending')
    .select('id')
  if (error || !data?.length) return { updated: false, error: error || null }
  return { updated: true, propertyId: deal.property_id, status: 'pending' }
}
