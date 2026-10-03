// ─────────────────────────────────────────────────────────────────────────────
// Moving a deal to a new stage — one path for the board drag and the deal
// page's stage rail.
//
// The board used to run its own copy: it never checked the save (a refused
// move still showed the deal in its new column), wrote no audit entry, and
// gave the stage's follow-up task to the deal's owner — so a co-agent moving a
// deal got a task they couldn't see, and the owner one they hadn't asked for.
// Tasks are personal (tasks_agent_scope), so the task goes to whoever moved it.
//
// The closing gate is not here: it needs the deal's checklist, envelopes and
// commission, which only the deal page loads. The board sends a drop on Closed
// to the deal page instead (see src/pages/deal/DealDrawer.jsx).
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { withRetry } from './db.js'
import { syncTaskCalendar } from './tasks.js'
import { STAGE_AUTO_TASKS } from '../stages.js'
import { audit } from '../audit.js'
import { fireWebhooks } from '../webhooks.js'

/** The follow-up task entering `stage` creates, or null. Pure. */
export function stageAutoTask(deal, stage, actorId, now = new Date()) {
  const auto = STAGE_AUTO_TASKS[stage]
  if (!auto || !deal) return null
  const due = new Date(now)
  due.setDate(due.getDate() + auto.daysOut)
  due.setHours(9, 0, 0, 0)
  return {
    title: auto.title(deal),
    type: auto.type,
    priority: auto.priority,
    due_date: due.toISOString(),
    agent_id: actorId || deal.agent_id || null,
    contact_id: deal.contact_id || null,
    deal_id: deal.id,
    completed: false,
  }
}

/**
 * Save the move, log it, and create the stage's follow-up task.
 * Returns { error, status } on a refused save, otherwise { comp_data, task }
 * (task is null when the stage has none or it couldn't be created).
 */
export async function changeDealStage(deal, newStage, { actorId } = {}) {
  // Stamp stage_since so days-in-stage / rotting stays accurate.
  const comp_data = { ...(deal.comp_data || {}), stage_since: new Date().toISOString() }
  const { error, status } = await withRetry(() =>
    supabase.from('deals').update({ stage: newStage, comp_data }).eq('id', deal.id))
  if (error) return { error, status }
  audit.stageChange(deal, deal.stage, newStage, actorId)
  const hook = { id: deal.id, title: deal.title, from_stage: deal.stage, to_stage: newStage, value: deal.value ?? null }
  fireWebhooks('deal.stage_changed', hook)
  if (newStage === 'closed') fireWebhooks('deal.closed', hook)

  const row = stageAutoTask(deal, newStage, actorId)
  if (!row) return { comp_data, task: null }
  const { data: task } = await supabase.from('tasks').insert([row]).select().single()
  if (task) syncTaskCalendar(task.id)
  return { comp_data, task: task || null }
}
