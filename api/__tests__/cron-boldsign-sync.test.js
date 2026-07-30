import { describe, it, expect } from 'vitest'
import { detectStateFromTitle, boldsignTemplateId, boldsignTemplateTitle } from '../cron.js'

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
