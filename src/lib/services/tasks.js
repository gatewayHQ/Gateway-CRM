// ─────────────────────────────────────────────────────────────────────────────
// Task → calendar sync, client side.
//
// A task with a due date belongs on the assigned agent's own calendar, not just
// on the CRM's Tasks page: the whole point of writing down "call the seller
// Thursday at 2" is that Thursday at 2 you get a reminder from the device in
// your pocket. api/email-send.js?action=outlook-task-calendar-sync does the
// work (see api/_lib/calendarSync.js#syncTaskCalendar); this is the one door
// the seven-odd screens that create tasks go through so none of them has to
// know that.
//
// Every call is BEST-EFFORT and fire-and-forget. Tasks are created from
// drawers, quick-add forms, cold-call flows and deal panels, all of which
// already report their own save result — a calendar that is momentarily behind
// must never turn a saved task into a visible error, and the nightly
// api/cron.js?task=calendar-sync sweep repairs anything this misses.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

/**
 * Push one task's due date onto the assigned agent's calendar: create, update
 * or delete the mirroring event so it matches the stored row.
 *
 * Silently does nothing when Outlook isn't connected, when the task has no due
 * date or no assignee, or when it's already completed — the server decides all
 * of that from the stored row, so callers never have to.
 *
 * @param {string} taskId
 * @param {{ purge?: boolean }} [opts] purge deletes the event whatever state
 *   the task is in. Call it that way immediately BEFORE deleting a task: the
 *   ledger row that points at the calendar event cascades away with the task,
 *   so afterwards there is nothing left to find the event by.
 */
export async function syncTaskCalendar(taskId, { purge = false } = {}) {
  if (!taskId) return
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.access_token) return
    await fetch('/api/email-send?action=outlook-task-calendar-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ taskId, purge }),
    })
  } catch {
    // best-effort — the nightly sweep is the safety net
  }
}

/**
 * Delete a task, taking its calendar event with it.
 *
 * The purge is awaited on purpose — unlike every other call here, ordering
 * matters: once the task row is gone so is the ledger row that names the Graph
 * event, and the event would sit on the agent's calendar with nothing left to
 * delete it by. A failed purge still lets the delete proceed (the sweep's
 * stale-row pass is the backstop) rather than blocking the user's delete.
 */
export async function deleteTask(id) {
  await syncTaskCalendar(id, { purge: true })
  return supabase.from('tasks').delete().eq('id', id)
}
