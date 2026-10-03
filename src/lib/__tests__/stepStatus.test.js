import { describe, it, expect } from 'vitest'
import { NEXT_STEP_STATUS, stepStatus, isStepDone, isStepResolved, stepPatch } from '../stepStatus.js'

describe('stepStatus', () => {
  it('reads doc_status, or infers it for rows that only have `completed`', () => {
    expect(stepStatus({ doc_status: 'na', completed: false })).toBe('na')
    expect(stepStatus({ completed: true })).toBe('complete')
    expect(stepStatus({ completed: false })).toBe('pending')
    expect(stepStatus(undefined)).toBe('pending')
  })

  it('cycles pending → complete → approved → N/A → pending', () => {
    let s = 'pending'
    const seen = []
    for (let i = 0; i < 4; i++) { s = NEXT_STEP_STATUS[s]; seen.push(s) }
    expect(seen).toEqual(['complete', 'approved', 'na', 'pending'])
  })

  it('treats N/A as resolved but not done', () => {
    // A row written before this fix: N/A on the tab, completed:false underneath.
    const legacyNa = { doc_status: 'na', completed: false }
    expect(isStepResolved(legacyNa)).toBe(true)
    expect(isStepDone(legacyNa)).toBe(false)
    expect(isStepResolved({ doc_status: 'approved' })).toBe(true)
    expect(isStepResolved({ doc_status: 'pending', completed: false })).toBe(false)
  })

  it('writes `completed` as "resolved", with a timestamp only when resolved', () => {
    expect(stepPatch('na', 'T')).toEqual({ doc_status: 'na', completed: true, completed_at: 'T' })
    expect(stepPatch('complete', 'T')).toEqual({ doc_status: 'complete', completed: true, completed_at: 'T' })
    expect(stepPatch('pending', 'T')).toEqual({ doc_status: 'pending', completed: false, completed_at: null })
  })
})
