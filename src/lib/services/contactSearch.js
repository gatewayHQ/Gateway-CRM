// ─────────────────────────────────────────────────────────────────────────────
// Server-side search for the global search box (src/components/GlobalSearch.jsx).
//
// Both RPCs search EVERY row the agent may see, not just the rows already
// loaded in memory. Results come back as { data, error }; the caller falls back
// to in-memory filtering (src/lib/search.js) when an RPC is unavailable.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

export const searchContactsRemote = (term, agentIds, limit) =>
  supabase.rpc('search_contacts',   { search_term: term, agent_ids: agentIds, result_limit: limit })

export const searchPropertiesRemote = (term, agentIds, limit) =>
  supabase.rpc('search_properties', { search_term: term, agent_ids: agentIds, result_limit: limit })
