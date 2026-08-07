import { describe, it, expect } from 'vitest'
import {
  getClosingGate, gateBadge, ISSUE_CODES, matchSignatures, missingStateForms,
} from '../compliance.js'

// Helper: make a "ready to close" deal so each test starts from a known-good
// baseline and we only assert on the field under test.
const dealReady = (overrides = {}) => ({
  id: 'd1',
  value: 100_000,
  expected_close_date: '2026-12-31',
  review_status: 'approved',
  comp_data: { key_dates: [] },
  ...overrides,
})

const steps = (count, { applicable = true, completed = true, signCount = 0 } = {}) =>
  Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    title: `Step ${i}`,
    completed,
    if_applicable: !applicable,
    doc_action: i < signCount ? 'sign' : 'manual',
  }))

const envelopes = (n, status = 'completed') =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i}`, status }))

const commission = { gross_pct: 3.0 }

describe('getClosingGate', () => {
  it('returns canClose=true with no issues for a fully-ready deal', () => {
    const gate = getClosingGate(dealReady(), { steps: steps(3), envelopes: [], commission })
    expect(gate.canClose).toBe(true)
    expect(gate.issues).toEqual([])
  })

  it('flags steps_incomplete when required steps are open', () => {
    const gate = getClosingGate(dealReady(), { steps: steps(3, { completed: false }), envelopes: [], commission })
    expect(gate.canClose).toBe(false)
    expect(gate.issues.some(i => i.code === ISSUE_CODES.STEPS_INCOMPLETE)).toBe(true)
  })

  it('ignores if_applicable steps for completion checks', () => {
    const reqSteps = steps(2, { completed: true })
    const optSteps = steps(3, { completed: false, applicable: false })
    const gate = getClosingGate(dealReady(), { steps: [...reqSteps, ...optSteps], envelopes: [], commission })
    expect(gate.canClose).toBe(true)
  })

  it('flags signatures_missing when fewer envelopes completed than sign-steps', () => {
    // 2 sign-action steps, 1 completed envelope → 1 missing
    const s = steps(2, { signCount: 2 })
    const gate = getClosingGate(dealReady(), { steps: s, envelopes: envelopes(1), commission })
    expect(gate.issues.some(i => i.code === ISSUE_CODES.SIGNATURES_MISSING)).toBe(true)
  })

  it('passes signatures when at least as many completed envelopes as sign steps', () => {
    const s = steps(2, { signCount: 2 })
    const gate = getClosingGate(dealReady(), { steps: s, envelopes: envelopes(2), commission })
    expect(gate.issues.some(i => i.code === ISSUE_CODES.SIGNATURES_MISSING)).toBe(false)
  })

  it('flags close_date_missing when expected_close_date is empty', () => {
    const gate = getClosingGate(dealReady({ expected_close_date: null }), { steps: steps(1), envelopes: [], commission })
    expect(gate.issues.some(i => i.code === ISSUE_CODES.CLOSE_DATE_MISSING)).toBe(true)
  })

  it('flags key_date_missing only for dates explicitly marked required', () => {
    const cd = { key_dates: [{ type: 'Inspection', date: null, required: true }] }
    const gate = getClosingGate(dealReady({ comp_data: cd }), { steps: steps(1), envelopes: [], commission })
    expect(gate.issues.some(i => i.code === ISSUE_CODES.KEY_DATE_MISSING)).toBe(true)
  })

  it('does not flag optional key dates that are missing', () => {
    const cd = { key_dates: [{ type: 'Inspection', date: null }] }
    const gate = getClosingGate(dealReady({ comp_data: cd }), { steps: steps(1), envelopes: [], commission })
    expect(gate.issues.some(i => i.code === ISSUE_CODES.KEY_DATE_MISSING)).toBe(false)
  })

  it('flags commission_missing only when caller has commission visibility', () => {
    const withVis    = getClosingGate(dealReady(), { steps: steps(1), envelopes: [], commission: null, hasCommissionVisibility: true })
    const withoutVis = getClosingGate(dealReady(), { steps: steps(1), envelopes: [], commission: null, hasCommissionVisibility: false })
    expect(withVis.issues.some(i => i.code === ISSUE_CODES.COMMISSION_MISSING)).toBe(true)
    expect(withoutVis.issues.some(i => i.code === ISSUE_CODES.COMMISSION_MISSING)).toBe(false)
  })

  it('does not flag commission_missing for zero-value deals', () => {
    const gate = getClosingGate(dealReady({ value: 0 }), { steps: steps(1), envelopes: [], commission: null, hasCommissionVisibility: true })
    expect(gate.issues.some(i => i.code === ISSUE_CODES.COMMISSION_MISSING)).toBe(false)
  })

  it('requires approval; pending review blocks closing', () => {
    const gate = getClosingGate(dealReady({ review_status: 'pending' }), { steps: steps(1), envelopes: [], commission })
    expect(gate.canClose).toBe(false)
    expect(gate.issues.some(i => i.code === ISSUE_CODES.REVIEW_REQUIRED)).toBe(true)
  })

  it('changes_requested status produces a distinct issue (so UI can show notes)', () => {
    const gate = getClosingGate(dealReady({ review_status: 'changes_requested', review_notes: 'Fix the disclosures' }),
                                { steps: steps(1), envelopes: [], commission })
    const issue = gate.issues.find(i => i.code === ISSUE_CODES.REVIEW_CHANGES)
    expect(issue).toBeTruthy()
    expect(issue.detail).toContain('Fix the disclosures')
  })

  it('returns canClose=false with a synthetic issue when deal is null', () => {
    const gate = getClosingGate(null)
    expect(gate.canClose).toBe(false)
    expect(gate.issues.length).toBeGreaterThan(0)
  })
})

describe('gateBadge', () => {
  it('green Ready when canClose', () => {
    const b = gateBadge({ canClose: true, issues: [] })
    expect(b.label).toBe('Ready')
  })
  it('red N blockers when any block', () => {
    const b = gateBadge({ canClose: false, issues: [{ severity: 'block' }, { severity: 'block' }] })
    expect(b.label).toMatch(/2 blocker/)
  })
  it('amber for warnings only', () => {
    const b = gateBadge({ canClose: false, issues: [{ severity: 'warn' }] })
    expect(b.label).toMatch(/1 warning/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Migration 0028 — envelope identity + state-required forms.
// ─────────────────────────────────────────────────────────────────────────────
describe('matchSignatures — identity, not counting', () => {
  const step = (id, satisfied_by = null) => ({ id, doc_action: 'sign', satisfied_by })
  const env  = (id, status = 'completed', boldsign_template_id = null) => ({ id, status, boldsign_template_id })

  it('THE BUG: three copies of one document no longer satisfy three steps', () => {
    // Pre-0028 this compared counts, so 3 completed envelopes cleared 3 steps
    // no matter what they were. Each envelope may now satisfy only one step.
    const steps = [step('s1'), step('s2'), step('s3')]
    const envs  = [env('e1'), env('e2'), env('e3')]
    // Three DISTINCT envelopes still clear three steps — that is legitimate.
    expect(matchSignatures(steps, envs).unsatisfied).toBe(0)
    // But one envelope cannot cover all three.
    expect(matchSignatures(steps, [env('e1')]).unsatisfied).toBe(2)
  })

  it('an explicit link is satisfied only by that envelope', () => {
    const steps = [step('s1', 'e9')]
    expect(matchSignatures(steps, [env('e1')]).unsatisfied).toBe(1)
    expect(matchSignatures(steps, [env('e9')]).unsatisfied).toBe(0)
  })

  it('a linked envelope that is not completed does not count', () => {
    expect(matchSignatures([step('s1', 'e1')], [env('e1', 'sent')]).unsatisfied).toBe(1)
  })

  it('a claimed envelope cannot also cover an unlinked step', () => {
    const steps = [step('s1', 'e1'), step('s2')]
    // e1 is consumed by s1, leaving nothing for s2.
    expect(matchSignatures(steps, [env('e1')]).unsatisfied).toBe(1)
    expect(matchSignatures(steps, [env('e1'), env('e2')]).unsatisfied).toBe(0)
  })

  it('ignores declined, voided and in-flight envelopes', () => {
    const envs = [env('e1', 'declined'), env('e2', 'voided'), env('e3', 'sent')]
    expect(matchSignatures([step('s1')], envs).unsatisfied).toBe(1)
  })

  it('no sign-steps means nothing to prove', () => {
    expect(matchSignatures([], [])).toEqual({ satisfied: 0, unsatisfied: 0, total: 0 })
  })
})

describe('missingStateForms', () => {
  const packet = (id, tid) => ({ id, name: `Packet ${id}`, boldsign_template_id: tid })
  const env    = (tid, status = 'completed') => ({ id: `e-${tid}`, status, boldsign_template_id: tid })

  it('a required packet with no executed envelope is missing', () => {
    expect(missingStateForms([packet('p1', 'tpl-ia-listing')], []).map(f => f.id)).toEqual(['p1'])
  })

  it('a completed envelope from the same template satisfies it', () => {
    expect(missingStateForms([packet('p1', 'tpl-ia-listing')], [env('tpl-ia-listing')])).toEqual([])
  })

  it('an envelope from a DIFFERENT template does not satisfy it', () => {
    expect(missingStateForms([packet('p1', 'tpl-ia-listing')], [env('tpl-sd-listing')]).map(f => f.id)).toEqual(['p1'])
  })

  it('a sent-but-unsigned envelope does not satisfy it', () => {
    expect(missingStateForms([packet('p1', 'tpl-a')], [env('tpl-a', 'sent')]).map(f => f.id)).toEqual(['p1'])
  })

  it('nothing required means nothing missing', () => {
    expect(missingStateForms([], [env('tpl-a')])).toEqual([])
  })
})

describe('getClosingGate — state forms blocker', () => {
  // A deal that clears every other blocker, so the forms check is isolated.
  const readyDeal = {
    id: 'd1', value: 500000, expected_close_date: '2026-09-01',
    review_status: 'approved', comp_data: { state: 'IA', transaction_type: 'seller' },
  }
  const ctx = (requiredForms, envelopes = []) => ({
    steps: [], envelopes, commission: { gross_pct: 3 },
    hasCommissionVisibility: true, requiredForms,
  })

  it('a clean deal with no required forms can close', () => {
    expect(getClosingGate(readyDeal, ctx([])).canClose).toBe(true)
  })

  it('an Iowa listing cannot close without its executed Iowa packet', () => {
    const gate = getClosingGate(readyDeal, ctx([{ id: 'p1', name: 'IA Listing Agreement', boldsign_template_id: 'tpl-ia' }]))
    expect(gate.canClose).toBe(false)
    const issue = gate.issues.find(i => i.code === ISSUE_CODES.STATE_FORMS_MISSING)
    expect(issue).toBeTruthy()
    expect(issue.severity).toBe('block')
    expect(issue.label).toContain('IA')
    expect(issue.detail).toContain('IA Listing Agreement')
  })

  it('executing the packet clears the blocker', () => {
    const forms = [{ id: 'p1', name: 'IA Listing Agreement', boldsign_template_id: 'tpl-ia' }]
    const envs  = [{ id: 'e1', status: 'completed', boldsign_template_id: 'tpl-ia' }]
    expect(getClosingGate(readyDeal, ctx(forms, envs)).canClose).toBe(true)
  })

  it('omitting requiredForms preserves the pre-0028 behaviour exactly', () => {
    // Callers that have not been updated, and databases without the column,
    // must not suddenly block every deal in the brokerage.
    const gate = getClosingGate(readyDeal, {
      steps: [], envelopes: [], commission: { gross_pct: 3 }, hasCommissionVisibility: true,
    })
    expect(gate.canClose).toBe(true)
  })
})

describe('matchSignatures — a link is authoritative', () => {
  const step = (id, satisfied_by = null) => ({ id, doc_action: 'sign', satisfied_by })
  const env  = (id, status = 'completed') => ({ id, status })

  it('a step linked to a missing envelope is NOT rescued by an unrelated one', () => {
    // The link records which document proves this step. Letting any other
    // completed envelope stand in would put the counting bug straight back.
    const r = matchSignatures([step('s1', 'e9')], [env('e1'), env('e2'), env('e3')])
    expect(r.unsatisfied).toBe(1)
  })

  it('an unlinked step alongside a broken link still matches freely', () => {
    const r = matchSignatures([step('s1', 'e9'), step('s2')], [env('e1')])
    expect(r.satisfied).toBe(1)     // s2 takes e1; s1 stays blocked on e9
    expect(r.unsatisfied).toBe(1)
  })
})
