// ─────────────────────────────────────────────────────────────────────────────
// Marketing account — the signed-in agent's session and sending identity.
//
// The marketing pages (Sequences, Templates, Mass Email) each read the auth
// session to call /api/email-send, and the Outlook connection row to decide
// whether mail goes out from the agent's own mailbox. Those reads live here so
// the pages don't talk to Supabase directly.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

// ── auth ─────────────────────────────────────────────────────────────────────

export const getAuthSession = () => supabase.auth.getSession()

export const getAuthUser = () => supabase.auth.getUser()

// ── ms_graph_connection_status ───────────────────────────────────────────────

/** The caller's Outlook connection row — the view's own filter scopes it to the signed-in agent (admins see every row). */
export const fetchOutlookConnection = () =>
  supabase.from('ms_graph_connection_status').select('*').maybeSingle()

/** One agent's Outlook connection — just the mailbox and its status. */
export const fetchAgentOutlookConnection = (agentId) =>
  supabase.from('ms_graph_connection_status')
    .select('email, status').eq('agent_id', agentId).maybeSingle()
