import { describe, it, expect } from 'vitest'
import { detectStateFromTitle, boldsignTemplateId, boldsignTemplateTitle, catalogDrift } from '../cron.js'

describe('detectStateFromTitle — nightly BoldSign drift sync', () => {
  it('matches a full state name in the template title', () => {
    expect(detectStateFromTitle('Iowa Listing Agreement')).toBe('IA')
    expect(detectStateFromTitle('South Dakota Listing Agreement')).toBe('SD')
    expect(detectStateFromTitle('Nebraska Buyer Rep')).toBe('NE')
  })

  it('matches a bare state code as a whole word', () => {
    expect(detectStateFromTitle('SD Listing Agreement')).toBe('SD')
  })

  it('does not false-positive on a state code substring', () => {
    // "NE" must not match inside "AGREEMENT" or similar — whole-word only.
    expect(detectStateFromTitle('AGREEMENT for services')).toBeNull()
  })

  it('returns null for an unrecognized title — never guesses', () => {
    expect(detectStateFromTitle('Generic Listing Template')).toBeNull()
    expect(detectStateFromTitle('')).toBeNull()
    expect(detectStateFromTitle(undefined)).toBeNull()
  })
})

describe('boldsignTemplateId / boldsignTemplateTitle — tolerant payload reads', () => {
  it('reads every id spelling BoldSign uses', () => {
    expect(boldsignTemplateId({ templateId: 't1' })).toBe('t1')
    expect(boldsignTemplateId({ documentId: 't2' })).toBe('t2')
    expect(boldsignTemplateId({ id: 't3' })).toBe('t3')
  })

  it('returns null when there is no id — the caller must not treat that as "deleted"', () => {
    expect(boldsignTemplateId({ templateName: 'No id here' })).toBeNull()
    expect(boldsignTemplateId(undefined)).toBeNull()
  })

  it('reads every title spelling, so state detection is not fed an empty string', () => {
    expect(boldsignTemplateTitle({ title: 'Iowa Listing' })).toBe('Iowa Listing')
    expect(boldsignTemplateTitle({ templateName: 'Iowa Listing' })).toBe('Iowa Listing')
    expect(boldsignTemplateTitle({ documentName: 'Iowa Listing' })).toBe('Iowa Listing')
    expect(boldsignTemplateTitle({})).toBe('')
    expect(detectStateFromTitle(boldsignTemplateTitle({ templateName: 'Iowa Agency Packet' }))).toBe('IA')
  })
})

describe('catalogDrift — what the sync reports instead of switching off', () => {
  const catalog = [
    { id: 'p1', name: 'Iowa Purchase Agreement Packet', state: 'IA', boldsign_template_id: 'gone-1', active: true },
    { id: 'p2', name: 'Purchase Agreement Packet',      state: 'NE', boldsign_template_id: 'live-1', active: true },
    { id: 'p3', name: 'Already off',                    state: 'IA', boldsign_template_id: 'gone-2', active: false },
    { id: 'p4', name: 'Plain form, no template',        state: 'IA', boldsign_template_id: null,     active: true },
  ]

  it('lists only active linked packets the account cannot see', () => {
    const out = catalogDrift(catalog, new Set(['live-1']))
    expect(out).toEqual([{ id: 'p1', name: 'Iowa Purchase Agreement Packet', state: 'IA', templateId: 'gone-1' }])
  })

  it('reports nothing when every id is present', () => {
    expect(catalogDrift(catalog, new Set(['gone-1', 'live-1']))).toEqual([])
  })

  it('treats a null active as sendable (pre-migration rows)', () => {
    const out = catalogDrift([{ id: 'p5', name: 'Null active', boldsign_template_id: 'x' }], new Set())
    expect(out.map(r => r.id)).toEqual(['p5'])
  })

  it('tolerates junk input', () => {
    expect(catalogDrift()).toEqual([])
    expect(catalogDrift([null, {}], new Set())).toEqual([])
  })
})
