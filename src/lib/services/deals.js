// ─────────────────────────────────────────────────────────────────────────────
// Scoped deal/commission reads shared by every page that (re)loads them.
//
// Visibility model (decided 2026-06, enforced in the DB by migration 0011;
// derived from the listing as well since migration 0055):
//   • An agent sees deals they OWN, deals of TEAM PEERS who share deals
//     (team_splits.share_deals), and every deal they are ON — named as an
//     additional agent on the deal, named on the LISTING behind it (as its
//     agent or one of its co-agents), or paid on it as a participant in
//     commissions.participants.
//   • Commissions follow the deal.
//   • Admins (office admin / transaction coordinator) see everything.
//
// The listing arms are asked of the database rather than reimplemented here —
// see fetchGrantedDealIds() below for why that distinction is the fix and not
// a refactor.
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

// ─────────────────────────────────────────────────────────────────────────────
// THE DATABASE'S OWN ANSWER (migration 0055)
//
// `app_visible_deal_ids()` is the function every deal-scoped RLS policy and
// every deal-documents storage policy is written against. Calling it directly
// is how this module stops guessing at the rule and asks for it.
//
// That matters because the client's own filters were a SECOND implementation of
// the visibility model, and the two drifted: the database grants a deal to
// whoever is on its LISTING, and no client filter knew to look there. An agent
// added to a listing after its deal was started could be granted the deal by
// RLS and still never see it, because nothing fetched it.
//
// Returns null — not [] — when the function isn't there (migration not applied,
// or an older client with no `.rpc`). Callers treat null as "no answer" and
// fall back to their own arms; [] would read as "you may see nothing".
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchGrantedDealIds(client) {
  if (typeof client?.rpc !== 'function') return null
  try {
    const { data, error } = await client.rpc('app_visible_deal_ids')
    if (error) return null
    return (data || [])
      .map(row => (row && typeof row === 'object' ? Object.values(row)[0] : row))
      .filter(Boolean)
  } catch {
    return null
  }
}

// IDs of deals the agent is on beyond the ones they own, from three sources:
//   1. `app_visible_deal_ids()` — the database's own answer, which covers every
//      arm of the model including the listing arms that are the whole point of
//      migration 0055, and
//   2. structured commission participants (jsonb containment:
//      participants @> [{"agent_id": "..."}]), and
//   3. deals.co_agent_ids uuid[] — the additional agents recorded on the deal
//      (migration 0025; before that, a legacy column present only in the
//      original production database). Its query errors harmlessly on a database
//      where 0025 hasn't been applied yet.
//
// 2 and 3 are kept as fallbacks so this still works against a database that is
// behind on migrations — the pattern the whole module uses.
// Returns an error only when EVERY source fails.
export async function fetchCoListedDealIds(client, agentId) {
  if (!agentId) return { data: [], error: null }
  const [granted, viaParticipants, viaLegacy] = await Promise.all([
    fetchGrantedDealIds(client),
    client.from('commissions').select('deal_id')
      .contains('participants', JSON.stringify([{ agent_id: agentId }])),
    client.from('deals').select('id').contains('co_agent_ids', [agentId]),
  ])
  const ids = new Set()
  for (const id of granted || []) ids.add(id)
  if (!viaParticipants.error) for (const r of viaParticipants.data || []) { if (r.deal_id) ids.add(r.deal_id) }
  if (!viaLegacy.error) for (const r of viaLegacy.data || []) { if (r.id) ids.add(r.id) }
  const error = granted === null && viaParticipants.error && viaLegacy.error
    ? viaParticipants.error
    : null
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
