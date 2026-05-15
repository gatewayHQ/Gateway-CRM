const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const code = (req.query.c || '').trim()
  if (!code || !/^[a-z0-9]{6,12}$/i.test(code)) {
    return res.status(400).json({ error: 'Invalid or missing campaign code' })
  }

  const supabaseUrl    = process.env.SUPABASE_URL
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({ error: 'Supabase environment variables not configured' })
  }

  const headers = {
    'apikey':        supabaseAnonKey,
    'Authorization': `Bearer ${supabaseAnonKey}`,
    'Content-Type':  'application/json',
  }

  try {
    // Fetch campaign by tracking_code
    const campFields = 'id,name,description,flyer_template,property_types,landing_headline,landing_tagline,landing_cta,landing_url,landing_mode,agent_id,tracking_code'
    const campUrl    = `${supabaseUrl}/rest/v1/mail_campaigns?tracking_code=eq.${encodeURIComponent(code)}&select=${campFields}&limit=1`
    const campRes    = await fetch(campUrl, { headers })

    if (!campRes.ok) {
      const text = await campRes.text()
      console.error('[campaign-landing] campaign fetch error', campRes.status, text)
      return res.status(500).json({ error: 'Failed to fetch campaign data' })
    }

    const campData = await campRes.json()
    if (!campData || campData.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' })
    }

    const campaign = campData[0]

    // Fetch agent if present
    let agent = null
    if (campaign.agent_id) {
      const agentFields = 'id,name,initials,color,email,phone,role'
      const agentUrl    = `${supabaseUrl}/rest/v1/agents?id=eq.${encodeURIComponent(campaign.agent_id)}&select=${agentFields}&limit=1`
      const agentRes    = await fetch(agentUrl, { headers })

      if (agentRes.ok) {
        const agentData = await agentRes.json()
        agent = agentData?.[0] || null
      } else {
        console.warn('[campaign-landing] agent fetch failed', agentRes.status)
      }
    }

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600')
    return res.status(200).json({ campaign, agent })
  } catch (err) {
    console.error('[campaign-landing] error', err)
    return res.status(500).json({ error: err.message })
  }
}
