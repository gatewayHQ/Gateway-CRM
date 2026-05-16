import { createClient } from '@supabase/supabase-js'

function basicAuth(sid, token) {
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const SID   = process.env.TWILIO_ACCOUNT_SID
  const TOKEN = process.env.TWILIO_AUTH_TOKEN
  if (!SID || !TOKEN) return res.status(500).json({ error: 'Twilio credentials not configured. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to Vercel env vars.' })

  const auth = basicAuth(SID, TOKEN)
  const BASE = `https://api.twilio.com/2010-04-01/Accounts/${SID}`

  // ── Provisioning actions (formerly twilio-provision.js) ──────────────────
  const { action } = req.body || {}

  if (action === 'test') {
    try {
      const r = await fetch(`${BASE}.json`, { headers: { Authorization: auth } })
      const d = await r.json()
      if (!r.ok) return res.status(r.status).json({ error: d.message || 'Invalid credentials' })
      return res.json({ ok: true, friendlyName: d.friendly_name })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  if (action === 'search') {
    try {
      const { areaCode } = req.body
      const qs = new URLSearchParams({ SmsEnabled: 'true', VoiceEnabled: 'false', Limit: '10' })
      if (areaCode) qs.set('AreaCode', String(areaCode).replace(/\D/g, '').slice(0, 3))
      const r = await fetch(`${BASE}/AvailablePhoneNumbers/US/Local.json?${qs}`, { headers: { Authorization: auth } })
      const d = await r.json()
      if (!r.ok) return res.status(r.status).json({ error: d.message })
      return res.json({ numbers: d.available_phone_numbers || [] })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  if (action === 'buy') {
    try {
      const { phoneNumber, friendlyName } = req.body
      if (!phoneNumber) return res.status(400).json({ error: 'phoneNumber required' })
      const proto      = req.headers['x-forwarded-proto'] || 'https'
      const webhookUrl = `${proto}://${req.headers.host}/api/twilio-webhook`
      const r = await fetch(`${BASE}/IncomingPhoneNumbers.json`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ PhoneNumber: phoneNumber, FriendlyName: friendlyName || 'Gateway CRM', SmsUrl: webhookUrl, SmsMethod: 'POST' }),
      })
      const d = await r.json()
      if (!r.ok) return res.status(r.status).json({ error: d.message })
      return res.json({ number: d.phone_number, sid: d.sid })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  if (action === 'list') {
    try {
      const r = await fetch(`${BASE}/IncomingPhoneNumbers.json?PageSize=50`, { headers: { Authorization: auth } })
      const d = await r.json()
      if (!r.ok) return res.status(r.status).json({ error: d.message })
      return res.json({
        numbers: (d.incoming_phone_numbers || []).map(n => ({
          sid: n.sid, phoneNumber: n.phone_number, friendlyName: n.friendly_name, smsUrl: n.sms_url,
        })),
      })
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // ── Send SMS (original twilio-send behaviour) ─────────────────────────────
  const { to, body, from, conversationId, agentId } = req.body
  if (!to || !body || !from) return res.status(400).json({ error: 'to, body, and from are required' })

  try {
    const r = await fetch(`${BASE}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Body: body, From: from, To: to }),
    })
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Twilio error' })

    if (conversationId) {
      const supabase = createClient(
        (process.env.SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''),
        process.env.SUPABASE_SERVICE_KEY || ''
      )
      await Promise.all([
        supabase.from('messages').insert([{
          conversation_id: conversationId, direction: 'outbound', body,
          status: data.status || 'sent', twilio_sid: data.sid, agent_id: agentId || null,
        }]),
        supabase.from('conversations').update({
          last_message_body: body, last_message_at: new Date().toISOString(),
        }).eq('id', conversationId),
      ])
    }

    return res.json({ sid: data.sid, status: data.status })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
