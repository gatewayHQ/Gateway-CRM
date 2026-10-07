// ─────────────────────────────────────────────────────────────────────────────
// Recovering from a deploy that happened while the app was open.
//
// Every page is a lazy chunk with a content-hashed name (DealPage-DiHwcAy7.js).
// A tab opened before a deploy still holds the OLD index.html, so when the agent
// then navigates to a page it hasn't visited yet, it asks for the old chunk —
// which no longer exists on the new deployment. The import rejects with
// "Failed to fetch dynamically imported module", and React.lazy caches that
// rejection, so "Try again" can never succeed: only a full reload (which fetches
// the new index.html, never cached — see vercel.json) fixes it.
//
// So on a chunk-load failure we reload once, automatically. A short guard in
// sessionStorage stops a reload loop if the chunk is genuinely broken or the
// network is down — then the error surfaces to the error boundary as before.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react'

const RELOAD_KEY = 'gw-chunk-reload-at'
const RELOAD_GUARD_MS = 10_000

// Chrome/Edge, Safari, Firefox, and Vite's CSS-preload wording, respectively.
const CHUNK_ERROR_RE = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i

export function isChunkLoadError(error) {
  return CHUNK_ERROR_RE.test(String(error?.message ?? error ?? ''))
}

/**
 * Reload the page to pick up the current deploy, unless we already did so in
 * the last few seconds. Returns true if a reload was started.
 */
export function reloadForNewVersion(storage = safeSessionStorage(), now = Date.now(), reload = () => window.location.reload()) {
  const last = Number(storage?.getItem(RELOAD_KEY) || 0)
  if (now - last < RELOAD_GUARD_MS) return false
  storage?.setItem(RELOAD_KEY, String(now))
  reload()
  return true
}

/** React.lazy that reloads once onto the new deploy when its chunk is gone. */
export function lazyWithReload(factory) {
  return React.lazy(() =>
    factory().catch((error) => {
      // Never resolve: the page is about to reload, so render nothing meanwhile.
      if (isChunkLoadError(error) && reloadForNewVersion()) return new Promise(() => {})
      throw error
    })
  )
}

function safeSessionStorage() {
  try { return window.sessionStorage } catch { return null }
}
