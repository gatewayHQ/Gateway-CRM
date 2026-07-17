import { describe, it, expect } from 'vitest'
import { detectStateFromTitle } from '../cron.js'

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
