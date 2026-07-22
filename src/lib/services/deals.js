// ─────────────────────────────────────────────────────────────────────────────
// Scoped deal/commission reads shared by every page that (re)loads them.
//
// Visibility is enforced in the DATABASE by Row-Level Security: `deals` SELECT
// is gated by app_visible_deal_ids(), which is computed over the deal_agents
// ownership model (own links + team visibility via app_team_deal_visibility;
// admins see all). See migration 0029.
//
// So the client does NOT re-derive visibility — it simply selects, and RLS
// returns exactly the rows the caller may see. (The previous client-side
// owner/co-listed filtering used a superseded model — deals.agent_id +
// commissions.participants — and could diverge from what RLS actually allows,
// showing or hiding the wrong deals.)
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

// Every deal the caller may see, newest first. RLS does the scoping; a plain
// select returns the admin's full firm or an agent's own + team-visible deals.
// (Extra opts are accepted for call-site compatibility but no longer needed.)
export async function fetchVisibleDeals(client, _opts = {}) {
  return client.from('deals').select('*').order('created_at', { ascending: false })
}

// Commissions for exactly the deals the caller can see. Admins fetch all;
// everyone else is scoped by the visible deal ids (and commissions RLS is the
// hard backstop).
export async function fetchVisibleCommissions(client, { isAdmin, dealIds }) {
  if (isAdmin) return client.from('commissions').select('*')
  if (!dealIds?.length) return { data: [], error: null }
  return selectInChunks(client, 'commissions', 'deal_id', dealIds)
}
