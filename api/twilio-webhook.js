import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

// Disable Vercel's automatic body parser — we need the raw body for signature validation
export const config = { api: { bodyParser: false } }

function validateSignature(authToken, signature, url, params) {
  const keys = Object.keys(params).sort()
  let s = url
  for (const k of keys) s += k + (params[k] ?? '')
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(s)).digest('base64')
  return expected === signature
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed')
    return
  }

  const raw    = await readRawBody(req)
  const params = Object.fromEntries(new URLSearchParams(raw))

  // Validate Twilio signature (skipped only if auth token not yet configured)
  const TOKEN = process.env.TWILIO_AUTH_TOKEN
  if (TOKEN) {
    const sig   = req.headers['x-twilio-signature'] || ''
    const proto = req.headers['x-forwarded-proto'] || 'https'
    const url   = `${proto}://${req.headers.host}/api/twilio-webhook`
    if (!validateSignature(TOKEN, sig, url, params)) {
      res.status(403).send('Forbidden')
      return
    }
  }

  const { From, To, Body, MessageSid } = params
  if (!From || !To || !Body) {
    res.setHeader('Content-Type', 'text/xml')
    res.send(EMPTY_TWIML)
    return
  }

  const supabase = createClient(
    (process.env.SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, ''),
    process.env.SUPABASE_SERVICE_KEY || ''
  )

  // Find existing conversation for this number pair
  const { data: existing } = await supabase
    .from('conversations')
    .select('id, unread_count')
    .eq('twilio_number', To)
    .eq('contact_number', From)
    .maybeSingle()

  let convId

  if (existing) {
    convId = existing.id
    await supabase.from('conversations').update({
      last_message_body: Body,
      last_message_at:   new Date().toISOString(),
      unread_count:      (existing.unread_count || 0) + 1,
    }).eq('id', existing.id)
  } else {
    // Try to match by phone number (handle formatting variants)
    const digits = From.replace(/\D/g, '')
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, assigned_agent_id')
      .or(`phone.ilike.%${digits.slice(-10)}%`)
      .maybeSingle()

    // Find the agent who owns this Twilio number
    const { data: agent } = await supabase
      .from('agents')
      .select('id')
      .eq('twilio_number', To)
      .maybeSingle()

    const { data: newConv } = await supabase
      .from('conversations')
      .insert([{
        contact_id:        contact?.id || null,
        agent_id:          agent?.id || contact?.assigned_agent_id || null,
        twilio_number:     To,
        contact_number:    From,
        contact_name:      contact
          ? `${contact.first_name} ${contact.last_name}`
          : From,
        last_message_body: Body,
        last_message_at:   new Date().toISOString(),
        unread_count:      1,
      }])
      .select('id')
      .single()

    convId = newConv?.id
  }

  if (convId) {
    await supabase.from('messages').insert([{
      conversation_id: convId,
      direction:       'inbound',
      body:            Body,
      status:          'received',
      twilio_sid:      MessageSid,
    }])
  }

  // Return empty TwiML — Twilio requires a valid XML response
  res.setHeader('Content-Type', 'text/xml')
  res.send(EMPTY_TWIML)
}
