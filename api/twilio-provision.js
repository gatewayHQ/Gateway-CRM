function basicAuth(sid, token) {
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const SID   = process.env.TWILIO_ACCOUNT_SID
  const TOKEN = process.env.TWILIO_AUTH_TOKEN
  if (!SID || !TOKEN) return res.status(500).json({ error: 'Twilio credentials not configured' })

  const auth = basicAuth(SID, TOKEN)
  const BASE = `https://api.twilio.com/2010-04-01/Accounts/${SID}`
  const { action, areaCode, phoneNumber, friendlyName } = req.body || {}

  try {
    // ── Test credentials ──────────────────────────────────────────────────────
    if (action === 'test') {
      const r = await fetch(`${BASE}.json`, { headers: { Authorization: auth } })
      const d = await r.json()
      if (!r.ok) return res.status(r.status).json({ error: d.message || 'Invalid credentials' })
      return res.json({ ok: true, friendlyName: d.friendly_name })
    }

    // ── Search available numbers ───────────────────────────────────────────────
    if (action === 'search') {
      const qs = new URLSearchParams({ SmsEnabled: 'true', VoiceEnabled: 'false', Limit: '10' })
      if (areaCode) qs.set('AreaCode', String(areaCode).replace(/\D/g, '').slice(0, 3))
      const r = await fetch(`${BASE}/AvailablePhoneNumbers/US/Local.json?${qs}`, { headers: { Authorization: auth } })
      const d = await r.json()
      if (!r.ok) return res.status(r.status).json({ error: d.message })
      return res.json({ numbers: d.available_phone_numbers || [] })
    }

    // ── Buy (provision) a number ───────────────────────────────────────────────
    if (action === 'buy') {
      if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' })
      const proto      = req.headers['x-forwarded-proto'] || 'https'
      const webhookUrl = `${proto}://${req.headers.host}/api/twilio-webhook`
      const r = await fetch(`${BASE}/IncomingPhoneNumbers.json`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          PhoneNumber:    phoneNumber,
          FriendlyName:  friendlyName || 'Gateway CRM',
          SmsUrl:        webhookUrl,
          SmsMethod:     'POST',
        }),
      })
      const d = await r.json()
      if (!r.ok) return res.status(r.status).json({ error: d.message })
      return res.json({ number: d.phone_number, sid: d.sid })
    }

    // ── List purchased numbers ────────────────────────────────────────────────
    if (action === 'list') {
      const r = await fetch(`${BASE}/IncomingPhoneNumbers.json?PageSize=50`, { headers: { Authorization: auth } })
      const d = await r.json()
      if (!r.ok) return res.status(r.status).json({ error: d.message })
      return res.json({
        numbers: (d.incoming_phone_numbers || []).map(n => ({
          sid:          n.sid,
          phoneNumber:  n.phone_number,
          friendlyName: n.friendly_name,
          smsUrl:       n.sms_url,
        })),
      })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
