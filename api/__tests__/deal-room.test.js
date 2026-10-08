/**
 * The Deal Room behind a QR landing page.
 *
 * What must hold:
 *
 *   1. TEASER MEANS STRIPPED, NOT HIDDEN. In teaser mode the underwriting
 *      numbers are absent from the JSON ?action=landing returns — a field the
 *      page merely declines to render is one "view source" away.
 *   2. MAILING ADDRESS IS OPTIONAL. Name, phone and email are the trade; the
 *      address, role and 1031 answers are recorded when given and never
 *      required.
 *   3. THE ACCESS TOKEN OPENS ONE ROOM. Signed, per mailing, expiring; a forged
 *      or other-campaign token opens nothing.
 *   4. THE AGENT HEARS ABOUT IT. A registration alerts every advisor and puts a
 *      call task on the owner's list — once, not on every revisit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.SCAN_SIGNING_SECRET = 'test-secret-for-scan-signing'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'

import {
  publicTeaserConfig, privateDealRoom, dealRoomDocs, mintAccess, readAccess, cleanQualifiers, isTeaser,
  ACCESS_MAX_AGE_MS,
} from '../_lib/dealRoom.js'
import { buildLandingLeadSms, toE164, handleLandingLead, campaignAgentIds } from '../_lib/landingLeadAlert.js'
import { buildDealRoomUpdateEmail } from '../_lib/dealRoomEmail.js'

const MAILING_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
const OTHER_ID   = 'aaaaaaaa-0000-0000-0000-000000000002'

const CFG = {
  headline: '24 Units in Riverside',
  detail_mode: 'commercial',
  price: '3200000', units: '24', building_sqft: '18000', year_built: '1998',
  cap_rate: '6.1', noi: '195000', gross_income: '320000', price_per_unit: '133000', occupancy: '94',
  images: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'],
  om: { path: 'x/Riverside-OM.pdf', filename: 'Riverside-OM.pdf', title: 'Riverside · OM', size: 4_200_000 },
  deal_room: {
    documents: [{ id: 'doc-rr', path: 'y/rent-roll.xlsx', filename: 'rent-roll.xlsx', kind: 'rent_roll', title: 'Rent Roll' }],
    updates: [
      { id: 'u1', date: '2026-09-01', title: 'August financials', body: 'old' },
      { id: 'u2', date: '2026-10-01', title: 'September financials uploaded', body: 'Occupancy 91%' },
    ],
  },
  followup_sequence_id: 'seq-1',
}

describe('publicTeaserConfig — what anyone with the link receives', () => {
  it('strips the underwriting numbers, extra photos and every storage path in teaser mode', () => {
    const pub = publicTeaserConfig(CFG)
    for (const k of ['cap_rate', 'noi', 'gross_income', 'price_per_unit', 'occupancy']) expect(pub[k]).toBeUndefined()
    expect(pub.images).toEqual(['a.jpg', 'b.jpg', 'c.jpg'])
    expect(JSON.stringify(pub)).not.toContain('x/Riverside-OM.pdf')
    expect(JSON.stringify(pub)).not.toContain('y/rent-roll.xlsx')
    expect(JSON.stringify(pub)).not.toContain('Occupancy 91%')
    expect(pub.followup_sequence_id).toBeUndefined()
  })

  it('keeps the public facts and describes what is inside', () => {
    const pub = publicTeaserConfig(CFG)
    expect(pub.units).toBe('24')
    expect(pub.price).toBe('3200000')
    expect(pub.om).toEqual({ filename: 'Riverside-OM.pdf', title: 'Riverside · OM', size: 4_200_000, available: true })
    expect(pub.deal_room).toMatchObject({
      available: true, teaser: true, doc_count: 2, update_count: 2, last_update_at: '2026-10-01', gated_photo_count: 2,
    })
    expect(pub.deal_room.gated_fields).toEqual(['cap_rate', 'noi', 'gross_income', 'price_per_unit', 'occupancy'])
  })

  it('hides the price unless the agent chose to show it', () => {
    expect(publicTeaserConfig({ ...CFG, price_display: 'gated' }).price).toBeUndefined()
    expect(publicTeaserConfig({ ...CFG, price_display: 'call_for_offers' }).price).toBeUndefined()
  })

  it('leaves the numbers public when the agent turns teaser mode off — paths still stripped', () => {
    const pub = publicTeaserConfig({ ...CFG, teaser_mode: false })
    expect(pub.cap_rate).toBe('6.1')
    expect(pub.images).toHaveLength(5)
    expect(JSON.stringify(pub)).not.toContain('x/Riverside-OM.pdf')
  })

  it('changes nothing for a campaign with no Deal Room', () => {
    const plain = { headline: 'x', cap_rate: '6', images: ['a', 'b', 'c', 'd'] }
    expect(isTeaser(plain)).toBe(false)
    expect(publicTeaserConfig(plain)).toEqual(plain)
  })
})

describe('privateDealRoom — what a registered visitor receives', () => {
  it('has the numbers, every photo, documents without paths, updates newest first', () => {
    const room = privateDealRoom({ ...CFG, price_display: 'gated' })
    expect(room.financials).toMatchObject({ cap_rate: '6.1', noi: '195000', price: '3200000' })
    expect(room.images).toHaveLength(5)
    expect(room.documents.map(d => d.id)).toEqual(['om', 'doc-rr'])
    expect(room.documents.every(d => !('path' in d))).toBe(true)
    expect(room.updates[0].id).toBe('u2')
  })

  it('lists the legacy OM first and drops documents with no file', () => {
    const docs = dealRoomDocs({ ...CFG, deal_room: { documents: [{ id: 'empty' }, ...CFG.deal_room.documents] } })
    expect(docs.map(d => d.id)).toEqual(['om', 'doc-rr'])
  })
})

const PORTFOLIO = {
  headline: 'Central Iowa Portfolio',
  price_display: 'gated',
  portfolio: [
    { id: 'p-oak', crm_property_id: 'crm-1', name: 'Oak Apartments', units: '12', price: '900000',
      cap_rate: '6.4', noi: '58000', images: ['o1.jpg', 'o2.jpg', 'o3.jpg', 'o4.jpg'],
      om: { path: 'p/oak-om.pdf', filename: 'oak-om.pdf' },
      documents: [{ id: 'rr', path: 'p/oak-rr.xlsx', filename: 'oak-rr.xlsx', kind: 'rent_roll' }] },
    { name: 'Elm Court', units: '8', occupancy: '97', images: ['e1.jpg'],
      om: { path: 'p/elm-om.pdf', filename: 'elm-om.pdf' } },
  ],
}

describe('portfolio — one page, several properties', () => {
  it('keys every property file under its property id', () => {
    expect(dealRoomDocs(PORTFOLIO).map(d => d.id)).toEqual(['p-oak:om', 'p-oak:rr', 'p-2:om'])
  })

  it('strips each property\'s numbers, extra photos, files and CRM link from the public page', () => {
    const pub = publicTeaserConfig(PORTFOLIO)
    const [oak, elm] = pub.portfolio
    expect(oak).not.toHaveProperty('cap_rate')
    expect(oak).not.toHaveProperty('noi')
    expect(oak).not.toHaveProperty('price')
    expect(oak).not.toHaveProperty('crm_property_id')
    expect(oak).not.toHaveProperty('documents')
    expect(oak.units).toBe('12')
    expect(oak.images).toHaveLength(3)
    expect(oak.gated_photo_count).toBe(1)
    expect(oak.doc_titles).toEqual(['Offering Memorandum', 'Rent Roll'])
    expect(elm).not.toHaveProperty('occupancy')
    expect(JSON.stringify(pub)).not.toMatch(/p\/oak|p\/elm/)
    expect(pub.deal_room.doc_titles[0]).toBe('Oak Apartments · Offering Memorandum')
    expect(pub.deal_room.gated_fields).toEqual(expect.arrayContaining(['cap_rate', 'noi', 'occupancy']))
  })

  it('opens each property\'s numbers, photos and documents to a registered visitor', () => {
    const room = privateDealRoom(PORTFOLIO)
    expect(room.documents).toEqual([])
    const oak = room.properties.find(p => p.id === 'p-oak')
    expect(oak.financials).toMatchObject({ cap_rate: '6.4', noi: '58000', price: '900000' })
    expect(oak.images).toHaveLength(4)
    expect(oak.documents.map(d => d.id)).toEqual(['p-oak:om', 'p-oak:rr'])
    expect(oak.documents.every(d => !('path' in d))).toBe(true)
  })

  it('leaves a single-property page without a portfolio key', () => {
    expect(publicTeaserConfig(CFG)).not.toHaveProperty('portfolio')
    expect(privateDealRoom(CFG)).not.toHaveProperty('properties')
  })
})

describe('access tokens', () => {
  it('opens the mailing it was minted for', () => {
    const t = mintAccess({ mailingId: MAILING_ID, email: 'Jane@Fund.com' })
    expect(readAccess(t, MAILING_ID)).toEqual({ mailingId: MAILING_ID, email: 'jane@fund.com' })
  })

  it('opens nothing else', () => {
    const t = mintAccess({ mailingId: MAILING_ID, email: 'jane@fund.com' })
    expect(readAccess(t, OTHER_ID)).toBeNull()
    const [body] = t.split('.')
    expect(readAccess(`${body}.forgedsignatureforgedsignature12`, MAILING_ID)).toBeNull()
    expect(readAccess('', MAILING_ID)).toBeNull()
  })

  it('expires', () => {
    const t = mintAccess({ mailingId: MAILING_ID, email: 'jane@fund.com', now: 0 })
    expect(readAccess(t, MAILING_ID, ACCESS_MAX_AGE_MS + 1)).toBeNull()
  })
})

describe('cleanQualifiers — every answer optional', () => {
  it('records what was given', () => {
    expect(cleanQualifiers({ mailing_address: ' 1 Main  St ', buyer_role: 'broker', is_1031: true }))
      .toEqual({ mailing_address: '1 Main St', buyer_role: 'broker', is_1031: true })
  })
  it('turns blanks and junk into nulls', () => {
    expect(cleanQualifiers({ mailing_address: '  ', buyer_role: 'king', is_1031: 'maybe' }))
      .toEqual({ mailing_address: null, buyer_role: null, is_1031: null })
    expect(cleanQualifiers()).toEqual({ mailing_address: null, buyer_role: null, is_1031: null })
  })
})

describe('agent alerts', () => {
  const lead = { name: 'Jane Investor', phone: '(515) 555-0134', email: 'jane@fund.com', buyer_role: 'principal', contact_id: 'c1' }
  const mailing = { id: MAILING_ID, name: 'Riverside', agent_id: 'ag1', landing_config: { agent_ids: ['ag2'], followup_sequence_id: 'seq-1' } }

  it('texts a short, tappable message', () => {
    expect(buildLandingLeadSms({ lead, mailing, dealRoom: true }))
      .toBe('Gateway: Jane Investor entered the Deal Room on Riverside. Call (515) 555-0134 (Principal / buyer)')
    expect(toE164('(515) 555-0134')).toBe('+15155550134')
    expect(toE164('555-0134')).toBeNull()
  })

  it('names every advisor on the campaign, owner first', () => {
    expect(campaignAgentIds(mailing)).toEqual(['ag1', 'ag2'])
  })

  it('rings the bell for each advisor, tasks the owner, and enrolls the drip', async () => {
    const inserted = []
    const svc = {
      from: (table) => {
        const chain = {
          select: () => chain, eq: () => chain, in: () => chain, limit: () => chain,
          insert: (row) => { inserted.push({ table, row }); return Promise.resolve({ error: null }) },
          then: (resolve) => resolve(table === 'agents'
            ? { data: [{ id: 'ag2', name: 'Bo Co' }, { id: 'ag1', name: 'Al Owner', email: '' }], error: null }
            : { data: [], error: null }),
        }
        return chain
      },
    }
    const report = await handleLandingLead(svc, { lead, mailing, dealRoom: true })
    const bells = inserted.filter(i => i.table === 'agent_notifications')
    expect(bells.map(b => b.row.agent_id)).toEqual(['ag1', 'ag2'])
    const task = inserted.find(i => i.table === 'tasks')
    expect(task.row).toMatchObject({ agent_id: 'ag1', type: 'call', priority: 'high', contact_id: 'c1' })
    const drip = inserted.find(i => i.table === 'contact_sequences')
    expect(drip.row).toMatchObject({ contact_id: 'c1', sequence_id: 'seq-1', agent_id: 'ag1', status: 'active' })
    expect(report.task).toBe(true)
    expect(report.drip).toBe(true)
  })
})

describe('"New in the Deal Room" email', () => {
  it('carries the recipient link, the update and an unsubscribe link', () => {
    const mail = buildDealRoomUpdateEmail({
      recipient: { name: 'Jane Investor', email: 'jane@fund.com' },
      agent: { name: 'Daniel Hart', phone: '515-555-0100' },
      headline: '24 Units in Riverside',
      update: { title: 'September financials uploaded', body: 'Occupancy 91%', date: '2026-10-01' },
      link: 'https://x.test/lp/property/abc?dr=TOKEN',
      unsubscribeUrl: 'https://x.test/unsubscribe?t=U',
      callForOffers: '2026-10-08',
    })
    expect(mail.subject).toBe('September financials uploaded — 24 Units in Riverside')
    expect(mail.html).toContain('https://x.test/lp/property/abc?dr=TOKEN')
    expect(mail.html).toContain('Hi Jane,')
    expect(mail.html).toContain('October 8, 2026')
    expect(mail.html).toContain('https://x.test/unsubscribe?t=U')
  })
})

// ─── Through the handler ─────────────────────────────────────────────────────

let inserts, upserts, updates, signCalls, priorRegistration, omRow

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async () => ({ data: [], error: null }),
    storage: {
      from: () => ({
        createSignedUrl: (path, ttl, opts) => {
          signCalls.push({ path, ttl, opts })
          return Promise.resolve({ data: { signedUrl: `https://storage.test/${path}` }, error: null })
        },
      }),
    },
    from: (table) => {
      let lastOp = 'select'
      const chain = {
        select: () => chain,
        insert: (rows) => { lastOp = 'insert'; inserts.push({ table, rows }); return chain },
        upsert: (row, opts) => { lastOp = 'upsert'; upserts.push({ table, row, opts }); return chain },
        update: (patch) => { lastOp = 'update'; updates.push({ table, patch }); return chain },
        eq: () => chain, in: () => chain, is: () => chain, limit: () => chain, order: () => chain,
        single:      () => Promise.resolve(rowFor(table, lastOp)),
        maybeSingle: () => Promise.resolve(rowFor(table, lastOp)),
        then: (resolve) => resolve(
          table === 'agents' ? { data: [{ id: 'ag1', name: 'Al Owner' }], error: null }
          : table === 'mailing_om_requests' && lastOp === 'select' && priorRegistration
            ? { data: [{ id: 'req-1' }], error: null }
            : { data: [], error: null, count: 1 }),
      }
      return chain
    },
  }),
}))

function rowFor(table, op) {
  if (table === 'mailings') return { data: { id: MAILING_ID, name: 'Riverside', agent_id: 'ag1', landing_config: CFG }, error: null }
  if (table === 'mailing_leads') return { data: { id: 'lead-1' }, error: null }
  if (table === 'contacts') return { data: { id: 'contact-1' }, error: null }
  if (table === 'mailing_om_requests') return { data: op === 'upsert' ? { id: 'req-1' } : omRow, error: null }
  return { data: null, error: null }
}

function mockRes() {
  return {
    headers: {}, statusCode: null, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this },
    status(c) { this.statusCode = c; return this },
    send(b) { this.body = b; return this },
    json(b) { this.body = b; return this },
    end() { return this },
  }
}
const req = (method, body, query = {}) => ({
  method, headers: { 'user-agent': 'Mozilla/5.0 (iPhone)', host: 'crm.test' },
  query, body, socket: { remoteAddress: '1.2.3.4' },
})

let handler
beforeEach(async () => {
  vi.resetModules()
  inserts = []; upserts = []; updates = []; signCalls = []
  priorRegistration = false
  omRow = { id: 'req-1', name: 'Jane Investor', visit_count: 2 }
  handler = (await import('../campaigns.js')).default
})

const GOOD = { name: 'Jane Investor', phone: '(515) 555-0134', email: 'jane@fund.com' }

describe('?action=landing in teaser mode', () => {
  it('ships no gated number to the browser', async () => {
    const res = mockRes()
    await handler(req('GET', {}, { action: 'landing', id: MAILING_ID }), res)
    expect(res.statusCode).toBe(200)
    const cfg = res.body.mailing.landing_config
    expect(cfg.cap_rate).toBeUndefined()
    expect(cfg.noi).toBeUndefined()
    expect(cfg.deal_room.available).toBe(true)
  })
})

describe('?action=om_request as Deal Room registration', () => {
  it('registers without a mailing address', async () => {
    const res = mockRes()
    await handler(req('POST', { action: 'om_request', mailing_id: MAILING_ID, ...GOOD }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.url).toContain('x/Riverside-OM.pdf')
    expect(readAccess(res.body.access_token, MAILING_ID)).toEqual({ mailingId: MAILING_ID, email: 'jane@fund.com' })
    expect(res.body.deal_room.financials.cap_rate).toBe('6.1')
    expect(res.body.deal_room.documents.every(d => !('path' in d))).toBe(true)
  })

  it('records the optional answers when given', async () => {
    await handler(req('POST', {
      action: 'om_request', mailing_id: MAILING_ID, ...GOOD,
      mailing_address: '1 Main St, Ames, IA', buyer_role: 'broker', is_1031: true,
    }), mockRes())
    expect(updates).toContainEqual({ table: 'mailing_leads', patch: { mailing_address: '1 Main St, Ames, IA', buyer_role: 'broker', is_1031: true } })
    expect(updates).toContainEqual({ table: 'mailing_om_requests', patch: { mailing_address: '1 Main St, Ames, IA', buyer_role: 'broker', is_1031: true } })
    const contact = inserts.find(i => i.table === 'contacts')
    expect(contact.rows[0].owner_address).toBe('1 Main St, Ames, IA')
  })

  it('alerts and tasks the agent on a first registration only', async () => {
    await handler(req('POST', { action: 'om_request', mailing_id: MAILING_ID, ...GOOD }), mockRes())
    expect(inserts.some(i => i.table === 'tasks')).toBe(true)
    expect(inserts.find(i => i.table === 'deal_room_events').rows.kind).toBe('enter')

    inserts = []
    priorRegistration = true
    await handler(req('POST', { action: 'om_request', mailing_id: MAILING_ID, ...GOOD }), mockRes())
    expect(inserts.some(i => i.table === 'tasks')).toBe(false)
    expect(inserts.find(i => i.table === 'deal_room_events').rows.kind).toBe('return')
  })
})

describe('?action=deal_room and deal_room_doc', () => {
  it('re-opens the room with a valid token and counts the visit', async () => {
    const token = mintAccess({ mailingId: MAILING_ID, email: 'jane@fund.com' })
    const res = mockRes()
    await handler(req('POST', { action: 'deal_room', mailing_id: MAILING_ID, access_token: token }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.deal_room.visitor.first_name).toBe('Jane')
    expect(updates.find(u => u.table === 'mailing_om_requests').patch.visit_count).toBe(3)
  })

  it('refuses a token minted for another campaign', async () => {
    const token = mintAccess({ mailingId: OTHER_ID, email: 'jane@fund.com' })
    const res = mockRes()
    await handler(req('POST', { action: 'deal_room', mailing_id: MAILING_ID, access_token: token }), res)
    expect(res.statusCode).toBe(401)
    expect(res.body.deal_room).toBeUndefined()
  })

  it('signs a document by its id from the campaign config, never a caller path', async () => {
    const token = mintAccess({ mailingId: MAILING_ID, email: 'jane@fund.com' })
    const res = mockRes()
    await handler(req('POST', { action: 'deal_room_doc', mailing_id: MAILING_ID, access_token: token, doc_id: 'doc-rr', path: 'evil' }), res)
    expect(res.statusCode).toBe(200)
    expect(signCalls[0].path).toBe('y/rent-roll.xlsx')

    const bad = mockRes()
    await handler(req('POST', { action: 'deal_room_doc', mailing_id: MAILING_ID, access_token: 'nope', doc_id: 'doc-rr' }), bad)
    expect(bad.statusCode).toBe(401)
  })
})
