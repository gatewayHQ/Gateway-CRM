// ─────────────────────────────────────────────────────────────────────────────
// Shared API auth — JWT verify + agent lookup + admin check.
//
// Until now every admin/personal API route open-coded this dance:
//   1. parse Authorization Bearer
//   2. hit /auth/v1/user to verify
//   3. look up the agent row by auth_id
//   4. assert is_admin if needed
//
// Each copy had subtle drift (header parsing, fallback envs). One source
// here means a future change (e.g. tighter audience checks) lands in one
// place. Vercel does not route files in api/_lib/ — they are pure helpers.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js'
import { isOfficeAdmin } from '../../src/lib/officeAdmins.js'

// No hardcoded project fallback. A literal here meant a deployment with the env
// var missing — a preview, a fork, a misconfigured environment — silently pointed
// its service-key reads and storage writes at the PRODUCTION project instead of
// failing. Absent config must fail loudly, not quietly succeed against live data.
export const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  ''

export const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY

const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

// Memoize the service-key client so we don't reconnect on every request.
let _svc = null
export function getServiceClient() {
  if (!SUPABASE_URL) {
    const e = new Error('Server misconfigured: SUPABASE_URL missing')
    e.status = 500
    throw e
  }
  if (!SERVICE_KEY) {
    const e = new Error('Server misconfigured: SUPABASE_SERVICE_KEY missing')
    e.status = 500
    throw e
  }
  if (_svc) return _svc
  _svc = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return _svc
}

// Extract a Bearer token from the request headers.
function extractBearer(req) {
  const raw = req.headers?.authorization || req.headers?.Authorization || ''
  return raw.replace(/^Bearer\s+/i, '').trim()
}

// A Supabase client acting AS THE CALLER (anon key + their JWT), so every read
// goes through the same RLS/storage policies the browser is subject to.
//
// Use this — not getServiceClient() — whenever an API route reads a resource
// the caller *named* (a storage path, a row id). The service key would happily
// hand back another agent's deal documents; this cannot, because it is not
// privileged. Not memoized: each request carries a different token.
export function getUserClient(req) {
  const jwt = extractBearer(req)
  if (!jwt) { const e = new Error('Sign in required'); e.status = 401; throw e }
  if (!ANON_KEY) {
    const e = new Error('Server misconfigured: VITE_SUPABASE_ANON_KEY missing')
    e.status = 500; throw e
  }
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth:   { persistSession: false, autoRefreshToken: false },
  })
}

// Verify the caller's JWT and return the Supabase auth user, or null on failure.
// Does NOT touch the agents table — call requireAgent() for that.
export async function requireAuthUser(req) {
  const jwt = extractBearer(req)
  if (!jwt) {
    const e = new Error('Sign in required'); e.status = 401; throw e
  }
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: ANON_KEY || SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  })
  if (!r.ok) {
    const e = new Error('Invalid session'); e.status = 401; throw e
  }
  const user = await r.json()
  if (!user?.id) {
    const e = new Error('Invalid session'); e.status = 401; throw e
  }
  return user
}

// Verify the caller's JWT AND resolve their agent row.
// Returns { user, agent, isAdmin }.
export async function requireAgent(req) {
  const user = await requireAuthUser(req)
  const svc  = getServiceClient()
  const { data: agent } = await svc
    .from('agents')
    .select('id, name, email, is_admin, role, auth_id')
    .eq('auth_id', user.id)
    .maybeSingle()
  if (!agent) {
    const e = new Error('No agent profile for this account'); e.status = 403; throw e
  }
  // Same rule the browser applies (src/lib/officeAdmins.js): the explicit flag,
  // with a legacy role fallback — but never that fallback for the two accounts
  // that can toggle themselves off, or "off" would only be cosmetic here.
  const isAdmin = isOfficeAdmin(agent)
  return { user, agent, isAdmin }
}

// Require admin. Returns { user, agent, svc }.
export async function requireAdmin(req) {
  const { user, agent, isAdmin } = await requireAgent(req)
  if (!isAdmin) {
    const e = new Error('Admin only'); e.status = 403; throw e
  }
  return { user, agent, svc: getServiceClient() }
}

// Standardized error responder. Lets handlers do:
//   try { ... } catch (e) { return errorResponse(res, e) }
export function errorResponse(res, err) {
  const status = err?.status || 500
  return res.status(status).json({ error: err?.message || 'Server error' })
}

// CORS preset for browser-called JSON APIs.
//
// ALLOWED_ORIGIN has been documented in .env.example the whole time but nothing
// read it — every deployment answered `*`, so any page on the internet could put
// a signed-in agent's own token to work against the signing API from a tab they
// didn't open. Set it (comma-separated for several) and only those origins are
// echoed; leave it unset and behavior is unchanged.
export function applyJsonCors(res, req) {
  const allowed = String(process.env.ALLOWED_ORIGIN || '')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
  const origin = String(req?.headers?.origin || '').replace(/\/$/, '')
  if (allowed.length) {
    res.setHeader('Vary', 'Origin')
    // No match → no CORS header at all, which is the browser's own refusal.
    if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key')
}
