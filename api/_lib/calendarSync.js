// ─────────────────────────────────────────────────────────────────────────────
// CRM dates → Outlook calendar sync — shared logic.
//
// Two kinds of date get pushed onto an agent's own calendar:
//   • a DEAL's key dates          (syncDealCalendar / syncAllDealCalendars)
//   • a TASK's due date           (syncTaskCalendar / syncAllTaskCalendars)
// The task half is at the bottom of this file; the deal half is first.
//
// Called from two places (both server-only, service-key client):
//   • api/cron.js       ?task=calendar-sync — nightly sweep, every deal AND
//     every open task with a due date
//   • api/email-send.js ?action=outlook-calendar-sync      — on-demand, one
//     deal, fired right after an agent edits a key date (src/pages/Pipeline.jsx)
//     ?action=outlook-task-calendar-sync — on-demand, one task, fired right
//     after a task is created/edited/completed/deleted (src/lib/services/tasks.js)
//
// Both need IDENTICAL diffing/create/update/delete logic, so it lives here
// once rather than being duplicated per entry point (migrations/README's
// "single source of truth" convention, applied to code instead of schema).
//
// Sync model: an open deal's comp_data.key_dates (each {type, date}) should
// map 1:1 to a row in deal_calendar_events + a Graph event on the ASSIGNED
// AGENT's own calendar. A closed/lost deal has no key dates to sync — any
// events already created for it get deleted (see resolveKeyDates below), so a
// dead deal doesn't leave stale reminders on someone's calendar forever.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto'
import { getValidAccessToken, createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from './msGraph.js'
import { isOpenStage } from '../../src/lib/stages.js'
import { streetLine, readPropertiesWithUnit } from '../../src/lib/address.js'

function eventHash(entry, dealTitle, propertyAddress) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([entry.type, entry.date, dealTitle, propertyAddress || '']))
    .digest('hex')
    .slice(0, 16)
}

// A closed/lost deal has nothing to sync — its key dates are treated as empty
// so the diff below deletes every event already created for it.
function resolveKeyDates(deal) {
  if (!isOpenStage(deal.stage)) return []
  return (deal.comp_data?.key_dates || []).filter(e => e?.date && e?.type)
}

// Sync one deal's key dates to its assigned agent's Outlook calendar.
// Returns { skipped: true, reason } if the agent isn't connected, otherwise
// { created, updated, deleted, errors }.
export async function syncDealCalendar(svc, deal, { property } = {}) {
  const { data: conn } = await svc.from('ms_graph_connections')
    .select('agent_id, status').eq('agent_id', deal.agent_id).maybeSingle()
  if (!conn || conn.status !== 'connected') {
    return { skipped: true, reason: 'Outlook not connected for this deal\'s agent' }
  }

  const { data: existingRows } = await svc.from('deal_calendar_events')
    .select('*').eq('deal_id', deal.id).eq('agent_id', deal.agent_id)
  const existingByType = Object.fromEntries((existingRows || []).map(r => [r.date_type, r]))

  let accessToken
  try {
    ;({ accessToken } = await getValidAccessToken(svc, deal.agent_id))
  } catch (err) {
    return { skipped: true, reason: err.message }
  }

  // The suite belongs in the calendar entry — an agent with two spaces in the
  // same building can't tell the events apart from the street line alone.
  const propertyAddress = streetLine(property) || null
  const keyDates = resolveKeyDates(deal)
  const seenTypes = new Set()
  const result = { created: 0, updated: 0, deleted: 0, errors: [] }

  for (const entry of keyDates) {
    seenTypes.add(entry.type)
    const hash = eventHash(entry, deal.title, propertyAddress)
    const existing = existingByType[entry.type]
    if (existing && existing.event_hash === hash) continue   // unchanged — skip the write entirely

    const subject  = `${entry.type} — ${deal.title}`
    const bodyHtml = `Gateway CRM deal: <b>${deal.title}</b>${propertyAddress ? `<br>${propertyAddress}` : ''}`

    try {
      if (existing) {
        await updateCalendarEvent(accessToken, existing.graph_event_id, { subject, date: entry.date, bodyHtml })
        await svc.from('deal_calendar_events')
          .update({ event_hash: hash, last_synced_at: new Date().toISOString() })
          .eq('id', existing.id)
        result.updated++
      } else {
        const created = await createCalendarEvent(accessToken, { subject, date: entry.date, bodyHtml })
        await svc.from('deal_calendar_events').insert([{
          deal_id: deal.id, agent_id: deal.agent_id, date_type: entry.type,
          graph_event_id: created.id, event_hash: hash,
        }])
        result.created++
      }
    } catch (err) {
      result.errors.push({ type: entry.type, error: err.message })
    }
  }

  // Key dates removed from the deal (or the deal closed) — delete the events
  // that no longer have a matching entry.
  for (const row of existingRows || []) {
    if (seenTypes.has(row.date_type)) continue
    try {
      await deleteCalendarEvent(accessToken, row.graph_event_id)
    } catch (err) {
      if (err.status !== 404) result.errors.push({ type: row.date_type, error: err.message })
    }
    await svc.from('deal_calendar_events').delete().eq('id', row.id)
    result.deleted++
  }

  return result
}

// Nightly safety net: every deal whose assigned agent has Outlook connected.
// Catches drift the on-demand path can't (a manually deleted calendar event,
// a deal that closed since its last key-date edit, a sync that failed
// mid-request). Bounded like the other cron tasks — see the 200-deal caps
// elsewhere in api/cron.js — so one run can't run away on a very large book.
export async function syncAllDealCalendars(svc) {
  const { data: connections } = await svc.from('ms_graph_connections')
    .select('agent_id').eq('status', 'connected')
  const connectedAgentIds = (connections || []).map(c => c.agent_id)
  if (!connectedAgentIds.length) {
    return { ok: true, message: 'No agents have Outlook connected', synced: 0, total: 0 }
  }

  const { data: deals } = await svc.from('deals')
    .select('id, title, agent_id, stage, comp_data, property_id')
    .in('agent_id', connectedAgentIds)
    .limit(500)

  // Only deals that either have key dates now, or might still have stale
  // events from key dates that were since removed/closed — i.e. anything with
  // a comp_data.key_dates array at all, open or not.
  const candidates = (deals || []).filter(d => Array.isArray(d.comp_data?.key_dates) && d.comp_data.key_dates.length > 0)
  if (!candidates.length) {
    return { ok: true, message: 'No deals with key dates', synced: 0, total: 0 }
  }

  const propertyIds = [...new Set(candidates.map(d => d.property_id).filter(Boolean))]
  const { data: properties } = propertyIds.length
    ? await readPropertiesWithUnit('id, address', (cols) => svc.from('properties').select(cols).in('id', propertyIds))
    : { data: [] }
  const propertyMap = Object.fromEntries((properties || []).map(p => [p.id, p]))

  let synced = 0
  const errors = []
  for (const deal of candidates) {
    const result = await syncDealCalendar(svc, deal, { property: propertyMap[deal.property_id] })
    if (!result.skipped) synced++
    if (result.errors?.length) errors.push({ deal: deal.title, errors: result.errors })
  }

  return { ok: true, synced, total: candidates.length, errors }
}

// ─────────────────────────────────────────────────────────────────────────────
// Task due dates → Outlook calendar sync
//
// Same shape as the deal key-date sync above, one level simpler: a task has at
// most ONE date (tasks.due_date), so the ledger is one row per task rather than
// one per (deal, date_type).
//
// A task earns a calendar event when it has a due date AND an assigned agent
// (whose calendar it goes on) AND is not completed. Miss any of those and the
// event is deleted instead — a task ticked off in the CRM should not keep
// nagging from the agent's phone, and an unassigned task has no calendar to go
// on at all.
//
// Unlike a key date, a due date is a timestamptz and the Add Task drawer
// collects a real time of day, so a task due at 2pm becomes a 30-minute timed
// event with a 30-minute reminder. A due date that landed exactly on midnight
// is treated as "that day" and becomes an all-day event with the standard
// (3-day) lead time, matching how key dates already appear.
// ─────────────────────────────────────────────────────────────────────────────

// 30 minutes' warning for a timed task — a task due at 2pm is actionable now,
// not in three days (the key-date default, which still applies to an all-day
// task; see msGraph.js#CALENDAR_REMINDER_MINUTES).
const TASK_REMINDER_MINUTES = Number(process.env.MS_TASK_REMINDER_MINUTES || 30)
const TASK_DURATION_MINUTES = Number(process.env.MS_TASK_DURATION_MINUTES || 30)

// A midnight-UTC due date carries no meaningful time of day (it came from a
// date-only picker, an import, or a `due_date` built from a bare date string),
// so it reads as "sometime on the 14th" → all-day event.
function isAllDayDue(dueDate) {
  const d = new Date(dueDate)
  if (Number.isNaN(d.getTime())) return false
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0
}

// Exported for the sweep below and for tests: does this task belong on a
// calendar at all right now?
export function taskWantsCalendarEvent(task) {
  return Boolean(task?.due_date) && Boolean(task?.agent_id) && !task?.completed
}

// The Graph event fields for one task, plus the hash of everything that would
// change the event. Pure — no Graph, no database — so the event's wording and
// the all-day/timed decision are testable on their own.
export function taskEventFields(task, { contact, deal } = {}) {
  const allDay = isAllDayDue(task.due_date)
  const typeLabel = task.type && task.type !== 'other' ? task.type : 'task'
  const subject = `${typeLabel.charAt(0).toUpperCase()}${typeLabel.slice(1)}: ${task.title}`

  const contactName = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : null
  const lines = [`Gateway CRM task: <b>${task.title}</b>`]
  if (contactName) lines.push(`Contact: ${contactName}`)
  if (deal?.title)  lines.push(`Deal: ${deal.title}`)
  if (task.priority && task.priority !== 'medium') lines.push(`Priority: ${task.priority}`)
  if (task.notes) lines.push(String(task.notes))

  const fields = {
    subject,
    bodyHtml: lines.join('<br>'),
    ...(allDay
      ? { date: new Date(task.due_date).toISOString().slice(0, 10) }
      : { startsAt: new Date(task.due_date).toISOString(), durationMinutes: TASK_DURATION_MINUTES, reminderMinutes: TASK_REMINDER_MINUTES }),
  }

  const hash = crypto.createHash('sha256')
    .update(JSON.stringify([fields.subject, fields.bodyHtml, fields.date || null, fields.startsAt || null]))
    .digest('hex')
    .slice(0, 16)

  return { fields, hash, allDay }
}

// Remove whatever event a ledger row points at, then the row. Used when a task
// is completed, loses its due date, is reassigned to another agent, or is about
// to be deleted. A 404 means the agent already deleted it in Outlook — that is
// success, not a failure worth reporting.
async function dropTaskEvent(svc, accessToken, row, result) {
  try {
    await deleteCalendarEvent(accessToken, row.graph_event_id)
  } catch (err) {
    if (err.status !== 404) {
      result.errors.push({ task: row.task_id, error: err.message })
      return
    }
  }
  await svc.from('task_calendar_events').delete().eq('id', row.id)
  result.deleted++
}

// Sync ONE task to the assigned agent's calendar.
//
// `purge: true` deletes the task's event regardless of the task's current
// state — the client calls it that way immediately BEFORE deleting a task,
// since the ledger row cascades away with the task and the Graph event would
// otherwise be left behind on the calendar with nothing pointing at it.
//
// Returns { skipped: true, reason } when there is no connected calendar to
// write to, otherwise { created, updated, deleted, errors }.
export async function syncTaskCalendar(svc, task, { contact, deal, purge = false, onlyAgentId = null } = {}) {
  const result = { created: 0, updated: 0, deleted: 0, errors: [] }

  const { data: existingRows } = await svc.from('task_calendar_events')
    .select('*').eq('task_id', task.id)
  // `onlyAgentId` narrows the sweep to ONE agent's rows. The endpoint passes it
  // when the task row itself is already gone (a delete whose purge lost the
  // race), where the task can no longer vouch for who is allowed to act on it —
  // so the caller may only clean events off their own calendar.
  const rows = (existingRows || []).filter(r => !onlyAgentId || r.agent_id === onlyAgentId)

  // Which agent's calendar is in play: the assignee's, or — when the task no
  // longer has one (unassigned, reassigned, deleted) — whoever's calendar the
  // existing event is actually sitting on, so it can be cleaned up there.
  const wanted = !purge && taskWantsCalendarEvent(task)
  const agentId = wanted ? task.agent_id : rows[0]?.agent_id
  if (!agentId) return { ...result, skipped: true, reason: 'Task has no assigned agent with a calendar event' }

  const { data: conn } = await svc.from('ms_graph_connections')
    .select('agent_id, status').eq('agent_id', agentId).maybeSingle()
  if (!conn || conn.status !== 'connected') {
    return { ...result, skipped: true, reason: 'Outlook not connected for this task\'s agent' }
  }

  let accessToken
  try {
    ;({ accessToken } = await getValidAccessToken(svc, agentId))
  } catch (err) {
    return { ...result, skipped: true, reason: err.message }
  }

  // Anything on the wrong calendar (the task was reassigned) or no longer
  // wanted (completed, date cleared, being deleted) comes off first. A row on
  // ANOTHER agent's calendar needs that agent's own token, so it gets one —
  // otherwise reassigning a task would leave the event on the old agent's
  // calendar forever, which is exactly the kind of stale reminder this ledger
  // exists to prevent.
  const keep = wanted ? rows.filter(r => r.agent_id === agentId) : []
  for (const row of rows) {
    if (keep.includes(row)) continue
    let token = accessToken
    if (row.agent_id !== agentId) {
      try {
        ;({ accessToken: token } = await getValidAccessToken(svc, row.agent_id))
      } catch (err) {
        result.errors.push({ task: row.task_id, error: err.message })
        continue
      }
    }
    await dropTaskEvent(svc, token, row, result)
  }
  if (!wanted) return result

  const { fields, hash } = taskEventFields(task, { contact, deal })
  const existing = keep[0]
  if (existing && existing.event_hash === hash) return result   // unchanged — no write at all

  try {
    if (existing) {
      await updateCalendarEvent(accessToken, existing.graph_event_id, fields)
      await svc.from('task_calendar_events')
        .update({ event_hash: hash, last_synced_at: new Date().toISOString() })
        .eq('id', existing.id)
      result.updated++
    } else {
      const created = await createCalendarEvent(accessToken, fields)
      await svc.from('task_calendar_events').insert([{
        task_id: task.id, agent_id: agentId, graph_event_id: created.id, event_hash: hash,
      }])
      result.created++
    }
  } catch (err) {
    result.errors.push({ task: task.id, error: err.message })
  }

  return result
}

// Nightly safety net for tasks, mirroring syncAllDealCalendars: every open task
// with a due date belonging to an agent who has Outlook connected, plus every
// ledger row whose task no longer wants an event (completed since the last
// sync, due date cleared, reassigned) so its event gets cleaned up.
//
// Bounded like the other cron tasks so one run can't run away on a large book.
export async function syncAllTaskCalendars(svc) {
  const { data: connections } = await svc.from('ms_graph_connections')
    .select('agent_id').eq('status', 'connected')
  const connectedAgentIds = (connections || []).map(c => c.agent_id)
  if (!connectedAgentIds.length) {
    return { ok: true, message: 'No agents have Outlook connected', synced: 0, total: 0 }
  }

  const { data: tasks } = await svc.from('tasks')
    .select('id, title, type, priority, due_date, completed, notes, agent_id, contact_id, deal_id')
    .in('agent_id', connectedAgentIds)
    .eq('completed', false)
    .not('due_date', 'is', null)
    .order('due_date', { ascending: true })
    .limit(500)

  // Ledger rows on a connected agent's calendar whose task is no longer in the
  // syncable set above — the event has to come back off the calendar.
  const { data: ledger } = await svc.from('task_calendar_events')
    .select('task_id, agent_id').in('agent_id', connectedAgentIds).limit(1000)
  const syncableIds = new Set((tasks || []).map(t => t.id))
  const staleIds = [...new Set((ledger || []).map(r => r.task_id).filter(id => !syncableIds.has(id)))]

  const candidates = tasks || []
  if (!candidates.length && !staleIds.length) {
    return { ok: true, message: 'No tasks with due dates', synced: 0, total: 0 }
  }

  const contactIds = [...new Set(candidates.map(t => t.contact_id).filter(Boolean))]
  const dealIds    = [...new Set(candidates.map(t => t.deal_id).filter(Boolean))]
  const { data: contacts } = contactIds.length
    ? await svc.from('contacts').select('id, first_name, last_name').in('id', contactIds)
    : { data: [] }
  const { data: deals } = dealIds.length
    ? await svc.from('deals').select('id, title').in('id', dealIds)
    : { data: [] }
  const contactMap = Object.fromEntries((contacts || []).map(c => [c.id, c]))
  const dealMap    = Object.fromEntries((deals || []).map(d => [d.id, d]))

  let synced = 0
  let cleaned = 0
  const errors = []
  for (const task of candidates) {
    const result = await syncTaskCalendar(svc, task, {
      contact: contactMap[task.contact_id], deal: dealMap[task.deal_id],
    })
    if (!result.skipped) synced++
    if (result.errors?.length) errors.push({ task: task.title, errors: result.errors })
  }
  // Tasks the query above no longer returns — completed, un-dated, deleted.
  // Passing the bare id is enough: with no due date on the object, the sync
  // treats it as unwanted and deletes whatever the ledger points at.
  for (const taskId of staleIds) {
    const result = await syncTaskCalendar(svc, { id: taskId }, { purge: true })
    if (result.deleted) cleaned++
    if (result.errors?.length) errors.push({ task: taskId, errors: result.errors })
  }

  return { ok: true, synced, cleaned, total: candidates.length, errors }
}
