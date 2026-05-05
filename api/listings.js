export default async function handler(req, res) {
  // CORS — allow any origin so website widgets work
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY

  if (!SUPABASE_URL || !ANON_KEY) return res.status(500).json({ error: 'Server not configured' })

  const proto = req.headers['x-forwarded-proto'] || 'https'
  const host  = req.headers.host
  const base  = `${proto}://${host}`

  // Filter by status if provided: ?status=active
  const statusFilter = req.query?.status || 'active'

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/properties?status=eq.${encodeURIComponent(statusFilter)}&select=id,address,city,state,zip,type,status,list_price,beds,baths,sqft,details,assigned_agent_id&order=created_at.desc`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
  )
  if (!r.ok) return res.status(500).json({ error: 'Failed to fetch listings' })
  const rows = await r.json()

  const listings = rows.map(p => ({
    id:          p.id,
    address:     p.address,
    city:        p.city,
    state:       p.state,
    zip:         p.zip,
    type:        p.type,
    status:      p.status,
    price:       p.list_price,
    beds:        p.beds,
    baths:       p.baths,
    sqft:        p.sqft,
    photos:      p.details?.photos || [],
    listingUrl:  `${base}/listing/${p.id}`,
    heroPhoto:   (p.details?.photos || [])[0] || null,
  }))

  // Cache for 60 seconds on CDN, revalidate in background
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  return res.json({ listings, count: listings.length, updatedAt: new Date().toISOString() })
}
