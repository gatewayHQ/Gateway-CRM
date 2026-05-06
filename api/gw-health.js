// GET /api/gw-health
import { withMiddleware } from './_lib/middleware.js'

export default withMiddleware(async (_req, res) => {
  res.status(200).json({
    ok: true,
    services: {
      claude: !!process.env.CLAUDE_API_KEY,
      buffer: !!process.env.BUFFER_ACCESS_TOKEN,
    },
    version: '1.0.0',
  })
}, { methods: ['GET'] })
