// GET /api/gw-buffer-profiles
import { withMiddleware } from './_lib/middleware.js'

export default withMiddleware(async (_req, res) => {
  const token = process.env.BUFFER_ACCESS_TOKEN
  if (!token) return res.status(500).json({ error: 'Buffer token not configured on server' })

  try {
    const response = await fetch('https://api.buffer.com/1/profiles.json', {
      headers: { 'Authorization': 'Bearer ' + token }
    })
    const data = await response.json()
    if (!response.ok) return res.status(response.status).json({ error: data.error || 'Buffer API error' })

    const profiles = (Array.isArray(data) ? data : []).map(p => ({
      id: p.id,
      service: p.service,
      handle: p.formatted_username || p.handle || p.id,
      avatar: p.avatar || '',
      timezone: p.timezone || '',
    }))
    res.status(200).json({ profiles })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}, { methods: ['GET'] })
