// ─────────────────────────────────────────────────────────────────────────────
// public/sw.js — the service worker behind the installable app.
//
// The load-bearing rule is what it does NOT touch. A worker that answered for
// /api/*, a POST, or the QR/email trackers would break live data, the Outlook
// OAuth callback, or scan counts; one that cached index.html would pin agents to
// an old deploy (vercel.json marks it no-store for exactly that reason). So most
// of these tests assert a request is left to the browser.
//
// The real file is executed in a vm context with a fake worker global, so what
// is tested is exactly what ships.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const ROOT = path.resolve(__dirname, '../../..')
const SW_SOURCE = readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8')
const ORIGIN = 'https://crm.example.com'

function fakeResponse(body, { ok = true, type = 'basic' } = {}) {
  return { body, ok, type, clone() { return fakeResponse(body, { ok, type }) } }
}

function fakeCaches() {
  const stores = new Map()
  const keyOf = (req) => (typeof req === 'string' ? new URL(req, ORIGIN).href : req.url)
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)
    return {
      match: async (req) => store.get(keyOf(req)),
      put: async (req, res) => { store.set(keyOf(req), res) },
      delete: async (req) => store.delete(keyOf(req)),
      keys: async () => [...store.keys()].map(url => ({ url })),
      addAll: async (urls) => { for (const u of urls) store.set(keyOf(u), fakeResponse(`precached ${u}`)) },
    }
  }
  return {
    stores,
    open,
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (req) => {
      for (const store of stores.values()) {
        const hit = store.get(keyOf(req))
        if (hit) return hit
      }
      return undefined
    },
  }
}

function loadWorker({ fetchImpl } = {}) {
  const handlers = {}
  const fetchCalls = []
  const caches = fakeCaches()
  const context = {
    URL,
    console,
    caches,
    Response: { error: () => ({ error: true }) },
    fetch: async (req) => {
      fetchCalls.push(req.url)
      return fetchImpl ? fetchImpl(req) : fakeResponse(`network ${req.url}`)
    },
  }
  context.self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { handlers[type] = fn },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    registration: {},
  }
  vm.createContext(context)
  vm.runInContext(SW_SOURCE, context)
  return { context, handlers, caches, fetchCalls }
}

function fetchEvent(url, { method = 'GET', mode = 'cors', range = false } = {}) {
  const waits = []
  const event = {
    request: {
      url: new URL(url, ORIGIN).href,
      method,
      mode,
      headers: { has: (h) => range && h.toLowerCase() === 'range' },
    },
    responded: null,
    respondWith(p) { event.responded = p },
    waitUntil(p) { waits.push(p) },
    settle: () => Promise.all(waits),
  }
  return event
}

describe('routeFor — which requests the worker answers', () => {
  const { context } = loadWorker()
  const route = (url, opts = {}) => context.routeFor({
    url: new URL(url, ORIGIN).href,
    method: opts.method || 'GET',
    mode: opts.mode || 'cors',
    hasRange: Boolean(opts.range),
  }, ORIGIN)

  it('sends page navigations to the network (offline page only on failure)', () => {
    expect(route('/', { mode: 'navigate' })).toBe('navigate')
    expect(route('/?deal=123', { mode: 'navigate' })).toBe('navigate')
    expect(route('/boldsign-return.html', { mode: 'navigate' })).toBe('navigate')
  })

  it('caches content-hashed build assets cache-first', () => {
    expect(route('/assets/index-3f9a1c.js')).toBe('cache-first')
    expect(route('/assets/app-9b2e.css')).toBe('cache-first')
  })

  it('revalidates brand art, icons and font CSS in the background', () => {
    expect(route('/brand/wolf-crm-logo-128.webp')).toBe('stale-while-revalidate')
    expect(route('/icons/icon-192.png')).toBe('stale-while-revalidate')
    expect(route('https://fonts.googleapis.com/css2?family=DM+Sans')).toBe('stale-while-revalidate')
    expect(route('https://fonts.gstatic.com/s/dmsans/v1/abc.woff2')).toBe('cache-first')
  })

  it('never touches the API, even as a navigation (Outlook OAuth callback)', () => {
    expect(route('/api/portal')).toBeNull()
    expect(route('/api/email-send?action=outlook-callback&code=x', { mode: 'navigate' })).toBeNull()
  })

  it('never touches the scan/open trackers or server-rendered share pages', () => {
    for (const p of ['/m/abc123', '/e/abc123', '/share/some-id', '/u/token1234567890abcdef']) {
      expect(route(p, { mode: 'navigate' })).toBeNull()
      expect(route(p)).toBeNull()
    }
  })

  it('never touches non-GET or Range requests', () => {
    expect(route('/assets/index-3f9a1c.js', { method: 'POST' })).toBeNull()
    expect(route('/', { mode: 'navigate', method: 'POST' })).toBeNull()
    expect(route('/assets/video-1a2b.mp4', { range: true })).toBeNull()
  })

  it('never touches other origins — Supabase, BoldSign, CDNs', () => {
    expect(route('https://abc.supabase.co/rest/v1/contacts')).toBeNull()
    expect(route('https://app.boldsign.com/document/sign')).toBeNull()
    expect(route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js')).toBeNull()
  })

  it('leaves unrecognised same-origin files alone rather than guessing', () => {
    expect(route('/manifest.webmanifest')).toBeNull()
    expect(route('/sw.js')).toBeNull()
  })
})

describe('fetch handler', () => {
  let worker
  beforeEach(() => { worker = loadWorker() })

  it('does not call respondWith for passthrough requests', () => {
    for (const [url, opts] of [
      ['/api/boldsign', { method: 'POST' }],
      ['/api/email-send?action=outlook-callback', { mode: 'navigate' }],
      ['https://abc.supabase.co/auth/v1/token', {}],
    ]) {
      const e = fetchEvent(url, opts)
      worker.handlers.fetch(e)
      expect(e.responded, url).toBeNull()
    }
  })

  it('serves navigations from the network and never stores the shell', async () => {
    const e = fetchEvent('/', { mode: 'navigate' })
    worker.handlers.fetch(e)
    const res = await e.responded
    expect(res.body).toBe(`network ${ORIGIN}/`)
    for (const store of worker.caches.stores.values()) {
      expect(store.has(`${ORIGIN}/`)).toBe(false)
    }
  })

  it('falls back to the offline page only when the network fails', async () => {
    worker = loadWorker({ fetchImpl: () => { throw new TypeError('Failed to fetch') } })
    const install = fetchEvent('/')    // reuse the waitUntil shape for install
    worker.handlers.install(install)
    await install.settle()

    const e = fetchEvent('/', { mode: 'navigate' })
    worker.handlers.fetch(e)
    const res = await e.responded
    expect(res.body).toBe('precached /offline.html')
  })

  it('serves a hashed asset from cache after the first fetch', async () => {
    const first = fetchEvent('/assets/index-3f9a1c.js')
    worker.handlers.fetch(first)
    await first.responded
    await first.settle()

    const second = fetchEvent('/assets/index-3f9a1c.js')
    worker.handlers.fetch(second)
    const res = await second.responded
    expect(res.body).toBe(`network ${ORIGIN}/assets/index-3f9a1c.js`)
    expect(worker.fetchCalls).toHaveLength(1)
  })

  it('does not cache error or opaque responses', async () => {
    worker = loadWorker({ fetchImpl: (req) =>
      req.url.includes('broken') ? fakeResponse('404', { ok: false }) : fakeResponse('x', { type: 'opaque' }) })
    for (const url of ['/assets/broken-1.js', 'https://fonts.gstatic.com/s/x.woff2']) {
      const e = fetchEvent(url)
      worker.handlers.fetch(e)
      await e.responded
      await e.settle()
    }
    const assets = worker.caches.stores.get('gw-assets-v1')
    expect(assets ? assets.size : 0).toBe(0)
  })
})

describe('activate — cache housekeeping', () => {
  it('deletes this app’s old caches and leaves foreign ones alone', async () => {
    const worker = loadWorker()
    await worker.caches.open('gw-assets-v0')
    await worker.caches.open('gw-static-v0')
    await worker.caches.open('gw-assets-v1')
    await worker.caches.open('someone-elses-cache')

    const e = fetchEvent('/')
    worker.handlers.activate(e)
    await e.settle()

    expect([...worker.caches.stores.keys()].sort()).toEqual(['gw-assets-v1', 'someone-elses-cache'])
  })

  it('trims the asset cache oldest-first', async () => {
    const worker = loadWorker()
    const cache = await worker.caches.open('t')
    for (let i = 0; i < 5; i++) await cache.put(`/assets/${i}.js`, fakeResponse(i))
    await worker.context.trimCache('t', 3)
    const left = (await cache.keys()).map(k => k.url.split('/').pop())
    expect(left).toEqual(['2.js', '3.js', '4.js'])
  })
})

describe('shipped files the worker and manifest depend on', () => {
  // cache.addAll() rejects if ANY url 404s, which fails the whole install —
  // a renamed icon would silently leave every browser without a worker.
  it('every precached file exists in public/', () => {
    const { context } = loadWorker()
    // `const` bindings live in the script's global lexical scope, not on the
    // context object, so read it by evaluating in that scope.
    for (const url of vm.runInContext('PRECACHE', context)) {
      expect(existsSync(path.join(ROOT, 'public', url)), url).toBe(true)
    }
  })

  it('every manifest icon exists, with a maskable one for Android', () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'))
    expect(manifest.start_url).toBe('/')
    expect(manifest.display).toBe('standalone')
    for (const icon of manifest.icons) {
      expect(existsSync(path.join(ROOT, 'public', icon.src)), icon.src).toBe(true)
    }
    const sizes = manifest.icons.map(i => i.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
    expect(manifest.icons.some(i => i.purpose === 'maskable')).toBe(true)
  })

  it('vercel.json lets browsers revalidate sw.js and keeps the shell uncached', () => {
    const vercel = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'))
    const headerFor = (source) => vercel.headers.find(h => h.source === source)?.headers
      .find(h => h.key === 'Cache-Control')?.value
    expect(headerFor('/sw.js')).toBe('no-cache')
    expect(headerFor('/index.html')).toMatch(/no-store/)
  })
})
