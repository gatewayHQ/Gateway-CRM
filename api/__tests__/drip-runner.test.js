// ─────────────────────────────────────────────────────────────────────────────
// Drip runner — api/_lib/dripRunner.js.
//
// WHAT THESE GUARD
//   1. THE SENDER IS THE SEQUENCE'S OWNER, through their own Outlook. Not a
//      shared Resend address, and not whoever happened to click "enroll".
//   2. NOTHING IS SENT TWICE. A step is claimed (current_step compare-and-set)
//      before it is sent; a second run over the same enrollment sends nothing.
//      A failed send hands the claim back so the step is retried, not skipped.
//   3. A DRIP STOPS for a reply, an opt-out, or a missing address — and a
//      mailbox that is not connected PAUSES it without losing its place.
//   4. `last_sent_at` is written: the pre-0060 runner wrote it to a column that
//      did not exist, so current_step never advanced.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'

process.env.SUPABASE_SERVICE_KEY = 'test-service-key'   // unsubscribe signing secret
delete process.env.RESEND_API_KEY

const { runDripSequences, stepDueAt } = await import('../_lib/dripRunner.js')

// ── A tiny in-memory stand-in for the supabase-js query builder ──────────────
function fakeDb(tables) {
  const db = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map(r => ({ ...r }))]))
  let seq = 0

  function builder(table) {
    const filters = []
    let op = 'select', patch = null, rows = null, head = false, wantCount = false, single = false
    const match = (r) => filters.every(f => f(r))
    const api = {
      select(_cols, opts = {}) { if (op === 'select') op = 'select'; head = !!opts.head; wantCount = !!opts.count; return api },
      eq(k, v)  { filters.push(r => r[k] === v); return api },
      neq(k, v) { filters.push(r => r[k] !== v); return api },
      in(k, vs) { filters.push(r => vs.includes(r[k])); return api },
      gte(k, v) { filters.push(r => r[k] >= v); return api },
      order()   { return api },
      limit()   { return api },
      single()  { single = true; return api },
      maybeSingle() { single = true; return api },
      update(p) { op = 'update'; patch = p; return api },
      insert(rs) { op = 'insert'; rows = rs; return api },
      then(res, rej) { return Promise.resolve(run()).then(res, rej) },
    }
    function run() {
      db[table] = db[table] || []
      if (op === 'insert') {
        const added = rows.map(r => ({ id: `${table}-${++seq}`, ...r }))
        db[table].push(...added)
        return { data: single ? added[0] : added, error: null }
      }
      if (op === 'update') {
        const hit = db[table].filter(match)
        hit.forEach(r => Object.assign(r, patch))
        return { data: hit.map(r => ({ id: r.id })), error: null }
      }
      const hit = db[table].filter(match)
      if (wantCount) return { data: head ? null : hit, count: hit.length, error: null }
      return { data: single ? (hit[0] || null) : hit, error: null }
    }
    return api
  }
  return { from: builder, db }
}

const OWNER    = { id: 'agent-owner', name: 'Olivia Owner', email: 'olivia@gw.com', phone: '(712) 555-0101' }
const ENROLLER = { id: 'agent-other', name: 'Eddie Enroller', email: 'eddie@gw.com' }
const DAY = 86_400_000
const NOW = Date.parse('2026-10-01T15:00:00Z')

function baseTables(overrides = {}) {
  return {
    sequences: [{ id: 'seq-1', name: 'Buyer drip', agent_id: OWNER.id }],
    sequence_steps: [
      { id: 'st-0', sequence_id: 'seq-1', sort_order: 0, step_type: 'email', delay_days: 0,
        subject: 'Hi {{firstName}}', body: 'Looking at {{searchSummary|homes}}?\n\n{{matchingListings}}' },
      { id: 'st-1', sequence_id: 'seq-1', sort_order: 1, step_type: 'call', delay_days: 1,
        subject: 'Call {{firstName}}', body: 'Budget {{maxPrice}}' },
      { id: 'st-2', sequence_id: 'seq-1', sort_order: 2, step_type: 'email', delay_days: 2,
        subject: 'Follow up', body: 'Still looking?' },
    ],
    contact_sequences: [{
      id: 'enr-1', contact_id: 'c-1', sequence_id: 'seq-1', agent_id: ENROLLER.id,
      current_step: 0, status: 'active', started_at: new Date(NOW - 60_000).toISOString(), last_sent_at: null,
    }],
    contacts: [{ id: 'c-1', first_name: 'Jordan', last_name: 'Miller', email: 'jordan@example.com',
      email_opt_out: false, submarket: 'Sioux City', search_beds_min: 3, search_baths_min: 2, search_price_max: 250000 }],
    agents: [OWNER, ENROLLER],
    email_messages: [], email_suppressions: [], email_log: [], activities: [], tasks: [],
    lead_property_views: [],
    properties: [
      { id: 'p-1', address: '1 A St', city: 'Sioux City', type: 'residential', status: 'active', list_price: 240000, beds: 3, baths: 2 },
    ],
    ...overrides,
  }
}

let sent, tokenFor
function deps(extra = {}) {
  return {
    getValidAccessToken: vi.fn(async (_svc, agentId) => {
      tokenFor.push(agentId)
      return { accessToken: `token-${agentId}`, connection: { scopes: ['Mail.Send'] } }
    }),
    sendGraphMail: vi.fn(async (token, msg) => { sent.push({ token, ...msg }) }),
    ...extra,
  }
}
const run = (svc, opts = {}) => runDripSequences(svc, {
  baseUrl: 'https://crm.example.com', now: NOW, gapMs: 0, deps: deps(), ...opts,
})

beforeEach(() => { sent = []; tokenFor = [] })

describe('who sends', () => {
  it("sends from the SEQUENCE OWNER'S Outlook, not the enroller's, and never via Resend", async () => {
    const svc = fakeDb(baseTables())
    const r = await run(svc)
    expect(r.body.sent).toBe(1)
    expect(tokenFor).toEqual([OWNER.id])
    expect(sent[0].token).toBe(`token-${OWNER.id}`)
    expect(sent[0].to).toEqual(['jordan@example.com'])
  })

  it('personalizes from the lead’s search and includes matching listings + an opt-out', async () => {
    const svc = fakeDb(baseTables())
    await run(svc)
    expect(sent[0].subject).toBe('Hi Jordan')
    expect(sent[0].html).toContain('3+ bed, 2+ bath homes up to $250,000 in Sioux City')
    expect(sent[0].html).toContain('https://crm.example.com/listing/p-1')
    expect(sent[0].html).toContain('https://crm.example.com/u/')
  })

  it('logs the send on the contact timeline and in the Emails tab under the owner', async () => {
    const svc = fakeDb(baseTables())
    await run(svc)
    expect(svc.db.activities[0]).toMatchObject({ contact_id: 'c-1', agent_id: OWNER.id, type: 'email' })
    expect(svc.db.email_messages[0]).toMatchObject({ contact_id: 'c-1', agent_id: OWNER.id, status: 'sent', source: 'crm' })
    expect(svc.db.email_log[0]).toMatchObject({ enrollment_id: 'enr-1', status: 'sent', agent_id: OWNER.id })
  })
})

describe('never twice', () => {
  it('advances current_step and writes last_sent_at', async () => {
    const svc = fakeDb(baseTables())
    await run(svc)
    const e = svc.db.contact_sequences[0]
    expect(e.current_step).toBe(1)
    expect(e.last_sent_at).toBe(new Date(NOW).toISOString())
    expect(e.status).toBe('active')
  })

  it('a second run over the same enrollment sends nothing (the next step is not due yet)', async () => {
    const svc = fakeDb(baseTables())
    await run(svc)
    await run(svc)
    expect(sent).toHaveLength(1)
  })

  it('a failed send hands the step back for the next run, with the reason recorded', async () => {
    const svc = fakeDb(baseTables())
    const failing = deps({ sendGraphMail: vi.fn(async () => { throw Object.assign(new Error('Graph 503'), { status: 502 }) }) })
    const r = await runDripSequences(svc, { baseUrl: 'https://crm.example.com', now: NOW, gapMs: 0, deps: failing })
    expect(r.body.errors).toBe(1)
    const e = svc.db.contact_sequences[0]
    expect(e.current_step).toBe(0)
    expect(e.status).toBe('active')
    expect(e.last_error).toMatch(/Graph 503/)
  })

  it('an enrollment already claimed by another run is skipped', async () => {
    const svc = fakeDb(baseTables())
    // Another run advanced it between our read and our claim.
    const realFrom = svc.from
    let raced = false
    svc.from = (t) => {
      const b = realFrom(t)
      if (t === 'contact_sequences' && !raced) {
        const origUpdate = b.update
        b.update = (p) => {
          if (p.current_step === 1) { raced = true; svc.db.contact_sequences[0].current_step = 1 }
          return origUpdate(p)
        }
      }
      return b
    }
    await runDripSequences(svc, { baseUrl: 'https://crm.example.com', now: NOW, gapMs: 0, deps: deps() })
    expect(sent).toHaveLength(0)
  })
})

describe('stopping and pausing', () => {
  it('stops the drip when the contact replied after enrolling — and tells the agent to call', async () => {
    const svc = fakeDb(baseTables({
      email_messages: [{ contact_id: 'c-1', status: 'received', sent_at: new Date(NOW - 1000).toISOString() }],
    }))
    const r = await run(svc)
    expect(r.body.replied).toBe(1)
    expect(sent).toHaveLength(0)
    expect(svc.db.contact_sequences[0].status).toBe('replied')
    expect(svc.db.activities[0].body).toMatch(/replied/i)
  })

  it('ignores mail from before the enrollment started', async () => {
    const svc = fakeDb(baseTables({
      email_messages: [{ contact_id: 'c-1', status: 'received', sent_at: new Date(NOW - 30 * DAY).toISOString() }],
    }))
    await run(svc)
    expect(sent).toHaveLength(1)
  })

  it('stops for an opted-out contact or a suppressed address', async () => {
    const t = baseTables()
    t.contacts[0].email_opt_out = true
    const svc = fakeDb(t)
    await run(svc)
    expect(sent).toHaveLength(0)
    expect(svc.db.contact_sequences[0]).toMatchObject({ status: 'stopped' })

    const svc2 = fakeDb(baseTables({ email_suppressions: [{ email: 'jordan@example.com', reason: 'bounced' }] }))
    await run(svc2)
    expect(sent).toHaveLength(0)
    expect(svc2.db.contact_sequences[0].status).toBe('stopped')
  })

  it('an agent without Outlook connected keeps their place and sees why', async () => {
    const svc = fakeDb(baseTables())
    const noOutlook = deps({ getValidAccessToken: vi.fn(async () => { throw Object.assign(new Error('not connected'), { status: 409 }) }) })
    await runDripSequences(svc, { baseUrl: 'https://crm.example.com', now: NOW, gapMs: 0, deps: noOutlook })
    const e = svc.db.contact_sequences[0]
    expect(e.current_step).toBe(0)
    expect(e.status).toBe('active')
    expect(e.last_error).toMatch(/Outlook is not connected/)
  })

  it('refuses to send without working unsubscribe links', async () => {
    const svc = fakeDb(baseTables())
    await run(svc, { baseUrl: '' })
    expect(sent).toHaveLength(0)
    expect(svc.db.contact_sequences[0].last_error).toMatch(/Unsubscribe/)
  })
})

describe('call steps', () => {
  it('put a high-priority call task on the owner’s list, rendered with the lead’s details', async () => {
    const t = baseTables()
    t.contact_sequences[0].current_step = 1
    t.contact_sequences[0].last_sent_at = new Date(NOW - 2 * DAY).toISOString()
    const svc = fakeDb(t)
    const r = await run(svc)
    expect(r.body.calls).toBe(1)
    expect(sent).toHaveLength(0)
    expect(svc.db.tasks[0]).toMatchObject({
      title: 'Call Jordan', type: 'call', priority: 'high', contact_id: 'c-1', agent_id: OWNER.id, notes: 'Budget $250,000',
    })
    expect(svc.db.contact_sequences[0].current_step).toBe(2)
  })

  it('work even when the agent has no Outlook connection', async () => {
    const t = baseTables()
    t.contact_sequences[0].current_step = 1
    t.contact_sequences[0].last_sent_at = new Date(NOW - 2 * DAY).toISOString()
    const svc = fakeDb(t)
    const noOutlook = deps({ getValidAccessToken: vi.fn(async () => { throw Object.assign(new Error('x'), { status: 409 }) }) })
    const r = await runDripSequences(svc, { baseUrl: 'https://crm.example.com', now: NOW, gapMs: 0, deps: noOutlook })
    expect(r.body.calls).toBe(1)
  })
})

describe('timing', () => {
  it('counts step 1 from enrollment and later steps from the previous send', () => {
    const e = { started_at: '2026-10-01T00:00:00Z', last_sent_at: '2026-10-05T00:00:00Z' }
    expect(stepDueAt(e, { delay_days: 0 }, 0)).toBe(Date.parse('2026-10-01T00:00:00Z'))
    expect(stepDueAt(e, { delay_days: 2 }, 1)).toBe(Date.parse('2026-10-07T00:00:00Z'))
  })

  it('completes the enrollment after its last step', async () => {
    const t = baseTables()
    t.contact_sequences[0].current_step = 2
    t.contact_sequences[0].last_sent_at = new Date(NOW - 3 * DAY).toISOString()
    const svc = fakeDb(t)
    await run(svc)
    expect(sent).toHaveLength(1)
    expect(svc.db.contact_sequences[0].status).toBe('completed')
  })

  it('runs only the enrollments asked for (the send-Day-0-now path)', async () => {
    const t = baseTables()
    t.contact_sequences.push({ ...t.contact_sequences[0], id: 'enr-2' })
    const svc = fakeDb(t)
    const r = await run(svc, { enrollmentIds: ['enr-2'] })
    expect(r.body.sent).toBe(1)
    expect(svc.db.contact_sequences.find(e => e.id === 'enr-1').current_step).toBe(0)
  })
})
