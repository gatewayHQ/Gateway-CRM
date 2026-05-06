// Wraps a Vercel serverless handler with shared CORS headers, OPTIONS handling,
// and optional x-gateway-secret authentication.
//
// Usage:
//   import { withMiddleware } from './_lib/middleware.js'
//   export default withMiddleware(async (req, res) => { ... })
//   export default withMiddleware(async (req, res) => { ... }, { methods: ['GET'] })

export function withMiddleware(handler, { methods = ['POST'] } = {}) {
  return async function (req, res) {
    res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || 'https://gatewayhq.github.io')
    res.setHeader('Access-Control-Allow-Methods', [...methods, 'OPTIONS'].join(', '))
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gateway-secret')

    if (req.method === 'OPTIONS') return res.status(200).end()

    if (!methods.includes(req.method)) {
      return res.status(405).json({ error: 'Method not allowed' })
    }

    const secret = req.headers['x-gateway-secret']
    if (process.env.GATEWAY_SECRET && secret !== process.env.GATEWAY_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    return handler(req, res)
  }
}
