// POST /api/buffer  — create Buffer updates
// GET  /api/buffer  — return connected Buffer profiles
// Both keep the access token server-side.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  process.env.ALLOWED_ORIGIN || 'https://gatewayhq.github.io',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-gateway-secret',
}

function checkAuth(req, res) {
  const secret = req.headers['x-gateway-secret']
  if (process.env.GATEWAY_SECRET && secret !== process.env.GATEWAY_SECRET) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}

export default async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (!checkAuth(req, res)) return

  const token = process.env.BUFFER_ACCESS_TOKEN
  if (!token) return res.status(500).json({ error: 'Buffer token not configured on server' })

  // ── GET /api/buffer — list connected profiles ────────────────────────────
  if (req.method === 'GET') {
    try {
      const response = await fetch('https://api.buffer.com/1/profiles.json', {
        headers: { Authorization: 'Bearer ' + token },
      })
      const data = await response.json()
      if (!response.ok) return res.status(response.status).json({ error: data.error || 'Buffer API error' })
      const profiles = (Array.isArray(data) ? data : []).map(p => ({
        id:       p.id,
        service:  p.service,
        handle:   p.formatted_username || p.handle || p.id,
        avatar:   p.avatar || '',
        timezone: p.timezone || '',
      }))
      return res.status(200).json({ profiles })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── POST /api/buffer — create updates ────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { profileIds, text, mediaUrl, scheduledAt } = req.body || {}
  if (!profileIds?.length || !text) {
    return res.status(400).json({ error: 'Missing profileIds or text' })
  }

  const results = []
  const errors  = []

  for (const profileId of profileIds) {
    try {
      const params = new URLSearchParams({ text, 'profile_ids[]': profileId })
      if (scheduledAt) params.append('scheduled_at', scheduledAt)
      if (mediaUrl)    params.append('media[link]', mediaUrl)

      const response = await fetch('https://api.buffer.com/1/updates/create.json', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })
      const data = await response.json()
      if (!response.ok || data.error) {
        errors.push({ profileId, error: data.error || `HTTP ${response.status}` })
      } else {
        results.push({ profileId, updateId: data.updates?.[0]?.id || data.id })
      }
    } catch (err) {
      errors.push({ profileId, error: err.message })
    }
  }

  return res.status(200).json({ results, errors, success: errors.length === 0 })
}
