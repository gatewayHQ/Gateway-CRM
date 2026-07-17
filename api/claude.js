import { requireAgent } from './_lib/auth.js'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Require a verified agent — otherwise this is an open, uncapped LLM proxy
  // billed to the brokerage's Anthropic key.
  try { await requireAgent(req) }
  catch (e) { return res.status(e.status || 401).json({ error: e.message || 'Sign in required' }) }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured in Vercel environment variables. Add it under Settings → Environment Variables.' })

  const { system, messages } = req.body
  // Clamp caller-supplied token budget to bound per-request cost.
  const max_tokens = Math.min(Math.max(Number(req.body?.max_tokens) || 1024, 1), 4096)
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' })
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens,
        system,
        messages,
      }),
    })
    const data = await response.json()
    if (!response.ok) {
      // Normalize Anthropic's nested error object into a flat string so the
      // client can display it directly without hitting [object Object].
      const errMsg = data?.error?.message || data?.message || `Anthropic API error (HTTP ${response.status})`
      return res.status(response.status).json({ error: errMsg })
    }
    return res.status(200).json(data)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
