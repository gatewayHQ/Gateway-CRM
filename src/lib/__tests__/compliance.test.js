import { describe, it, expect } from 'vitest'
import { getClosingGate, gateBadge, ISSUE_CODES } from '../compliance.js'

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
