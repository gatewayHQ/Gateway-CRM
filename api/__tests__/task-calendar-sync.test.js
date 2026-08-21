/**
 * Task due dates → the assigned agent's Outlook calendar
 * (api/_lib/calendarSync.js task half + api/_lib/msGraph.js#calendarEventBody).
 *
 * WHAT THESE GUARD
 *
 * 1. THE POINT OF THE FEATURE. A task saved with a due date has to reach the
 *    calendar the agent actually looks at. If `syncTaskCalendar` stops creating
 *    an event for a plain "call the seller Thursday" task, the CRM is back to
 *    being the only place the date exists.
 *
 * 2. IT COMES BACK OFF AGAIN. Completing a task, clearing its due date,
 *    unassigning it or deleting it must delete the event. A to-do list that
 *    keeps buzzing a phone about work already done is worse than no sync — it
 *    is the reason agents mute a calendar entirely.
 *
 * 3. TIME OF DAY SURVIVES. `tasks.due_date` is a timestamptz and the Add Task
 *    drawer collects a real time, so 2pm must arrive as a timed event at 2pm,
 *    not as an all-day banner (and not shifted by a timezone round-trip). A
 *    midnight due date is the one that means "that day".
 *
 * 4. NO POINTLESS WRITES. The event hash exists so the nightly sweep doesn't
 *    re-PATCH every event every night; a re-sync of an unchanged task must make
 *    no Graph call at all.
 *
 * 5. REASSIGNMENT MOVES THE EVENT. Handing a task to another agent has to take
 *    the event off the first agent's calendar — using THAT agent's token, since
 *    a Graph token only reaches its own owner's calendar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const graph = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
}))

vi.mock('../_lib/msGraph.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, ...graph }
})

const { syncTaskCalendar, syncAllTaskCalendars, taskEventFields, taskWantsCalendarEvent } =
  await import('../_lib/calendarSync.js')
const { calendarEventBody } = await import('../_lib/msGraph.js')

const AGENT   = 'aaaaaaaa-0000-0000-0000-00000000a001'
const AGENT_2 = 'aaaaaaaa-0000-0000-0000-00000000a002'
const TASK    = 'tttttttt-0000-0000-0000-00000000t001'

const task = (over = {}) => ({
  id: TASK, title: 'Call the seller', type: 'call', priority: 'medium',
  due_date: '2026-09-10T19:00:00.000Z', completed: false, notes: null,
  agent_id: AGENT, contact_id: null, deal_id: null, ...over,
})

// ─── A stand-in for the service-key Supabase client ──────────────────────────
// Only the query shapes calendarSync.js actually uses: filtered selects,
// insert, update-by-id and delete-by-column. Rows live in `tables`, so a test
// can assert on what the sync wrote rather than only on what it called.
function fakeClient(tables = {}) {
  const db = { task_calendar_events: [], ms_graph_connections: [], tasks: [], contacts: [], deals: [], ...tables }
  const writes = []

  const from = (name) => {
    const filters = []
    const match = row => filters.every(([col, val, op]) =>
      op === 'in' ? val.includes(row[col])
        : op === 'not-null' ? row[col] !== null && row[col] !== undefined
        : row[col] === val)
    const rows = () => (db[name] || []).filter(match)

    const q = {
      select() { return q },
      eq(col, val)  { filters.push([col, val]); return q },
      in(col, val)  { filters.push([col, val, 'in']); return q },
      not(col)      { filters.push([col, null, 'not-null']); return q },
      order()       { return q },
      limit()       { return Promise.resolve({ data: rows() }) },
      maybeSingle() { return Promise.resolve({ data: rows()[0] || null }) },
      single()      { return Promise.resolve({ data: rows()[0] || null }) },
      then(res, rej) { return Promise.resolve({ data: rows() }).then(res, rej) },
      insert(newRows) {
        db[name] = [...(db[name] || []), ...newRows.map((r, i) => ({ id: `row-${db[name].length + i}`, ...r }))]
        writes.push({ op: 'insert', table: name, rows: newRows })
        return Promise.resolve({ data: newRows })
      },
      update(patch) {
        writes.push({ op: 'update', table: name, patch })
        return { eq(col, val) {
          db[name] = db[name].map(r => (r[col] === val ? { ...r, ...patch } : r))
          return Promise.resolve({ data: null })
        } }
      },
      delete() {
        return { eq(col, val) {
          writes.push({ op: 'delete', table: name, col, val })
          db[name] = db[name].filter(r => r[col] !== val)
          return Promise.resolve({ data: null })
        } }
      },
    }
    return q
  }

  return { from, db, writes }
}

const connected = (...agentIds) => agentIds.map(agent_id => ({ agent_id, status: 'connected' }))

beforeEach(() => {
  vi.clearAllMocks()
  graph.getValidAccessToken.mockImplementation(async (_svc, agentId) => ({ accessToken: `token-${agentId}` }))
  graph.createCalendarEvent.mockResolvedValue({ id: 'graph-event-1' })
  graph.updateCalendarEvent.mockResolvedValue({ id: 'graph-event-1' })
  graph.deleteCalendarEvent.mockResolvedValue(null)
})

// ─── A dated task reaches the calendar ───────────────────────────────────────

describe('a task created with a due date lands on the assignee\'s calendar', () => {
  it('creates the Graph event and records the ledger row', async () => {
    const svc = fakeClient({ ms_graph_connections: connected(AGENT) })

    const result = await syncTaskCalendar(svc, task())

    expect(result).toMatchObject({ created: 1, updated: 0, deleted: 0 })
    expect(graph.createCalendarEvent).toHaveBeenCalledTimes(1)
    const [token, fields] = graph.createCalendarEvent.mock.calls[0]
    expect(token).toBe(`token-${AGENT}`)              // the ASSIGNEE's calendar
    expect(fields.subject).toContain('Call the seller')
    expect(svc.db.task_calendar_events).toHaveLength(1)
    expect(svc.db.task_calendar_events[0]).toMatchObject({
      task_id: TASK, agent_id: AGENT, graph_event_id: 'graph-event-1',
    })
  })

  it('carries the contact, deal and notes into the event body', () => {
    const { fields } = taskEventFields(
      task({ notes: 'Bring the comps', priority: 'high' }),
      { contact: { first_name: 'Janet', last_name: 'Hala' }, deal: { title: '1201 Grand — 24 units' } },
    )
    expect(fields.bodyHtml).toContain('Janet Hala')
    expect(fields.bodyHtml).toContain('1201 Grand — 24 units')
    expect(fields.bodyHtml).toContain('Bring the comps')
    expect(fields.bodyHtml).toContain('high')
  })

  it('does nothing when the assignee has no Outlook connection', async () => {
    const svc = fakeClient()                            // no ms_graph_connections row
    const result = await syncTaskCalendar(svc, task())
    expect(result.skipped).toBe(true)
    expect(graph.createCalendarEvent).not.toHaveBeenCalled()
    expect(svc.db.task_calendar_events).toHaveLength(0)
  })

  it('skips an unassigned task — there is no calendar to write to', async () => {
    const svc = fakeClient({ ms_graph_connections: connected(AGENT) })
    const result = await syncTaskCalendar(svc, task({ agent_id: null }))
    expect(result.skipped).toBe(true)
    expect(graph.createCalendarEvent).not.toHaveBeenCalled()
  })
})

// ─── Time of day ─────────────────────────────────────────────────────────────

describe('time of day survives the trip to Outlook', () => {
  it('a task due at a specific time becomes a timed event at that instant', () => {
    const { fields, allDay } = taskEventFields(task({ due_date: '2026-09-10T19:00:00.000Z' }))
    expect(allDay).toBe(false)
    expect(fields.startsAt).toBe('2026-09-10T19:00:00.000Z')

    const body = calendarEventBody(fields)
    expect(body.isAllDay).toBe(false)
    expect(body.start).toEqual({ dateTime: '2026-09-10T19:00:00', timeZone: 'UTC' })
    expect(body.end).toEqual({ dateTime: '2026-09-10T19:30:00', timeZone: 'UTC' })
    expect(body.reminderMinutesBeforeStart).toBe(30)   // not the key-date 3 days
  })

  it('a midnight due date means "that day" — an all-day event', () => {
    const { fields, allDay } = taskEventFields(task({ due_date: '2026-09-10T00:00:00.000Z' }))
    expect(allDay).toBe(true)
    expect(fields.date).toBe('2026-09-10')

    const body = calendarEventBody(fields)
    expect(body.isAllDay).toBe(true)
    expect(body.start.dateTime).toBe('2026-09-10T00:00:00')
    expect(body.end.dateTime).toBe('2026-09-11T00:00:00')   // Graph's end is exclusive
  })

  it('tags every event so an agent can tell where it came from', () => {
    expect(calendarEventBody(taskEventFields(task()).fields).categories).toEqual(['Gateway CRM'])
  })
})

// ─── The event comes back off again ──────────────────────────────────────────

describe('an event that should no longer exist is deleted', () => {
  const ledgerRow = {
    id: 'led-1', task_id: TASK, agent_id: AGENT,
    graph_event_id: 'graph-event-1', event_hash: 'stale',
  }

  it.each([
    ['the task is completed',        { completed: true }],
    ['the due date is cleared',      { due_date: null }],
    ['the task is unassigned',       { agent_id: null }],
  ])('%s', async (_label, patch) => {
    const svc = fakeClient({
      ms_graph_connections: connected(AGENT),
      task_calendar_events: [{ ...ledgerRow }],
    })

    const result = await syncTaskCalendar(svc, task(patch))

    expect(result.deleted).toBe(1)
    expect(graph.deleteCalendarEvent).toHaveBeenCalledWith(`token-${AGENT}`, 'graph-event-1')
    expect(svc.db.task_calendar_events).toHaveLength(0)
    expect(graph.createCalendarEvent).not.toHaveBeenCalled()
  })

  it('purge deletes the event for a task about to be deleted', async () => {
    const svc = fakeClient({
      ms_graph_connections: connected(AGENT),
      task_calendar_events: [{ ...ledgerRow }],
    })
    // What the client sends just before deleting the row: the id is all it has.
    const result = await syncTaskCalendar(svc, { id: TASK }, { purge: true })
    expect(result.deleted).toBe(1)
    expect(svc.db.task_calendar_events).toHaveLength(0)
  })

  it('treats an event the agent already deleted in Outlook as done, not failed', async () => {
    const svc = fakeClient({
      ms_graph_connections: connected(AGENT),
      task_calendar_events: [{ ...ledgerRow }],
    })
    graph.deleteCalendarEvent.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))

    const result = await syncTaskCalendar(svc, task({ completed: true }))

    expect(result.errors).toEqual([])
    expect(result.deleted).toBe(1)
    expect(svc.db.task_calendar_events).toHaveLength(0)   // ledger row cleaned up too
  })

  it('keeps the ledger row when the delete fails for a real reason', async () => {
    const svc = fakeClient({
      ms_graph_connections: connected(AGENT),
      task_calendar_events: [{ ...ledgerRow }],
    })
    graph.deleteCalendarEvent.mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { status: 503 }))

    const result = await syncTaskCalendar(svc, task({ completed: true }))

    expect(result.errors).toHaveLength(1)
    expect(svc.db.task_calendar_events).toHaveLength(1)    // retried by the nightly sweep
  })
})

// ─── Diffing ─────────────────────────────────────────────────────────────────

describe('re-syncing only writes when something changed', () => {
  it('an unchanged task makes no Graph call at all', async () => {
    const { hash } = taskEventFields(task())
    const svc = fakeClient({
      ms_graph_connections: connected(AGENT),
      task_calendar_events: [{ id: 'led-1', task_id: TASK, agent_id: AGENT, graph_event_id: 'graph-event-1', event_hash: hash }],
    })

    const result = await syncTaskCalendar(svc, task())

    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0 })
    expect(graph.createCalendarEvent).not.toHaveBeenCalled()
    expect(graph.updateCalendarEvent).not.toHaveBeenCalled()
  })

  it('a moved due date patches the existing event instead of making a second one', async () => {
    const { hash } = taskEventFields(task())
    const svc = fakeClient({
      ms_graph_connections: connected(AGENT),
      task_calendar_events: [{ id: 'led-1', task_id: TASK, agent_id: AGENT, graph_event_id: 'graph-event-1', event_hash: hash }],
    })

    const result = await syncTaskCalendar(svc, task({ due_date: '2026-09-11T19:00:00.000Z' }))

    expect(result).toMatchObject({ created: 0, updated: 1 })
    expect(graph.updateCalendarEvent).toHaveBeenCalledWith(`token-${AGENT}`, 'graph-event-1', expect.any(Object))
    expect(svc.db.task_calendar_events).toHaveLength(1)
  })

  it('a renamed task updates the event subject', async () => {
    const a = taskEventFields(task()).hash
    const b = taskEventFields(task({ title: 'Call the seller back' })).hash
    expect(a).not.toBe(b)
  })
})

// ─── Reassignment ────────────────────────────────────────────────────────────

describe('reassigning a task moves the event', () => {
  it('deletes from the old agent with the OLD agent\'s token, creates for the new one', async () => {
    const svc = fakeClient({
      ms_graph_connections: connected(AGENT, AGENT_2),
      task_calendar_events: [{ id: 'led-1', task_id: TASK, agent_id: AGENT, graph_event_id: 'graph-event-1', event_hash: 'stale' }],
    })

    const result = await syncTaskCalendar(svc, task({ agent_id: AGENT_2 }))

    expect(graph.deleteCalendarEvent).toHaveBeenCalledWith(`token-${AGENT}`, 'graph-event-1')
    expect(graph.createCalendarEvent).toHaveBeenCalledWith(`token-${AGENT_2}`, expect.any(Object))
    expect(result).toMatchObject({ created: 1, deleted: 1 })
    expect(svc.db.task_calendar_events).toEqual([
      expect.objectContaining({ task_id: TASK, agent_id: AGENT_2 }),
    ])
  })
})

// ─── The nightly sweep ───────────────────────────────────────────────────────

describe('the nightly sweep', () => {
  it('syncs open dated tasks and cleans up ledger rows whose task is gone', async () => {
    const svc = fakeClient({
      ms_graph_connections: connected(AGENT),
      tasks: [task()],
      task_calendar_events: [
        // A task deleted outside the app (or whose purge call never landed).
        { id: 'led-orphan', task_id: 'tttttttt-0000-0000-0000-00000000t999', agent_id: AGENT, graph_event_id: 'graph-event-9', event_hash: 'x' },
      ],
    })

    const result = await syncAllTaskCalendars(svc)

    expect(result.ok).toBe(true)
    expect(result.synced).toBe(1)
    expect(result.cleaned).toBe(1)
    expect(graph.createCalendarEvent).toHaveBeenCalledTimes(1)
    expect(graph.deleteCalendarEvent).toHaveBeenCalledWith(`token-${AGENT}`, 'graph-event-9')
  })

  it('does no work when nobody has Outlook connected', async () => {
    const svc = fakeClient({ tasks: [task()] })
    const result = await syncAllTaskCalendars(svc)
    expect(result).toMatchObject({ ok: true, synced: 0 })
    expect(graph.getValidAccessToken).not.toHaveBeenCalled()
  })

  it('one agent\'s Graph failure does not stop the rest of the sweep', async () => {
    const svc = fakeClient({
      ms_graph_connections: connected(AGENT, AGENT_2),
      tasks: [task(), task({ id: 'tttttttt-0000-0000-0000-00000000t002', agent_id: AGENT_2 })],
    })
    graph.createCalendarEvent.mockRejectedValueOnce(Object.assign(new Error('Graph is down'), { status: 503 }))

    const result = await syncAllTaskCalendars(svc)

    expect(result.errors).toHaveLength(1)
    expect(graph.createCalendarEvent).toHaveBeenCalledTimes(2)   // the second task still tried
    expect(svc.db.task_calendar_events).toHaveLength(1)
  })
})

// ─── The predicate the whole feature turns on ────────────────────────────────

describe('taskWantsCalendarEvent', () => {
  it.each([
    [{ due_date: '2026-09-10T19:00:00Z', agent_id: AGENT, completed: false }, true],
    [{ due_date: null,                   agent_id: AGENT, completed: false }, false],
    [{ due_date: '2026-09-10T19:00:00Z', agent_id: null,  completed: false }, false],
    [{ due_date: '2026-09-10T19:00:00Z', agent_id: AGENT, completed: true  }, false],
  ])('%o → %s', (t, expected) => {
    expect(taskWantsCalendarEvent(t)).toBe(expected)
  })
})

// ─── Scoping the orphan cleanup ──────────────────────────────────────────────

describe('onlyAgentId scopes a purge to one agent\'s own calendar', () => {
  it('leaves another agent\'s event alone', async () => {
    const svc = fakeClient({
      ms_graph_connections: connected(AGENT, AGENT_2),
      task_calendar_events: [
        { id: 'led-1', task_id: TASK, agent_id: AGENT_2, graph_event_id: 'graph-event-2', event_hash: 'x' },
      ],
    })

    // What the endpoint sends when the task row is already gone: the caller may
    // only clean up their OWN calendar, since the task can no longer say who
    // was allowed to act on it.
    const result = await syncTaskCalendar(svc, { id: TASK }, { purge: true, onlyAgentId: AGENT })

    expect(result.skipped).toBe(true)
    expect(graph.deleteCalendarEvent).not.toHaveBeenCalled()
    expect(svc.db.task_calendar_events).toHaveLength(1)
  })

  it('still cleans up the caller\'s own orphaned event', async () => {
    const svc = fakeClient({
      ms_graph_connections: connected(AGENT),
      task_calendar_events: [
        { id: 'led-1', task_id: TASK, agent_id: AGENT, graph_event_id: 'graph-event-1', event_hash: 'x' },
      ],
    })

    const result = await syncTaskCalendar(svc, { id: TASK }, { purge: true, onlyAgentId: AGENT })

    expect(result.deleted).toBe(1)
    expect(svc.db.task_calendar_events).toHaveLength(0)
  })
})
