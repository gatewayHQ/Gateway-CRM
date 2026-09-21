// ─────────────────────────────────────────────────────────────────────────────
// Nightly access audit — /api/cron?task=access-audit
//
// Migration 0049 fixed a storage policy that had hidden a deal's documents from
// its co-agent for months. This task exists because of the SECOND half of that
// bug: nothing compared the live database to what the repository says it should
// be, so the hole was invisible to CI, to the app, and to everyone using it.
//
// What matters here is the posture, and each of these is a rule the task must
// not drift out of:
//   • it REPORTS, it never repairs — an access control that rewrites itself at
//     3am is worse than one that drifts
//   • a database missing the migration is a normal state, not a page
//   • an unfixed hole produces ONE notification, not one per night
//   • the notification carries the findings, not just "something is wrong"
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { runAccessAudit } from '../cron.js'

/**
 * Minimal Supabase stub. `notifications` collects every insert so a test can
 * assert on what an admin would actually receive; `unread` seeds the dedupe
 * lookup.
 */
function fakeSupabase({ rpc, admins = [], unread = [], rpcError = null }) {
  const notifications = []
  const client = {
    notifications,
    rpc: async () => ({ data: rpc, error: rpcError }),
    from(table) {
      if (table === 'agents') {
        return { select: () => ({ eq: async () => ({ data: admins, error: null }) }) }
      }
      if (table === 'agent_notifications') {
        return {
          select: () => {
            const chain = {
              eq: () => chain,
              limit: async () => ({ data: unread, error: null }),
            }
            return chain
          },
          insert: async (rows) => { notifications.push(...rows); return { error: null } },
        }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  return client
}

const FAIL_ROW = {
  area: 'storage policy', item: 'files_own_folder_v2', status: 'FAIL',
  detail: 'scopes a DEAL bucket by uploader (`owner`) — this is the rule that hid a deal\'s documents from its co-agent.',
}
const OK_ROW   = { area: 'storage bucket', item: 'deal-documents', status: 'ok',   detail: 'private' }
const WARN_ROW = { area: 'co-agent visibility', item: 'deals displaying a co-agent RLS does not grant', status: 'warn', detail: '2 deal(s).' }

describe('runAccessAudit', () => {
  it('says nothing when the database matches the model', async () => {
    const db = fakeSupabase({ rpc: [OK_ROW, OK_ROW], admins: [{ id: 'a1', name: 'Erin' }] })
    const res = await runAccessAudit(db)
    expect(res.status).toBe(200)
    expect(res.body.failures).toBe(0)
    expect(db.notifications).toEqual([])
  })

  it('does not notify on warnings alone', async () => {
    // A warning is drift, not a hole. Paging an admin for it teaches them to
    // ignore the alert that matters.
    const db = fakeSupabase({ rpc: [OK_ROW, WARN_ROW], admins: [{ id: 'a1', name: 'Erin' }] })
    const res = await runAccessAudit(db)
    expect(res.body.failures).toBe(0)
    expect(res.body.warnings).toBe(1)
    expect(db.notifications).toEqual([])
  })

  it('notifies every office admin when something fails', async () => {
    const db = fakeSupabase({
      rpc: [OK_ROW, FAIL_ROW],
      admins: [{ id: 'a1', name: 'Erin' }, { id: 'a2', name: 'Daniel' }],
    })
    const res = await runAccessAudit(db)
    expect(res.body.failures).toBe(1)
    expect(res.body.notified).toBe(2)
    expect(db.notifications.map(n => n.agent_id).sort()).toEqual(['a1', 'a2'])
    expect(db.notifications[0].type).toBe('access_audit')
  })

  it('puts the finding IN the notification, not just a count', async () => {
    // An alert that only says "something is wrong" costs the reader a round
    // trip to find out what — and at 7am nobody makes that trip.
    const db = fakeSupabase({ rpc: [FAIL_ROW], admins: [{ id: 'a1', name: 'Erin' }] })
    await runAccessAudit(db)
    expect(db.notifications[0].message).toContain('files_own_folder_v2')
    expect(db.notifications[0].message).toContain('uploader')
    expect(db.notifications[0].title).toMatch(/1 problem$/)
  })

  it('does not repeat nightly while the admin has not read the last one', async () => {
    const db = fakeSupabase({
      rpc: [FAIL_ROW],
      admins: [{ id: 'a1', name: 'Erin' }],
      unread: [{ id: 'n1' }],
    })
    const res = await runAccessAudit(db)
    expect(res.body.notified).toBe(0)
    expect(db.notifications).toEqual([])
  })

  it('treats a database without migration 0050 as normal, not a failure', async () => {
    // Code and migration ship independently; a cron that 500s until a human
    // pastes SQL trains everyone to ignore cron failures.
    const db = fakeSupabase({ rpc: null, rpcError: { message: 'function public.app_access_audit() does not exist' } })
    const res = await runAccessAudit(db)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.skipped).toMatch(/0050/)
  })

  it('surfaces a real RPC error rather than swallowing it', async () => {
    const db = fakeSupabase({ rpc: null, rpcError: { message: 'permission denied for table pg_policy' } })
    const res = await runAccessAudit(db)
    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
  })

  it('never writes anything but a notification — it reports, it does not repair', async () => {
    // The stub throws on any table other than agents / agent_notifications, so
    // a future "helpful" auto-fix fails this test rather than shipping.
    const db = fakeSupabase({ rpc: [FAIL_ROW], admins: [{ id: 'a1', name: 'Erin' }] })
    await expect(runAccessAudit(db)).resolves.toBeTruthy()
  })

  it('reports the findings even when there is no admin to tell', async () => {
    const db = fakeSupabase({ rpc: [FAIL_ROW], admins: [] })
    const res = await runAccessAudit(db)
    expect(res.body.notified).toBe(0)
    expect(res.body.findings).toHaveLength(1)
    expect(res.body.note).toMatch(/no office admin/i)
  })
})
