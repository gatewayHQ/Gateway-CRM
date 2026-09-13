/**
 * THE OUTLOOK NOTIFICATION STORM
 * (api/_lib/msGraph.js#resolveReminderLead + api/_lib/calendarSync.js)
 *
 * THE BUG THESE EXIST FOR. An agent put an inspection on a deal as a key date
 * and Outlook pushed twenty-odd notifications at them. Three things combined:
 *
 *   1. The Key Dates tab saved and synced on EVERY onChange of a native date
 *      input — and a year typed digit by digit is four of them (0002, 0020,
 *      0202, 2026). That part is fixed in the browser (src/pages/Pipeline.jsx).
 *
 *   2. Those syncs overlapped, and the create path is read-then-write: both
 *      read "no event yet", both created one. The second ledger insert lost to
 *      the unique index and the error was never read — so the second CALENDAR
 *      EVENT was real, had a reminder, and had nothing in the ledger naming it.
 *      No later sync could update or delete it. Every race added another.
 *
 *   3. The default lead time is three days, so any date closer than that got a
 *      reminder set in the PAST — which Outlook fires the instant it sees the
 *      event, and again whenever the event's reminder fields are rewritten. An
 *      inspection booked for Thursday and typed in on Tuesday popped straight
 *      away, every single save.
 *
 * What these guard, then:
 *   • a reminder is never asked for in the past (3), and a date already gone by
 *     gets no reminder at all;
 *   • losing the create race deletes the surplus event rather than stranding it
 *     on somebody's calendar forever (2);
 *   • the duplicates ALREADY out there get swept up — and the sweep will not
 *     touch an event it cannot prove the CRM created.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const graph = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  listGatewayCalendarEvents: vi.fn(),
}))

vi.mock('../_lib/msGraph.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, ...graph }
})

const { syncTaskCalendar, syncDealCalendar, pruneDuplicateCalendarEvents } =
  await import('../_lib/calendarSync.js')
const { resolveReminderLead, calendarEventBody } = await import('../_lib/msGraph.js')

const AGENT = 'aaaaaaaa-0000-0000-0000-00000000a001'
const TASK  = 'tttttttt-0000-0000-0000-00000000t001'
const DEAL  = 'dddddddd-0000-0000-0000-00000000d001'

const MINUTE = 60000
const HOUR   = 60 * MINUTE
const DAY    = 24 * HOUR

// ─── A stand-in for the service-key client, WITH the unique indexes ──────────
// The real ones (uq_deal_calendar_events_key, uq_task_calendar_events_key) are
// the whole point of the race test: without them the fake would happily record
// two rows and the bug would look fixed when it wasn't.
const UNIQUE = {
  deal_calendar_events: ['deal_id', 'agent_id', 'date_type'],
  task_calendar_events: ['task_id', 'agent_id'],
}

function fakeClient(tables = {}) {
  const db = {
    task_calendar_events: [], deal_calendar_events: [], ms_graph_connections: [],
    ...tables,
  }

  const from = (name) => {
    const filters = []
    const match = row => filters.every(([col, val]) => row[col] === val)
    const rows = () => (db[name] || []).filter(match)

    const q = {
      select() { return q },
      eq(col, val) { filters.push([col, val]); return q },
      in(col, val) { filters.push([col, val]); return q },
      order() { return q },
      limit() { return Promise.resolve({ data: rows() }) },
      maybeSingle() { return Promise.resolve({ data: rows()[0] || null }) },
      then(res, rej) { return Promise.resolve({ data: rows() }).then(res, rej) },
      insert(newRows) {
        const cols = UNIQUE[name]
        for (const r of newRows) {
          if (cols && (db[name] || []).some(x => cols.every(c => x[c] === r[c]))) {
            return Promise.resolve({
              data: null,
              error: { code: '23505', message: `duplicate key value violates unique constraint "uq_${name}"` },
            })
          }
        }
        db[name] = [...(db[name] || []), ...newRows.map((r, i) => ({ id: `row-${(db[name] || []).length + i}`, ...r }))]
        return Promise.resolve({ data: newRows, error: null })
      },
      update(patch) {
        return { eq(col, val) {
          db[name] = db[name].map(r => (r[col] === val ? { ...r, ...patch } : r))
          return Promise.resolve({ data: null, error: null })
        } }
      },
      delete() {
        return { eq(col, val) {
          db[name] = db[name].filter(r => r[col] !== val)
          return Promise.resolve({ data: null, error: null })
        } }
      },
    }
    return q
  }

  return { from, db }
}

const connected = (...agentIds) => agentIds.map(agent_id => ({ agent_id, status: 'connected' }))

const task = (over = {}) => ({
  id: TASK, title: 'Call the seller', type: 'call', priority: 'medium',
  due_date: '2026-12-10T19:00:00.000Z', completed: false, notes: null,
  agent_id: AGENT, contact_id: null, deal_id: null, ...over,
})

const deal = (over = {}) => ({
  id: DEAL, title: '1201 Grand — 24 units', agent_id: AGENT, stage: 'psa',
  comp_data: { key_dates: [{ type: 'Inspection', date: '2026-12-10' }] },
  property_id: null, ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  graph.getValidAccessToken.mockImplementation(async (_svc, agentId) => ({ accessToken: `token-${agentId}` }))
  graph.createCalendarEvent.mockResolvedValue({ id: 'graph-event-1' })
  graph.updateCalendarEvent.mockResolvedValue({ id: 'graph-event-1' })
  graph.deleteCalendarEvent.mockResolvedValue(null)
  graph.listGatewayCalendarEvents.mockResolvedValue([])
})

// ─── 1. A reminder is never set in the past ──────────────────────────────────

describe('the reminder Outlook is asked for is never already overdue', () => {
  const NOW = Date.parse('2026-09-13T12:00:00Z')

  it('leaves the asked-for lead alone when the date is far enough out', () => {
    // 10 days out, 3-day lead — plenty of runway, nothing to adjust.
    expect(resolveReminderLead(NOW + 10 * DAY, 4320, NOW)).toBe(4320)
  })

  it('steps DOWN a lead that would already have gone by', () => {
    // An inspection two days out with a three-day lead: the reminder moment is
    // yesterday. This is the common case, not the edge one.
    expect(resolveReminderLead(NOW + 2 * DAY, 4320, NOW)).toBe(24 * 60)
    // Tomorrow morning — a day's lead is gone too, so two hours.
    expect(resolveReminderLead(NOW + 20 * HOUR, 4320, NOW)).toBe(2 * 60)
    // This afternoon.
    expect(resolveReminderLead(NOW + 45 * MINUTE, 4320, NOW)).toBe(30)
  })

  it('asks for NO reminder at all once the date itself has gone by', () => {
    expect(resolveReminderLead(NOW - HOUR, 4320, NOW)).toBeNull()
    // …and when nothing on the ladder still fits before the start.
    expect(resolveReminderLead(NOW + 5 * MINUTE, 4320, NOW)).toBeNull()
  })

  it('never steps a lead UP — a task asking for 30 minutes keeps 30 minutes', () => {
    expect(resolveReminderLead(NOW + 10 * DAY, 30, NOW)).toBe(30)
  })

  it('turns the reminder off in the event body for a key date already past', () => {
    const body = calendarEventBody({ subject: 'Inspection — 1201 Grand', date: '2026-09-01' }, NOW)
    expect(body.isReminderOn).toBe(false)
    expect(body.reminderMinutesBeforeStart).toBeUndefined()
  })

  it('still carries a real reminder for a key date with runway', () => {
    const body = calendarEventBody({ subject: 'Inspection — 1201 Grand', date: '2026-12-01' }, NOW)
    expect(body.isReminderOn).toBe(true)
    expect(body.reminderMinutesBeforeStart).toBe(4320)
  })
})

// ─── 2. Losing the create race leaves nothing behind ─────────────────────────

describe('a sync that loses the create race does not strand its event', () => {
  it('deletes the surplus event instead of leaving it untracked (key date)', async () => {
    const svc = fakeClient({ ms_graph_connections: connected(AGENT) })

    // The other sync — the one whose fetch came back first — records its row
    // while this one is still waiting on Microsoft.
    graph.createCalendarEvent.mockImplementation(async () => {
      svc.db.deal_calendar_events.push({
        id: 'row-winner', deal_id: DEAL, agent_id: AGENT, date_type: 'Inspection',
        graph_event_id: 'winner-event', event_hash: 'whatever',
      })
      return { id: 'loser-event' }
    })

    const result = await syncDealCalendar(svc, deal())

    // The event this call created is taken back off the calendar…
    expect(graph.deleteCalendarEvent).toHaveBeenCalledWith(`token-${AGENT}`, 'loser-event')
    // …the winner's is untouched…
    expect(graph.deleteCalendarEvent).not.toHaveBeenCalledWith(`token-${AGENT}`, 'winner-event')
    // …exactly one ledger row survives, naming the event that still exists…
    expect(svc.db.deal_calendar_events).toHaveLength(1)
    expect(svc.db.deal_calendar_events[0].graph_event_id).toBe('winner-event')
    // …and nothing is reported as created, because nothing was.
    expect(result.created).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('deletes the surplus event instead of leaving it untracked (task)', async () => {
    const svc = fakeClient({ ms_graph_connections: connected(AGENT) })
    graph.createCalendarEvent.mockImplementation(async () => {
      svc.db.task_calendar_events.push({
        id: 'row-winner', task_id: TASK, agent_id: AGENT,
        graph_event_id: 'winner-event', event_hash: 'whatever',
      })
      return { id: 'loser-event' }
    })

    const result = await syncTaskCalendar(svc, task())

    expect(graph.deleteCalendarEvent).toHaveBeenCalledWith(`token-${AGENT}`, 'loser-event')
    expect(svc.db.task_calendar_events).toHaveLength(1)
    expect(svc.db.task_calendar_events[0].graph_event_id).toBe('winner-event')
    expect(result.created).toBe(0)
  })

  it('still records the event normally when there is no race', async () => {
    const svc = fakeClient({ ms_graph_connections: connected(AGENT) })
    const result = await syncTaskCalendar(svc, task())
    expect(result.created).toBe(1)
    expect(graph.deleteCalendarEvent).not.toHaveBeenCalled()
    expect(svc.db.task_calendar_events).toHaveLength(1)
  })
})

// ─── 3. Sweeping up the duplicates already out there ─────────────────────────

describe('the duplicate sweep clears copies the ledger lost', () => {
  const gatewayEvent = (id, over = {}) => ({
    id,
    subject: 'Inspection — 1201 Grand — 24 units',
    start: { dateTime: '2026-12-10T00:00:00.0000000', timeZone: 'Central Standard Time' },
    isAllDay: true,
    ...over,
  })

  const withLedger = () => fakeClient({
    ms_graph_connections: connected(AGENT),
    deal_calendar_events: [{
      id: 'row-1', deal_id: DEAL, agent_id: AGENT, date_type: 'Inspection',
      graph_event_id: 'tracked', event_hash: 'h',
    }],
  })

  it('deletes the untracked twins and keeps the one the ledger names', async () => {
    const svc = withLedger()
    graph.listGatewayCalendarEvents.mockResolvedValue([
      gatewayEvent('tracked'), gatewayEvent('orphan-a'), gatewayEvent('orphan-b'),
    ])

    const result = await pruneDuplicateCalendarEvents(svc, AGENT)

    expect(result.deleted).toBe(2)
    expect(graph.deleteCalendarEvent).toHaveBeenCalledWith(`token-${AGENT}`, 'orphan-a')
    expect(graph.deleteCalendarEvent).toHaveBeenCalledWith(`token-${AGENT}`, 'orphan-b')
    expect(graph.deleteCalendarEvent).not.toHaveBeenCalledWith(`token-${AGENT}`, 'tracked')
  })

  it('LEAVES ALONE an untracked event with no tracked twin', async () => {
    // Could be an orphan, could be the agent's own entry or a copy they want.
    // Nothing here can tell the difference, so nothing here deletes it.
    const svc = withLedger()
    graph.listGatewayCalendarEvents.mockResolvedValue([
      gatewayEvent('tracked'),
      gatewayEvent('something-else', { subject: 'Closing — 1201 Grand — 24 units' }),
    ])

    const result = await pruneDuplicateCalendarEvents(svc, AGENT)

    expect(result.deleted).toBe(0)
    expect(graph.deleteCalendarEvent).not.toHaveBeenCalled()
  })

  it('does not treat a different date as a duplicate', async () => {
    const svc = withLedger()
    graph.listGatewayCalendarEvents.mockResolvedValue([
      gatewayEvent('tracked'),
      gatewayEvent('moved', { start: { dateTime: '2026-12-17T00:00:00.0000000', timeZone: 'Central Standard Time' } }),
    ])

    const result = await pruneDuplicateCalendarEvents(svc, AGENT)
    expect(result.deleted).toBe(0)
  })

  it('counts an already-deleted event as cleared rather than an error', async () => {
    const svc = withLedger()
    graph.listGatewayCalendarEvents.mockResolvedValue([gatewayEvent('tracked'), gatewayEvent('orphan-a')])
    graph.deleteCalendarEvent.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))

    const result = await pruneDuplicateCalendarEvents(svc, AGENT)
    expect(result.deleted).toBe(1)
    expect(result.errors).toEqual([])
  })

  it('reads nothing from the calendar when the agent has no tracked events', async () => {
    // With no ledger row there is no keeper to prove, so there is nothing this
    // sweep could legitimately delete — and no reason to enumerate anything.
    const svc = fakeClient({ ms_graph_connections: connected(AGENT) })
    const result = await pruneDuplicateCalendarEvents(svc, AGENT)
    expect(result.skipped).toBe(true)
    expect(graph.listGatewayCalendarEvents).not.toHaveBeenCalled()
  })

  it('skips quietly when the mailbox will not answer the category query', async () => {
    const svc = withLedger()
    graph.listGatewayCalendarEvents.mockRejectedValue(Object.assign(new Error('$filter not supported'), { status: 400 }))

    const result = await pruneDuplicateCalendarEvents(svc, AGENT)
    expect(result.skipped).toBe(true)
    expect(graph.deleteCalendarEvent).not.toHaveBeenCalled()
  })
})
