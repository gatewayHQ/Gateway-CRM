// A deal checklist step's status — the one set of rules every screen and job
// uses to read and write it. Pure: no React, no database.
//
// A step row carries two fields that used to disagree:
//   doc_status  'pending' | 'complete' | 'approved' | 'na'   (what the Checklist tab shows)
//   completed   boolean                                       (what the closing gate counted)
//
// The Checklist tab wrote both, but wrote N/A as completed:false, so an item an
// agent had deliberately marked "not applicable" still blocked closing. The
// deal page's Next Actions tick wrote only `completed`, so a step done there
// still showed as pending on the Checklist tab. Every write now goes through
// stepPatch(), and every read through stepStatus() / isStepResolved(), which
// also make sense of rows written the old way.

/** Clicking a step's status on the Checklist tab moves it along this cycle. */
export const NEXT_STEP_STATUS = { pending: 'complete', complete: 'approved', approved: 'na', na: 'pending' }

/** The step's status, inferring it for rows that only ever had `completed` set. */
export const stepStatus = (step) => step?.doc_status || (step?.completed ? 'complete' : 'pending')

/** Work done on it: complete, or complete and approved. */
export const isStepDone = (step) => ['complete', 'approved'].includes(stepStatus(step))

/** Nothing left to do: done, or marked not applicable. This is what closing checks. */
export const isStepResolved = (step) => isStepDone(step) || stepStatus(step) === 'na'

/**
 * The fields to write for a new status. `completed` mirrors "resolved", so
 * anything that only reads `completed` (the client portal, older queries)
 * agrees with the closing gate.
 */
export function stepPatch(status, now = new Date().toISOString()) {
  const resolved = status !== 'pending'
  return { doc_status: status, completed: resolved, completed_at: resolved ? now : null }
}
