// ─────────────────────────────────────────────────────────────────────────────
// Compliance gate — the single source of truth for "is this deal ready to
// close?". Pure functions, no I/O. Same shape on Pipeline, DealPage, and the
// AdminReview queue so the admin and the agent see the same picture.
//
// A gate is a list of *blockers* — each one is a missing-or-incomplete thing
// that has to be done before the deal can move to 'closed'. The UI decides
// how to render them; admins can override-with-confirm, agents cannot.
// ─────────────────────────────────────────────────────────────────────────────

// Issue codes are stable identifiers so the UI can route to the right tab and
// the cron nudges can target the right next-action.
export const ISSUE_CODES = {
  STEPS_INCOMPLETE:    'steps_incomplete',
  SIGNATURES_MISSING:  'signatures_missing',
  STATE_FORMS_MISSING: 'state_forms_missing',
  KEY_DATE_MISSING:    'key_date_missing',
  CLOSE_DATE_MISSING:  'close_date_missing',
  COMMISSION_MISSING:  'commission_missing',
  REVIEW_REQUIRED:     'review_required',
  REVIEW_CHANGES:      'review_changes',
}

/**
 * Match sign-steps to the envelopes that actually satisfy them.
 *
 * The old check compared counts — `signSteps.length > completedCount` — so
 * three sign-steps and three completed copies of the SAME disclosure passed.
 * Matching is now by identity:
 *
 *   1. A step with `satisfied_by` is satisfied ONLY by that envelope, and only
 *      when it is completed. The link is authoritative in both directions: if
 *      the named envelope is missing or unsigned the step stays unsatisfied,
 *      and no other envelope may stand in for it. Falling back to "any
 *      envelope will do" would defeat the point of recording the link.
 *   2. Steps without a link (legacy rows, no backfill required) are matched
 *      greedily against the remaining completed envelopes — one envelope per
 *      step. Weaker than an explicit link, but it still makes three copies of
 *      one document satisfy exactly one step instead of three.
 *
 * Returns { satisfied, unsatisfied, total }.
 */
export function matchSignatures(signSteps = [], envelopes = []) {
  const completed = envelopes.filter(e => e?.status === 'completed')
  const claimed   = new Set()
  let satisfied   = 0

  // Pass 1 — linked steps resolve against their own envelope only. A linked
  // step never falls through to the greedy pass.
  const unlinked = []
  for (const step of signSteps) {
    const link = step?.satisfied_by
    if (!link) { unlinked.push(step); continue }
    const hit = completed.find(e => e.id === link && !claimed.has(e.id))
    if (hit) { claimed.add(hit.id); satisfied++ }
    // else: stays unsatisfied — deliberately not eligible for pass 2.
  }

  // Pass 2 — unlinked steps take one unclaimed envelope each.
  for (const _step of unlinked) {
    const free = completed.find(e => !claimed.has(e.id))
    if (!free) break
    claimed.add(free.id)
    satisfied++
  }

  return { satisfied, unsatisfied: signSteps.length - satisfied, total: signSteps.length }
}

/**
 * The state-required packets this deal has not executed.
 *
 * `requiredForms` are the active, template-linked form_packets rows marked
 * `required` for the deal's (comp_data.state, comp_data.transaction_type) —
 * loaded by src/lib/services/requiredForms.js. A packet is satisfied by a
 * COMPLETED envelope on the deal built from the same BoldSign template, which
 * is genuine identity rather than a count or a filename guess.
 */
export function missingStateForms(requiredForms = [], envelopes = []) {
  const executed = new Set(
    envelopes
      .filter(e => e?.status === 'completed' && e.boldsign_template_id)
      .map(e => e.boldsign_template_id)
  )
  return requiredForms.filter(f => f?.boldsign_template_id && !executed.has(f.boldsign_template_id))
}

// Steps the system treats as required for closing. `if_applicable` rows are
// optional; the agent has to explicitly tick them. Everything else must be
// completed before the deal can move to 'closed'.
function requiredSteps(steps = []) {
  return steps.filter(s => !s.if_applicable)
}

// Returns { canClose, issues: [{code, label, severity, tab, detail}] }.
// severity: 'block' (cannot close) | 'warn' (admin can override).
// `hasCommissionVisibility` — pass false for non-admins so we don't flag a
// commission they can't actually see (commission data is admin-only).
export function getClosingGate(deal, {
  steps = [], envelopes = [], commission = null,
  hasCommissionVisibility = true, requiredForms = [],
} = {}) {
  if (!deal) return { canClose: false, issues: [{ code: 'no_deal', label: 'Deal not loaded', severity: 'block' }] }
  const issues = []
  const req = requiredSteps(steps)

  // 1) All required checklist steps complete
  const openSteps = req.filter(s => !s.completed)
  if (openSteps.length > 0) {
    issues.push({
      code: ISSUE_CODES.STEPS_INCOMPLETE,
      label: `${openSteps.length} closing checklist ${openSteps.length === 1 ? 'item' : 'items'} pending`,
      severity: 'block',
      tab: 'checklist',
      detail: openSteps.slice(0, 5).map(s => s.title),
    })
  }

  // 2) Every sign-action step needs its OWN completed BoldSign envelope.
  //    (Steps mark intent; envelopes are the proof.) Matched by identity —
  //    see matchSignatures() for why counting was not enough.
  const signSteps = req.filter(s => s.doc_action === 'sign')
  const sigs = matchSignatures(signSteps, envelopes)
  if (sigs.unsatisfied > 0) {
    issues.push({
      code: ISSUE_CODES.SIGNATURES_MISSING,
      label: `${sigs.unsatisfied} of ${sigs.total} required signatures not yet completed`,
      severity: 'block',
      tab: 'signatures',
    })
  }

  // 2b) State-required forms. The deal's state decides which packets apply;
  //     each must have a completed envelope built from that packet's BoldSign
  //     template. This is what makes IA/SD/NE compliance a property of the
  //     system rather than something the transaction coordinator remembers.
  const missingForms = missingStateForms(requiredForms, envelopes)
  if (missingForms.length > 0) {
    const stateCode = deal?.comp_data?.state
    issues.push({
      code: ISSUE_CODES.STATE_FORMS_MISSING,
      label: `${missingForms.length} required ${stateCode ? `${stateCode} ` : ''}form${missingForms.length === 1 ? '' : 's'} not executed`,
      severity: 'block',
      tab: 'signatures',
      detail: missingForms.slice(0, 5).map(f => f.name),
    })
  }

  // 3) Expected close date set (key dates are nice-to-have, close date is not)
  if (!deal.expected_close_date) {
    issues.push({
      code: ISSUE_CODES.CLOSE_DATE_MISSING,
      label: 'Expected close date is not set',
      severity: 'block',
      tab: 'dates',
    })
  }

  // 4) Any key_dates the user explicitly flagged required (`required:true`)
  //    must be filled in. Default is optional, so legacy deals don't trip.
  const keyDates = deal?.comp_data?.key_dates || []
  const requiredKD = keyDates.filter(d => d?.required && !d.date)
  if (requiredKD.length > 0) {
    issues.push({
      code: ISSUE_CODES.KEY_DATE_MISSING,
      label: `Required key date${requiredKD.length === 1 ? '' : 's'} missing: ${requiredKD.map(d => d.type).join(', ')}`,
      severity: 'block',
      tab: 'dates',
    })
  }

  // 5) Commission must be entered for the brokerage to know what to disburse.
  //    Only enforce when the caller has visibility into commission data
  //    (admin); a non-admin can't see commission, so flagging it as a blocker
  //    on their view would be a phantom warning they can't act on.
  if (hasCommissionVisibility) {
    const hasComm = commission && Number(commission.gross_pct || 0) > 0
    if ((Number(deal.value) || 0) > 0 && !hasComm) {
      issues.push({
        code: ISSUE_CODES.COMMISSION_MISSING,
        label: 'Commission not entered',
        severity: 'block',
        tab: 'commission',
      })
    }
  }

  // 6) Broker review must be approved. Agents see this as a 'block' (they must
  //    submit-for-review); admins see it as a 'warn' (they can self-approve).
  if (deal.review_status === 'changes_requested') {
    issues.push({
      code: ISSUE_CODES.REVIEW_CHANGES,
      label: 'Admin requested changes — address feedback and resubmit',
      severity: 'block',
      tab: 'review',
      detail: deal.review_notes ? [deal.review_notes] : [],
    })
  } else if (deal.review_status !== 'approved') {
    issues.push({
      code: ISSUE_CODES.REVIEW_REQUIRED,
      label: deal.review_status === 'pending' ? 'Awaiting admin review' : 'Admin review required before closing',
      severity: 'block',
      tab: 'review',
    })
  }

  return { canClose: issues.length === 0, issues }
}

// Shorthand for the badge on the deal card: green/amber/red.
export function gateBadge(gate) {
  if (!gate) return { color: 'var(--gw-mist)', label: '—' }
  if (gate.canClose) return { color: 'var(--gw-green)', label: 'Ready' }
  const hasBlock = gate.issues.some(i => i.severity === 'block')
  return hasBlock
    ? { color: '#dc2626', label: `${gate.issues.length} blocker${gate.issues.length === 1 ? '' : 's'}` }
    : { color: '#d97706', label: `${gate.issues.length} warning${gate.issues.length === 1 ? '' : 's'}` }
}
