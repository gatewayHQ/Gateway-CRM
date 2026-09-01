// The dashboard's signature queue. The ordering IS the feature — an agent works
// this list top-down, so "oldest first" is not a presentation detail, it is what
// makes the tile worth looking at.
import { describe, it, expect } from 'vitest'
import { buildQueue, daysWaiting, urgencyOf, waitingLabel, recipientLine } from '../SignatureQueue.jsx'

const NOW = new Date('2026-09-01T12:00:00Z').getTime()
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString()

describe('daysWaiting', () => {
  it('counts from the send, not from when the row was created', () => {
    // The embedded flow writes the row when the agent opens the PREPARE screen,
    // possibly days before the send. Counting from created_at made an old draft
    // that finally went out look instantly stale.
    expect(daysWaiting({ sent_at: daysAgo(3), created_at: daysAgo(30) }, NOW)).toBe(3)
  })

  it('falls back to created_at for a row with no send stamp', () => {
    expect(daysWaiting({ created_at: daysAgo(5) }, NOW)).toBe(5)
  })

  it('is null when there is no date at all, and never negative', () => {
    expect(daysWaiting({}, NOW)).toBeNull()
    expect(daysWaiting({ sent_at: 'not a date' }, NOW)).toBeNull()
    expect(daysWaiting({ sent_at: new Date(NOW + 86400000).toISOString() }, NOW)).toBe(0)
  })
})

describe('urgency', () => {
  it('escalates at three days and again at a week', () => {
    expect(urgencyOf(0).level).toBe('fresh')
    expect(urgencyOf(2).level).toBe('fresh')
    expect(urgencyOf(3).level).toBe('warm')
    expect(urgencyOf(6).level).toBe('warm')
    expect(urgencyOf(7).level).toBe('cold')
    expect(urgencyOf(40).level).toBe('cold')
    expect(urgencyOf(null).level).toBe('new')
  })
})

describe('buildQueue', () => {
  it('puts the oldest chase at the top — that is the one at risk', () => {
    const { awaiting } = buildQueue([
      { id: 'fresh', status: 'sent',      sent_at: daysAgo(1) },
      { id: 'stale', status: 'sent',      sent_at: daysAgo(12) },
      { id: 'mid',   status: 'delivered', sent_at: daysAgo(4) },
    ], NOW)
    expect(awaiting.map(r => r.id)).toEqual(['stale', 'mid', 'fresh'])
    expect(awaiting[0].days).toBe(12)
  })

  it('counts delivered as in flight — the client opened it and still has not signed', () => {
    const { awaiting } = buildQueue([{ id: 'v', status: 'delivered', sent_at: daysAgo(1) }], NOW)
    expect(awaiting).toHaveLength(1)
  })

  it('keeps drafts apart, newest first — finishing one is a different job from chasing', () => {
    const { awaiting, drafts } = buildQueue([
      { id: 'old_draft', status: 'draft', created_at: daysAgo(9) },
      { id: 'new_draft', status: 'draft', created_at: daysAgo(1) },
      { id: 'sent',      status: 'sent',  sent_at: daysAgo(2) },
    ], NOW)
    expect(awaiting.map(r => r.id)).toEqual(['sent'])
    expect(drafts.map(r => r.id)).toEqual(['new_draft', 'old_draft'])
  })

  it('shows nothing that is finished — a signed or voided document is not a queue item', () => {
    const { awaiting, drafts } = buildQueue([
      { id: 'done',    status: 'completed', sent_at: daysAgo(1) },
      { id: 'dead',    status: 'voided',    sent_at: daysAgo(1) },
      { id: 'no',      status: 'declined',  sent_at: daysAgo(1) },
      { id: 'expired', status: 'expired',   sent_at: daysAgo(1) },
    ], NOW)
    expect(awaiting).toHaveLength(0)
    expect(drafts).toHaveLength(0)
  })

  it('survives an empty table and junk rows', () => {
    expect(buildQueue([], NOW)).toEqual({ awaiting: [], drafts: [] })
    expect(buildQueue([null, {}, { status: 'weird' }], NOW)).toEqual({ awaiting: [], drafts: [] })
  })
})

describe('waitingLabel', () => {
  it('reads like a person saying it', () => {
    expect(waitingLabel(null)).toBe('just sent')
    expect(waitingLabel(0)).toBe('sent today')
    expect(waitingLabel(1)).toBe('waiting 1 day')
    expect(waitingLabel(9)).toBe('waiting 9 days')
  })
})

describe('recipientLine', () => {
  it('names the people on the document from the stored signer array', () => {
    expect(recipientLine({ signers: [{ name: 'Jane Doe' }, { name: 'John Doe' }] })).toBe('Jane Doe and John Doe')
  })

  it('reads both naming conventions — ad-hoc sends and template sends differ', () => {
    expect(recipientLine({ signers: [{ signerName: 'Jane Doe' }] })).toBe('Jane Doe')
    expect(recipientLine({ signers: [{ signerEmail: 'jane@example.com' }] })).toBe('jane@example.com')
  })

  it('summarises a crowd rather than overflowing the row', () => {
    expect(recipientLine({ signers: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] }))
      .toBe('A and 3 others')
  })

  it('falls back to the legacy comma-joined column', () => {
    expect(recipientLine({ signer_name: 'Jane Doe, John Doe' })).toBe('Jane Doe and John Doe')
  })

  it('says so plainly when there is nobody recorded', () => {
    expect(recipientLine({})).toBe('no recipients recorded')
    expect(recipientLine({ signers: [], signer_name: '' })).toBe('no recipients recorded')
  })
})
