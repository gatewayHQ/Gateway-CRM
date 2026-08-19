/**
 * POST /api/webhooks/website-lead — the Manus website's lead feed.
 *
 * WHAT THESE GUARD
 *
 * 1. THE ROTATION RACE. The pre-0037 round-robin read the most recent
 *    lead_captures row and took the next agent alphabetically. Two leads in the
 *    same second read the same row and both got the same agent — the
 *    read-modify-write that cost ~2 of every 3 concurrent QR scans until 0031
 *    made that path atomic. Assignment is now one RPC against a locked cursor,
 *    so the test that matters is "the handler asks the database to rotate; it
 *    never computes the next agent itself".
 *
 * 2. IDEMPOTENCY ORDERING. The lead row is written FIRST, unassigned, so the
 *    unique index on dedupe_key decides whether a delivery is new. A retry has
 *    to lose that race BEFORE the rotation runs, or every retry silently burns
 *    an agent's turn and sends a second email. The "no rpc on a duplicate" test
 *    is the one that keeps that ordering from being refactored away.
 *
 * 3. A STORED LEAD IS A SUCCESSFUL DELIVERY. Resend down, no agents configured,
 *    an unmatched property URL — none may turn into a 5xx, because a webhook
 *    sender retries 5xx and would replay a lead already in the CRM.
 *
 * 4. THE SECRET FAILS CLOSED. api/_lib/middleware.js skips its check when the
 *    env var is unset; on a public write endpoint that would leave the rotation
 *    forgeable by anyone who found the URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

process.env.SUPABASE_URL         = 'https://project.supabase.co'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'
process.env.RESEND_API_KEY       = 'test-resend-key'
process.env.PUBLIC_BASE_URL      = 'https://crm.example.com'

const SECRET = 'test-webhook-secret'

const AGENT_A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Alice Adams',  email: 'alice@gw.com' }
const AGENT_B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'Bob Barker',   email: 'bob@gw.com'   }
const LEAD_ID = 'cccccccc-0000-0000-0000-000000000003'
const PROP_ID = 'dddddddd-0000-0000-0000-000000000004'

let handler

// `secret: null` omits the header entirely, which is what an unauthenticated
// caller actually looks like. (`undefined` would hit the destructuring default
// and silently send the real secret.)
function mockReq(body, { method = 'POST', secret = SECRET, headers = {} } = {}) {
  const h = { host: 'crm.example.com', ...headers }
  if (secret !== null) h['x-gateway-secret'] = secret
  return { method, query: { action: 'website-lead' }, headers: h, body }
}

function mockRes() {
  return {
    headers: {}, statusCode: null, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this },
    status(c) { this.statusCode = c; return this },
    json(b)   { this.body = b; return this },
    send(b)   { this.body = b; return this },
    end()     { return this },
  }
}

// ── The fake PostgREST / Resend ──────────────────────────────────────────────
// `plan` is what each test bends. `calls` is what each test asserts on: the
// point of most of these assertions is WHICH requests were made, and in what
// order, not just the final JSON.
let plan, calls

function jsonRes(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

function installFetch() {
  calls = []
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const u      = String(url)
    const method = init.method || 'GET'
    const body   = init.body ? JSON.parse(init.body) : null
    calls.push({ url: u, method, body })

    if (u.startsWith('https://api.resend.com')) {
      return plan.resendOk ? jsonRes(200, { id: 'email-1' }) : jsonRes(500, { error: 'down' })
    }
    if (u.includes('/rpc/lead_lane_for_both')) {
      return jsonRes(200, plan.laneForBoth)
    }
    if (u.includes('/rpc/assign_lead_round_robin')) {
      if (plan.rpcMissing) return jsonRes(404, { message: 'function not found' })
      const hit = plan.rotate.shift()
      return jsonRes(200, hit ? [hit] : [])
    }
    if (u.includes('/rest/v1/leads')) {
      if (method === 'POST') {
        return plan.leadConflict
          ? jsonRes(409, { code: '23505' })
          : jsonRes(201, [{ id: LEAD_ID }])
      }
      if (method === 'PATCH') return jsonRes(200, [{ id: LEAD_ID }])
      return jsonRes(200, plan.priorLead ? [plan.priorLead] : [])   // dedupe lookup
    }
    if (u.includes('/rest/v1/contacts')) {
      if (method === 'POST')  return jsonRes(201, [{ id: 'contact-1' }])
      if (method === 'PATCH') return jsonRes(200, [{ id: 'contact-1' }])
      return jsonRes(200, plan.existingContact ? [plan.existingContact] : [])
    }
    if (u.includes('/rest/v1/agents')) {
      const ids = [...u.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)]
        .map(m => m[0])
      return jsonRes(200, [AGENT_A, AGENT_B].filter(a => ids.includes(a.id)))
    }
    if (u.includes('/rest/v1/properties'))         return jsonRes(200, plan.properties)
    if (u.includes('/rest/v1/lead_property_views')) return jsonRes(201, [])
    if (u.includes('/rest/v1/sequences'))          return jsonRes(200, plan.sequences)
    if (u.includes('/rest/v1/contact_sequences')) {
      return method === 'POST' ? jsonRes(201, []) : jsonRes(200, [])
    }
    if (u.includes('/rest/v1/activities'))          return jsonRes(201, [])
    if (u.includes('/rest/v1/agent_notifications')) return jsonRes(201, [])
    if (u.includes('/rest/v1/lead_captures'))       return jsonRes(200, plan.leadCaptures)
    return jsonRes(404, { message: `unrouted ${u}` })
  })
}

const rpcCalls   = () => calls.filter(c => c.url.includes('/rpc/assign_lead_round_robin'))
const postsTo    = t => calls.filter(c => c.method === 'POST'  && c.url.includes(`/rest/v1/${t}`))
const patchesTo  = t => calls.filter(c => c.method === 'PATCH' && c.url.includes(`/rest/v1/${t}`))
const emails     = () => calls.filter(c => c.url.startsWith('https://api.resend.com'))

beforeEach(async () => {
  process.env.WEBSITE_LEAD_WEBHOOK_SECRET = SECRET
  delete process.env.LEAD_BOTH_NOTIFY_SECONDARY
  plan = {
    rotate:          [{ agent_id: AGENT_A.id, lane: 'residential' }],
    rpcMissing:      false,
    laneForBoth:     'residential',
    leadConflict:    false,
    priorLead:       null,
    existingContact: null,
    properties:      [],
    sequences:       [],
    leadCaptures:    [],
    resendOk:        true,
  }
  installFetch()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  handler = (await import('../_handlers/website-lead.js')).default
})

afterEach(() => { vi.restoreAllMocks() })

// ─────────────────────────────────────────────────────────────────────────────
describe('auth and method', () => {
  it('rejects a request with no secret', async () => {
    const res = mockRes()
    await handler(mockReq({ name: 'A', email: 'a@b.co' }, { secret: null }), res)
    expect(res.statusCode).toBe(401)
    expect(postsTo('leads')).toHaveLength(0)
  })

  it('rejects a wrong secret', async () => {
    const res = mockRes()
    await handler(mockReq({ name: 'A', email: 'a@b.co' }, { secret: 'nope' }), res)
    expect(res.statusCode).toBe(401)
  })

  it('rejects a secret of a different LENGTH without throwing (hashed compare)', async () => {
    const res = mockRes()
    await handler(mockReq({ name: 'A', email: 'a@b.co' }, { secret: 'x' }), res)
    // timingSafeEqual throws on unequal buffer lengths; hashing both sides first
    // is what keeps this a clean 401 instead of a 500.
    expect(res.statusCode).toBe(401)
  })

  it('FAILS CLOSED when no secret is configured at all', async () => {
    delete process.env.WEBSITE_LEAD_WEBHOOK_SECRET
    const prior = process.env.GATEWAY_SECRET
    delete process.env.GATEWAY_SECRET
    const res = mockRes()
    await handler(mockReq({ name: 'A', email: 'a@b.co' }, { secret: 'anything' }), res)
    expect(res.statusCode).toBe(500)
    expect(postsTo('leads')).toHaveLength(0)
    if (prior !== undefined) process.env.GATEWAY_SECRET = prior
  })

  it('rejects non-POST', async () => {
    const res = mockRes()
    await handler(mockReq(null, { method: 'GET' }), res)
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toBe('POST')
  })

  it('never sets a CORS origin — a secret-bearing endpoint is not browser-callable', async () => {
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com' }), res)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('validation', () => {
  const cases = [
    ['no body',            null],
    ['no name',            { email: 'a@b.co' }],
    ['no email',           { name: 'A' }],
    ['malformed email',    { name: 'A', email: 'not-an-email' }],
    ['viewed_properties not an array', { name: 'A', email: 'a@b.co', viewed_properties: 'x' }],
  ]
  for (const [label, body] of cases) {
    it(`400s on ${label}, and stores nothing`, async () => {
      const res = mockRes()
      await handler(mockReq(body), res)
      expect(res.statusCode).toBe(400)
      expect(postsTo('leads')).toHaveLength(0)
    })
  }

  it('accepts first_name + last_name instead of name', async () => {
    const res = mockRes()
    await handler(mockReq({ first_name: 'Jane', last_name: 'Smith', email: 'jane@example.com' }), res)
    expect(res.statusCode).toBe(200)
    expect(postsTo('leads')[0].body.name).toBe('Jane Smith')
  })

  it('413s on an oversized payload', async () => {
    const res = mockRes()
    await handler(mockReq(
      { name: 'A', email: 'a@b.co' },
      { headers: { 'content-length': String(2 * 1024 * 1024) } }
    ), res)
    expect(res.statusCode).toBe(413)
  })

  it('falls back to residential for an unknown interest_type rather than rejecting', async () => {
    const res = mockRes()
    await handler(mockReq({ name: 'A', email: 'a@b.co', interest_type: 'spaceship' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.interest_type).toBe('residential')
  })
})

describe('the happy path', () => {
  beforeEach(() => {
    plan.properties = [{ id: PROP_ID, address: '123 Main St', city: 'Sioux City', state: 'IA' }]
  })

  it('stores the lead, rotates, creates the contact, links views, notifies', async () => {
    const res = mockRes()
    await handler(mockReq({
      name:  'Jane Smith',
      email: 'Jane@Example.COM ',
      phone: '(712) 555-0142',
      interest_type: 'residential',
      viewed_properties: [
        `https://gatewayre.com/listing/${PROP_ID}`,
        '456 Unlisted Ave',
      ],
      message: 'I would like a showing this weekend',
    }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({
      ok: true, deduped: false,
      lead_id: LEAD_ID,
      assigned_agent_id: AGENT_A.id,
      lane: 'residential',
      assignment: 'round_robin',
      properties_linked: 2,
      properties_matched: 1,   // the uuid URL resolves; the bare street does not
      contact_created: true,
    })

    // Email + phone are normalized on the way in.
    const lead = postsTo('leads')[0].body
    expect(lead.email).toBe('jane@example.com')
    expect(lead.phone).toBe('7125550142')
    expect(lead.assigned_agent_id).toBeUndefined()   // assigned by the later PATCH

    // The rotation is the database's job.
    expect(rpcCalls()).toHaveLength(1)
    expect(rpcCalls()[0].body).toEqual({ p_lane: 'residential' })

    // The unmatched view is kept, not dropped.
    const views = postsTo('lead_property_views')[0].body
    expect(views).toHaveLength(2)
    expect(views.filter(v => v.property_id)).toHaveLength(1)
    expect(views.map(v => v.title || v.url)).toContain('456 Unlisted Ave')

    // Timeline + both notification channels.
    expect(postsTo('activities')).toHaveLength(1)
    expect(postsTo('agent_notifications')[0].body).toMatchObject({
      agent_id: AGENT_A.id, type: 'lead',
    })
    expect(emails()).toHaveLength(1)
    expect(emails()[0].body.to).toBe(AGENT_A.email)
    expect(emails()[0].body.subject).toContain('Jane Smith')
    expect(res.body.notified.primary).toEqual({ in_app: true, email: true })
  })

  it('writes the lead BEFORE it rotates, so a retry cannot burn a turn', async () => {
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com' }), res)
    const leadInsert = calls.findIndex(c => c.method === 'POST' && c.url.includes('/rest/v1/leads'))
    const rotation   = calls.findIndex(c => c.url.includes('/rpc/assign_lead_round_robin'))
    expect(leadInsert).toBeGreaterThanOrEqual(0)
    expect(rotation).toBeGreaterThan(leadInsert)
  })
})

describe('idempotency', () => {
  it('a duplicate delivery returns the original lead and does NOT rotate', async () => {
    plan.leadConflict = true
    plan.priorLead = {
      id: LEAD_ID, contact_id: 'contact-1',
      assigned_agent_id: AGENT_A.id, secondary_agent_id: null, lane: 'residential',
    }
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com' }), res)

    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ ok: true, deduped: true, lead_id: LEAD_ID, assigned_agent_id: AGENT_A.id })
    // The whole point: no second turn, no second contact, no second email.
    expect(rpcCalls()).toHaveLength(0)
    expect(postsTo('contacts')).toHaveLength(0)
    expect(emails()).toHaveLength(0)
  })

  it('derives a stable dedupe key from the sender event_id when given one', async () => {
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com', event_id: 'manus-99' }), res)
    expect(postsTo('leads')[0].body.dedupe_key).toBe('evt:manus-99')
  })

  it('hashes a key when the sender gives no event id', async () => {
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com' }), res)
    expect(postsTo('leads')[0].body.dedupe_key).toMatch(/^auto:[0-9a-f]{40}$/)
  })
})

describe("interest_type 'both'", () => {
  it('gives one owner and copies the other lane as a labeled FYI', async () => {
    plan.laneForBoth = 'commercial'
    plan.rotate = [
      { agent_id: AGENT_B.id, lane: 'commercial'  },   // the owner
      { agent_id: AGENT_A.id, lane: 'residential' },   // the courtesy copy
    ]
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com', interest_type: 'both' }), res)

    expect(res.body).toMatchObject({
      assigned_agent_id:  AGENT_B.id,
      secondary_agent_id: AGENT_A.id,
      lane:               'commercial',
    })
    // Balanced by the DB, not by the handler guessing.
    expect(calls.some(c => c.url.includes('/rpc/lead_lane_for_both'))).toBe(true)
    expect(rpcCalls().map(c => c.body.p_lane)).toEqual(['commercial', 'residential'])

    const [ownerMail, fyiMail] = emails().map(c => c.body)
    expect(ownerMail.to).toBe(AGENT_B.email)
    expect(ownerMail.subject).toBe('New website lead: Jane Smith')
    // The FYI must not read like an assignment.
    expect(fyiMail.to).toBe(AGENT_A.email)
    expect(fyiMail.subject).toMatch(/^FYI/)
    expect(fyiMail.subject).toContain('Bob Barker')
    expect(fyiMail.html).toContain('owns the follow-up')
  })

  it('drops the courtesy copy when the other lane rotates back to the owner', async () => {
    plan.rotate = [
      { agent_id: AGENT_A.id, lane: 'residential' },
      { agent_id: AGENT_A.id, lane: 'commercial'  },   // one-agent brokerage
    ]
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com', interest_type: 'both' }), res)
    expect(res.body.secondary_agent_id).toBeNull()
    expect(emails()).toHaveLength(1)
  })

  it('LEAD_BOTH_NOTIFY_SECONDARY=false makes it a plain single assignment', async () => {
    process.env.LEAD_BOTH_NOTIFY_SECONDARY = 'false'
    plan.rotate = [{ agent_id: AGENT_A.id, lane: 'residential' }]
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com', interest_type: 'both' }), res)
    expect(res.body.secondary_agent_id).toBeNull()
    expect(rpcCalls()).toHaveLength(1)
  })
})

describe('an existing relationship wins over the rotation', () => {
  it('keeps the contact\'s current agent and never touches the rotation', async () => {
    plan.existingContact = { id: 'contact-1', assigned_agent_id: AGENT_B.id }
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com', interest_type: 'both' }), res)

    expect(res.body).toMatchObject({
      assigned_agent_id: AGENT_B.id,
      assignment:        'existing_contact_owner',
      contact_created:   false,
      secondary_agent_id: null,
    })
    // Spending a turn and discarding the result would silently skip an agent.
    expect(rpcCalls()).toHaveLength(0)
    expect(postsTo('contacts')).toHaveLength(0)
    expect(emails()[0].body.to).toBe(AGENT_B.email)
  })

  it('backfills a missing phone on the existing contact, and only when missing', async () => {
    plan.existingContact = { id: 'contact-1', assigned_agent_id: AGENT_B.id }
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com', phone: '712-555-0142' }), res)
    const patch = patchesTo('contacts')[0]
    expect(patch.body).toEqual({ phone: '7125550142' })
    // The filter, not the app, is what protects a number already on file.
    expect(patch.url).toContain('phone=is.null')
  })
})

describe('a stored lead is always a successful delivery', () => {
  it('200s with no agent in either rotation, leaving the lead claimable', async () => {
    plan.rotate = []
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatchObject({ ok: true, assigned_agent_id: null, assignment: 'unassigned' })
    expect(postsTo('leads')).toHaveLength(1)
  })

  it('200s when Resend is down, and reports the failed channel', async () => {
    plan.resendOk = false
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.notified.primary).toEqual({ in_app: true, email: false })
  })

  it('500s ONLY when the lead itself could not be stored — the sender should retry', async () => {
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      if (String(url).includes('/rest/v1/leads') && (init.method || 'GET') === 'POST') {
        return jsonRes(500, { message: 'db down' })
      }
      return jsonRes(200, [])
    })
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com' }), res)
    expect(res.statusCode).toBe(500)
  })

  it('falls back to the legacy picker when 0037 has not been applied', async () => {
    plan.rpcMissing = true
    plan.leadCaptures = []
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      const u = String(url), method = init.method || 'GET'
      calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : null })
      if (u.includes('/rpc/assign_lead_round_robin')) return jsonRes(404, {})
      if (u.includes('/rest/v1/leads') && method === 'POST') return jsonRes(201, [{ id: LEAD_ID }])
      if (u.includes('/rest/v1/agents')) return jsonRes(200, [AGENT_A, AGENT_B])
      if (u.startsWith('https://api.resend.com')) return jsonRes(200, {})
      return jsonRes(200, [])
    })
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.assignment).toBe('round_robin_legacy')
    expect(res.body.assigned_agent_id).toBe(AGENT_A.id)   // first alphabetically
  })
})

describe('drip hand-off', () => {
  it('enrolls the contact when the lane has an auto-enroll sequence', async () => {
    plan.sequences = [{ id: 'seq-1' }]
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com' }), res)
    expect(res.body.drip_status).toBe('enrolled')
    expect(postsTo('contact_sequences')[0].body).toMatchObject({
      contact_id: 'contact-1', sequence_id: 'seq-1', current_step: 0, status: 'active',
    })
    expect(patchesTo('leads')[0].body).toMatchObject({
      drip_status: 'enrolled', drip_sequence_id: 'seq-1',
    })
  })

  it("skips — not fails — when no sequence is configured for the lane", async () => {
    plan.sequences = []
    const res = mockRes()
    await handler(mockReq({ name: 'Jane Smith', email: 'jane@example.com' }), res)
    expect(res.statusCode).toBe(200)
    expect(res.body.drip_status).toBe('skipped')
    expect(postsTo('contact_sequences')).toHaveLength(0)
  })
})
