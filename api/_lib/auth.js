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

export const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  'https://twgwemkihpwlgliftagg.supabase.co'

export const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY

const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY

// Memoize the service-key client so we don't reconnect on every request.
let _svc = null
export function getServiceClient() {
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
  const isAdmin = agent.is_admin === true || (agent.role || '').toLowerCase().includes('admin')
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

// CORS preset for browser-called JSON APIs. Wildcard for now (no cookies are
// ever sent); tighten to specific origins if/when we add credentialed routes.
export function applyJsonCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key')
}
