// Lightweight observability helpers — structured logging + handler wrapping.
//
// Log destinations:
//   1. stdout (always) — captured by Vercel and visible in the dashboard.
//
//   2. Logtrail (https://logtrail.net) — when LOGTRAIL_API_KEY is set.
//      Get your key: app.logtrail.net → Settings → API Keys
//      Add to Vercel: Dashboard → your project → Settings → Environment Variables
//      Docs: https://docs.logtrail.net
//
// Free plan limits enforced here: 700 bytes/log, max 5 tags.

const SERVICE        = process.env.VERCEL_PROJECT_NAME || 'gateway-crm'
const ENV            = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development'
const LOGTRAIL_KEY   = process.env.LOGTRAIL_API_KEY || null
const LOGTRAIL_URL   = 'https://api.logtrail.net/api/v1/workspace/logs'
const FREE_MAX_BYTES = 700

// Build a Logtrail-schema payload from our internal log object.
// Fields: action (required), level (required), clientTimestamp (required),
//         message, metadata, tags — all mapped from our format.
function buildLogtrailEntry(payload) {
  const entry = {
    action:          `api.${payload.handler || payload.service || 'app'}`,
    level:           payload.level,
    message:         payload.msg,
    clientTimestamp: payload.ts,
    // Free plan: max 5 tags
    tags: [payload.env, payload.handler].filter(Boolean).slice(0, 5),
  }

  // Compact metadata — keep field names short to stay inside 700 bytes
  const meta = {}
  if (payload.method)                   meta.method = payload.method
  if (payload.status)                   meta.status = payload.status
  if (payload.duration_ms !== undefined) meta.ms    = payload.duration_ms
  if (payload.req_id)                   meta.req_id = String(payload.req_id).slice(0, 40)
  if (payload.action)                   meta.op     = payload.action  // the ?action= query param
  if (payload.err_message)              meta.err    = payload.err_message.slice(0, 80)
  // Include only the first "at ..." stack frame — enough to locate the crash
  if (payload.err_stack) {
    const frame = payload.err_stack.split('\n').find(l => l.trim().startsWith('at '))
    if (frame) meta.at = frame.trim().slice(0, 60)
  }

  if (Object.keys(meta).length) entry.metadata = meta

  // Progressive trimming to honour the Free plan 700-byte hard limit
  let body = JSON.stringify(entry)
  if (body.length > FREE_MAX_BYTES && entry.metadata) {
    delete entry.metadata.at
    body = JSON.stringify(entry)
  }
  if (body.length > FREE_MAX_BYTES && entry.metadata) {
    delete entry.metadata.err
    body = JSON.stringify(entry)
  }
  if (body.length > FREE_MAX_BYTES) {
    entry.message = entry.message?.slice(0, 60)
    body = JSON.stringify(entry)
  }

  return body
}

// Fire-and-forget POST to Logtrail. Never awaited — logging must never slow
// down or crash an API handler.
function sendToLogtrail(payload) {
  if (!LOGTRAIL_KEY) return
  fetch(LOGTRAIL_URL, {
    method:  'POST',
    headers: { 'X-API-Key': LOGTRAIL_KEY, 'Content-Type': 'application/json' },
    body:    buildLogtrailEntry(payload),
  }).catch(() => {})
}

function emit(level, message, meta = {}) {
  const payload = {
    ts:      new Date().toISOString(),
    level,
    service: SERVICE,
    env:     ENV,
    region:  process.env.VERCEL_REGION || null,
    msg:     message,
    ...meta,
  }
  const line = JSON.stringify(payload)
  if (level === 'error') console.error(line)
  else                   console.log(line)
  sendToLogtrail(payload)
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
    const start  = Date.now()
    const action = req.body?.action || req.query?.action || null
    const reqId  = req.headers['x-vercel-id'] || crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      await handler(req, res)
      log.info(`${name} ok`, {
        handler:     name,
        action,
        method:      req.method,
        status:      res.statusCode,
        duration_ms: Date.now() - start,
        req_id:      reqId,
      })
    } catch (err) {
      log.error(`${name} error`, {
        handler:     name,
        action,
        method:      req.method,
        duration_ms: Date.now() - start,
        req_id:      reqId,
        err_message: err?.message,
        err_stack:   err?.stack?.split('\n').slice(0, 5).join('\n'),
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
    status:    allOk ? 'healthy' : 'degraded',
    service:   SERVICE,
    env:       ENV,
    version:   process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
    timestamp: new Date().toISOString(),
    checks,
  })
}
