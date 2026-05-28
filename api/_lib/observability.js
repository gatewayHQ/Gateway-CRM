// Lightweight observability helpers — structured logging + handler wrapping.
//
// Log destinations:
//   1. stdout (always) — Vercel captures this; configure a log drain in
//      Vercel Dashboard → Team Settings → Log Drains to forward to Better Stack.
//      Better Stack source URL: https://in.logs.betterstack.com  (use "Vercel" source type)
//
//   2. Better Stack HTTP ingest (when LOGTAIL_SOURCE_TOKEN is set) — used for
//      Docker/self-hosted deployments or when you want richer structured metadata
//      without a log drain.  Set the token from Better Stack → Sources → your source → Token.

const SERVICE       = process.env.VERCEL_PROJECT_NAME || 'gateway-crm'
const ENV           = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development'
const LOGTAIL_TOKEN = process.env.LOGTAIL_SOURCE_TOKEN || null

// Fire-and-forget HTTP send to Better Stack ingest.
// Better Stack expects { dt, message, level, ...fields }.
// We never await this — logging must not slow down or crash the handler.
function sendToLogtail(payload) {
  if (!LOGTAIL_TOKEN) return
  const body = JSON.stringify({
    dt:      payload.ts,
    message: payload.msg,
    level:   payload.level,
    service: payload.service,
    env:     payload.env,
    region:  payload.region,
    ...Object.fromEntries(
      Object.entries(payload).filter(([k]) => !['ts','msg','level','service','env','region'].includes(k))
    ),
  })
  fetch('https://in.logs.betterstack.com', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LOGTAIL_TOKEN}` },
    body,
  }).catch(() => {}) // swallow — a logging failure must never surface to the user
}

function emit(level, message, meta = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    env: ENV,
    region: process.env.VERCEL_REGION || null,
    msg: message,
    ...meta,
  }
  const line = JSON.stringify(payload)
  if (level === 'error') console.error(line)
  else                   console.log(line)
  sendToLogtail(payload)
}

export const log = {
  info:  (msg, meta) => emit('info',  msg, meta),
  warn:  (msg, meta) => emit('warn',  msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
}

// Wrap an API handler so unhandled errors and timing get logged consistently.
// Usage:
//   import { wrap } from './_lib/observability.js'
//   export default wrap('campaigns', async (req, res) => { ... })
export function wrap(name, handler) {
  return async function wrapped(req, res) {
    const start = Date.now()
    const action = req.body?.action || req.query?.action || null
    const reqId = req.headers['x-vercel-id'] || crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`
    try {
      await handler(req, res)
      log.info(`${name} ok`, {
        handler: name,
        action,
        method: req.method,
        status: res.statusCode,
        duration_ms: Date.now() - start,
        req_id: reqId,
      })
    } catch (err) {
      const duration = Date.now() - start
      log.error(`${name} error`, {
        handler: name,
        action,
        method: req.method,
        duration_ms: duration,
        req_id: reqId,
        err_message: err?.message,
        err_stack: err?.stack?.split('\n').slice(0, 5).join('\n'),
      })
      if (!res.headersSent) {
        res.status(500).json({ error: err?.message || 'Internal error', req_id: reqId })
      }
    }
  }
}

// Cheap health check fold — call from any existing endpoint via ?action=health
// to keep us under the Hobby function budget while still being uptime-pingable.
export async function healthResponse(res, deps = {}) {
  const checks = {}
  if (deps.supabase) {
    try {
      const t0 = Date.now()
      const { error } = await deps.supabase.from('agents').select('id', { head: true, count: 'exact' }).limit(1)
      checks.supabase = { ok: !error, latency_ms: Date.now() - t0, error: error?.message }
    } catch (e) {
      checks.supabase = { ok: false, error: e.message }
    }
  }
  const allOk = Object.values(checks).every(c => c.ok !== false)
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'healthy' : 'degraded',
    service: SERVICE,
    env: ENV,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
    timestamp: new Date().toISOString(),
    checks,
  })
}
