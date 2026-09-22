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

// IDs of deals the agent is co-listed on, from both sources:
//   1. structured commission participants (jsonb containment:
//      participants @> [{"agent_id": "..."}]) — the canonical model, and
//   2. deals.co_agent_ids uuid[] — the co-agents carried over from the property
//      at conversion (migration 0025; before that, a legacy column present only
//      in the original production database). Its query errors harmlessly on a
//      database where 0025 hasn't been applied yet.
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

// ─────────────────────────────────────────────────────────────────────────────
// DUPLICATE DEALS
//
// Two agents each had a deal on 102 7th St. SE. Steph's carried 22 filled
// terms, 3 documents and a task; Emma's was empty. Nothing failed to
// synchronise — they were two ROWS, and everything on a deal hangs off its id.
//
// The second row is easy to create and impossible to notice: "Start Deal" was
// a bare insert, and the property looked untouched to Emma because RLS only
// shows her deals she is on. The access model manufactures the duplicate.
//
// Which is why this check CANNOT be done against the deals already in the
// browser. That list is RLS-scoped — Emma's client never contained Steph's
// deal, so any client-side "does this property have a deal?" answers false for
// exactly the person who is about to create the duplicate. It has to be asked
// of the database, through a security-definer function that can see past RLS
// for this one narrow question (migration 0054).
// ─────────────────────────────────────────────────────────────────────────────

/** True when the RPC is absent because migration 0054 has not been applied. */
const isMissingRpc = (message = '') =>
  /does not exist|PGRST202|schema cache|could not find the function/i.test(message)

/**
 * Open deals already on this property, optionally narrowed to one side.
 *
 * Returns `{ deals, error, unavailable }`. `unavailable` means the migration
 * has not been applied: callers treat that as "no duplicate found" and carry
 * on, because a pending migration must never block an agent from starting a
 * deal — the same degrade-and-continue rule the co-agent column uses.
 *
 * @param side 'buyer' | 'seller' | 'both' | null (null = any side)
 */
export async function findOpenDealsOnProperty(client, propertyId, side = null) {
  if (!propertyId) return { deals: [], error: null, unavailable: false }
  const { data, error } = await client.rpc('app_open_deal_on_property', {
    p_property_id: propertyId,
    p_side: side || null,
  })
  if (error) {
    if (isMissingRpc(error.message || '')) return { deals: [], error: null, unavailable: true }
    return { deals: [], error: error.message, unavailable: false }
  }
  return { deals: data || [], error: null, unavailable: false }
}

/**
 * Ask the agent who owns a deal to add you to it.
 *
 * Notifies them; grants nothing. A function that let an agent add THEMSELVES
 * to any deal would be a privilege escalation dressed up as a convenience, so
 * the owner stays the only one who can widen their own deal's team.
 */
export async function requestDealAccess(client, dealId) {
  if (!dealId) return { ok: false, error: 'deal missing' }
  const { data, error } = await client.rpc('app_request_deal_access', { p_deal_id: dealId })
  if (error) {
    if (isMissingRpc(error.message || '')) return { ok: false, error: 'Run migration 0054 to enable access requests.' }
    return { ok: false, error: error.message }
  }
  return { ok: data !== false, error: data === false ? 'Could not send that request.' : null }
}
