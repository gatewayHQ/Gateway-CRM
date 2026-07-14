import { describe, it, expect } from 'vitest'
import {
  TRACKS, TRACK_ORDER, STAGE_LABELS, ALL_DEAL_STAGES,
  trackForDeal, boardStageFor, isOpenStage,
  UNDER_CONTRACT_STAGES, isUnderContractStage,
} from '../stages.js'

describe('track definitions', () => {
  it('every track stage has a label and is a storable token', () => {
    for (const trackId of TRACK_ORDER) {
      for (const s of TRACKS[trackId].stages) {
        expect(STAGE_LABELS[s], `label for ${s}`).toBeTruthy()
        expect(ALL_DEAL_STAGES, `${s} in ALL_DEAL_STAGES`).toContain(s)
      }
    }
  })

  it('every track ends with closed and lost', () => {
    for (const trackId of TRACK_ORDER) {
      const stages = TRACKS[trackId].stages
      expect(stages.slice(-2)).toEqual(['closed', 'lost'])
    }
  })

  it('commercial follows the decided order (OM before listing agreement)', () => {
    const s = TRACKS.commercial.stages
    expect(s.indexOf('om-marketing')).toBeLessThan(s.indexOf('listing-agreement'))
    expect(s.indexOf('loi')).toBeLessThan(s.indexOf('psa'))
    expect(s.indexOf('psa')).toBeLessThan(s.indexOf('due-diligence'))
  })
})

describe('under-contract stages (property status sync)', () => {
  it('are all storable tokens', () => {
    for (const s of UNDER_CONTRACT_STAGES) expect(ALL_DEAL_STAGES).toContain(s)
  })

  it('cover both residential tracks and the commercial PSA/DD equivalents', () => {
    expect(isUnderContractStage('under-contract')).toBe(true)
    expect(isUnderContractStage('psa')).toBe(true)
    expect(isUnderContractStage('due-diligence')).toBe(true)
  })

  it('exclude pre-contract and terminal stages', () => {
    for (const s of ['lead', 'qualified', 'showing', 'offer', 'loi', 'active', 'closed', 'lost']) {
      expect(isUnderContractStage(s), s).toBe(false)
    }
  })
})

describe('trackForDeal', () => {
  it('commercial deals go to the commercial board regardless of side', () => {
    expect(trackForDeal({ prop_category: 'commercial' })).toBe('commercial')
    expect(trackForDeal({ prop_category: 'commercial', comp_data: { transaction_type: 'seller' } })).toBe('commercial')
  })

  it('residential deals split by the Forms-tab side field', () => {
    expect(trackForDeal({ prop_category: 'residential', comp_data: { transaction_type: 'seller' } })).toBe('residential-seller')
    expect(trackForDeal({ prop_category: 'residential', comp_data: { transaction_type: 'buyer' } })).toBe('residential-buyer')
  })

  it('legacy deals without category or side default to the buyer board (legacy stage shape)', () => {
    expect(trackForDeal({ stage: 'showing' })).toBe('residential-buyer')
    expect(trackForDeal({ prop_category: null, comp_data: null })).toBe('residential-buyer')
  })
})

describe('boardStageFor', () => {
  it('native stages pass through untouched', () => {
    expect(boardStageFor({ stage: 'loi' }, 'commercial')).toBe('loi')
    expect(boardStageFor({ stage: 'pre-list' }, 'residential-seller')).toBe('pre-list')
  })

  it('every storable token maps to a valid column on every board (no deal can vanish)', () => {
    for (const trackId of TRACK_ORDER) {
      for (const s of ALL_DEAL_STAGES) {
        const col = boardStageFor({ stage: s }, trackId)
        expect(TRACKS[trackId].stages, `${s} on ${trackId}`).toContain(col)
      }
    }
  })

  it('legacy commercial deals land where the workflow expects', () => {
    expect(boardStageFor({ stage: 'lead' }, 'commercial')).toBe('pursuit')
    expect(boardStageFor({ stage: 'under-contract' }, 'commercial')).toBe('psa')
    expect(boardStageFor({ stage: 'offer' }, 'commercial')).toBe('loi')
  })

  it('closed/lost stay terminal on every board', () => {
    for (const trackId of TRACK_ORDER) {
      expect(boardStageFor({ stage: 'closed' }, trackId)).toBe('closed')
      expect(boardStageFor({ stage: 'lost' }, trackId)).toBe('lost')
    }
  })
})

describe('isOpenStage', () => {
  it('only closed and lost are terminal', () => {
    expect(isOpenStage('closed')).toBe(false)
    expect(isOpenStage('lost')).toBe(false)
    expect(isOpenStage('due-diligence')).toBe(true)
    expect(isOpenStage('lead')).toBe(true)
  })
})

describe('unified board (2026-06-12: single pipeline, no res/comm split)', () => {
  it('uses the original legacy stage columns', () => {
    expect(TRACKS.unified.stages).toEqual(['lead','qualified','showing','offer','under-contract','closed','lost'])
  })
  it('maps every storable token onto a unified column (no deal can vanish)', () => {
    for (const s of ALL_DEAL_STAGES) {
      const col = boardStageFor({ stage: s }, 'unified')
      expect(TRACKS.unified.stages, `${s} on unified`).toContain(col)
    }
  })
  it('maps track-split-era tokens to sensible columns', () => {
    expect(boardStageFor({ stage: 'loi' }, 'unified')).toBe('offer')
    expect(boardStageFor({ stage: 'psa' }, 'unified')).toBe('under-contract')
    expect(boardStageFor({ stage: 'due-diligence' }, 'unified')).toBe('under-contract')
    expect(boardStageFor({ stage: 'pursuit' }, 'unified')).toBe('lead')
  })
})
