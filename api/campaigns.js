import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

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
      const { data, error } = await supabase
        .from('mail_campaigns')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error

      // Attach per-campaign send/response counts
      const ids = data.map(c => c.id)
      let counts = {}
      if (ids.length > 0) {
        const { data: sends } = await supabase
          .from('mail_sends')
          .select('campaign_id, response')
          .in('campaign_id', ids)
        ;(sends || []).forEach(s => {
          if (!counts[s.campaign_id]) counts[s.campaign_id] = { total: 0, responses: 0 }
          counts[s.campaign_id].total++
          if (s.response !== 'no-response') counts[s.campaign_id].responses++
        })
      }
      const enriched = data.map(c => ({
        ...c,
        total_sends:     counts[c.id]?.total     || 0,
        total_responses: counts[c.id]?.responses || 0,
      }))
      return res.json({ campaigns: enriched })
    }

    if (action === 'create_campaign') {
      const {
        name, description, property_types, status, flyer_url, frequency_cap, frequency_days,
        flyer_template, landing_mode, landing_url, landing_headline, landing_tagline, landing_cta,
        date_sent, date_completed, cost_per_piece, fixed_cost,
      } = req.body
      const agent_id = req.body.agent_id || null
      if (!name) return res.status(400).json({ error: 'name is required' })
      // Generate unique 8-char tracking code
      const code = [...Array(8)].map(() => 'abcdefghjkmnpqrstuvwxyz23456789'[Math.floor(Math.random()*31)]).join('')
      const { data, error } = await supabase
        .from('mail_campaigns')
        .insert([{
          name, description, property_types,
          status:         status         || 'active',
          agent_id,
          flyer_url,
          frequency_cap:  frequency_cap  || 0,
          frequency_days: frequency_days || 30,
          tracking_code:  code,
          flyer_template: flyer_template || null,
          landing_mode:   landing_mode   || 'external',
          landing_url:    landing_url    || null,
          landing_headline: landing_headline || null,
          landing_tagline:  landing_tagline  || null,
          landing_cta:      landing_cta      || 'Schedule a Call',
          date_sent:        date_sent        || null,
          date_completed:   date_completed   || null,
          cost_per_piece:   cost_per_piece   || 0,
          fixed_cost:       fixed_cost       || 0,
        }])
        .select()
        .single()
      if (error) throw error
      return res.json({ campaign: data })
    }

    if (action === 'update_campaign') {
      const { id, ...patch } = req.body
      if (!id) return res.status(400).json({ error: 'id is required' })
      delete patch.action
      const { data, error } = await supabase
        .from('mail_campaigns')
        .update(patch)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      return res.json({ campaign: data })
    }

    if (action === 'delete_campaign') {
      const { id } = req.body
      if (!id) return res.status(400).json({ error: 'id is required' })
      const { error } = await supabase.from('mail_campaigns').delete().eq('id', id)
      if (error) throw error
      return res.json({ ok: true })
    }

    // ── Sends ──────────────────────────────────────────────────────────────

    if (action === 'list_sends') {
      const { campaign_id, contact_id, limit: lim = 200 } = req.query
      let q = supabase.from('mail_sends').select('*').order('sent_at', { ascending: false }).limit(Number(lim))
      if (campaign_id) q = q.eq('campaign_id', campaign_id)
      if (contact_id)  q = q.eq('contact_id', contact_id)
      const { data, error } = await q
      if (error) throw error
      return res.json({ sends: data })
    }

    if (action === 'log_send') {
      const { campaign_id, contact_id, cold_lead_id, recipient_name, recipient_address,
              recipient_city, recipient_state, recipient_zip,
              channel, sent_at, response, notes } = req.body
      const agent_id = req.body.agent_id || null
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' })

      // Suppression check
      if (contact_id) {
        const { data: sup } = await supabase
          .from('mail_suppressions')
          .select('id, reason')
          .eq('contact_id', contact_id)
          .limit(1)
        if (sup?.length > 0) {
          return res.status(409).json({ error: `Suppressed: ${sup[0].reason}`, suppressed: true })
        }
      }

      // Frequency cap check
      const { data: camp } = await supabase
        .from('mail_campaigns')
        .select('frequency_cap, frequency_days')
        .eq('id', campaign_id)
        .single()
      if (camp?.frequency_cap > 0 && contact_id) {
        const since = new Date(Date.now() - camp.frequency_days * 86400000).toISOString()
        const { count } = await supabase
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

      const { data, error } = await supabase
        .from('mail_sends')
        .insert([{ campaign_id, contact_id, cold_lead_id, recipient_name, recipient_address,
                   recipient_city, recipient_state, recipient_zip,
                   channel: channel || 'mail', sent_at: sent_at || new Date().toISOString(),
                   agent_id, response: response || 'no-response', notes }])
        .select()
        .single()
      if (error) throw error

      // Auto-create follow-up task when marked interested
      if (response === 'interested' && contact_id && agent_id) {
        await supabase.from('tasks').insert([{
          title: `Follow up — interested lead from campaign`,
          type: 'follow-up', priority: 'high',
          due_date: new Date(Date.now() + 86400000).toISOString(),
          contact_id, agent_id,
          notes: `Responded to mail campaign. Notes: ${notes || ''}`,
        }])
      }

      return res.json({ send: data })
    }

    if (action === 'update_send') {
      const { id, ...patch } = req.body
      if (!id) return res.status(400).json({ error: 'id is required' })
      delete patch.action
      if (patch.response && !patch.responded_at) patch.responded_at = new Date().toISOString()
      const { data, error } = await supabase
        .from('mail_sends')
        .update(patch)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      return res.json({ send: data })
    }

    if (action === 'delete_send') {
      const { id } = req.body
      if (!id) return res.status(400).json({ error: 'id is required' })
      const { error } = await supabase.from('mail_sends').delete().eq('id', id)
      if (error) throw error
      return res.json({ ok: true })
    }

    // ── Recipient history (how many times a contact has been sent to) ────

    if (action === 'contact_history') {
      const { contact_id } = req.query
      if (!contact_id) return res.status(400).json({ error: 'contact_id is required' })
      const { data, error } = await supabase
        .from('mail_sends')
        .select('*, mail_campaigns(name, property_types)')
        .eq('contact_id', contact_id)
        .order('sent_at', { ascending: false })
      if (error) throw error
      return res.json({ history: data, total_sends: data.length })
    }

    // ── Batch log sends (one campaign → list of contacts/addresses) ──────

    if (action === 'batch_log') {
      const { campaign_id, recipients, channel, sent_at, agent_id } = req.body
      if (!campaign_id || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: 'campaign_id and recipients[] are required' })
      }
      const rows = recipients.map(r => ({
        campaign_id,
        contact_id:       r.contact_id       || null,
        cold_lead_id:     r.cold_lead_id     || null,
        recipient_name:   r.recipient_name   || null,
        recipient_address:r.recipient_address|| null,
        recipient_city:   r.recipient_city   || null,
        recipient_state:  r.recipient_state  || null,
        recipient_zip:    r.recipient_zip    || null,
        channel:          channel  || 'mail',
        sent_at:          sent_at  || new Date().toISOString(),
        agent_id:         agent_id || null,
        response: 'no-response',
      }))
      const { data, error } = await supabase.from('mail_sends').insert(rows).select()
      if (error) throw error
      return res.json({ sends: data, count: data.length })
    }

    // ── Suppressions ───────────────────────────────────────────────────────

    if (action === 'list_suppressions') {
      const { data, error } = await supabase
        .from('mail_suppressions')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      return res.json({ suppressions: data })
    }

    if (action === 'add_suppression') {
      const { address, email, phone, full_name, reason, contact_id, notes } = req.body
      const agent_id = req.body.agent_id || null
      const { data, error } = await supabase
        .from('mail_suppressions')
        .insert([{ address, email, phone, full_name, reason: reason || 'dnc', contact_id, agent_id, notes }])
        .select()
        .single()
      if (error) throw error
      return res.json({ suppression: data })
    }

    if (action === 'remove_suppression') {
      const { id } = req.body
      const { error } = await supabase.from('mail_suppressions').delete().eq('id', id)
      if (error) throw error
      return res.json({ ok: true })
    }

    // ── Analytics ─────────────────────────────────────────────────────────

    if (action === 'campaign_analytics') {
      const { campaign_id } = req.query
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' })

      const { data: sends } = await supabase
        .from('mail_sends')
        .select('channel, response, sent_at, recipient_zip')
        .eq('campaign_id', campaign_id)

      if (!sends) return res.json({ analytics: {} })

      const byChannel = {}
      const byResponse = {}
      const byZip = {}
      const byMonth = {}

      for (const s of sends) {
        byChannel[s.channel]   = (byChannel[s.channel]   || 0) + 1
        byResponse[s.response] = (byResponse[s.response] || 0) + 1
        if (s.recipient_zip) byZip[s.recipient_zip] = (byZip[s.recipient_zip] || 0) + 1
        const mo = s.sent_at?.slice(0, 7)
        if (mo) byMonth[mo] = (byMonth[mo] || 0) + 1
      }

      const total    = sends.length
      const responded = sends.filter(s => s.response !== 'no-response').length
      const converted = sends.filter(s => s.response === 'converted').length

      return res.json({
        analytics: {
          total,
          responded,
          converted,
          response_rate: total > 0 ? Math.round(responded / total * 100) : 0,
          conversion_rate: total > 0 ? Math.round(converted / total * 100) : 0,
          by_channel:  byChannel,
          by_response: byResponse,
          by_zip:      byZip,
          by_month:    byMonth,
        },
      })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    console.error('[campaigns]', err)
    return res.status(500).json({ error: err.message })
  }
}
