export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const {
    propertyId,
    name, first_name, last_name,
    email, phone,
    agent_id, session_key, message, property_address,
  } = req.body || {}

  // Support either combined `name` or separate first/last
  const resolvedFirst = first_name?.trim() || name?.trim().split(/\s+/)[0] || ''
  const resolvedLast  = last_name?.trim()  || name?.trim().split(/\s+/).slice(1).join(' ') || '—'

  if (!resolvedFirst || !email?.trim()) {
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

  const normalEmail = email.trim().toLowerCase()

  // Check for existing contact to avoid duplicates
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/contacts?email=eq.${encodeURIComponent(normalEmail)}&select=id&limit=1`,
    { headers }
  )
  const existing = checkRes.ok ? await checkRes.json() : []

  let contactId
  let isNew = false

  if (existing.length > 0) {
    contactId = existing[0].id
  } else {
    const noteParts = [
      property_address ? `Interested in: ${property_address}` : '',
      message          ? `Message: ${message}`                 : '',
    ].filter(Boolean)

    const createRes = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body: JSON.stringify({
        first_name:          resolvedFirst,
        last_name:           resolvedLast,
        email:               normalEmail,
        phone:               phone?.trim() || null,
        source:              'website',
        type:                'buyer',
        status:              'active',
        assigned_agent_id:   agent_id || null,
        notes:               noteParts.join('\n') || null,
      }),
    })
    if (!createRes.ok) {
      const d = await createRes.json().catch(() => ({}))
      return res.status(500).json({ error: d.message || 'Failed to create contact' })
    }
    const [created] = await createRes.json()
    contactId = created?.id
    isNew = true
  }

  // Log an activity note — property inquiry or lead form
  if (contactId) {
    const activityBody = property_address
      ? `Website lead form submitted — interested in: ${property_address}${message ? `\nMessage: ${message}` : ''}`
      : propertyId
        ? `Landing page inquiry submitted for property ID: ${propertyId}`
        : `Website lead form submitted${message ? `\nMessage: ${message}` : ''}`

    await fetch(`${SUPABASE_URL}/rest/v1/activities`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        contact_id: contactId,
        agent_id:   agent_id || null,
        type:       'note',
        body:       activityBody,
      }),
    }).catch(() => {})
  }

  // Write the lead_captures row with converted_contact_id already set so it
  // shows as "In CRM" immediately in the Leads page — no manual conversion needed.
  if (session_key && contactId) {
    await fetch(`${SUPABASE_URL}/rest/v1/lead_captures`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        session_key,
        agent_id:             agent_id || null,
        first_name:           resolvedFirst,
        last_name:            resolvedLast,
        email:                normalEmail,
        phone:                phone?.trim() || null,
        property_address:     property_address || null,
        message:              message || null,
        converted_contact_id: contactId,
      }),
    }).catch(() => {})
  }

  return res.json({ ok: true, contactId, isNew })
}
