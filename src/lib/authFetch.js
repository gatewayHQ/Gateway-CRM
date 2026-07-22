// ─────────────────────────────────────────────────────────────────────────────
// authedFetch — fetch() that carries the current Supabase session as a Bearer
// token. Use for any /api/* endpoint that authenticates the caller (campaigns,
// twilio-send, boldsign, portal, …). One place to attach auth means the header
// logic can't drift call-site to call-site.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from './supabase.js'

export async function authedFetch(url, options = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { ...(options.headers || {}) }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  return fetch(url, { ...options, headers })
}
