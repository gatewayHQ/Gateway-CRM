// ─────────────────────────────────────────────────────────────────────────────
// What hangs off a deal's timeline: logged activities, the agent's tasks on the
// deal, and the key-date reminders already sent for it.
//
// Results come back exactly as Supabase returns them, so callers keep their own
// retry (withRetry), error messages and state updates.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

export const createDealActivity = (row) =>
  supabase.from('activities').insert([row]).select().single()

export const createDealTask = (row) =>
  supabase.from('tasks').insert([row]).select().single()

export const markTaskComplete = (taskId) =>
  supabase.from('tasks').update({ completed: true }).eq('id', taskId)

// RLS makes tasks strictly personal, so this only ever reaches the caller's
// own tasks on the deal.
export const unlinkDealTasks = (dealId) =>
  supabase.from('tasks').update({ deal_id: null }).eq('deal_id', dealId)

export const fetchDealSentReminders = (dealId) =>
  supabase.from('deadline_reminders').select('date_type, threshold').eq('deal_id', dealId)
