// ─────────────────────────────────────────────────────────────────────────────
// Team agents — direct reads/writes of the `agents` table (and agent headshot
// storage) used by the Team and Settings pages.
//
// Profile fields guarded by the privilege trigger (role / is_admin / splits /
// caps) are NOT written here — those go through agentProfile.js. What remains
// is the agent list read and per-agent UI preferences.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { fetchAgentRoster } from './agents.js'

const HEADSHOT_BUCKET = 'campaign-images'

export const fetchAgents = () => fetchAgentRoster(supabase)

// Sidebar customization (Settings → hidden nav items).
export const updateAgentNavHidden = (agentId, navHidden) =>
  supabase.from('agents').update({ nav_hidden: navHidden }).eq('id', agentId)

// ── Headshots ────────────────────────────────────────────────────────────────

export const uploadAgentHeadshot = (path, blob, options) =>
  supabase.storage.from(HEADSHOT_BUCKET).upload(path, blob, options)

export const agentHeadshotPublicUrl = (path) =>
  supabase.storage.from(HEADSHOT_BUCKET).getPublicUrl(path)
