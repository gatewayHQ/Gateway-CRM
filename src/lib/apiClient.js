// ─────────────────────────────────────────────────────────────────────────────
// Authenticated API client — attaches the caller's Supabase session token to
// requests hitting our own /api/* routes.
//
// Several server routes (campaigns admin actions, claude, email-send,
// twilio-send, mailchimp) are gated with requireAgent() on the server. The
// browser must therefore send `Authorization: Bearer <access_token>` or the
// request is rejected as unauthenticated. Route every INTERNAL (logged-in)
// call through these helpers.
//
// PUBLIC landing-page calls (lead capture) must NOT use these — they run for
// anonymous visitors and hit intentionally-public endpoints.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from './supabase.js'

/** Merge the Bearer token into a headers object (no-op if not signed in). */
export async function authHeaders(extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra }
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  } catch { /* not signed in — request will 401 server-side */ }
  return headers
}

/** POST JSON to an internal API route with the session token attached. */
export async function apiPost(url, body = {}, extraHeaders = {}) {
  const headers = await authHeaders(extraHeaders)
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
}

/** GET an internal API route with the session token attached. */
export async function apiGet(url, extraHeaders = {}) {
  const headers = await authHeaders(extraHeaders)
  return fetch(url, { headers })
}
