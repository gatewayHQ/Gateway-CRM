import { describe, it, expect } from 'vitest'
import { STAGE_LABELS } from '../stages.js'
import {
  normalizeStageLabel, normalizeStageLabels, resolveStageLabel,
  resolveStageLabels, hasStageLabelOverrides, STAGE_LABEL_MAX,
} from '../stageLabels.js'

describe('normalizeStageLabel', () => {
  it('keeps a real rename, trimmed and whitespace-collapsed', () => {
    expect(normalizeStageLabel('offer', '  LOI   Out  ')).toBe('LOI Out')
  })

  it('treats blank as "no override" so a cleared box resets the column', () => {
    expect(normalizeStageLabel('offer', '')).toBeNull()
    expect(normalizeStageLabel('offer', '   ')).toBeNull()
    expect(normalizeStageLabel('offer', null)).toBeNull()
    expect(normalizeStageLabel('offer', undefined)).toBeNull()
  })

  it('drops an override identical to the built-in label — storing it would block a reset', () => {
    expect(normalizeStageLabel('offer', 'Offer')).toBeNull()
    expect(normalizeStageLabel('under-contract', 'Under Contract')).toBeNull()
  })

  it('clamps a long label so a renamed column still fits its 240px header', () => {
    const long = 'x'.repeat(STAGE_LABEL_MAX + 40)
    expect(normalizeStageLabel('lead', long)).toHaveLength(STAGE_LABEL_MAX)
  })
})

describe('normalizeStageLabels', () => {
  it('drops unknown stage tokens — a rename must name a stage that exists', () => {
    expect(normalizeStageLabels({ lead: 'Prospect', nonsense: 'Hack', __proto__: 'x' }))
      .toEqual({ lead: 'Prospect' })
  })

  it('rejects non-objects rather than spreading them over the label map', () => {
    expect(normalizeStageLabels(null)).toEqual({})
    expect(normalizeStageLabels('lead')).toEqual({})
    expect(normalizeStageLabels(['Lead'])).toEqual({})
    expect(normalizeStageLabels(42)).toEqual({})
  })

  it('coerces a non-string value instead of writing it through', () => {
    expect(normalizeStageLabels({ lead: 7 })).toEqual({ lead: '7' })
  })
})

describe('resolveStageLabels', () => {
  it('layers overrides on the defaults and leaves the rest alone', () => {
    const labels = resolveStageLabels({ qualified: 'Vetted' })
    expect(labels.qualified).toBe('Vetted')
    expect(labels.lead).toBe(STAGE_LABELS.lead)
    expect(labels.closed).toBe(STAGE_LABELS.closed)
  })

  it('falls back to defaults with no overrides at all', () => {
    expect(resolveStageLabels(undefined)).toEqual(STAGE_LABELS)
    expect(resolveStageLabels({})).toEqual(STAGE_LABELS)
  })

  it('never invents a stage the board does not have', () => {
    expect(Object.keys(resolveStageLabels({ bogus: 'Nope' })).sort())
      .toEqual(Object.keys(STAGE_LABELS).sort())
  })
})

describe('resolveStageLabel', () => {
  it('returns the override, then the default, then the raw token', () => {
    expect(resolveStageLabel('offer', { offer: 'LOI Out' })).toBe('LOI Out')
    expect(resolveStageLabel('offer', {})).toBe('Offer')
    expect(resolveStageLabel('mystery-stage', {})).toBe('mystery-stage')
  })
})

describe('hasStageLabelOverrides', () => {
  it('is false when nothing meaningful is stored', () => {
    expect(hasStageLabelOverrides(undefined)).toBe(false)
    expect(hasStageLabelOverrides({})).toBe(false)
    expect(hasStageLabelOverrides({ offer: 'Offer' })).toBe(false)   // == default
    expect(hasStageLabelOverrides({ nope: 'Custom' })).toBe(false)   // unknown stage
  })

  it('is true once a column is genuinely renamed', () => {
    expect(hasStageLabelOverrides({ offer: 'LOI Out' })).toBe(true)
  })
})
