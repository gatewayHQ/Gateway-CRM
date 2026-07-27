import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/portal?action=my-earnings — the privacy boundary in front of
// commission data, and the server-side aggregation behind the earnings chart.
//
// The Supabase service client is stubbed; everything else (auth handling, the
// commission engine, the bucketing) is the real code path.
// ─────────────────────────────────────────────────────────────────────────────

const ME        = 'a-me-0000-0000-0000-000000000001'
const COLLEAGUE = 'a-co-0000-0000-0000-000000000002'

let dealsSelectFails   // simulate a database without migration 0024
let dealRows

const AGENT_ROSTER = [
  { id: ME,        name: 'Me',        default_split_pct: 70, no_brokerage_split: false },
  { id: COLLEAGUE, name: 'Colleague', default_split_pct: 70, no_brokerage_split: false },
]

const ME_ROW = { id: ME, name: 'Me', cap_amount: 25000, cap_anniversary: null, no_brokerage_split: false }

// A thenable query builder: awaiting it resolves the canned result, and
// .select()/.eq() chain like the real PostgREST client.
function builder(result) {
  const self = {
    select: () => self,
    eq: () => self,
    contains: () => self,
    order: () => self,
    maybeSingle: () => Promise.resolve(result.single ?? result),
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  }
  return self
}

// The deals read is attempted twice (with, then without, the agent_comp_*
// columns), so its result depends on the column list asked for.
const dealsClient = {
  from: (table) => {
    if (table === 'agents') {
      return builder({ data: AGENT_ROSTER, error: null, single: { data: ME_ROW, error: null } })
    }
    if (table === 'commissions') return builder({ data: [], error: null })
    if (table === 'deals') {
      return {
        select: (cols) => {
          const wantsComp = /agent_comp/.test(cols)
          const result = wantsComp && dealsSelectFails
            ? { data: null, error: { message: 'column deals.agent_comp_type does not exist' } }
            : {
                data: dealRows.map(d => wantsComp ? d : stripComp(d)),
                error: null,
              }
          return builder(result)
        },
      }
    }
    return builder({ data: [], error: null })
  },
}

const stripComp = ({ agent_comp_type, agent_comp_rate_pct, agent_comp_flat, ...rest }) => rest

vi.mock('../_lib/auth.js', () => ({
  requireAuthUser: async () => ({ id: 'auth-user-1' }),
  requireAgent:    async () => ({ user: { id: 'auth-user-1' }, agent: ME_ROW, isAdmin: false }),
  getServiceClient: () => dealsClient,
  errorResponse: (res, err) => res.status(err?.status || 500).json({ error: err?.message || 'error' }),
  applyJsonCors: () => {},
  SUPABASE_URL: 'https://example.supabase.co',
  SERVICE_KEY: 'test-key',
}))

const { default: handler } = await import('../portal.js')

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v },
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
  }
}

const call = async (query) => {
  const res = mockRes()
  await handler({ method: 'GET', query: { action: 'my-earnings', ...query }, headers: {} }, res)
  return res
}

// Two closed deals I earned on (one priced by rate, one by flat fee), one closed
// deal that is only my colleague's, and one open deal of mine.
beforeEach(() => {
  dealsSelectFails = false
  dealRows = [
    {
      id: 'd-rate', title: 'Rate deal', stage: 'closed', value: 1_000_000, agent_id: ME,
      updated_at: '2026-05-20T12:00:00Z', created_at: '2026-01-01T00:00:00Z',
      agent_comp_type: 'rate', agent_comp_rate_pct: 3, agent_comp_flat: null,
    },
    {
      id: 'd-flat', title: 'Flat deal', stage: 'closed', value: 400_000, agent_id: ME,
      updated_at: '2026-07-10T12:00:00Z', created_at: '2026-02-01T00:00:00Z',
      agent_comp_type: 'flat', agent_comp_rate_pct: null, agent_comp_flat: 10_000,
    },
    {
      id: 'd-theirs', title: 'Not mine', stage: 'closed', value: 900_000, agent_id: COLLEAGUE,
      updated_at: '2026-06-01T12:00:00Z', created_at: '2026-01-01T00:00:00Z',
      agent_comp_type: 'rate', agent_comp_rate_pct: 3, agent_comp_flat: null,
    },
    {
      id: 'd-open', title: 'Open deal', stage: 'under-contract', value: 500_000, agent_id: ME,
      updated_at: '2026-07-01T12:00:00Z', created_at: '2026-03-01T00:00:00Z',
      agent_comp_type: 'rate', agent_comp_rate_pct: 3, agent_comp_flat: null,
    },
  ]
})

// A custom range shorter than ~4 months auto-buckets by week, so these tests
// ask for months explicitly where monthly bars are the point.
const RANGE = { range: 'custom', from: '2026-05-01', to: '2026-07-31', bucket: 'month' }

describe('my-earnings — chart series', () => {
  it('aggregates the caller’s closed takes into buckets, split rate vs flat', async () => {
    const res = await call(RANGE)
    expect(res.statusCode).toBe(200)
    const { series } = res.body

    expect(series.bucket).toBe('month')
    expect(series.points.map(p => p.short)).toEqual(['May', 'Jun', 'Jul'])

    // Rate deal: 3% of 1M = 30k gross, 70% split = 21k. Flat deal: 10k fee,
    // 70% split = 7k. Neither carries a transaction fee (no commission row).
    expect(series.points[0].rate_take).toBeCloseTo(21_000, 2)
    expect(series.points[0].flat_take).toBe(0)
    expect(series.points[1].take).toBe(0)              // June was my colleague's deal
    expect(series.points[2].flat_take).toBeCloseTo(7_000, 2)
    expect(series.points[2].rate_take).toBe(0)

    expect(series.totals).toMatchObject({ deals: 2 })
    expect(series.totals.take).toBeCloseTo(28_000, 2)
    expect(series.best).toMatchObject({ take: 21_000 })
  })

  it('never includes another agent’s deals, whatever the query says', async () => {
    const res = await call({ ...RANGE, agent_id: COLLEAGUE })
    const ids = res.body.deals.map(d => d.deal_id)
    expect(ids).not.toContain('d-theirs')
    expect(ids).toContain('d-rate')
    // The series total is still only mine.
    expect(res.body.series.totals.take).toBeCloseTo(28_000, 2)
  })

  it('labels each deal row as flat or rate priced', async () => {
    const res = await call(RANGE)
    const byId = Object.fromEntries(res.body.deals.map(d => [d.deal_id, d]))
    expect(byId['d-rate'].is_flat).toBe(false)
    expect(byId['d-flat'].is_flat).toBe(true)
    expect(byId['d-flat'].comp_source).toBe('agent')
  })

  it('leaves open deals out of the chart but keeps them in the list', async () => {
    const res = await call(RANGE)
    expect(res.body.series.totals.deals).toBe(2)
    expect(res.body.deals.some(d => d.deal_id === 'd-open' && !d.closed)).toBe(true)
  })

  it('honours the range: a window with no closings charts as empty', async () => {
    const res = await call({ range: 'custom', from: '2026-01-01', to: '2026-03-31', bucket: 'month' })
    expect(res.body.series.totals.take).toBe(0)
    expect(res.body.series.points).toHaveLength(3)
  })

  it('supports weekly buckets', async () => {
    const res = await call({ range: 'custom', from: '2026-07-06', to: '2026-07-19', bucket: 'week' })
    expect(res.body.series.bucket).toBe('week')
    expect(res.body.series.points.map(p => p.key)).toEqual(['2026-07-06', '2026-07-13'])
    // The flat-fee deal closed Fri 2026-07-10 — the Jul 6 week, not Jul 13.
    expect(res.body.series.points[0].take).toBeCloseTo(7_000, 2)
    expect(res.body.series.points[1].take).toBe(0)
  })

  it('skips the series for a single-deal lookup (the deal page path)', async () => {
    const res = await call({ deal_id: 'd-rate' })
    expect(res.body.series).toBeNull()
    expect(res.body.deals.length).toBeGreaterThan(0)
  })

  it('still answers on a database without migration 0024', async () => {
    dealsSelectFails = true
    const res = await call(RANGE)
    expect(res.statusCode).toBe(200)
    // No agent-set compensation available → the firm default 3% prices both
    // deals, so nothing is flat and the chart still renders.
    expect(res.body.series.totals.deals).toBe(2)
    expect(res.body.series.totals.flat_take).toBe(0)
    expect(res.body.series.totals.rate_take).toBeGreaterThan(0)
  })
})
