// ─────────────────────────────────────────────────────────────────────────────
// Transaction steps service — checklist read + toggle + audit.
//
// Lifted out of DealPage so any view that wants to show or tick a deal's
// checklist (mobile, admin queue, client portal in the future) goes through
// the same path. Toggle returns the updated row so callers can patch local
// state without a round-trip.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { TABLES } from '../constants.js'
import { audit } from '../audit.js'

export async function listDealSteps(dealId) {
  const { data, error } = await supabase
    .from(TABLES.TRANSACTION_STEPS)
    .select('id, title, completed, sort_order, doc_action, doc_status, if_applicable')
    .eq('deal_id', dealId)
    .order('sort_order', { ascending: true })
  return { steps: data || [], error: error?.message || null }
}

export async function toggleDealStep(deal, step, { actorId } = {}) {
  if (!step?.id) return { ok: false, error: 'step missing' }
  const completed = !step.completed
  const { error } = await supabase
    .from(TABLES.TRANSACTION_STEPS)
    .update({ completed, completed_at: completed ? new Date().toISOString() : null })
    .eq('id', step.id)
  if (error) return { ok: false, error: error.message }
  audit.stepToggled(deal, step, actorId)
  return { ok: true, completed }
}
