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

// ── POST: landing-page / website lead capture (formerly /api/property-gate) ──
// Accepts the full lead shape (first_name/last_name OR name, agent_id,
// session_key, property_address, property_type, message). Assigns an agent
// (explicit link, else round-robin by specialty), de-dupes the contact by
// email, and logs an activity + a lead_captures record.
async function handleGate(req, res) {
  const {
    propertyId,
    name, first_name, last_name,
    email, phone,
    agent_id,            // set when the lead comes from a specific agent's page/listing
    session_key, message, property_address,
    property_type,       // 'residential' | 'commercial' — drives round-robin pool
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

  // Lead assignment: explicit agent link first, else round-robin by specialty.
  const assignedAgentId = agent_id || await pickRoundRobinAgent(SUPABASE_URL, headers, property_type)

  // De-duplicate the contact by email.
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

  // Activity note on the contact timeline.
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

  // Lead-capture record (already linked to the created/matched contact).
  // ALWAYS written: the round-robin advances by reading the latest
  // lead_captures row, so skipping this (the old session_key-only behavior)
  // froze the rotation on one agent for plain website forms.
  if (contactId) {
    await fetch(`${SUPABASE_URL}/rest/v1/lead_captures`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        session_key:          session_key || null,
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

  // Tell the assigned agent — instantly in-app (realtime channel already
  // subscribed in App.jsx) and by email. Both best-effort: a notification
  // failure must never lose the lead.
  if (assignedAgentId) {
    const leadName = `${resolvedFirst} ${resolvedLast}`.replace(/ —$/, '').trim()
    const detail = [
      property_address ? `Interested in ${property_address}` : null,
      phone?.trim() ? `Phone: ${phone.trim()}` : null,
      `Email: ${normalEmail}`,
      message ? `"${message}"` : null,
    ].filter(Boolean)

    await fetch(`${SUPABASE_URL}/rest/v1/agent_notifications`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        agent_id: assignedAgentId,
        title:    `New website lead: ${leadName}`,
        message:  detail.join(' · '),
        type:     'lead',
      }),
    }).catch(() => {})

    const RESEND_KEY = process.env.RESEND_API_KEY
    if (RESEND_KEY) {
      try {
        const agentRes = await fetch(
          `${SUPABASE_URL}/rest/v1/agents?id=eq.${assignedAgentId}&select=name,email&limit=1`,
          { headers }
        )
        const [agentRow] = agentRes.ok ? await agentRes.json() : []
        if (agentRow?.email) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
            body: JSON.stringify({
              from: process.env.RESEND_FROM || 'Gateway CRM <noreply@gatewayreadvisors.com>',
              to: agentRow.email,
              subject: `🔔 New website lead: ${leadName}`,
              html: `<p>Hi ${agentRow.name?.split(' ')[0] || ''},</p>
<p>A new website lead was just assigned to you:</p>
<p><strong>${leadName}</strong><br/>${detail.join('<br/>')}</p>
<p>They're in your CRM contacts now — reach out while it's hot.</p>`,
            }),
          })
        }
      } catch { /* email is best-effort */ }
    }
  }

  return res.json({ ok: true, contactId, isNew, assignedAgentId })
}

// Round-robin: pull agents by specialty, find the most recently assigned agent
// in that pool, and return the next one in alphabetical rotation. Falls back to
// the other specialty, then any agent, then null if none are configured.
async function pickRoundRobinAgent(supabaseUrl, headers, propertyType) {
  const specialty = propertyType === 'commercial' ? 'commercial' : 'residential'
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
    if (agents.length === 1) return agents[0].id

    const idList = agents.map(a => a.id).join(',')
    const lastRes = await fetch(
      `${supabaseUrl}/rest/v1/lead_captures?agent_id=in.(${idList})&select=agent_id&order=created_at.desc&limit=1`,
      { headers }
    )
    const last = lastRes.ok ? await lastRes.json() : []
    if (!last.length) return agents[0].id

    const lastIdx = agents.findIndex(a => a.id === last[0].agent_id)
    const nextIdx = (lastIdx === -1 ? 0 : lastIdx + 1) % agents.length
    return agents[nextIdx].id
  }

  return null  // no agents configured at all
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
