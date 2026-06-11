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

  // Co-hosted endpoint (Vercel Hobby caps the repo at 12 functions):
  // GET /api/portal?action=my-earnings — the signed-in agent's own commission
  // slices, computed server-side. See handleMyEarnings below.
  if (req.query?.action === 'my-earnings') return handleMyEarnings(req, res)

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

// ─────────────────────────────────────────────────────────────────────────────
// My Earnings — GET /api/portal?action=my-earnings[&deal_id=<uuid>]
//
// Commissions are ADMIN-ONLY at the database level (back office, 2026-06-12):
// an agent cannot read raw commission rows, because each row contains every
// participant's split. This endpoint is the privacy boundary: it verifies the
// caller's Supabase JWT, loads commissions with the SERVICE key, computes the
// caller's slice per deal with the same engine the admin tracker uses
// (src/lib/commission.js), and returns ONLY the caller's numbers — partner
// splits never leave the server.
//
// Response: { agent_id, cap: {amount, anniversary, window_start, prepaid,
//             ytd_cap_paid, ytd_fees, capped}, ytd: {take, deals},
//             deals: [{deal_id, title, stage, value, closed_at, take, cap,
//                      fees, split_pct, gross, closed}] }
// ─────────────────────────────────────────────────────────────────────────────
import { agentSliceForDeal, capWindowStart } from '../src/lib/commission.js'

async function handleMyEarnings(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co'
  const serviceKey   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey      = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY
  if (!serviceKey) return res.status(500).json({ error: 'Server misconfigured' })

  // 1. Verify the caller: their JWT must resolve to a real Supabase user.
  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!jwt) return res.status(401).json({ error: 'Sign in required' })
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: anonKey || serviceKey, Authorization: `Bearer ${jwt}` },
  })
  if (!userRes.ok) return res.status(401).json({ error: 'Invalid session' })
  const user = await userRes.json()
  if (!user?.id) return res.status(401).json({ error: 'Invalid session' })

  const svc = createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  try {
    // 2. Resolve the agent for this auth user.
    const { data: me } = await svc.from('agents')
      .select('id, name, cap_amount, cap_anniversary, no_brokerage_split')
      .eq('auth_id', user.id).maybeSingle()
    if (!me) return res.status(403).json({ error: 'No agent profile for this account' })

    // 3. Load context. Deals where the caller is owner, legacy co-agent, or a
    //    commission participant — everything else is filtered out below anyway.
    const dealFilter = req.query?.deal_id ? { col: 'id', val: req.query.deal_id } : null
    let dealQuery = svc.from('deals').select('id, title, stage, value, probability, agent_id, co_agent_ids, expected_close_date, updated_at, created_at, comp_data')
    if (dealFilter) dealQuery = dealQuery.eq(dealFilter.col, dealFilter.val)
    const [{ data: deals }, { data: commissions }, { data: agents }] = await Promise.all([
      dealQuery,
      svc.from('commissions').select('*'),
      svc.from('agents').select('id, name, default_split_pct, no_brokerage_split'),
    ])

    const commByDeal = new Map((commissions || []).map(c => [c.deal_id, c]))
    const windowStart = capWindowStart(me.cap_anniversary)

    const rows = []
    let ytdTake = 0, ytdCapPaid = 0, ytdFees = 0, ytdDeals = 0
    for (const deal of deals || []) {
      const slice = agentSliceForDeal(deal, commByDeal.get(deal.id), agents || [], me.id)
      if (!slice.onDeal || (slice.take === 0 && slice.cap === 0 && slice.fees === 0 && deal.agent_id !== me.id)) continue
      const closed = deal.stage === 'closed'
      const closedAt = deal.updated_at || deal.created_at
      rows.push({
        deal_id: deal.id, title: deal.title, stage: deal.stage,
        value: deal.value, closed, closed_at: closed ? closedAt : null,
        take: slice.take, cap: slice.cap, fees: slice.fees,
        split_pct: slice.splitPct, gross: slice.gross,
      })
      if (closed && new Date(closedAt) >= windowStart) {
        ytdTake += slice.take; ytdCapPaid += slice.cap; ytdFees += slice.fees; ytdDeals += 1
      }
    }
    rows.sort((a, b) => new Date(b.closed_at || '2999') - new Date(a.closed_at || '2999'))

    const capAmount = me.cap_amount != null ? Number(me.cap_amount) : null
    return res.status(200).json({
      agent_id: me.id,
      cap: {
        amount: capAmount,
        anniversary: me.cap_anniversary,
        window_start: windowStart.toISOString().slice(0, 10),
        prepaid: !!me.no_brokerage_split,
        ytd_cap_paid: Math.round(ytdCapPaid * 100) / 100,
        ytd_fees: Math.round(ytdFees * 100) / 100,
        capped: !!me.no_brokerage_split || (capAmount != null && ytdCapPaid >= capAmount),
      },
      ytd: { take: Math.round(ytdTake * 100) / 100, deals: ytdDeals },
      deals: rows,
    })
  } catch (e) {
    console.error('[my-earnings]', e)
    return res.status(500).json({ error: 'Could not compute earnings' })
  }
}
