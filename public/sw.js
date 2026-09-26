// ─────────────────────────────────────────────────────────────────────────────
// Gateway CRM service worker.
//
// What it is for: making the installed app (see public/manifest.webmanifest and
// src/lib/pwa.js) open fast on a phone, and show a real "you're offline" screen
// instead of the browser's error page when there is no signal.
//
// What it must never do is serve an old copy of the app. vercel.json marks
// index.html `no-store` precisely so every deploy reaches every agent on their
// next load, and a service worker that cached the shell would silently undo
// that — an agent could run last week's build for days. So the rules are:
//
//   • index.html / every page navigation → always the network. The cache is only
//     consulted when the network FAILS, and then it serves offline.html, never a
//     stale shell.
//   • /assets/* → cache-first. Vite content-hashes these filenames, so a given
//     URL's bytes never change; a new deploy is new URLs. Safe forever.
//   • /brand/*, /icons/*, Google Fonts CSS → stale-while-revalidate.
//   • Google Fonts files → cache-first (URLs are versioned by Google).
//   • EVERYTHING ELSE is not touched — the browser handles it as if this file
//     did not exist. That includes /api/* (live data, auth'd, often POST),
//     Supabase (cross-origin), the QR-scan and email-open trackers (/m/*, /e/*,
//     which must reach the server to count), /share/*, BoldSign, and any
//     non-GET or Range request.
//
// Updating: bump VERSION only if the caching rules change shape. Normal deploys
// need no change here — the shell isn't cached, and new hashed assets just get
// new cache entries (old ones are trimmed by ASSET_CACHE_MAX).
//
// Kill switch: if this ever misbehaves in production, replace the body of this
// file with the three lines in docs/pwa.md ("Emergency: remove the service
// worker") and deploy. Browsers re-check sw.js on every navigation.
// ─────────────────────────────────────────────────────────────────────────────

const VERSION = 'v1'
const ASSET_CACHE  = `gw-assets-${VERSION}`
const STATIC_CACHE = `gw-static-${VERSION}`
const CURRENT_CACHES = [ASSET_CACHE, STATIC_CACHE]

const OFFLINE_URL = '/offline.html'
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png']

// A deploy replaces most hashed chunks, so without a cap the asset cache grows
// by one app's worth every release. 250 is several full builds of this app.
const ASSET_CACHE_MAX = 250

// Same-origin paths the worker must never answer for, even as a navigation.
// /api/ carries the Outlook OAuth callback and every server action; /m/ and /e/
// are scan/open trackers that 302 onward; /share/ and /u/ are server-rendered.
const PASSTHROUGH_PREFIXES = ['/api/', '/m/', '/e/', '/share/', '/u/']

const FONT_CSS_ORIGIN  = 'https://fonts.googleapis.com'
const FONT_FILE_ORIGIN = 'https://fonts.gstatic.com'

/**
 * Which strategy a request gets, or null to leave it entirely to the browser.
 * Pure — takes the request's shape, not the Request — so it can be unit-tested.
 *
 * @param {{ url: string, method: string, mode: string, hasRange: boolean }} req
 * @param {string} origin  this worker's origin (self.location.origin)
 * @returns {'navigate' | 'cache-first' | 'stale-while-revalidate' | null}
 */
function routeFor(req, origin) {
  if (req.method !== 'GET' || req.hasRange) return null

  let url
  try { url = new URL(req.url) } catch { return null }

  if (url.origin === origin) {
    if (PASSTHROUGH_PREFIXES.some(p => url.pathname.startsWith(p))) return null
    if (req.mode === 'navigate') return 'navigate'
    if (url.pathname.startsWith('/assets/')) return 'cache-first'
    if (url.pathname.startsWith('/brand/') || url.pathname.startsWith('/icons/')) return 'stale-while-revalidate'
    return null
  }

  if (url.origin === FONT_CSS_ORIGIN)  return 'stale-while-revalidate'
  if (url.origin === FONT_FILE_ORIGIN) return 'cache-first'
  return null
}

/** Only complete, readable responses are worth keeping (not opaque, not errors). */
function isCacheable(response) {
  return response && response.ok && (response.type === 'basic' || response.type === 'cors')
}

async function trimCache(name, max) {
  const cache = await caches.open(name)
  const keys = await cache.keys()   // insertion order → oldest first
  const excess = keys.length - max
  for (let i = 0; i < excess; i++) await cache.delete(keys[i])
}

async function navigate(event) {
  try {
    return await fetch(event.request)
  } catch {
    const offline = await caches.match(OFFLINE_URL)
    return offline || Response.error()
  }
}

async function cacheFirst(event) {
  const cache = await caches.open(ASSET_CACHE)
  const hit = await cache.match(event.request)
  if (hit) return hit
  const response = await fetch(event.request)
  if (isCacheable(response)) {
    event.waitUntil(
      cache.put(event.request, response.clone()).then(() => trimCache(ASSET_CACHE, ASSET_CACHE_MAX))
    )
  }
  return response
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(STATIC_CACHE)
  const hit = await cache.match(event.request)
  const refresh = fetch(event.request).then(response => {
    if (isCacheable(response)) return cache.put(event.request, response.clone()).then(() => response)
    return response
  })
  if (hit) {
    // Serve the cached copy now; the refresh must still be allowed to finish,
    // and a failed refresh (offline) is not an error worth surfacing.
    event.waitUntil(refresh.catch(() => {}))
    return hit
  }
  return refresh
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(PRECACHE))
      // Safe to take over immediately: nothing this worker serves is tied to a
      // particular build (the shell is never cached), so an old page running
      // under a new worker, or vice versa, cannot mismatch.
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(
      names
        .filter(n => n.startsWith('gw-') && !CURRENT_CACHES.includes(n))
        .map(n => caches.delete(n))
    )
    // Navigation preload is deliberately NOT enabled. The browser issues the
    // preload for every navigation, including the ones routeFor passes through
    // untouched — and for those it then fetches again itself. That would send
    // the Outlook OAuth callback twice (the second exchange of a one-time code
    // fails) and count a QR scan twice. The boot cost it would save is ~ms.
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const strategy = routeFor({
    url: request.url,
    method: request.method,
    mode: request.mode,
    hasRange: request.headers.has('range'),
  }, self.location.origin)

  if (strategy === 'navigate')               event.respondWith(navigate(event))
  else if (strategy === 'cache-first')       event.respondWith(cacheFirst(event))
  else if (strategy === 'stale-while-revalidate') event.respondWith(staleWhileRevalidate(event))
  // null → no respondWith: the browser fetches it normally.
})
