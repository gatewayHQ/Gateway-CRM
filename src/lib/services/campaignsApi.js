// The /api/campaigns endpoint: one action-dispatching call for the campaigns UI.
import { supabase } from '../supabase.js'

// ─── API helper ───────────────────────────────────────────────────────────────

/**
 * The signed-in agent's session token, for actions the server checks
 * (deal_room_notify sends from the caller's own Outlook). Sent on every call;
 * actions that do not check it ignore it.
 */
async function authHeader() {
  try {
    const { data } = await supabase.auth.getSession()
    const t = data?.session?.access_token
    return t ? { Authorization: `Bearer ${t}` } : {}
  } catch { return {} }
}

export async function api(action, payload = {}, method = 'POST') {
  const auth = await authHeader()
  if (method === 'GET') {
    const qs = new URLSearchParams({ action, ...payload }).toString()
    const r = await fetch(`/api/campaigns?${qs}`, { headers: auth })
    return r.json()
  }
  const r = await fetch('/api/campaigns', {
    method,
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ action, ...payload }),
  })
  return r.json()
}
