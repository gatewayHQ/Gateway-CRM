// POST /api/buffer
// Proxies Buffer update creation — no CORS issues, token stays server-side.
// Body: { profileIds: string[], text: string, mediaUrl?: string, scheduledAt?: string }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://gatewayhq.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gateway-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-gateway-secret'];
  if (process.env.GATEWAY_SECRET && secret !== process.env.GATEWAY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { profileIds, text, mediaUrl, scheduledAt } = req.body || {};
  if (!profileIds?.length || !text) {
    return res.status(400).json({ error: 'Missing profileIds or text' });
  }

  const token = process.env.BUFFER_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'Buffer token not configured on server' });

  const results = [];
  const errors  = [];

  for (const profileId of profileIds) {
    try {
      const params = new URLSearchParams({ text, 'profile_ids[]': profileId });
      if (scheduledAt) params.append('scheduled_at', scheduledAt);

      // Media — Buffer v1 wants a media[link] parameter for link attachments
      if (mediaUrl) params.append('media[link]', mediaUrl);

      const response = await fetch('https://api.buffer.com/1/updates/create.json', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params.toString()
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        errors.push({ profileId, error: data.error || `HTTP ${response.status}` });
      } else {
        results.push({ profileId, updateId: data.updates?.[0]?.id || data.id });
      }
    } catch (err) {
      errors.push({ profileId, error: err.message });
    }
  }

  res.status(200).json({ results, errors, success: errors.length === 0 });
}
