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
import { isStepResolved, stepPatch } from '../stepStatus.js'

// `satisfied_by` arrives with migration 0028 (which envelope proves this
// sign-step). Selected separately so a database that has not applied 0028 yet
// falls back instead of erroring — the closing gate degrades to distinct-
// envelope matching, which is still correct, just less precise.
const STEP_COLS      = 'id, title, completed, sort_order, doc_action, doc_status, if_applicable'
const STEP_COLS_0028 = `${STEP_COLS}, satisfied_by`

export async function listDealSteps(dealId) {
  const query = (cols) => supabase
    .from(TABLES.TRANSACTION_STEPS)
    .select(cols)
    .eq('deal_id', dealId)
    .order('sort_order', { ascending: true })

  let { data, error } = await query(STEP_COLS_0028)
  if (error && /satisfied_by/.test(error.message || '')) {
    ;({ data, error } = await query(STEP_COLS))
  }
  return { steps: data || [], error: error?.message || null }
}

// Ticks a step done, or back to pending. Writes doc_status as well as
// `completed` (via stepPatch), so the Checklist tab shows the same thing the
// deal page does. Returns the fields written (`patch`), for the caller's local state.
export async function toggleDealStep(deal, step, { actorId } = {}) {
  if (!step?.id) return { ok: false, error: 'step missing' }
  const patch = stepPatch(isStepResolved(step) ? 'pending' : 'complete')
  const { error } = await supabase
    .from(TABLES.TRANSACTION_STEPS)
    .update(patch)
    .eq('id', step.id)
  if (error) return { ok: false, error: error.message }
  audit.stepToggled(deal, step, actorId)
  return { ok: true, patch }
}
