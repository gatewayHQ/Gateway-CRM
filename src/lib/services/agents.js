// ─────────────────────────────────────────────────────────────────────────────
// Agents — the signed-in user's identity row and the team roster.
//
// The boot sequence and the first-run onboarding modal used to issue these
// queries inline from App.jsx. They live here so the shell never talks to a
// table directly, and so identity resolution (who is signed in, and which
// agent row is theirs) can be tested without a browser.
//
// Every function takes the Supabase client as its first argument, matching
// the rest of src/lib/services.
// ─────────────────────────────────────────────────────────────────────────────

/** The whole roster, oldest first — the order every agent picker shows. */
export const fetchAgentRoster = (supabase) =>
  supabase.from('agents').select('*').order('created_at', { ascending: true })

/**
 * Team membership with the per-dimension sharing flags. Missing table (an
 * un-migrated database) or a rejected request degrades to "no team".
 */
export const fetchTeamSplits = (supabase) =>
  supabase.from('team_splits').select('agent_id,team_id,share_contacts,share_properties,share_deals')
    .then(r => r, () => ({ data: [] }))

/**
 * Which roster row belongs to this auth user.
 *
 *   1. The row already claimed by this auth id.
 *   2. Otherwise an UNCLAIMED row whose email matches — an admin pre-created
 *      the agent before they ever signed in. Returned as `orphan` because it
 *      still has to be claimed.
 */
export function findAgentForUser(agents, user) {
  const userId = user?.id
  if (!userId) return { agent: null, orphan: null }
  const agent = agents.find(a => a.auth_id === userId)
  if (agent) return { agent, orphan: null }
  const email = user?.email?.toLowerCase()
  const orphan = agents.find(a => !a.auth_id && a.email?.toLowerCase() === email) || null
  return { agent: null, orphan }
}

/**
 * Resolve the signed-in user's agent row, claiming a pre-created one by email
 * when needed. Returns `{ agent, agents }` — `agents` is the roster to use from
 * here on (re-read when a claim race forced a fresh look). `agent` is null when
 * this user has no profile yet and must onboard.
 */
export async function resolveSignedInAgent(supabase, agents, user) {
  const { agent, orphan } = findAgentForUser(agents, user)
  if (agent || !orphan) return { agent, agents }

  const { error } = await supabase.from('agents').update({ auth_id: user.id }).eq('id', orphan.id)
  if (!error) return { agent: { ...orphan, auth_id: user.id }, agents }

  // Unique constraint conflict — someone else already claimed this auth_id.
  const { data: fresh } = await supabase.from('agents').select('*')
  return {
    agent: (fresh || []).find(a => a.auth_id === user.id) || null,
    agents: fresh || agents,
  }
}

/** First-run profile for a signed-in user with no agent row. */
export const createAgentProfile = (supabase, profile) =>
  supabase.from('agents').insert([profile]).select().single()
