// Simple in-memory rate limiter.
// State resets on cold start — acceptable for serverless; prevents hot-path abuse.

// ip → { count, resetAt }
const store = new Map()

export function rateLimit(ip, { max = 60, windowMs = 60000 } = {}) {
  const now = Date.now()
  const entry = store.get(ip) || { count: 0, resetAt: now + windowMs }
  if (now > entry.resetAt) {
    entry.count = 0
    entry.resetAt = now + windowMs
  }
  entry.count++
  store.set(ip, entry)
  return { ok: entry.count <= max, remaining: Math.max(0, max - entry.count), resetAt: entry.resetAt }
}
