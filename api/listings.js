import { streetLine } from '../src/lib/address.js'

export default async function handler(req, res) {
  // CORS — allow any origin so website widgets work
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co').trim().replace(/\/+$/, '')

  // Service key, NOT the anon key. This endpoint is a PUBLIC feed (website
  // listing widgets) but it is server-side, so it reads with service-role
  // credentials and decides for itself what to publish — see the explicit field
  // mapping below, which only ever emits `details.photos`.
  //
  // It used to present the anon key. Migration 0027 closed `properties` to anon
  // and RLS filters rather than erroring, so this quietly started returning
  // `{ listings: [], count: 0 }` — a 200 with an empty feed, which every widget
  // renders as "no listings" rather than as an error.
  const SERVICE_KEY = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  if (!SERVICE_KEY) return res.status(500).json({ error: 'Server configuration error' })
  const AUTH = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }

  // Health check — folded into this endpoint so external uptime monitors can
  // ping /api/listings?action=health without consuming a Vercel function slot.
  if (req.query?.action === 'health') {
    const t0 = Date.now()
    let supabaseOk = false
    let supabaseLatency = null
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/agents?select=id&limit=1`, {
        headers: AUTH,
      })
      supabaseOk = r.ok
      supabaseLatency = Date.now() - t0
    } catch {
      supabaseOk = false
    }
    return res.status(supabaseOk ? 200 : 503).json({
      status: supabaseOk ? 'healthy' : 'degraded',
      service: 'gateway-crm',
      version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'dev',
      env: process.env.VERCEL_ENV || 'development',
      region: process.env.VERCEL_REGION || null,
      checks: { supabase: { ok: supabaseOk, latency_ms: supabaseLatency } },
      timestamp: new Date().toISOString(),
    })
  }

  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host  = req.headers.host
  const base  = `${proto}://${host}`

  // Filter by status if provided: ?status=active
  const statusFilter = req.query?.status || 'active'

  // `unit` is the suite inside the building (migration 0042). PostgREST 400s the
  // whole select on an unknown column, so a deploy that lands before the
  // migration retries without it rather than serving every widget an error.
  const feedColumns = (withUnit) =>
    `id,address,${withUnit ? 'unit,' : ''}city,state,zip,type,status,list_price,beds,baths,sqft,details,assigned_agent_id`
  const fetchFeed = (withUnit) => fetch(
    `${SUPABASE_URL}/rest/v1/properties?status=eq.${encodeURIComponent(statusFilter)}&select=${feedColumns(withUnit)}&order=created_at.desc`,
    { headers: AUTH }
  )
  let r = await fetchFeed(true)
  if (r.status === 400) r = await fetchFeed(false)
  if (!r.ok) return res.status(500).json({ error: 'Failed to fetch listings' })
  const rows = await r.json()

  const listings = rows.map(p => ({
    id:            p.id,
    // `address` stays the bare street line so existing website widgets read
    // exactly as before; `unit` and the composed `streetAddress` are additive.
    address:       p.address,
    unit:          p.unit || null,
    streetAddress: streetLine(p),
    city:          p.city,
    state:         p.state,
    zip:           p.zip,
    type:          p.type,
    status:        p.status,
    price:         p.list_price,
    beds:          p.beds,
    baths:         p.baths,
    sqft:          p.sqft,
    photos:        p.details?.photos || [],
    listingUrl:    `${base}/listing/${p.id}`,
    heroPhoto:     (p.details?.photos || [])[0] || null,
  }))

  // Cache for 60 seconds on CDN, revalidate in background
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  return res.json({ listings, count: listings.length, updatedAt: new Date().toISOString() })
}
