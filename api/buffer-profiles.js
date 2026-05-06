// GET /api/buffer-profiles
// Returns the connected Buffer profiles for the configured account.
// All agents see the same profiles — shared brokerage Buffer account.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://gatewayhq.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gateway-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-gateway-secret'];
  if (process.env.GATEWAY_SECRET && secret !== process.env.GATEWAY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'Buffer token not configured on server' });

  try {
    const response = await fetch('https://api.buffer.com/1/profiles.json', {
      headers: { 'Authorization': 'Bearer ' + token }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || 'Buffer API error' });
    }

    // Return only the fields the toolkit needs
    const profiles = (Array.isArray(data) ? data : []).map(p => ({
      id:       p.id,
      service:  p.service,
      handle:   p.formatted_username || p.handle || p.id,
      avatar:   p.avatar || '',
      timezone: p.timezone || ''
    }));

    res.status(200).json({ profiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
