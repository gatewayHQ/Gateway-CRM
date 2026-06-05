/**
 * Gateway CRM — Public Property Endpoint
 *
 * GET  /api/property-public?id=<uuid>   — social-share HTML for a listing
 *                                          (served at /share/:id via rewrite)
 * POST /api/property-public             — landing-page lead capture (gate)
 *
 * Two public-facing property actions share one serverless function (Vercel
 * Hobby caps total functions at 12). GET renders Open Graph / Twitter cards
 * and redirects real users to the full listing; POST creates/links a contact.
 */

const TYPE_LABELS = {
  residential: 'Residential', rental: 'Rental', multifamily: 'Multifamily',
  office: 'Office', land: 'Land', retail: 'Retail',
  industrial: 'Industrial', 'mixed-use': 'Mixed-Use', commercial: 'Commercial',
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// ── GET: social-share HTML (formerly /api/share) ─────────────────────────────
async function handleShare(req, res) {
  const id = req.query.id || req.url?.split('/').pop()?.split('?')[0]
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).send('Invalid property ID')

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co'
  const ANON_KEY     = process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3Z3dlbWtpaHB3bGdsaWZ0YWdnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNjkzMjAsImV4cCI6MjA5MjY0NTMyMH0.YRaCsDpExXjuPyrssFyzXP9RQktFAW7GTuEMgQq8sZU'

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/properties?id=eq.${id}&select=address,city,state,zip,type,status,list_price,beds,baths,sqft,details,notes&limit=1`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` } }
  )
  if (!r.ok) return res.status(500).send('Database error')
  const rows = await r.json()
  if (!rows?.length) return res.status(404).send('Listing not found')

  const p          = rows[0]
  const proto      = req.headers['x-forwarded-proto'] || 'https'
  const base       = `${proto}://${req.headers.host}`
  const listingUrl = `${base}/listing/${id}`
  const heroPhoto  = (p.details?.photos || [])[0] || ''

  const title = [p.address, p.city, p.state].filter(Boolean).join(', ')
  const price = p.list_price ? `$${Number(p.list_price).toLocaleString()}` : ''
  const type  = TYPE_LABELS[p.type] || p.type || ''
  const specs = [
    type, price,
    p.beds  ? `${p.beds} bd`  : '',
    p.baths ? `${p.baths} ba` : '',
    p.sqft  ? `${Number(p.sqft).toLocaleString()} sqft` : '',
  ].filter(Boolean).join(' · ')

  const desc = p.notes
    ? `${specs} — ${p.notes.slice(0, 120)}${p.notes.length > 120 ? '…' : ''}`
    : specs

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400')

  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — Gateway Real Estate</title>
  <meta name="description" content="${esc(desc)}">

  <!-- ── Open Graph (Facebook · LinkedIn · WhatsApp · iMessage · Slack · Discord) -->
  <meta property="og:type"        content="website">
  <meta property="og:url"         content="${esc(listingUrl)}">
  <meta property="og:title"       content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:site_name"   content="Gateway Real Estate">
  ${heroPhoto ? `<meta property="og:image"        content="${esc(heroPhoto)}">
  <meta property="og:image:width"  content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt"    content="${esc(title)}">` : ''}

  <!-- ── Twitter / X Card -->
  <meta name="twitter:card"        content="${heroPhoto ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title"       content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  ${heroPhoto ? `<meta name="twitter:image" content="${esc(heroPhoto)}">` : ''}

  <!-- ── Redirect real users instantly to the full listing page -->
  <meta http-equiv="refresh" content="0;url=${esc(listingUrl)}">
  <script>window.location.replace(${JSON.stringify(listingUrl)})</script>
</head>
<body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#1e2642">
  <div style="font-size:24px;font-weight:600;margin-bottom:8px">Gateway Real Estate</div>
  <div style="font-size:16px;margin-bottom:24px">${esc(title)}</div>
  <a href="${esc(listingUrl)}" style="color:#4a6fa5">View Listing →</a>
</body>
</html>`)
}

// ── POST: landing-page lead capture (formerly /api/property-gate) ────────────
async function handleGate(req, res) {
  const { propertyId, name, email, phone } = req.body || {}
  if (!name?.trim() || !email?.trim()) {
    return res.status(400).json({ error: 'name and email are required' })
  }
  if (!email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email address' })
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Server configuration error' })
  }

  const headers = {
    'Content-Type': 'application/json',
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  }

  const parts = name.trim().split(/\s+/)
  const first = parts[0]
  const last  = parts.slice(1).join(' ') || '—'

  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/contacts?email=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=id&limit=1`,
    { headers }
  )
  const existing = checkRes.ok ? await checkRes.json() : []

  let contactId

  if (existing.length > 0) {
    contactId = existing[0].id
  } else {
    const createRes = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        first_name: first,
        last_name:  last,
        email:      email.trim().toLowerCase(),
        phone:      phone?.trim() || null,
        source:     'website',
        type:       'buyer',
        status:     'active',
      }),
    })
    if (!createRes.ok) {
      const d = await createRes.json().catch(() => ({}))
      return res.status(500).json({ error: d.message || 'Failed to create contact' })
    }
    const [created] = await createRes.json()
    contactId = created?.id
  }

  if (contactId && propertyId) {
    await fetch(`${SUPABASE_URL}/rest/v1/activities`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        contact_id: contactId,
        type:       'note',
        body:       `Landing page inquiry submitted for property ID: ${propertyId}`,
      }),
    }).catch(() => {})
  }

  return res.json({ ok: true, contactId })
}

export default async function handler(req, res) {
  // CORS for the lead-capture POST (landing pages may be embedded externally)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()

  if (req.method === 'POST') return handleGate(req, res)
  return handleShare(req, res)
}
