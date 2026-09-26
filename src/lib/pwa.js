// ─────────────────────────────────────────────────────────────────────────────
// Installable app (PWA) wiring — see docs/pwa.md for the whole picture.
//
// Only the AGENT app is installable. The same index.html also serves the
// client-facing pages (landing pages, the client portal, advisor profiles,
// unsubscribe — see src/main.jsx), and a buyer who adds a listing to their home
// screen must not get an icon that opens the agents' login. So the manifest and
// the "behave like an app" meta tags are not in index.html; main.jsx calls
// enableInstallableApp() only when it is about to render <App />.
//
// The service worker is registered from the same place, and only in production
// builds: under `vite dev` it would cache modules the dev server expects to
// hot-swap.
// ─────────────────────────────────────────────────────────────────────────────

const MANIFEST_HREF = '/manifest.webmanifest'
const SW_URL = '/sw.js'

/** localStorage key holding when the agent last dismissed the install prompt. */
export const INSTALL_DISMISSED_KEY = 'gw_install_dismissed_at'
/** How long a dismissal lasts before the prompt may show again. */
export const INSTALL_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000

function addHeadTag(tag, attrs) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.head.appendChild(el)
}

/**
 * Advertise the agent app as installable and start the service worker.
 * Idempotent — a second call is a no-op.
 */
export function enableInstallableApp() {
  if (typeof document === 'undefined') return
  if (document.querySelector(`link[rel="manifest"]`)) return

  addHeadTag('link', { rel: 'manifest', href: MANIFEST_HREF })
  // iOS reads these, not the manifest, for a home-screen launch: full screen,
  // the label under the icon, and a status bar that doesn't overlap the page.
  addHeadTag('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' })
  addHeadTag('meta', { name: 'mobile-web-app-capable', content: 'yes' })
  addHeadTag('meta', { name: 'apple-mobile-web-app-title', content: 'Gateway CRM' })
  addHeadTag('meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black' })

  captureInstallPrompt()
  if (import.meta.env.PROD) registerServiceWorker()
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  const register = () => {
    // updateViaCache 'none': the browser always asks the server for sw.js
    // rather than trusting its HTTP cache, so a changed worker (including the
    // kill switch in docs/pwa.md) is picked up on the very next page load.
    navigator.serviceWorker.register(SW_URL, { scope: '/', updateViaCache: 'none' })
      .catch(err => console.warn('[pwa] service worker registration failed:', err))
  }
  // After `load`, so registering never competes with the app's own first paint.
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}

// ── Install prompt ───────────────────────────────────────────────────────────
// Chrome/Edge/Android fire `beforeinstallprompt` once, possibly before React
// has mounted anything, and the event is the only handle for showing the native
// install dialog later. Held here so the banner can pick it up whenever it
// renders. iOS never fires it — see installMode() for that path.

let deferredPrompt = null
const listeners = new Set()
const notify = () => listeners.forEach(fn => fn())

function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()          // suppress Chrome's own mini-infobar; we show ours
    deferredPrompt = e
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    notify()
  })
}

/** Subscribe to install-availability changes. Returns the unsubscribe. */
export function onInstallChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Show the native install dialog. Resolves true if the agent accepted. */
export async function promptInstall() {
  const e = deferredPrompt
  if (!e) return false
  deferredPrompt = null           // the event is single-use
  notify()
  e.prompt()
  const { outcome } = await e.userChoice
  return outcome === 'accepted'
}

/** Already running as an installed app (launched from the home screen/dock)? */
export function isStandalone(win = window) {
  return Boolean(
    win.matchMedia?.('(display-mode: standalone)').matches ||
    win.navigator?.standalone          // iOS Safari's pre-standard flag
  )
}

/**
 * iPhone/iPad. iPadOS 13+ reports itself as a Mac, so a Mac with a touch
 * screen is an iPad — no real Mac has one.
 */
export function isIos(nav = navigator) {
  const ua = nav.userAgent || ''
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1
}

/**
 * Which install affordance, if any, to show right now:
 *   'prompt' — the browser handed us a native install dialog (Chrome/Edge/Android)
 *   'ios'    — iOS, where installing is Share → Add to Home Screen, by hand
 *   null     — already installed, recently dismissed, or not installable here
 */
export function installMode({
  standalone,
  hasPrompt,
  ios,
  dismissedAt,
  now = Date.now(),
}) {
  if (standalone) return null
  if (dismissedAt && now - dismissedAt < INSTALL_SNOOZE_MS) return null
  if (hasPrompt) return 'prompt'
  if (ios) return 'ios'
  return null
}

/** Current install mode for this browser, reading live state. */
export function currentInstallMode() {
  let dismissedAt = 0
  try { dismissedAt = Number(localStorage.getItem(INSTALL_DISMISSED_KEY)) || 0 } catch {}
  return installMode({
    standalone: isStandalone(),
    hasPrompt: Boolean(deferredPrompt),
    ios: isIos(),
    dismissedAt,
  })
}

export function dismissInstall() {
  try { localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now())) } catch {}
  notify()
}
