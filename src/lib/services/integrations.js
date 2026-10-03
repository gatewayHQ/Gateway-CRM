// ─────────────────────────────────────────────────────────────────────────────
// Integrations service — Outlook (Microsoft Graph) connection status and the
// per-user email (Resend) settings kept in Supabase auth user metadata.
//
// Webhook configs live in webhookConfigs.js.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

// The caller's session — its access_token authorizes the /api/email-send calls.
export const getAuthSession = () => supabase.auth.getSession()

// ms_graph_connection_status is a per-user view: at most one row (the caller's).
export const fetchOutlookConnectionStatus = () =>
  supabase.from('ms_graph_connection_status').select('*').maybeSingle()

// ── Email settings (auth user metadata; persists across devices) ─────────────

export const getAuthUser = () => supabase.auth.getUser()

export const updateAuthUserMetadata = (data) => supabase.auth.updateUser({ data })
