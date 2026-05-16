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
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured in Vercel environment variables. Add it under Settings → Environment Variables.' })

  // ── Flyer copy generation (formerly /api/generate-flyer) ──────────────────
  if (req.body?.action === 'generate_flyer' || req.body?.template) {
    const {
      template, campaign_name, property_types, agent_name, brokerage, target_area,
      // Personalization Engine (#6) extras:
      property_address, property_price, property_beds, property_baths, property_sqft,
      contact_name, contact_type, contact_zip, contact_city,
      campaign_response_rate, campaign_sends, best_performing_zip,
      photo_caption, personalization_tone,
    } = req.body || {}

    if (!template || !TEMPLATE_PROMPTS[template]) {
      return res.status(400).json({ error: `Invalid template. Must be one of: ${Object.keys(TEMPLATE_PROMPTS).join(', ')}` })
    }

    const angle       = TEMPLATE_PROMPTS[template]
    const badge       = TEMPLATE_BADGES[template]
    const propTypesStr = Array.isArray(property_types) && property_types.length > 0 ? property_types.join(', ') : 'real estate'

    // Build a rich personalization context block
    const propertyDetails = [
      property_address && `Property: ${property_address}`,
      property_price   && `List Price: $${Number(property_price).toLocaleString()}`,
      (property_beds || property_baths) && `${property_beds||''}bd / ${property_baths||''}ba${property_sqft ? ` · ${Number(property_sqft).toLocaleString()} sqft` : ''}`,
      photo_caption    && `Photo Caption: ${photo_caption}`,
    ].filter(Boolean).join('\n')

    const audienceDetails = [
      contact_name  && `Recipient: ${contact_name}`,
      contact_type  && `Audience Type: ${contact_type}`,
      (contact_city || contact_zip) && `Recipient Area: ${contact_city || ''} ${contact_zip || ''}`.trim(),
    ].filter(Boolean).join('\n')

    const campaignInsights = [
      campaign_sends        && `Campaign Reach: ${campaign_sends} sends so far`,
      campaign_response_rate && `Current Response Rate: ${campaign_response_rate}% (industry avg ~5%)`,
      best_performing_zip   && `Best Performing Zip: ${best_performing_zip}`,
    ].filter(Boolean).join('\n')

    const toneInstruction = personalization_tone === 'urgent'  ? 'Use strong urgency language and FOMO.'
                           : personalization_tone === 'warm'   ? 'Use warm, relationship-focused language. Reference the local community.'
                           : personalization_tone === 'luxury' ? 'Use premium, aspirational language. Emphasize exclusivity and quality.'
                           : personalization_tone === 'data'   ? 'Lead with data points and market statistics. Appeal to analytical buyers/sellers.'
                           : 'Use confident, professional language with a clear value proposition.'

    const prompt = `You are a senior real estate marketing copywriter specializing in high-converting direct mail.

Write compelling postcard copy with this angle: ${angle}
${toneInstruction}

CAMPAIGN CONTEXT:
${campaign_name ? `Campaign: ${campaign_name}` : ''}
Property Types: ${propTypesStr}
${agent_name  ? `Agent: ${agent_name}` : ''}
${brokerage   ? `Brokerage: ${brokerage}` : ''}
${target_area ? `Target Area: ${target_area}` : ''}
${propertyDetails ? `\nPROPERTY DETAILS:\n${propertyDetails}` : ''}
${audienceDetails ? `\nAUDIENCE:\n${audienceDetails}` : ''}
${campaignInsights ? `\nCAMPAIGN PERFORMANCE:\n${campaignInsights}` : ''}

PERSONALIZATION RULES:
- If a property address is provided, mention it or its neighborhood naturally
- If a recipient type is specified, tailor language to their perspective (buyer/seller/investor)
- If campaign data is provided, use it to position the agent as knowledgeable and results-driven
- Be hyper-local and specific — avoid generic real estate clichés

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
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
      })

      if (!anthropicRes.ok) {
        const errData = await anthropicRes.json().catch(() => ({}))
        return res.status(anthropicRes.status).json({ error: errData?.error?.message || `Anthropic API error (HTTP ${anthropicRes.status})` })
      }

      const responseData = await anthropicRes.json()
      const rawText      = responseData?.content?.[0]?.text || ''

      let copy
      try {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/)
        if (!jsonMatch) throw new Error('No JSON object found in response')
        copy = JSON.parse(jsonMatch[0])
      } catch {
        return res.status(500).json({ error: 'Failed to parse AI response as JSON', raw: rawText })
      }

      const required = ['headline', 'subheadline', 'tagline', 'cta', 'bullets']
      for (const field of required) {
        if (!copy[field]) return res.status(500).json({ error: `AI response missing field: ${field}`, raw: rawText })
      }

      return res.status(200).json({ copy, template, badge })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Competitive Intelligence (#15) ──────────────────────────────────────────
  if (req.body?.action === 'competitive_intelligence') {
    const {
      property_types, target_area, campaign_response_rate, campaign_sends,
      flyer_template, top_zip_codes,
    } = req.body || {}

    const propStr = Array.isArray(property_types) ? property_types.join(', ') : (property_types || 'real estate')

    const prompt = `You are a real estate market intelligence analyst specializing in direct mail marketing strategy.

Provide competitive intelligence and positioning advice for an agent running a ${propStr} direct mail campaign${target_area ? ` in ${target_area}` : ''}.

Campaign Context:
${flyer_template  ? `Campaign Type: ${flyer_template}` : ''}
${campaign_sends  ? `Total Sends: ${campaign_sends}` : ''}
${campaign_response_rate ? `Response Rate: ${campaign_response_rate}%` : ''}
${top_zip_codes   ? `Top Zip Codes: ${top_zip_codes}` : ''}

Return a JSON object with:
{
  "market_insights": ["3-4 bullet points about what top-performing agents do in direct mail"],
  "competitive_gaps": ["2-3 common weaknesses agents have in their mailer campaigns"],
  "positioning_tips": ["3 specific ways to differentiate this campaign from competitors"],
  "best_practices": ["3-4 proven best practices for ${propStr} direct mail"],
  "timing_recommendations": "1-2 sentences on optimal send timing and frequency",
  "response_rate_context": "1 sentence contextualizing the current response rate vs market"
}

Be specific, data-driven, and actionable. Focus on real estate direct mail best practices.
Return only the JSON object, no commentary.`

    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
      })
      const responseData = await anthropicRes.json()
      const rawText = responseData?.content?.[0]?.text || ''
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return res.status(500).json({ error: 'Failed to parse AI response', raw: rawText })
      const insights = JSON.parse(jsonMatch[0])
      return res.status(200).json({ insights })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Predictive List Optimization (#19) ───────────────────────────────────────
  if (req.body?.action === 'predict_best_segments') {
    const { zip_detail, by_channel, by_month, total_sends, response_rate } = req.body || {}

    const zipInsights = zip_detail
      ? Object.entries(zip_detail)
          .map(([z, v]) => `${z}: ${v.sends} sends, ${v.responses} responses (${v.sends>0?Math.round(v.responses/v.sends*100):0}%)`)
          .join('\n')
      : ''

    const prompt = `You are a predictive analytics expert for real estate direct mail.

Based on this campaign's performance data, identify which segments to prioritize and which to drop.

Performance Data:
Total Sends: ${total_sends || 0}
Overall Response Rate: ${response_rate || 0}%
${zipInsights ? `\nPer-Zip Performance:\n${zipInsights}` : ''}
${by_channel ? `\nChannel Mix:\n${JSON.stringify(by_channel)}` : ''}

Return a JSON object with:
{
  "top_segments": ["zip codes or segments to double down on, with brief reason"],
  "drop_segments": ["underperforming segments to stop mailing"],
  "recommended_budget_shift": "where to reallocate spend",
  "predicted_roi_improvement": "estimated improvement if recommendations are followed",
  "next_send_strategy": "2-3 sentences on the ideal next campaign strategy"
}

Be specific. Return only the JSON object.`

    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
      })
      const responseData = await anthropicRes.json()
      const rawText = responseData?.content?.[0]?.text || ''
      const jsonMatch = rawText.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return res.status(500).json({ error: 'Failed to parse AI response' })
      const predictions = JSON.parse(jsonMatch[0])
      return res.status(200).json({ predictions })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── General Claude message proxy (email generation, AI suggestions) ────────
  const { system, messages, max_tokens = 1024 } = req.body
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' })
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens, system, messages }),
    })
    const data = await response.json()
    if (!response.ok) {
      const errMsg = data?.error?.message || data?.message || `Anthropic API error (HTTP ${response.status})`
      return res.status(response.status).json({ error: errMsg })
    }
    return res.status(200).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
