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
  // Co-hosted authenticated endpoints (Vercel Hobby caps the repo at 12
  // functions, so profile management lives here rather than in its own file).
  // These are the SECURE profile routes: every write goes through requireAgent()
  // and an explicit self-or-admin authorization check. See handleProfile below.
  if (req.method === 'POST' && (req.body?.action || '').startsWith('profile-')) {
    return handleProfile(req, res)
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Co-hosted endpoint (Vercel Hobby caps the repo at 12 functions):
  // GET /api/portal?action=my-earnings — the signed-in agent's own commission
  // slices, computed server-side. See handleMyEarnings below.
  if (req.query?.action === 'my-earnings') return handleMyEarnings(req, res)
  // GET /api/portal?token=<>&action=sign-link&documentId=<>&signerEmail=<>
  // Mints a BoldSign embedded-signing URL for a client signing in the portal.
  if (req.query?.action === 'sign-link') return handlePortalSignLink(req, res)

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

    // 4b. Pending signature documents for this deal (client can sign in-portal).
    const { data: sigAll } = await supabase
      .from('boldsign_documents')
      .select('document_id, document_name, status, signer_email')
      .eq('deal_id', deal.id)
      .order('created_at', { ascending: false })
    const signatureDocs = (sigAll || [])
      .filter(d => !['completed', 'voided'].includes(d.status))
      .map(d => ({
        documentId: d.document_id,
        name:       (d.document_name || 'Document').replace(/\.pdf$/i, ''),
        status:     d.status,
        signers:    String(d.signer_email || '').split(',').map(s => s.trim()).filter(Boolean),
      }))

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
      signatureDocs,
    })
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong loading this portal.' })
  }
}

// ─── Embedded signing from the portal ─────────────────────────────────────────
// Validates the portal token → deal, confirms the document belongs to that deal
// and the email is one of its signers, then mints a BoldSign embedded-sign URL.
async function handlePortalSignLink(req, res) {
  const token       = (req.query?.token || '').trim()
  const documentId  = (req.query?.documentId || '').trim()
  const signerEmail = (req.query?.signerEmail || '').trim().toLowerCase()
  if (!/^[0-9a-f-]{36}$/i.test(token)) return res.status(400).json({ error: 'Invalid portal link' })
  if (!documentId || !signerEmail)     return res.status(400).json({ error: 'documentId and signerEmail required' })

  const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://twgwemkihpwlgliftagg.supabase.co'
  const serviceKey   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  const API_KEY      = process.env.BOLDSIGN_API_KEY
  if (!serviceKey) return res.status(500).json({ error: 'Server misconfigured: set SUPABASE_SERVICE_KEY' })
  if (!API_KEY)    return res.status(500).json({ error: 'BoldSign not configured' })

  const supabase = createClient(SUPABASE_URL, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  try {
    const { data: deal } = await supabase.from('deals').select('id')
      .eq('portal_token', token).eq('portal_enabled', true).maybeSingle()
    if (!deal) return res.status(404).json({ error: 'This portal link is no longer active.' })

    const { data: doc } = await supabase.from('boldsign_documents')
      .select('document_id, signer_email, status').eq('document_id', documentId).eq('deal_id', deal.id).maybeSingle()
    if (!doc) return res.status(404).json({ error: 'Document not found for this portal.' })
    if (['completed', 'voided'].includes(doc.status)) return res.status(400).json({ error: 'This document is already finalized.' })

    const emails = String(doc.signer_email || '').toLowerCase().split(',').map(s => s.trim())
    if (!emails.includes(signerEmail)) return res.status(403).json({ error: 'That email is not a signer on this document.' })

    const qs = new URLSearchParams({ documentId, signerEmail })
    const r  = await fetch(`https://api.boldsign.com/v1/document/getEmbeddedSignLink?${qs.toString()}`, {
      headers: { 'X-API-KEY': API_KEY, Accept: 'application/json' },
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) return res.status(r.status).json({ error: data?.error || data?.message || 'Could not create sign link' })
    return res.status(200).json({ url: data.signLink || data.embeddedSigningLink || data.url || null })
  } catch (err) {
    return res.status(500).json({ error: 'Could not start signing.' })
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
import { requireAuthUser, requireAgent, getServiceClient, errorResponse } from './_lib/auth.js'

// ─────────────────────────────────────────────────────────────────────────────
// PROFILE ROUTES — the secure replacement for editing agent profiles directly
// from the browser. Every action authenticates the caller (requireAgent) and
// enforces least-privilege authorization:
//   • profile-save   : create (admin only) / update. A non-admin may update ONLY
//                       their own row, and may NOT touch privileged columns
//                       (role, is_admin, commission split/cap).
//   • profile-delete : admin only.
// This is defense-in-depth: the database RLS + trigger (migration 0023) enforce
// the same rules even if a write bypasses this endpoint.
// ─────────────────────────────────────────────────────────────────────────────

// Fields any owner may edit on their own profile.
const PROFILE_SELF_FIELDS = ['name', 'initials', 'email', 'phone', 'photo_url', 'bio', 'tagline', 'stats', 'color', 'specialty', 'nav_hidden']
// Fields only an admin may set (role doubles as a legacy admin flag).
const PROFILE_ADMIN_FIELDS = ['role', 'is_admin', 'default_split_pct', 'no_brokerage_split', 'cap_amount', 'cap_anniversary']

async function handleProfile(req, res) {
  let ctx
  try {
    ctx = await requireAgent(req)          // { user, agent, isAdmin }
  } catch (e) { return errorResponse(res, e) }

  const { agent: me, isAdmin } = ctx
  const svc = getServiceClient()
  const action = req.body?.action

  try {
    if (action === 'profile-save') {
      const { id, ...fields } = req.body
      const targetId = id || null
      const isCreate = !targetId

      // Creating a teammate is an admin-only action.
      if (isCreate && !isAdmin) {
        return res.status(403).json({ error: 'Only an admin can add new agents.' })
      }

      // Updating someone else's profile is admin-only; you may always edit yourself.
      if (!isCreate && !isAdmin && targetId !== me.id) {
        return res.status(403).json({ error: 'You can only edit your own profile.' })
      }

      // Whitelist columns by role — this is where privilege escalation is stopped.
      const allowed = isAdmin
        ? [...PROFILE_SELF_FIELDS, ...PROFILE_ADMIN_FIELDS]
        : PROFILE_SELF_FIELDS
      const payload = {}
      for (const k of allowed) if (k in fields) payload[k] = fields[k]

      if (isCreate) {
        if (!payload.name || !payload.email) {
          return res.status(400).json({ error: 'Name and email are required.' })
        }
        const { data, error } = await svc.from('agents').insert([payload]).select().single()
        if (error) return res.status(400).json({ error: error.message })
        return res.status(200).json({ agent: data })
      }

      if (Object.keys(payload).length === 0) {
        return res.status(400).json({ error: 'No editable fields provided.' })
      }
      const { data, error } = await svc.from('agents').update(payload).eq('id', targetId).select().single()
      if (error) return res.status(400).json({ error: error.message })
      return res.status(200).json({ agent: data })
    }

    if (action === 'profile-delete') {
      if (!isAdmin) return res.status(403).json({ error: 'Only an admin can remove agents.' })
      const { id } = req.body
      if (!id) return res.status(400).json({ error: 'id required' })
      if (id === me.id) return res.status(400).json({ error: 'You cannot delete your own profile.' })
      const { error } = await svc.from('agents').delete().eq('id', id)
      if (error) return res.status(400).json({ error: error.message })
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: `Unknown profile action: ${action}` })
  } catch (e) {
    return errorResponse(res, e)
  }
}

async function handleMyEarnings(req, res) {
  let user, svc
  try {
    user = await requireAuthUser(req)
    svc  = getServiceClient()
  } catch (e) { return errorResponse(res, e) }

  try {
    // Resolve the agent for this auth user (with the cap-window fields the
    // earnings computation needs).
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
