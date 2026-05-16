import { createClient } from '@supabase/supabase-js'

const _rawUrl      = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co'
// Strip accidental /rest/v1 suffix or trailing slashes (avoids PGRST107 double-path)
const SUPABASE_URL = _rawUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '')
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || ''

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { action } = req.body?.action ? req.body : req.query

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
        property_id, flyer_photo_urls, flyer_photo_caption,
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
          flyer_url:      flyer_url      || null,
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
          property_id:      property_id      || null,
          flyer_photo_urls: Array.isArray(flyer_photo_urls) ? flyer_photo_urls : [],
          flyer_photo_caption: flyer_photo_caption || null,
        }])
        .select()
        .single()
      if (error) throw error
      return res.json({ campaign: data })
    }

    if (action === 'update_campaign') {
      const { id, ...raw } = req.body
      if (!id) return res.status(400).json({ error: 'id is required' })
      // Strip action + read-only columns that must never be overwritten via patch
      const { action: _a, tracking_code, qr_code_url, bitly_id,
              total_sends, total_responses, created_at, ...patch } = raw
      // Coerce empty strings to null for typed columns
      if (patch.agent_id    === '') patch.agent_id    = null
      if (patch.date_sent   === '') patch.date_sent   = null
      if (patch.date_completed === '') patch.date_completed = null
      if (patch.flyer_template  === '') patch.flyer_template  = null
      if (patch.landing_url     === '') patch.landing_url     = null
      if (patch.landing_headline === '') patch.landing_headline = null
      if (patch.landing_tagline  === '') patch.landing_tagline  = null
      if (patch.landing_cta      === '') patch.landing_cta      = null
      if (patch.flyer_url        === '') patch.flyer_url        = null
      if (patch.canva_design_url === '') patch.canva_design_url = null
      if (patch.property_id      === '') patch.property_id      = null
      if (patch.flyer_photo_caption === '') patch.flyer_photo_caption = null
      if (!Array.isArray(patch.flyer_photo_urls) && patch.flyer_photo_urls !== undefined) {
        patch.flyer_photo_urls = []
      }
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

    // ── Property Photos (Implementation #2) ───────────────────────────────

    if (action === 'get_property_photos') {
      const { property_id } = req.query
      if (!property_id) return res.status(400).json({ error: 'property_id is required' })
      const { data, error } = await supabase
        .from('properties')
        .select('id, address, city, state, zip, type, status, list_price, details')
        .eq('id', property_id)
        .single()
      if (error) throw error
      if (!data) return res.status(404).json({ error: 'Property not found' })
      const photos = data.details?.photos || []
      return res.json({ property: data, photos })
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

    // ── ROI Attribution (Implementation #4) ───────────────────────────────────

    if (action === 'campaign_roi') {
      const { campaign_id } = req.query
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' })

      const { data: camp } = await supabase
        .from('mail_campaigns')
        .select('id, cost_per_piece, fixed_cost, commission_rate, attribution_window_days, created_at, total_sends')
        .eq('id', campaign_id)
        .single()
      if (!camp) return res.status(404).json({ error: 'Campaign not found' })

      const commissionRate = camp.commission_rate       || 0.025
      const windowDays     = camp.attribution_window_days || 180
      const windowStart    = new Date(camp.created_at).toISOString()
      const totalSpend     = ((camp.total_sends || 0) * (camp.cost_per_piece || 0)) + (camp.fixed_cost || 0)

      // Collect contact IDs + explicitly linked deal IDs from sends
      const { data: sends } = await supabase
        .from('mail_sends')
        .select('contact_id, deal_id')
        .eq('campaign_id', campaign_id)
      const contactIds     = [...new Set((sends || []).map(s => s.contact_id).filter(Boolean))]
      const explicitDealIds = [...new Set((sends || []).map(s => s.deal_id).filter(Boolean))]

      let deals = []

      // 1. Explicitly linked deals
      if (explicitDealIds.length > 0) {
        const { data: explicit } = await supabase
          .from('deals')
          .select('id, title, value, sold_price, stage, contact_id, created_at')
          .in('id', explicitDealIds)
        deals.push(...(explicit || []).map(d => ({ ...d, attribution: 'explicit' })))
      }

      // 2. Inferred: same contact, closed deal, within attribution window
      if (contactIds.length > 0) {
        const { data: inferred } = await supabase
          .from('deals')
          .select('id, title, value, sold_price, stage, contact_id, created_at')
          .in('contact_id', contactIds)
          .eq('stage', 'closed')
          .gte('created_at', windowStart)
        const explSet = new Set(explicitDealIds)
        deals.push(...(inferred || []).filter(d => !explSet.has(d.id)).map(d => ({ ...d, attribution: 'inferred' })))
      }

      // Dedup by deal id
      const seen = new Set()
      deals = deals.filter(d => { if (seen.has(d.id)) return false; seen.add(d.id); return true })

      const totalDealValue      = deals.reduce((n, d) => n + (d.sold_price || d.value || 0), 0)
      const estimatedCommission = totalDealValue * commissionRate
      const roiPct              = totalSpend > 0 ? Math.round((estimatedCommission - totalSpend) / totalSpend * 100) : null

      return res.json({
        roi: {
          total_spend:            Math.round(totalSpend * 100) / 100,
          total_deal_value:       Math.round(totalDealValue * 100) / 100,
          estimated_commission:   Math.round(estimatedCommission * 100) / 100,
          deal_count:             deals.length,
          roi_pct:                roiPct,
          commission_rate:        commissionRate,
          attribution_window_days: windowDays,
          attributed_deals:       deals,
        }
      })
    }

    if (action === 'link_deal') {
      const { send_id, deal_id } = req.body
      if (!send_id) return res.status(400).json({ error: 'send_id is required' })
      const { data, error } = await supabase
        .from('mail_sends')
        .update({ deal_id: deal_id || null })
        .eq('id', send_id)
        .select()
        .single()
      if (error) throw error
      return res.json({ send: data })
    }

    // ── A/B Testing ────────────────────────────────────────────────────────

    if (action === 'create_ab_variant') {
      const { campaign_id } = req.body
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' })

      const { data: orig, error: fetchErr } = await supabase
        .from('mail_campaigns')
        .select('*')
        .eq('id', campaign_id)
        .single()
      if (fetchErr || !orig) return res.status(404).json({ error: 'Campaign not found' })

      // Mark original as A
      await supabase.from('mail_campaigns')
        .update({ is_ab_test: true, ab_variant: 'A' })
        .eq('id', campaign_id)

      // Clone as B
      const { id: _id, created_at: _ca, ab_winning_variant: _awv, ab_concluded_at: _aca, ...cloneFields } = orig
      const { data: variant, error: cloneErr } = await supabase
        .from('mail_campaigns')
        .insert({
          ...cloneFields,
          name:                 `${orig.name} — Variant B`,
          is_ab_test:           true,
          ab_variant:           'B',
          ab_parent_campaign_id: campaign_id,
          status:               'draft',
        })
        .select()
        .single()
      if (cloneErr) throw cloneErr
      return res.json({ variant })
    }

    if (action === 'get_ab_comparison') {
      const { campaign_id } = req.query
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' })

      const { data: campaign } = await supabase.from('mail_campaigns').select('*').eq('id', campaign_id).single()
      if (!campaign) return res.status(404).json({ error: 'Campaign not found' })

      // Determine parent and variant IDs
      const parentId  = campaign.ab_parent_campaign_id || campaign.id
      const variantId = campaign.ab_parent_campaign_id ? campaign.id : null

      const { data: allCampaigns } = await supabase
        .from('mail_campaigns').select('*')
        .or(`id.eq.${parentId}${variantId ? `,id.eq.${variantId}` : `,ab_parent_campaign_id.eq.${parentId}`}`)

      const ids = (allCampaigns || []).map(c => c.id)
      const { data: sends } = await supabase
        .from('mail_sends').select('campaign_id, response').in('campaign_id', ids)

      const stats = {}
      for (const c of (allCampaigns || [])) {
        const cs = (sends || []).filter(s => s.campaign_id === c.id)
        const total     = cs.length
        const responded = cs.filter(s => s.response !== 'no-response').length
        const converted = cs.filter(s => s.response === 'converted').length
        stats[c.ab_variant || (c.id === parentId ? 'A' : 'B')] = {
          campaign: c,
          total,
          responded,
          converted,
          response_rate:   total > 0 ? Math.round(responded / total * 100) : 0,
          conversion_rate: total > 0 ? Math.round(converted / total * 100) : 0,
        }
      }
      return res.json({ comparison: stats, parent_id: parentId })
    }

    if (action === 'declare_ab_winner') {
      const { campaign_id, winner } = req.body
      if (!campaign_id || !winner) return res.status(400).json({ error: 'campaign_id and winner (A|B) are required' })

      const { data, error } = await supabase
        .from('mail_campaigns')
        .update({ ab_winning_variant: winner, ab_concluded_at: new Date().toISOString() })
        .or(`id.eq.${campaign_id},ab_parent_campaign_id.eq.${campaign_id}`)
        .select()
      if (error) throw error
      return res.json({ ok: true, updated: data })
    }

    // ── Smart Audience Builder ────────────────────────────────────────────

    if (action === 'audience_preview') {
      const { types, statuses, zip_codes, cities, states, tags, asset_types, sources, days_since_contact, assigned_agent_id } = req.method === 'POST' ? req.body : req.query

      let query = supabase
        .from('contacts')
        .select('id, first_name, last_name, email, phone, type, status, source, owner_address, owner_city, owner_state, owner_zip, tags, asset_types, last_contacted_at, assigned_agent_id')
        .order('last_contacted_at', { ascending: true, nullsFirst: true })
        .limit(500)

      const parseArr = v => {
        if (!v) return null
        if (Array.isArray(v)) return v.filter(Boolean)
        if (typeof v === 'string') return v.split(',').map(s => s.trim()).filter(Boolean)
        return null
      }

      const typesArr   = parseArr(types)
      const statusArr  = parseArr(statuses)
      const zipArr     = parseArr(zip_codes)
      const cityArr    = parseArr(cities)
      const stateArr   = parseArr(states)
      const tagsArr    = parseArr(tags)
      const assetArr   = parseArr(asset_types)
      const sourceArr  = parseArr(sources)

      if (typesArr?.length)   query = query.in('type', typesArr)
      if (statusArr?.length)  query = query.in('status', statusArr)
      if (zipArr?.length)     query = query.in('owner_zip', zipArr)
      if (cityArr?.length)    query = query.in('owner_city', cityArr)
      if (stateArr?.length)   query = query.in('owner_state', stateArr)
      if (sourceArr?.length)  query = query.in('source', sourceArr)
      if (assigned_agent_id)  query = query.eq('assigned_agent_id', assigned_agent_id)

      if (tagsArr?.length) {
        query = query.overlaps('tags', tagsArr)
      }
      if (assetArr?.length) {
        query = query.overlaps('asset_types', assetArr)
      }
      if (days_since_contact) {
        const cutoff = new Date(Date.now() - parseInt(days_since_contact) * 86400000).toISOString()
        query = query.or(`last_contacted_at.lte.${cutoff},last_contacted_at.is.null`)
      }

      const { data: contacts, error } = await query
      if (error) throw error
      return res.json({ contacts: contacts || [], count: (contacts || []).length })
    }

    if (action === 'bulk_log_sends') {
      const { campaign_id, contact_ids, channel, agent_id, notes, sent_at } = req.body
      if (!campaign_id || !contact_ids?.length) {
        return res.status(400).json({ error: 'campaign_id and contact_ids are required' })
      }

      // Fetch contact addresses for the sends
      const { data: contacts } = await supabase
        .from('contacts')
        .select('id, first_name, last_name, owner_address, owner_city, owner_state, owner_zip')
        .in('id', contact_ids)

      const contactMap = {}
      ;(contacts || []).forEach(c => { contactMap[c.id] = c })

      const rows = contact_ids.map(cid => {
        const c = contactMap[cid] || {}
        return {
          campaign_id,
          contact_id:         cid,
          channel:            channel || 'direct-mail',
          agent_id:           agent_id || null,
          recipient_name:     [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
          recipient_address:  c.owner_address || null,
          recipient_city:     c.owner_city    || null,
          recipient_state:    c.owner_state   || null,
          recipient_zip:      c.owner_zip     || null,
          response:           'no-response',
          notes:              notes || null,
          sent_at:            sent_at || new Date().toISOString(),
        }
      })

      const { data: inserted, error } = await supabase
        .from('mail_sends')
        .insert(rows)
        .select()
      if (error) throw error
      return res.json({ sends: inserted || [], count: (inserted || []).length })
    }

    // ── Budget & Cost Items ────────────────────────────────────────────────

    if (action === 'list_cost_items') {
      const { campaign_id } = req.query
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' })
      const { data, error } = await supabase
        .from('campaign_cost_items')
        .select('*')
        .eq('campaign_id', campaign_id)
        .order('date_incurred', { ascending: false })
      if (error) throw error
      return res.json({ items: data || [] })
    }

    if (action === 'add_cost_item') {
      const { campaign_id, category, description, unit_cost, quantity, date_incurred } = req.body
      if (!campaign_id) return res.status(400).json({ error: 'campaign_id is required' })
      const { data, error } = await supabase
        .from('campaign_cost_items')
        .insert({
          campaign_id,
          category:      category || 'other',
          description:   description || null,
          unit_cost:     parseFloat(unit_cost) || 0,
          quantity:      parseInt(quantity) || 1,
          date_incurred: date_incurred || null,
        })
        .select()
        .single()
      if (error) throw error
      return res.json({ item: data })
    }

    if (action === 'delete_cost_item') {
      const { id } = req.body
      if (!id) return res.status(400).json({ error: 'id is required' })
      const { error } = await supabase.from('campaign_cost_items').delete().eq('id', id)
      if (error) throw error
      return res.json({ ok: true })
    }

    if (action === 'list_deals') {
      const { data: deals, error } = await supabase
        .from('deals')
        .select('id, address, city, state, stage, value, contact_id')
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) throw error
      return res.json({ deals: deals || [] })
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
