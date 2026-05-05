import { createClient } from '@supabase/supabase-js'

function basicAuth(sid, token) {
  return 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { to, body, from, conversationId, agentId } = req.body
  if (!to || !body || !from) return res.status(400).json({ error: 'to, body, and from are required' })

  const SID   = process.env.TWILIO_ACCOUNT_SID
  const TOKEN = process.env.TWILIO_AUTH_TOKEN
  if (!SID || !TOKEN) return res.status(500).json({ error: 'Twilio credentials not configured. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to Vercel env vars.' })

  try {
    const r = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: basicAuth(SID, TOKEN),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ Body: body, From: from, To: to }),
      }
    )
    const data = await r.json()
    if (!r.ok) return res.status(r.status).json({ error: data.message || 'Twilio error' })

    // Persist to Supabase
    if (conversationId) {
      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      )
      await Promise.all([
        supabase.from('messages').insert([{
          conversation_id: conversationId,
          direction: 'outbound',
          body,
          status: data.status || 'sent',
          twilio_sid: data.sid,
          agent_id: agentId || null,
        }]),
        supabase.from('conversations').update({
          last_message_body: body,
          last_message_at: new Date().toISOString(),
        }).eq('id', conversationId),
      ])
    }

    return res.json({ sid: data.sid, status: data.status })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
