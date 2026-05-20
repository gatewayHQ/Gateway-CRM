import { createClient } from '@supabase/supabase-js'

// Lazy singleton — resolved at first request so cold-start env vars are always
// present. Module-level createClient(undefined, undefined) produces the
// "Invalid path specified in request URL" error when SUPABASE_URL is missing.
let _supabase = null
function getSupabase() {
  if (_supabase) return _supabase
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY env vars are not set')
  _supabase = createClient(url, key)
  return _supabase
}

// Extract missing column name from Supabase/PostgREST/Postgres errors.
// Returns the column name or null if the error isn't a missing-column error.
function extractMissingColumn(msg) {
  if (!msg) return null
  // PostgREST: "Could not find the 'foo' column of 'mail_campaigns' in the schema cache"
  let m = msg.match(/Could not find the ['"]?([a-z_][a-z0-9_]*)['"]? column/i)
  if (m) return m[1]
  // Postgres: column "foo" of relation "..." does not exist
  m = msg.match(/column ["']?([a-z_][a-z0-9_]*)["']? of relation/i)
  if (m) return m[1]
  // Postgres alt: column "foo" does not exist
  m = msg.match(/column ["']?([a-z_][a-z0-9_]*)["']? does not exist/i)
  if (m) return m[1]
  return null
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { action } = req.body || req.query

  try {
    // ── Campaigns ─────────────────────────────────────────────────────────

    if (action === 'list_campaigns') {
      const { data, error } = await getSupabase()
        .from('mail_campaigns')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error

      const ids = data.map(c => c.id)
      let counts = {}
      if (ids.length > 0) {
        const { data: sends } = await getSupabase()
          .from('mail_sends')
          .select('campaign_id, response, sent_at')
          .in('campaign_id', ids)
          .order('sent_at', { ascending: false })
        ;(sends || []).forEach(s => {
          if (!counts[s.campaign_id]) counts[s.campaign_id] = { total: 0, responses: 0, last_at: null }
          counts[s.campaign_id].total++
          if (s.response !== 'no-response') counts[s.campaign_id].responses++
          if (!counts[s.campaign_id].last_at) counts[s.campaign_id].last_at = s.sent_at
        })
      }
      const enriched = data.map(c => ({
        ...c,
        total_sends:     counts[c.id]?.total     || 0,
        total_responses: counts[c.id]?.responses || 0,
        last_send_at:    counts[c.id]?.last_at   || null,
      }))
      return res.json({ campaigns: enriched })
    }

    if (action === 'create_campaign') {
      const {
        name, description, property_types, status, agent_id,
        property_id, qr_target,
        tracking_url, frequency_cap, frequency_days,
        channel, email_subject, email_body,
      } = req.body
      if (!name) return res.status(400).json({ error: 'name is required' })

      // Build payload — retry without optional columns if schema is missing them
      const CORE = {
        name,
        description:    description    || null,
        property_types: property_types || [],
        status:         status         || 'active',
        agent_id:       agent_id       || null,
        property_id:    property_id    || null,
        qr_target:      qr_target      || 'crm_landing',
        tracking_url:   tracking_url   || null,
        frequency_cap:  frequency_cap  || 0,
        frequency_days: frequency_days || 30,
      }
      const OPTIONAL = {
        channel:       channel       || 'mail',
        email_subject: email_subject || null,
        email_body:    email_body    || null,
      }

      let payload = { ...CORE, ...OPTIONAL }
      let { data, error } = await getSupabase().from('mail_campaigns').insert([payload]).select().single()

      // If a column doesn't exist in the user's schema, drop it and retry
      let attempts = 0
      while (error && attempts++ < 12) {
        const badCol = extractMissingColumn(error.message)
        if (!badCol || !(badCol in payload)) break
        delete payload[badCol]
        ;({ data, error } = await getSupabase().from('mail_campaigns').insert([payload]).select().single())
      }
      if (error) throw error
      return res.json({ campaign: data })
    }

    if (action === 'update_campaign') {
      const { id } = req.body
      if (!id) return res.status(400).json({ error: 'id is required' })
      const ALLOWED = [
        'name','description','property_types','status','agent_id',
        'property_id','qr_target',
        'tracking_url','qr_code_url','bitly_id',
        'frequency_cap','frequency_days',
        'channel','email_subject','email_body',
      ]
      const patch = {}
      for (const key of ALLOWED) {
        if (Object.prototype.hasOwnProperty.call(req.body, key)) patch[key] = req.body[key]
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'no updatable fields provided' })

      let working = { ...patch }
      let { data, error } = await getSupabase().from('mail_campaigns').update(working).eq('id', id).select().single()
      let attempts = 0
      while (error && attempts++ < 12) {
        const badCol = extractMissingColumn(error.message)
        if (!badCol || !(badCol in working)) break
        delete working[badCol]
        if (Object.keys(working).length === 0) break
        ;({ data, error } = await getSupabase().from('mail_campaigns').update(working).eq('id', id).select().single())
      }
      if (error) throw error
      return res.json({ campaign: data })
    }

    if (action === 'delete_campaign') {
      const { id } = req.body
      if (!id) return res.status(400).json({ error: 'id is required' })
      const { error } = await getSupabase().from('mail_campaigns').delete().eq('id', id)
      if (error) throw error
      return res.json({ ok: true })
    }

    // ── Sends ──────────────────────────────────────────────────────────────

    if (action === 'list_sends') {
      const { campaign_id, contact_id, limit: lim = 500 } = req.query
      let q = getSupabase().from('mail_sends').select('*').order('sent_at', { ascending: false }).limit(Number(lim))
      if (campaign_id) q = q.eq('campaign_id', campaign_id)
      if (contact_id)  q = q.eq('contact_id', contact_id)
      const { data, error } = await q
      if (error) throw error
      return res.json({ sends: data })
    }

    if (action === 'log_send') {
      const { campaign_id, contact_id, cold_lead_id, recipient_name, recipient_address,
              recipient_city, recipient_state, recipient_zip,
              channel, sent_at, agent_id, response, notes } = req.body
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' })

      // Suppression check
      if (contact_id) {
        const { data: sup } = await getSupabase()
          .from('mail_suppressions')
          .select('id, reason')
          .eq('contact_id', contact_id)
          .limit(1)
        if (sup?.length > 0) {
          return res.status(409).json({ error: `Suppressed: ${sup[0].reason}`, suppressed: true })
        }
      }

      // Frequency cap check
      const { data: camp } = await getSupabase()
        .from('mail_campaigns')
        .select('frequency_cap, frequency_days')
        .eq('id', campaign_id)
        .single()
      if (camp?.frequency_cap > 0 && contact_id) {
        const since = new Date(Date.now() - camp.frequency_days * 86400000).toISOString()
        const { count } = await getSupabase()
          .from('mail_sends')
          .select('*', { count: 'exact', head: true })
          .eq('campaign_id', campaign_id)
          .eq('contact_id', contact_id)
          .gte('sent_at', since)
        if ((count || 0) >= camp.frequency_cap) {
          return res.status(409).json({
            error: `Frequency cap reached: already sent ${count} times in ${camp.frequency_days} days`,
            capped: true,
          })
        }
      }

      const { data, error } = await getSupabase()
        .from('mail_sends')
        .insert([{ campaign_id, contact_id, cold_lead_id, recipient_name, recipient_address,
                   recipient_city, recipient_state, recipient_zip,
                   channel: channel || 'mail', sent_at: sent_at || new Date().toISOString(),
                   agent_id, response: response || 'no-response', notes }])
        .select()
        .single()
      if (error) throw error

      if (response === 'interested' && contact_id && agent_id) {
        await getSupabase().from('tasks').insert([{
          title: `Follow up — interested lead from campaign`,
          type: 'follow-up', priority: 'high',
          due_date: new Date(Date.now() + 86400000).toISOString(),
          contact_id, agent_id,
          notes: `Responded to campaign outreach. Notes: ${notes || ''}`,
        }])
      }

      return res.json({ send: data })
    }

    if (action === 'update_send') {
      const { id, ...patch } = req.body
      if (!id) return res.status(400).json({ error: 'id is required' })
      delete patch.action
      const SEND_ALLOWED = ['response', 'notes', 'channel', 'sent_at', 'agent_id']
      const cleanPatch = {}
      for (const k of SEND_ALLOWED) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) cleanPatch[k] = patch[k]
      }
      if (cleanPatch.response && cleanPatch.response !== 'no-response') {
        cleanPatch.responded_at = new Date().toISOString()
      }
      const { data, error } = await getSupabase()
        .from('mail_sends')
        .update(cleanPatch)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error

      if (patch.response === 'interested' && patch.contact_id && patch.agent_id) {
        await getSupabase().from('tasks').insert([{
          title: `Follow up — interested lead from campaign`,
          type: 'follow-up', priority: 'high',
          due_date: new Date(Date.now() + 86400000).toISOString(),
          contact_id: patch.contact_id, agent_id: patch.agent_id,
        }])
      }

      return res.json({ send: data })
    }

    if (action === 'delete_send') {
      const { id } = req.body
      if (!id) return res.status(400).json({ error: 'id is required' })
      const { error } = await getSupabase().from('mail_sends').delete().eq('id', id)
      if (error) throw error
      return res.json({ ok: true })
    }

    // ── Contact campaign history ──────────────────────────────────────────

    if (action === 'contact_history') {
      const { contact_id } = req.query
      if (!contact_id) return res.status(400).json({ error: 'contact_id is required' })
      const { data, error } = await getSupabase()
        .from('mail_sends')
        .select('*, mail_campaigns(name, property_types, channel)')
        .eq('contact_id', contact_id)
        .order('sent_at', { ascending: false })
      if (error) throw error
      return res.json({ history: data, total_sends: data.length })
    }

    // ── Batch log ─────────────────────────────────────────────────────────

    if (action === 'batch_log') {
      const { campaign_id, recipients, channel, sent_at, agent_id } = req.body
      if (!campaign_id || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: 'campaign_id and recipients[] are required' })
      }

      // Suppress check for all contact_ids
      const contactIds = recipients.filter(r => r.contact_id).map(r => r.contact_id)
      let suppressedIds = new Set()
      if (contactIds.length > 0) {
        const { data: sups } = await getSupabase()
          .from('mail_suppressions')
          .select('contact_id')
          .in('contact_id', contactIds)
        ;(sups || []).forEach(s => suppressedIds.add(s.contact_id))
      }

      const now = sent_at || new Date().toISOString()
      const rows = recipients
        .filter(r => !r.contact_id || !suppressedIds.has(r.contact_id))
        .map(r => ({
          campaign_id,
          contact_id:        r.contact_id        || null,
          cold_lead_id:      r.cold_lead_id      || null,
          recipient_name:    r.recipient_name    || null,
          recipient_address: r.recipient_address || null,
          recipient_city:    r.recipient_city    || null,
          recipient_state:   r.recipient_state   || null,
          recipient_zip:     r.recipient_zip     || null,
          channel:           channel  || 'mail',
          sent_at:           now,
          agent_id:          agent_id || null,
          response:          'no-response',
        }))

      if (rows.length === 0) return res.json({ sends: [], count: 0, skipped: suppressedIds.size })

      const { data, error } = await getSupabase().from('mail_sends').insert(rows).select()
      if (error) throw error
      return res.json({ sends: data, count: data.length, skipped: suppressedIds.size })
    }

    // ── Email blast via Resend ────────────────────────────────────────────

    if (action === 'send_email_blast') {
      const { campaign_id, contact_ids, subject, body, agent_id, sent_at } = req.body
      if (!campaign_id || !Array.isArray(contact_ids) || !subject || !body) {
        return res.status(400).json({ error: 'campaign_id, contact_ids, subject, and body are required' })
      }

      const RESEND_KEY = process.env.RESEND_API_KEY
      const FROM       = process.env.RESEND_FROM || 'noreply@example.com'
      if (!RESEND_KEY) return res.status(500).json({ error: 'Email not configured — add RESEND_API_KEY to your environment variables' })

      const { data: camp } = await getSupabase()
        .from('mail_campaigns')
        .select('frequency_cap, frequency_days, name')
        .eq('id', campaign_id)
        .single()

      const { data: contacts } = await getSupabase()
        .from('contacts')
        .select('id, first_name, last_name, email')
        .in('id', contact_ids)

      if (!contacts?.length) return res.status(400).json({ error: 'No valid contacts found' })

      // Get all suppressed contact_ids
      const { data: sups } = await getSupabase()
        .from('mail_suppressions')
        .select('contact_id')
        .in('contact_id', contact_ids)
      const suppressedIds = new Set((sups || []).map(s => s.contact_id))

      const results = { sent: 0, skipped: 0, errors: [] }
      const sentRows = []
      const now = sent_at || new Date().toISOString()

      const applyMerge = (text, c) =>
        text
          .replace(/\{\{first_name\}\}/g, c.first_name || '')
          .replace(/\{\{last_name\}\}/g,  c.last_name  || '')
          .replace(/\{\{full_name\}\}/g,  `${c.first_name || ''} ${c.last_name || ''}`.trim())

      for (const contact of contacts) {
        if (!contact.email)             { results.skipped++; continue }
        if (suppressedIds.has(contact.id)) { results.skipped++; continue }

        // Frequency cap
        if (camp?.frequency_cap > 0) {
          const since = new Date(Date.now() - camp.frequency_days * 86400000).toISOString()
          const { count } = await getSupabase()
            .from('mail_sends')
            .select('*', { count: 'exact', head: true })
            .eq('campaign_id', campaign_id)
            .eq('contact_id', contact.id)
            .gte('sent_at', since)
          if ((count || 0) >= camp.frequency_cap) { results.skipped++; continue }
        }

        const mergedSubject = applyMerge(subject, contact)
        const mergedHtml    = applyMerge(body, contact).replace(/\n/g, '<br>')

        try {
          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: FROM, to: [contact.email], subject: mergedSubject, html: mergedHtml }),
          })
          if (!emailRes.ok) {
            const err = await emailRes.json()
            results.errors.push({ contact_id: contact.id, error: err.message || 'Send failed' })
            results.skipped++
            continue
          }
        } catch (e) {
          results.errors.push({ contact_id: contact.id, error: e.message })
          results.skipped++
          continue
        }

        sentRows.push({ campaign_id, contact_id: contact.id, channel: 'email', sent_at: now, agent_id: agent_id || null, response: 'no-response' })
        results.sent++
      }

      if (sentRows.length > 0) {
        const { error: insErr } = await getSupabase().from('mail_sends').insert(sentRows)
        if (insErr) console.error('[send_email_blast] insert error', insErr)
      }

      return res.json(results)
    }

    // ── Suppressions ───────────────────────────────────────────────────────

    if (action === 'list_suppressions') {
      const { data, error } = await getSupabase()
        .from('mail_suppressions')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      return res.json({ suppressions: data })
    }

    if (action === 'add_suppression') {
      const { address, email, phone, full_name, reason, contact_id, agent_id, notes } = req.body
      const { data, error } = await getSupabase()
        .from('mail_suppressions')
        .insert([{ address, email, phone, full_name, reason: reason || 'dnc', contact_id, agent_id, notes }])
        .select()
        .single()
      if (error) throw error
      return res.json({ suppression: data })
    }

    if (action === 'remove_suppression') {
      const { id } = req.body
      const { error } = await getSupabase().from('mail_suppressions').delete().eq('id', id)
      if (error) throw error
      return res.json({ ok: true })
    }

    // ── Analytics ─────────────────────────────────────────────────────────

    if (action === 'campaign_analytics') {
      const { campaign_id } = req.query
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' })

      const { data: sends } = await getSupabase()
        .from('mail_sends')
        .select('channel, response, sent_at, recipient_zip, agent_id')
        .eq('campaign_id', campaign_id)

      if (!sends) return res.json({ analytics: {} })

      const byChannel  = {}
      const byResponse = {}
      const byZip      = {}
      const byMonth    = {}
      const byAgent    = {}

      for (const s of sends) {
        byChannel[s.channel]   = (byChannel[s.channel]   || 0) + 1
        byResponse[s.response] = (byResponse[s.response] || 0) + 1
        if (s.recipient_zip) byZip[s.recipient_zip] = (byZip[s.recipient_zip] || 0) + 1
        const mo = s.sent_at?.slice(0, 7)
        if (mo) byMonth[mo] = (byMonth[mo] || 0) + 1
        if (s.agent_id) byAgent[s.agent_id] = (byAgent[s.agent_id] || 0) + 1
      }

      const total     = sends.length
      const responded = sends.filter(s => s.response !== 'no-response').length
      const converted = sends.filter(s => s.response === 'converted').length
      const interested = sends.filter(s => s.response === 'interested').length

      return res.json({
        analytics: {
          total, responded, converted, interested,
          response_rate:   total > 0 ? Math.round(responded  / total * 100) : 0,
          conversion_rate: total > 0 ? Math.round(converted  / total * 100) : 0,
          interest_rate:   total > 0 ? Math.round(interested / total * 100) : 0,
          by_channel:  byChannel,
          by_response: byResponse,
          by_zip:      byZip,
          by_month:    byMonth,
          by_agent:    byAgent,
        },
      })
    }

    // ── Generate QR code via Bitly ────────────────────────────────────────

    if (action === 'generate_qr') {
      const { campaign_id } = req.body
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' })

      const { data: camp, error: campErr } = await getSupabase()
        .from('mail_campaigns')
        .select('id, name, property_id, qr_target, tracking_url')
        .eq('id', campaign_id)
        .single()
      if (campErr) throw campErr

      const BITLY_TOKEN = process.env.BITLY_ACCESS_TOKEN
      if (!BITLY_TOKEN) return res.status(500).json({ error: 'Bitly not configured (missing BITLY_ACCESS_TOKEN)' })

      const proto   = req.headers['x-forwarded-proto'] || 'https'
      const host    = req.headers.host
      const baseUrl = `${proto}://${host}`

      let longUrl
      if (camp.qr_target === 'crm_landing' && camp.property_id) {
        longUrl = `${baseUrl}/listing/${camp.property_id}`
      } else if (camp.qr_target === 'custom_url' && camp.tracking_url) {
        longUrl = camp.tracking_url
      } else {
        longUrl = `${baseUrl}/listing`
      }

      const linkRes = await fetch('https://api-ssl.bitly.com/v4/shorten', {
        method: 'POST',
        headers: { Authorization: `Bearer ${BITLY_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ long_url: longUrl, title: camp.name }),
      })
      const linkData = await linkRes.json()
      if (!linkRes.ok) throw new Error(linkData.message || 'Bitly link creation failed')

      const shortUrl = linkData.link
      const bitlyId  = linkData.id

      const qrRes = await fetch(`https://api-ssl.bitly.com/v4/bitlinks/${bitlyId}/qr`, {
        headers: { Authorization: `Bearer ${BITLY_TOKEN}` },
      })
      const qrData    = await qrRes.json()
      const qrCodeUrl = qrRes.ok ? (qrData.qr_code || qrData.link || null) : null

      const { data: updated, error: updateErr } = await getSupabase()
        .from('mail_campaigns')
        .update({ tracking_url: shortUrl, bitly_id: bitlyId, qr_code_url: qrCodeUrl })
        .eq('id', campaign_id)
        .select()
        .single()
      if (updateErr) throw updateErr

      return res.json({ campaign: updated })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    console.error('[campaigns]', err)
    return res.status(500).json({ error: err.message })
  }
}
