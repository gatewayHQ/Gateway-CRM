// ─────────────────────────────────────────────────────────────────────────────
// Outlook (Microsoft Graph) connection status.
//
// ms_graph_connection_status is a per-user view: its own filter scopes it to the
// signed-in agent (admins see every row). Screens use it to decide whether mail
// and calendar events go out through the agent's own mailbox.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

/** The caller's full connection row, or null. */
export const fetchOutlookConnection = () =>
  supabase.from('ms_graph_connection_status').select('*').maybeSingle()

/** The caller's connection status only, or null. */
export const fetchOutlookConnectionStatus = () =>
  supabase.from('ms_graph_connection_status').select('status').maybeSingle()

/** One agent's Outlook connection — just the mailbox and its status. */
export const fetchAgentOutlookConnection = (agentId) =>
  supabase.from('ms_graph_connection_status')
    .select('email, status').eq('agent_id', agentId).maybeSingle()
