/**
 * Gateway CRM — Performance Monitor
 *
 * Lightweight client-side performance tracking.
 * Reports to console in dev; can be pointed at an analytics endpoint in prod.
 *
 * Benchmarks this system must meet:
 *  ┌─────────────────────────────────────────────────────────┐
 *  │  METRIC                    TARGET      THRESHOLD        │
 *  │  Time to Interactive       < 2.0s      < 3.5s           │
 *  │  First Contentful Paint    < 1.0s      < 1.8s           │
 *  │  Route change (cached)     < 50ms      < 150ms          │
 *  │  Route change (cold)       < 400ms     < 800ms          │
 *  │  DB query (indexed)        < 50ms      < 200ms          │
 *  │  DB query (full table)     < 500ms     < 1000ms         │
 *  │  List render (1k rows)     < 16ms      < 32ms           │
 *  │  List render (10k rows)    < 16ms      < 32ms (virtual) │
 *  │  Cache hit rate            > 85%       > 70%            │
 *  │  Optimistic update lag     0ms         0ms              │
 *  └─────────────────────────────────────────────────────────┘
 */

const isDev = import.meta.env.DEV

const stats = {
  cacheHits:   0,
  cacheMisses: 0,
  queries:     [],
  renders:     [],
  navigations: [],
}

// ─── Query timing ────────────────────────────────────────────────────────────

export function trackQuery(label, durationMs, fromCache = false) {
  if (fromCache) {
    stats.cacheHits++
  } else {
    stats.cacheMisses++
    stats.queries.push({ label, ms: durationMs, at: Date.now() })
    if (durationMs > 200 && isDev) {
      console.warn(`[perf] SLOW QUERY: "${label}" took ${durationMs}ms (target <200ms)`)
    }
  }
}

// ─── Navigation timing ───────────────────────────────────────────────────────

let navStart = 0

export function startNavigation(route) {
  navStart = performance.now()
  return () => endNavigation(route)
}

export function endNavigation(route) {
  if (!navStart) return
  const ms = Math.round(performance.now() - navStart)
  stats.navigations.push({ route, ms, at: Date.now() })
  if (ms > 150 && isDev) {
    console.warn(`[perf] SLOW NAV: "${route}" took ${ms}ms (target <50ms cached, <400ms cold)`)
  }
  navStart = 0
  return ms
}

// ─── Cache statistics ─────────────────────────────────────────────────────────

export function getCacheHitRate() {
  const total = stats.cacheHits + stats.cacheMisses
  if (total === 0) return 1
  return stats.cacheHits / total
}

// ─── Web Vitals ───────────────────────────────────────────────────────────────

export function initWebVitals() {
  if (typeof window === 'undefined') return

  // First Contentful Paint
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'first-contentful-paint') {
        const ms = Math.round(entry.startTime)
        if (ms > 1800 && isDev) {
          console.warn(`[perf] SLOW FCP: ${ms}ms (target <1000ms, threshold <1800ms)`)
        } else if (isDev) {
          console.info(`[perf] FCP: ${ms}ms ✓`)
        }
      }
    }
  })
  try { observer.observe({ type: 'paint', buffered: true }) } catch {}

  // Long tasks (>50ms blocks main thread)
  const ltObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (isDev && entry.duration > 100) {
        console.warn(`[perf] LONG TASK: ${Math.round(entry.duration)}ms — may cause jank`)
      }
    }
  })
  try { ltObserver.observe({ type: 'longtask', buffered: true }) } catch {}

  // LCP
  const lcpObserver = new PerformanceObserver((list) => {
    const last = list.getEntries().at(-1)
    if (!last) return
    const ms = Math.round(last.startTime)
    if (isDev) {
      const status = ms < 2500 ? '✓' : ms < 4000 ? '⚠' : '✗'
      console.info(`[perf] LCP: ${ms}ms ${status}`)
    }
  })
  try { lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true }) } catch {}
}

// ─── Dev dashboard ───────────────────────────────────────────────────────────

export function printReport() {
  if (!isDev) return
  const hitRate = (getCacheHitRate() * 100).toFixed(1)
  const slowQueries = stats.queries.filter(q => q.ms > 200)
  const avgNav = stats.navigations.length
    ? Math.round(stats.navigations.reduce((s, n) => s + n.ms, 0) / stats.navigations.length)
    : 0

  console.group('[Gateway CRM — Perf Report]')
  console.log(`Cache hit rate:  ${hitRate}% (target >85%)`)
  console.log(`Cache hits:      ${stats.cacheHits}`)
  console.log(`Cache misses:    ${stats.cacheMisses}`)
  console.log(`Avg nav time:    ${avgNav}ms`)
  console.log(`Total queries:   ${stats.queries.length}`)
  if (slowQueries.length) {
    console.warn('Slow queries:', slowQueries)
  }
  console.groupEnd()
}

// Expose to window for quick console inspection
if (isDev && typeof window !== 'undefined') {
  window.__gwPerf = { stats, getCacheHitRate, printReport }
}
