import { describe, it, expect } from 'vitest'
import { DEAL_TAB_IDS, dealTabOrDefault } from '../dealTabs.js'
import { isContractStage } from '../stages.js'

describe('dealTabOrDefault', () => {
  it('keeps a real tab', () => {
    for (const id of DEAL_TAB_IDS) expect(dealTabOrDefault(id)).toBe(id)
  })
  it('falls back to Details for a tab that does not exist', () => {
    expect(dealTabOrDefault('commission')).toBe('details')
    expect(dealTabOrDefault(undefined)).toBe('details')
  })
})

describe('isContractStage', () => {
  it('is true from contract to closing on every track', () => {
    for (const s of ['under-contract', 'psa', 'due-diligence']) expect(isContractStage(s)).toBe(true)
  })
  it('is false before contract and once finished', () => {
    for (const s of ['lead', 'pursuit', 'showing', 'offer', 'loi', 'closed', 'lost']) expect(isContractStage(s)).toBe(false)
  })
})
