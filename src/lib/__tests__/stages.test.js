import { describe, it, expect } from 'vitest'
import {
  TRACKS, UNIFIED, STAGE_LABELS, ALL_DEAL_STAGES,
  boardStageFor, isOpenStage,
} from '../stages.js'

describe('track definitions', () => {
  it('only the unified board survives (commercial/res tracks removed 2026-08)', () => {
    expect(Object.keys(TRACKS)).toEqual([UNIFIED])
  })

  it('every board stage has a label and is a storable token', () => {
    for (const s of TRACKS[UNIFIED].stages) {
      expect(STAGE_LABELS[s], `label for ${s}`).toBeTruthy()
      expect(ALL_DEAL_STAGES, `${s} in ALL_DEAL_STAGES`).toContain(s)
    }
  })

  it('the board ends with closed and lost', () => {
    expect(TRACKS[UNIFIED].stages.slice(-2)).toEqual(['closed', 'lost'])
  })

  it('commercial stage TOKENS remain storable even though the board is gone', () => {
    // Deleting the commercial track must not orphan deals already stored with
    // its tokens — they still resolve through FOREIGN_STAGE_MAP.
    for (const s of ['pursuit','om-marketing','listing-agreement','on-market','loi','psa','due-diligence','pre-list']) {
      expect(ALL_DEAL_STAGES, `${s} still storable`).toContain(s)
      expect(STAGE_LABELS[s], `label for ${s}`).toBeTruthy()
    }
  })
})

describe('boardStageFor', () => {
  it('native stages pass through untouched', () => {
    expect(boardStageFor({ stage: 'offer' }, UNIFIED)).toBe('offer')
    expect(boardStageFor({ stage: 'lead' }, UNIFIED)).toBe('lead')
  })

  it('closed/lost stay terminal', () => {
    expect(boardStageFor({ stage: 'closed' }, UNIFIED)).toBe('closed')
    expect(boardStageFor({ stage: 'lost' }, UNIFIED)).toBe('lost')
  })

  it('an unknown track id falls back to the stored stage', () => {
    expect(boardStageFor({ stage: 'loi' }, 'no-such-track')).toBe('loi')
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
