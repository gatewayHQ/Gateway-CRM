const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const TEMPLATE_PROMPTS = {
  just_listed:     'New property on market, attract buyers, urgency + opportunity angle',
  just_sold:       'Recent sale, demonstrate track record, credibility + momentum angle',
  buyers_waiting:  'Qualified buyers looking in area, target sellers, urgency + guaranteed sale',
  exclusive_offer: 'Off-market opportunity, exclusivity + FOMO angle',
  market_update:   'Share market data, local expert positioning, expertise + value-add',
  sellers_wanted:  'Agent/client wants to buy in area, direct acquisition + cash offer',
}

const TEMPLATE_BADGES = {
  just_listed:     'Just Listed',
  just_sold:       'Just Sold',
  buyers_waiting:  'Buyers Wanted',
  exclusive_offer: 'Exclusive Off-Market',
  market_update:   'Market Update',
  sellers_wanted:  'Sellers Wanted',
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' })
  }

  const { template, campaign_name, property_types, agent_name, brokerage, target_area } = req.body || {}

  if (!template || !TEMPLATE_PROMPTS[template]) {
    return res.status(400).json({ error: `Invalid template. Must be one of: ${Object.keys(TEMPLATE_PROMPTS).join(', ')}` })
  }

  const angle       = TEMPLATE_PROMPTS[template]
  const badge       = TEMPLATE_BADGES[template]
  const propTypesStr = Array.isArray(property_types) && property_types.length > 0
    ? property_types.join(', ')
    : 'real estate'
  const agentStr    = agent_name ? `Agent: ${agent_name}` : ''
  const brokerStr   = brokerage  ? `Brokerage: ${brokerage}` : ''
  const areaStr     = target_area ? `Target Area: ${target_area}` : ''
  const campStr     = campaign_name ? `Campaign: ${campaign_name}` : ''

  const prompt = `You are a real estate marketing copywriter for direct mail postcards and flyers.

Write compelling marketing copy for a real estate postcard with this angle: ${angle}

Context:
${campStr}
Property Types: ${propTypesStr}
${agentStr}
${brokerStr}
${areaStr}

Return ONLY valid JSON with exactly these fields:
{
  "headline": "ALL CAPS, punchy, max 10 words",
  "subheadline": "Title Case, max 15 words",
  "tagline": "2-3 sentences, benefit-focused, speak directly to the recipient",
  "cta": "4-6 words call to action",
  "bullets": ["short phrase 1", "short phrase 2", "short phrase 3"]
}

Rules:
- headline must be ALL CAPS
- No quotation marks inside the strings
- bullets are short, punchy phrases (under 8 words each)
- Be specific and benefit-driven, not generic
- Do not include your own commentary, only the JSON object`

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 600,
        messages: [
          { role: 'user', content: prompt }
        ],
      }),
    })

    if (!anthropicRes.ok) {
      const errData = await anthropicRes.json().catch(() => ({}))
      const errMsg  = errData?.error?.message || `Anthropic API error (HTTP ${anthropicRes.status})`
      return res.status(anthropicRes.status).json({ error: errMsg })
    }

    const responseData = await anthropicRes.json()
    const rawText      = responseData?.content?.[0]?.text || ''

    // Parse JSON from response — strip markdown code blocks if present
    let copy
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      if (!jsonMatch) throw new Error('No JSON object found in response')
      copy = JSON.parse(jsonMatch[0])
    } catch (parseErr) {
      console.error('[generate-flyer] JSON parse error', parseErr.message, rawText)
      return res.status(500).json({ error: 'Failed to parse AI response as JSON', raw: rawText })
    }

    // Validate expected fields
    const required = ['headline', 'subheadline', 'tagline', 'cta', 'bullets']
    for (const field of required) {
      if (!copy[field]) {
        return res.status(500).json({ error: `AI response missing field: ${field}`, raw: rawText })
      }
    }

    return res.status(200).json({ copy, template, badge })
  } catch (err) {
    console.error('[generate-flyer] error', err)
    return res.status(500).json({ error: err.message })
  }
}
