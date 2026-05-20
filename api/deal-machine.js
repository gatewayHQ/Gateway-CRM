/**
 * Gateway CRM — Deal Machine proxy
 *
 * Wraps the Deal Machine REST API so the browser never touches
 * DEAL_MACHINE_API_KEY directly.
 *
 * Requires: DEAL_MACHINE_API_KEY in Vercel Environment Variables
 *   → Vercel Dashboard → Project → Settings → Environment Variables
 *   → Get your key: Deal Machine app → Account → Integrations → API
 *
 * POST /api/deal-machine
 *   body: { address: "123 Main St, Oakland CA", radius: 500 }
 *   response: { properties: [...], count: N }
 *
 * Each property in the response:
 *   { owner_name, address_line1, city, state, zip,
 *     property_address, property_type, estimated_value }
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = (process.env.DEAL_MACHINE_API_KEY || '').trim()
  if (!apiKey) {
    return res.status(500).json({
      error: 'DEAL_MACHINE_API_KEY is not configured.',
      setup: true,
    })
  }

  const { address, radius = 500 } = req.body || {}
  if (!address?.trim()) return res.status(400).json({ error: 'address is required' })

  const radiusNum = Math.min(5280, Math.max(100, Number(radius) || 500))

  try {
    // Deal Machine v2 property search
    // Docs: https://developers.dealmachine.com
    const dmRes = await fetch('https://app.dealmachine.com/api/v2/property_list', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        address,
        radius: radiusNum,
        limit: 500,
        include_owner_info: true,
      }),
    })

    const contentType = dmRes.headers.get('content-type') || ''
    if (!dmRes.ok) {
      const body = contentType.includes('json') ? await dmRes.json() : await dmRes.text()
      const msg = typeof body === 'object'
        ? (body.message || body.error || JSON.stringify(body))
        : String(body).slice(0, 300)
      return res.status(dmRes.status).json({ error: `Deal Machine error: ${msg}` })
    }

    const data = await dmRes.json()

    // Deal Machine returns results under various keys depending on endpoint version
    const raw = data.properties || data.results || data.data || data.items || []

    const properties = raw.map(p => {
      // Prefer mailing address over situs address for direct mail
      const ownerFirst = p.owner_first_name || p.mailing_first_name || ''
      const ownerLast  = p.owner_last_name  || p.mailing_last_name  || ''
      const ownerFull  = p.owner_name || p.mailing_name || [ownerFirst, ownerLast].filter(Boolean).join(' ') || null

      return {
        owner_name:       ownerFull,
        address_line1:    p.mailing_street  || p.mailing_address || p.property_street  || p.address || null,
        city:             p.mailing_city    || p.property_city   || p.city    || null,
        state:            p.mailing_state   || p.property_state  || p.state   || null,
        zip:              p.mailing_zip     || p.property_zip    || p.zip     || null,
        property_address: p.property_street || p.property_address || p.address || null,
        property_type:    p.property_type   || p.type            || null,
        estimated_value:  p.estimated_value || p.avm             || p.value   || null,
      }
    }).filter(p => p.owner_name || p.address_line1)

    return res.status(200).json({ properties, count: properties.length })
  } catch (err) {
    return res.status(500).json({ error: `Request failed: ${err.message}` })
  }
}
