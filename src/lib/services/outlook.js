// ─────────────────────────────────────────────────────────────────────────────
// Outlook (Microsoft Graph) connection status.
//
// ms_graph_connection_status shows an agent their own row — and shows an office
// admin EVERY agent's row (migration 0034). Reading it unfiltered with
// .maybeSingle() therefore worked for agents and broke for admins as soon as a
// second agent connected: several rows, an error, and "Not connected" on the
// admin's own Integrations page. Every read of "my connection" now filters to
// the signed-in agent, resolved by app_current_agent_id() — the same function
// the view's own filter uses, so it always means the login whose mailbox
// sends the mail (not whoever an admin is previewing with "Switch to").
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

const VIEW = 'ms_graph_connection_status'

/**
 * What a connection row means for the agent:
 *   'connected' — mail and calendar go through their Outlook;
 *   'error'     — a connection exists but Microsoft needs them to reconnect;
 *   'none'      — no usable connection (no row, or disconnected).
 * Every screen asks this one function, so "connected" means the same thing on
 * Integrations as it does on Mass Email, Tasks and Compose.
 */
export function outlookState(row) {
  if (row?.status === 'connected') return 'connected'
  if (row?.status === 'error') return 'error'
  return 'none'
}

export const isOutlookConnected = (row) => outlookState(row) === 'connected'

async function ownConnection(columns) {
  const { data: agentId, error } = await supabase.rpc('app_current_agent_id')
  if (error) return { data: null, error }
  if (!agentId) return { data: null, error: null }
  return supabase.from(VIEW).select(columns).eq('agent_id', agentId).maybeSingle()
}

/** The signed-in agent's full connection row, or null. */
export const fetchOutlookConnection = () => ownConnection('*')

/** The signed-in agent's connection status only, or null. */
export const fetchOutlookConnectionStatus = () => ownConnection('status')

/** One agent's Outlook connection — just the mailbox and its status. */
export const fetchAgentOutlookConnection = (agentId) =>
  supabase.from(VIEW)
    .select('email, status').eq('agent_id', agentId).maybeSingle()
