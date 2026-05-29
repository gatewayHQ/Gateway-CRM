// ─────────────────────────────────────────────────────────────────────────────
// Client Portal API — GET /api/portal?token=<uuid>
//
// Returns a read-only bundle for one deal: progress checklist, key dates,
// shared documents (signed download URLs), and agent contact info.
//
// Security:
//   • token is an unguessable v4 uuid stored on deals.portal_token
//   • only deals with portal_enabled = true are served
//   • only documents the agent explicitly shared (comp_data.portal_docs) are
//     signed/returned — internal files are never exposed
//   • sensitive deal fields (value, probability, notes) are never returned
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js'

const DOC_BUCKET = 'deal-documents'

// Client-friendly stage labels + ordered funnel for the progress bar
const STAGE_FLOW = ['lead', 'qualified', 'showing', 'offer', 'under-contract', 'closed']
const STAGE_LABELS = {
  lead:             'Getting Started',
  qualified:        'Active Search',
  showing:          'Touring Homes',
  offer:            'Offer Submitted',
  'under-contract': 'Under Contract',
  closed:           'Closed',
  lost:             'On Hold',
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const token = (req.query?.token || '').trim()
  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return res.status(400).json({ error: 'Invalid portal link' })
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co'
  const serviceKey   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey) {
    return res.status(500).json({ error: 'Server misconfigured: set SUPABASE_SERVICE_KEY' })
  }

  const supabase = createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  try {
    // 1. Resolve the deal by token (must be portal-enabled)
    const { data: deal, error: dealErr } = await supabase
      .from('deals')
      .select('id, title, stage, expected_close_date, comp_data, property_id, agent_id, contact_id, portal_enabled')
      .eq('portal_token', token)
      .eq('portal_enabled', true)
      .maybeSingle()

    if (dealErr) return res.status(500).json({ error: 'Database error' })
    if (!deal)   return res.status(404).json({ error: 'This portal link is no longer active.' })

    const comp = deal.comp_data || {}

    // 2. Related records — agent, property, contact greeting (parallel)
    const [agentRes, propRes, contactRes, stepsRes] = await Promise.all([
      deal.agent_id
        ? supabase.from('agents').select('name, initials, role, email, color').eq('id', deal.agent_id).maybeSingle()
        : Promise.resolve({ data: null }),
      deal.property_id
        ? supabase.from('properties').select('address, city, state, zip').eq('id', deal.property_id).maybeSingle()
        : Promise.resolve({ data: null }),
      deal.contact_id
        ? supabase.from('contacts').select('first_name').eq('id', deal.contact_id).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('transaction_steps').select('title, completed, completed_at, sort_order')
        .eq('deal_id', deal.id).order('sort_order', { ascending: true }),
    ])

    // 3. Key dates — only entries that actually have a date set
    const keyDates = (comp.key_dates || [])
      .filter(d => d && d.date)
      .map(d => ({ type: d.type, date: d.date }))

    // 4. Documents — only those the agent explicitly shared
    const sharedNames = Array.isArray(comp.portal_docs) ? comp.portal_docs : []
    let documents = []
    if (sharedNames.length) {
      const paths = sharedNames.map(n => `deal-${deal.id}/${n}`)
      const { data: signed } = await supabase.storage.from(DOC_BUCKET).createSignedUrls(paths, 60 * 30)
      // Map by original index BEFORE filtering so names stay aligned with URLs
      documents = (signed || [])
        .map((s, i) => ({ name: sharedNames[i].replace(/^\d+-/, ''), url: s.signedUrl, ok: s.signedUrl && !s.error }))
        .filter(d => d.ok)
        .map(({ name, url }) => ({ name, url }))
    }

    const steps = stepsRes.data || []
    const doneCount = steps.filter(s => s.completed).length

    const property = propRes.data
    const propertyLabel = property
      ? [property.address, [property.city, property.state].filter(Boolean).join(', '), property.zip]
          .filter(Boolean).join(' · ')
      : null

    res.setHeader('Cache-Control', 'private, no-store')
    return res.status(200).json({
      title: deal.title,
      stage: deal.stage,
      stageLabel: STAGE_LABELS[deal.stage] || deal.stage,
      stageFlow: STAGE_FLOW.map(s => ({ key: s, label: STAGE_LABELS[s], reached: STAGE_FLOW.indexOf(deal.stage) >= STAGE_FLOW.indexOf(s) })),
      isClosed: deal.stage === 'closed',
      expectedCloseDate: deal.expected_close_date,
      property: propertyLabel,
      clientFirstName: contactRes.data?.first_name || null,
      agent: agentRes.data
        ? { name: agentRes.data.name, initials: agentRes.data.initials, role: agentRes.data.role, email: agentRes.data.email, color: agentRes.data.color }
        : null,
      checklist: {
        total: steps.length,
        done: doneCount,
        pct: steps.length ? Math.round((doneCount / steps.length) * 100) : 0,
        steps: steps.map(s => ({ title: s.title, completed: !!s.completed, completedAt: s.completed_at })),
      },
      keyDates,
      documents,
    })
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong loading this portal.' })
  }
}
