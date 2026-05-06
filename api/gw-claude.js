// POST /api/gw-claude
// Body: { system?: string, user: string, max_tokens?: number, model?: string }
import { withMiddleware } from './_lib/middleware.js'

export default withMiddleware(async (req, res) => {
  const { system, user, max_tokens, model } = req.body || {}
  if (!user) return res.status(400).json({ error: 'Missing user prompt' })

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-6',
        max_tokens: max_tokens || 1000,
        system: system || '',
        messages: [{ role: 'user', content: user }],
      }),
    })
    const data = await response.json()
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Claude API error' })
    res.status(200).json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
