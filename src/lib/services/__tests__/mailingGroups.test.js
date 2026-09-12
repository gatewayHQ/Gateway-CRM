import { describe, it, expect } from 'vitest'
import { MAILING_GROUPS, mailingGroup, groupMailings, mailingsSummary } from '../mailingGroups.js'

// ─────────────────────────────────────────────────────────────────────────────
// Mail campaigns, grouped by where each piece actually is. The one rule worth
// pinning: a mailing whose status nobody recognises is a DRAFT, never something
// presented as being out in the mail — the page must not imply that a piece was
// sent when the CRM cannot say that it was.
// ─────────────────────────────────────────────────────────────────────────────
const m = (status, over = {}) => ({ id: `${status}-${over.id || 1}`, status, ...over })

describe('mailingGroup', () => {
  it('puts anything a scan can come from in one place', () => {
    expect(mailingGroup(m('active'))).toBe('out')
    expect(mailingGroup(m('sent'))).toBe('out')
  })

  it('keeps drafts and archives apart from it', () => {
    expect(mailingGroup(m('draft'))).toBe('drafts')
    expect(mailingGroup(m('archived'))).toBe('archived')
  })

  it('treats an unknown or missing status as a draft, never as sent', () => {
    expect(mailingGroup(m('queued'))).toBe('drafts')
    expect(mailingGroup({})).toBe('drafts')
    expect(mailingGroup(m('  SENT  '))).toBe('out')   // but a real status still reads
  })
})

describe('groupMailings', () => {
  const list = [m('draft', { id: 1 }), m('sent', { id: 2 }), m('archived', { id: 3 }), m('active', { id: 4 })]

  it('orders the groups by how much attention they deserve', () => {
    expect(groupMailings(list).map(g => g.id)).toEqual(['out', 'drafts', 'archived'])
  })

  it('drops an empty group instead of drawing a header over nothing', () => {
    expect(groupMailings([m('draft')]).map(g => g.id)).toEqual(['drafts'])
    expect(groupMailings([])).toEqual([])
  })

  it('keeps the order the page sorted them into', () => {
    // The page has its own sort control; re-sorting here would silently
    // override the agent's choice.
    const sorted = [m('sent', { id: 'b' }), m('sent', { id: 'a' })]
    expect(groupMailings(sorted)[0].mailings.map(x => x.id)).toEqual(['b', 'a'])
  })

  it('loses nothing', () => {
    const total = groupMailings(list).reduce((n, g) => n + g.mailings.length, 0)
    expect(total).toBe(list.length)
  })

  it('opens what can still be worked on', () => {
    expect(Object.fromEntries(MAILING_GROUPS.map(g => [g.id, g.open])))
      .toEqual({ out: true, drafts: true, archived: false })
  })
})

describe('mailingsSummary', () => {
  it('leads with leads — the only figure here that is money', () => {
    const line = mailingsSummary([
      m('sent', { recipient_count: 136, scan_count: 4, lead_count: 2 }),
      m('draft', { id: 2 }),
    ])
    expect(line).toBe('1 out in the mail · 136 pieces · 4 scans · 2 leads')
  })

  it('still reports zero leads, because zero is the answer to the question', () => {
    expect(mailingsSummary([m('active', { scan_count: 13 })])).toContain('0 leads')
  })

  it('says nothing on an empty page', () => {
    expect(mailingsSummary([])).toBeNull()
  })
})
