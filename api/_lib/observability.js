// Lightweight observability helpers — structured logging + handler wrapping.
//
// Why no Sentry SDK? It would push us over the Vercel Hobby 12-function limit
// indirectly via cold-start budget. Instead we emit structured JSON to stdout
// where Vercel/Datadog/Logflare/Better Stack can ingest it via log drains.

const SERVICE = process.env.VERCEL_PROJECT_NAME || 'gateway-crm'
const ENV     = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development'

function emit(level, message, meta = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    env: ENV,
    region: process.env.VERCEL_REGION || null,
    msg: message,
    ...meta,
  })
  if (level === 'error') console.error(line)
  else                   console.log(line)
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
