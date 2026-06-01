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
    agent_id,           // set when lead comes from a specific agent's page/listing
    session_key, message, property_address,
    property_type,      // 'residential' | 'commercial' — drives round-robin pool
  } = req.body || {}

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

  // ── Lead assignment ───────────────────────────────────────────────────────
  // Priority 1: explicit agent link (their profile page, their listing)
  // Priority 2: round-robin within the matching specialty pool
  const assignedAgentId = agent_id || await pickRoundRobinAgent(SUPABASE_URL, headers, property_type)

  // ── Deduplicate contact ───────────────────────────────────────────────────
  const normalEmail = email.trim().toLowerCase()
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
        first_name:        resolvedFirst,
        last_name:         resolvedLast,
        email:             normalEmail,
        phone:             phone?.trim() || null,
        source:            'website',
        type:              'buyer',
        status:            'active',
        assigned_agent_id: assignedAgentId,
        notes:             noteParts.join('\n') || null,
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

  // ── Activity note ─────────────────────────────────────────────────────────
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
        agent_id:   assignedAgentId,
        type:       'note',
        body:       activityBody,
      }),
    }).catch(() => {})
  }

  // ── Lead capture record (already marked as converted) ────────────────────
  if (session_key && contactId) {
    await fetch(`${SUPABASE_URL}/rest/v1/lead_captures`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        session_key,
        agent_id:             assignedAgentId,
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

  return res.json({ ok: true, contactId, isNew, assignedAgentId })
}

// ── Round-robin logic ─────────────────────────────────────────────────────────
// Pulls agents by specialty, checks the most recently assigned lead in that
// pool, and returns the next agent ID in alphabetical rotation.
// Falls back: if specialty pool is empty, tries the other specialty, then any agent.
async function pickRoundRobinAgent(supabaseUrl, headers, propertyType) {
  const specialty = propertyType === 'commercial' ? 'commercial' : 'residential'

  // Try the matching specialty pool first, fall back to the other, then unfiltered
  const pools = [
    `specialty=eq.${specialty}`,
    `specialty=eq.${specialty === 'residential' ? 'commercial' : 'residential'}`,
    '',  // all agents
  ]

  for (const filter of pools) {
    const qs = filter ? `${filter}&` : ''
    const agentsRes = await fetch(
      `${supabaseUrl}/rest/v1/agents?${qs}select=id,name&order=name.asc`,
      { headers }
    )
    if (!agentsRes.ok) continue
    const agents = await agentsRes.json()
    if (!agents.length) continue

    // Single agent in pool — always assign them
    if (agents.length === 1) return agents[0].id

    // Find most recently assigned agent within this exact pool
    const idList = agents.map(a => a.id).join(',')
    const lastRes = await fetch(
      `${supabaseUrl}/rest/v1/lead_captures?agent_id=in.(${idList})&select=agent_id&order=created_at.desc&limit=1`,
      { headers }
    )
    const last = lastRes.ok ? await lastRes.json() : []

    if (!last.length) {
      // No prior assignments in this pool — start at the first agent
      return agents[0].id
    }

    const lastIdx = agents.findIndex(a => a.id === last[0].agent_id)
    // lastIdx === -1 means the last lead went to an agent now outside the pool;
    // treat as "start over" so no one gets skipped.
    const nextIdx = (lastIdx === -1 ? 0 : lastIdx + 1) % agents.length
    return agents[nextIdx].id
  }

  return null  // no agents configured at all
}
