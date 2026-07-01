// ─────────────────────────────────────────────────────────────────────────────
// Broker review service — submit / approve / request changes.
//
// One place owns the review_status state transitions. Pages call submit()
// or decide() and get back the patched fields to apply optimistically.
// Audit + notification side-effects are handled here so the agent and
// admin views never disagree about what's been recorded.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { withRetry, mutationErrorMessage } from './db.js'
import { TABLES, REVIEW_STATUS } from '../constants.js'
import { audit } from '../audit.js'

/**
 * Agent submits the deal for admin review.
 * @returns {{ ok: true, patch }} on success, { ok: false, error } on failure.
 */
export async function submitDealForReview(deal, { actorId } = {}) {
  if (!deal?.id) return { ok: false, error: 'Deal missing' }
  const patch = {
    review_status:       REVIEW_STATUS.PENDING,
    review_requested_at: new Date().toISOString(),
    review_requested_by: actorId || null,
  }
  const { error, status } = await withRetry(() =>
    supabase.from(TABLES.DEALS).update(patch).eq('id', deal.id)
  )
  if (error) return { ok: false, error: mutationErrorMessage(error, status) }
  audit.reviewSubmitted(deal, actorId)
  return { ok: true, patch }
}

/**
 * Admin decides on a review. `decision` is 'approved' | 'changes_requested'.
 * Notes are required for 'changes_requested' (enforced at the call site too,
 * but redundantly enforced here so any caller is safe).
 */
export async function decideDealReview(deal, decision, { actorId, notes = null } = {}) {
  if (!deal?.id) return { ok: false, error: 'Deal missing' }
  if (decision !== REVIEW_STATUS.APPROVED && decision !== REVIEW_STATUS.CHANGES_REQUESTED) {
    return { ok: false, error: `Unknown decision: ${decision}` }
  }
  if (decision === REVIEW_STATUS.CHANGES_REQUESTED && !notes?.trim()) {
    return { ok: false, error: 'Notes required when requesting changes' }
  }
  const patch = {
    review_status:     decision,
    review_decided_at: new Date().toISOString(),
    review_decided_by: actorId || null,
    review_notes:      notes?.trim() || null,
  }
  const { error, status } = await withRetry(() =>
    supabase.from(TABLES.DEALS).update(patch).eq('id', deal.id)
  )
  if (error) return { ok: false, error: mutationErrorMessage(error, status) }
  if (decision === REVIEW_STATUS.APPROVED) audit.reviewApproved(deal, actorId, patch.review_notes)
  else                                     audit.reviewChanges(deal, actorId, patch.review_notes)
  return { ok: true, patch }
}
