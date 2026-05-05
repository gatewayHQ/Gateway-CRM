export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

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

  // Check for existing contact with this email to avoid duplicates
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/contacts?email=eq.${encodeURIComponent(email.trim().toLowerCase())}&select=id&limit=1`,
    { headers }
  )
  const existing = checkRes.ok ? await checkRes.json() : []

  let contactId

  if (existing.length > 0) {
    contactId = existing[0].id
  } else {
    // Create new contact
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

  // Log an activity on the contact noting which property they inquired about
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
