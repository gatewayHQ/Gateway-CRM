// GET /api/gw-health
// Returns service status — useful for uptime checks and env var validation.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://gatewayhq.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gateway-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = req.headers['x-gateway-secret'];
  if (process.env.GATEWAY_SECRET && secret !== process.env.GATEWAY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.status(200).json({
    ok: true,
    services: {
      claude: !!process.env.CLAUDE_API_KEY,
      buffer: !!process.env.BUFFER_ACCESS_TOKEN
    },
    version: '1.0.0'
  });
};
