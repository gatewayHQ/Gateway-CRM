import { createClient } from '@supabase/supabase-js'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function detectDevice(ua = '') {
  const s = ua.toLowerCase()
  if (/tablet|ipad|playbook|silk|(android(?!.*mobile))/i.test(s)) return 'tablet'
  if (/mobile|iphone|ipod|android|blackberry|opera mini|iemobile|wpdesktop/i.test(s)) return 'mobile'
  return 'desktop'
}

function notFoundPage(code) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Link Not Found</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center;
           min-height: 100vh; margin: 0; background: #f8f9fa; }
    .card { text-align: center; padding: 40px; max-width: 380px; }
    h1 { font-size: 24px; color: #1e2642; margin-bottom: 8px; }
    p  { color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Link Not Found</h1>
    <p>The QR code link <code>${code}</code> is not associated with any active campaign.</p>
    <p style="margin-top:24px;font-size:12px;color:#9aa3b2">Gateway CRM</p>
  </div>
</body>
</html>`
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).end('Method Not Allowed')

  const code = (req.query.c || '').trim()

  // Validate code format
  if (!code || !/^[a-z0-9]{6,12}$/i.test(code)) {
    res.setHeader('Cache-Control', 'no-store')
    return res.status(400).send(notFoundPage(code || '(empty)'))
  }

  const supabase = createClient(
    (process.env.SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''),
    process.env.SUPABASE_SERVICE_KEY || ''
  )

  // Look up campaign by tracking code
  let campaign
  try {
    const { data, error } = await supabase
      .from('mail_campaigns')
      .select('id, name, landing_mode, landing_url, tracking_code')
      .eq('tracking_code', code)
      .single()

    if (error || !data) {
      res.setHeader('Cache-Control', 'no-store')
      return res.status(404).send(notFoundPage(code))
    }
    campaign = data
  } catch (err) {
    console.error('[track] lookup error', err)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(500).send(notFoundPage(code))
  }

  // Fire-and-forget scan log (do NOT await — don't delay the redirect)
  const ua         = req.headers['user-agent'] || ''
  const deviceType = detectDevice(ua)
  const ip         = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim()
  const referrer   = req.headers['referer'] || req.headers['referrer'] || null

  supabase
    .from('campaign_scans')
    .insert([{
      campaign_id: campaign.id,
      ip_address:  ip || null,
      user_agent:  ua || null,
      device_type: deviceType,
      referrer:    referrer,
    }])
    .then(({ error: scanErr }) => {
      if (scanErr) console.error('[track] scan insert error', scanErr.message)
    })

  // Determine redirect destination
  const destination = campaign.landing_mode === 'external' && campaign.landing_url
    ? campaign.landing_url
    : `/campaign/${campaign.tracking_code}`

  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Location', destination)
  return res.status(302).end()
}
