// ─────────────────────────────────────────────────────────────────────────────
// Outlook connection + session lookups used by the contact drawer, the Emails
// tab, the task drawer and the Getting Started card.
//
// Both are thin pass-throughs: the screens decide what "connected" means and
// what to do without a session, exactly as before.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

/** The signed-in agent's Microsoft Graph connection row (status only), or null. */
export const fetchOutlookConnectionStatus = () =>
  supabase.from('ms_graph_connection_status').select('status').maybeSingle()

/** The current auth session — callers read `data.session.access_token` for /api calls. */
export const getAuthSession = () => supabase.auth.getSession()
