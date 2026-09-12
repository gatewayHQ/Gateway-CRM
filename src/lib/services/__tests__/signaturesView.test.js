import { describe, it, expect } from 'vitest'
import {
  GROUPS, OVERDUE_DAYS, daysOut, packetGroup, groupPackets, summaryLine, nextStep, showsStatusChip,
} from '../signaturesView.js'

// ─────────────────────────────────────────────────────────────────────────────
// The judgement the Signatures tab now makes for the agent: which pile each
// packet goes in, and what the one sentence above them says. Getting this wrong
// is worse than the busy screen it replaces — a packet filed under "Signed" is
// a packet nobody chases — so every rule is pinned here rather than left to a
// reading of the JSX.
// ─────────────────────────────────────────────────────────────────────────────
const NOW = new Date('2026-09-12T12:00:00Z').getTime()
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString()

const packet = (status, over = {}) => ({ id: `${status}-${over.id || 1}`, status, sent_at: daysAgo(1), ...over })

describe('packetGroup — one packet, one pile', () => {
  it('puts a draft in front of the agent: nobody has been asked yet', () => {
    expect(packetGroup(packet('draft', { sent_at: null, created_at: daysAgo(0) }), NOW)).toBe('needs_you')
  })

  it('puts a flagged packet in front of the agent', () => {
    // needs_attention means a recipient cannot get in at all — a reminder fixes
    // nothing, so it must not sit quietly under "out for signature".
    expect(packetGroup(packet('needs_attention'), NOW)).toBe('needs_you')
  })

  it('leaves a packet that is simply moving under "out for signature"', () => {
    expect(packetGroup(packet('sent', { sent_at: daysAgo(1) }), NOW)).toBe('out')
    expect(packetGroup(packet('delivered', { sent_at: daysAgo(6) }), NOW)).toBe('out')
  })

  it('promotes a live packet the day it goes overdue', () => {
    expect(packetGroup(packet('sent', { sent_at: daysAgo(OVERDUE_DAYS - 1) }), NOW)).toBe('out')
    expect(packetGroup(packet('sent', { sent_at: daysAgo(OVERDUE_DAYS) }), NOW)).toBe('needs_you')
    expect(packetGroup(packet('sent', { sent_at: daysAgo(30) }), NOW)).toBe('needs_you')
  })

  it('files finished work out of the way, in the two kinds it comes in', () => {
    expect(packetGroup(packet('completed'), NOW)).toBe('signed')
    for (const dead of ['voided', 'declined', 'expired']) {
      expect(packetGroup(packet(dead), NOW)).toBe('stalled')
    }
  })

  it('does not pad "needs you" with work that has no deadline', () => {
    // A recalled packet does need a correction eventually. It is not what the
    // agent has to do today, and a triage list padded with maybes stops being
    // read at all.
    expect(packetGroup(packet('voided', { sent_at: daysAgo(40) }), NOW)).toBe('stalled')
  })

  it('has somewhere to put a status nobody has seen before', () => {
    expect(packetGroup(packet('something_new'), NOW)).toBe('stalled')
    expect(packetGroup({}, NOW)).toBe('stalled')
  })
})

describe('daysOut', () => {
  it('counts from when it went out, falling back to when it was made', () => {
    expect(daysOut({ sent_at: daysAgo(9) }, NOW)).toBe(9)
    expect(daysOut({ created_at: daysAgo(3) }, NOW)).toBe(3)
  })

  it('is null for a packet that never went anywhere, and never negative', () => {
    expect(daysOut({}, NOW)).toBeNull()
    expect(daysOut({ sent_at: 'not a date' }, NOW)).toBeNull()
    expect(daysOut({ sent_at: new Date(NOW + 86_400_000).toISOString() }, NOW)).toBe(0)
  })
})

describe('groupPackets — the list, in the order it is read', () => {
  const rows = [
    packet('completed', { id: 'c', sent_at: daysAgo(20) }),
    packet('sent',      { id: 'late', sent_at: daysAgo(9) }),
    packet('voided',    { id: 'v', sent_at: daysAgo(8) }),
    packet('delivered', { id: 'fresh', sent_at: daysAgo(1) }),
    packet('draft',     { id: 'd', sent_at: null, created_at: daysAgo(2) }),
  ]

  it('orders the groups by what the agent has to do about them', () => {
    expect(groupPackets(rows, NOW).map(g => g.id)).toEqual(['needs_you', 'out', 'stalled', 'signed'])
  })

  it('drops a group with nothing in it rather than drawing an empty header', () => {
    const only = groupPackets([packet('sent', { sent_at: daysAgo(1) })], NOW)
    expect(only.map(g => g.id)).toEqual(['out'])
    expect(groupPackets([], NOW)).toEqual([])
  })

  it('puts the newest first inside a group', () => {
    const grouped = groupPackets(rows, NOW)
    const needs = grouped.find(g => g.id === 'needs_you')
    expect(needs.packets.map(p => p.id)).toEqual(['d', 'late'])   // 2 days ago, then 9
  })

  it('opens what can be worked on and closes what is finished', () => {
    const open = Object.fromEntries(GROUPS.map(g => [g.id, g.open]))
    expect(open).toEqual({ needs_you: true, out: true, stalled: false, signed: false })
  })

  it('loses nothing — every packet lands in exactly one group', () => {
    const total = groupPackets(rows, NOW).reduce((n, g) => n + g.packets.length, 0)
    expect(total).toBe(rows.length)
  })
})

describe('summaryLine — the tab in one sentence', () => {
  it('leads with how many need the agent, and how late the worst one is', () => {
    const rows = [packet('sent', { id: 'a', sent_at: daysAgo(9) }), packet('draft', { id: 'b', sent_at: null, created_at: daysAgo(1) })]
    expect(summaryLine(rows, NOW)).toBe('2 documents need you. The oldest has been out 9 days.')
  })

  it('says it in the singular for one', () => {
    expect(summaryLine([packet('draft', { sent_at: null, created_at: daysAgo(1) })], NOW))
      .toBe('1 document needs you.')
  })

  it('reassures rather than alarms when everything is simply in motion', () => {
    const rows = [packet('sent', { sent_at: daysAgo(2) }), packet('delivered', { id: 2, sent_at: daysAgo(1) })]
    expect(summaryLine(rows, NOW)).toBe('2 documents out for signature — nothing needs you right now.')
  })

  it('says nothing at all when there is nothing to say', () => {
    // A tab holding only finished work should not manufacture a status line to
    // prove it is working.
    expect(summaryLine([packet('completed'), packet('voided', { id: 2 })], NOW)).toBeNull()
    expect(summaryLine([], NOW)).toBeNull()
  })
})

describe('nextStep — the one button that stays on the row', () => {
  it('names what will happen, per state', () => {
    expect(nextStep(packet('draft')).label).toBe('Send')
    expect(nextStep(packet('sent')).label).toBe('Remind')
    expect(nextStep(packet('delivered')).label).toBe('Remind')
    expect(nextStep(packet('completed')).label).toBe('Download')
    expect(nextStep(packet('voided')).label).toBe('Send correction')
  })

  it('never offers Remind on a packet BoldSign has flagged', () => {
    // The recipient cannot open the link or their address bounced. Emailing
    // them again teaches a client to ignore the next one.
    const step = nextStep(packet('needs_attention'))
    expect(step.id).toBe('fix')
    expect(step.label).toBe('Fix packet')
  })

  it('offers nothing rather than something useless', () => {
    expect(nextStep({ status: 'something_new' })).toBeNull()
    expect(nextStep({})).toBeNull()
  })
})

describe('showsStatusChip — the word only where the colour cannot say it', () => {
  it('drops the chip on a packet that is simply in progress', () => {
    expect(showsStatusChip(packet('sent'))).toBe(false)
    expect(showsStatusChip(packet('delivered'))).toBe(false)
  })

  it('keeps it where the word carries meaning of its own', () => {
    for (const s of ['draft', 'completed', 'voided', 'declined', 'needs_attention']) {
      expect(showsStatusChip(packet(s))).toBe(true)
    }
  })
})
