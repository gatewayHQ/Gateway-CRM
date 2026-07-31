import { describe, it, expect } from 'vitest'
import { detectStateFromTitle, shouldRemind } from '../cron.js'

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

// ─────────────────────────────────────────────────────────────────────────────
// Auto-reminder sweep. An e-signature request that nags is worse than one that
// doesn't — it gets ignored or marked as spam — so every one of these bounds
// matters as much as the reminder itself.
// ─────────────────────────────────────────────────────────────────────────────
describe('shouldRemind — nightly signature chase', () => {
  const NOW = new Date('2026-07-31T12:00:00Z')
  const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString()
  const doc = (over = {}) => ({ status: 'sent', sent_at: daysAgo(10), reminder_count: 0, last_reminded_at: null, ...over })

  it('reminds a document that has been outstanding long enough', () => {
    expect(shouldRemind(doc(), NOW)).toBe(true)
  })

  it('leaves a freshly sent document alone', () => {
    expect(shouldRemind(doc({ sent_at: daysAgo(1) }), NOW)).toBe(false)
    expect(shouldRemind(doc({ sent_at: daysAgo(2.9) }), NOW)).toBe(false)
  })

  it('does not remind twice inside the cooldown window', () => {
    expect(shouldRemind(doc({ last_reminded_at: daysAgo(1) }), NOW)).toBe(false)
    expect(shouldRemind(doc({ last_reminded_at: daysAgo(4) }), NOW)).toBe(true)
  })

  it('stops after the per-document cap so a client is never spammed', () => {
    expect(shouldRemind(doc({ reminder_count: 3, last_reminded_at: daysAgo(9) }), NOW)).toBe(true)
    expect(shouldRemind(doc({ reminder_count: 4, last_reminded_at: daysAgo(9) }), NOW)).toBe(false)
    expect(shouldRemind(doc({ reminder_count: 99 }), NOW)).toBe(false)
  })

  it('only chases documents actually awaiting signature', () => {
    for (const status of ['draft', 'completed', 'declined', 'expired', 'voided']) {
      expect(shouldRemind(doc({ status }), NOW)).toBe(false)
    }
    expect(shouldRemind(doc({ status: 'delivered' }), NOW)).toBe(true)
  })

  it('falls back to created_at when sent_at is missing, and never reminds without either', () => {
    expect(shouldRemind({ status: 'sent', created_at: daysAgo(10), reminder_count: 0 }, NOW)).toBe(true)
    expect(shouldRemind({ status: 'sent', reminder_count: 0 }, NOW)).toBe(false)
  })

  it('treats a null reminder_count as zero rather than throwing', () => {
    expect(shouldRemind(doc({ reminder_count: null }), NOW)).toBe(true)
  })
})
