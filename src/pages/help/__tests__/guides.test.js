// The real guide content, checked the way an agent would trip over it: every
// "Take me there" must reach a screen that exists, every related link must
// point at a guide that exists, and every **label** must be closed.
import { describe, it, expect } from 'vitest'
import { CATEGORIES, GUIDES } from '../guides/index.js'
import { ROUTE_IDS } from '../../../app/routes.jsx'
import { searchGuides, validateGuides, visibleGuides } from '../guideModel.js'

describe('help guide content', () => {
  it('passes validation', () => {
    expect(validateGuides(GUIDES, { categories: CATEGORIES, routes: ROUTE_IDS })).toEqual([])
  })

  it('covers every topic', () => {
    for (const c of CATEGORIES) expect(GUIDES.some(g => g.category === c.id), c.id).toBe(true)
  })

  it('keeps admin-only guides away from agents but shows them to admins', () => {
    const agentIds = visibleGuides(GUIDES).map(g => g.id)
    expect(agentIds).not.toContain('review-queue')
    expect(visibleGuides(GUIDES, { isAdmin: true }).map(g => g.id)).toContain('review-queue')
    // An agent-facing guide never links to a guide the agent can't open.
    const agentSet = new Set(agentIds)
    for (const g of visibleGuides(GUIDES)) {
      for (const r of g.related || []) expect(agentSet.has(r), `${g.id} → ${r}`).toBe(true)
    }
  })

  // The questions agents actually ask, and the guide each should find first.
  it.each([
    ['add a contact', 'add-contact'],
    ['import csv', 'import-contacts'],
    ['split pdf', 'split-documents'],
    ['merge', 'merge-documents'],
    ['send for signature', 'send-from-template'],
    ['mass email', 'mass-email'],
    ['outlook', 'connect-outlook'],
    ['qr code', 'mail-campaign'],
    ['drip', 'drip-sequence'],
    ['close a deal', 'close-deal'],
  ])('“%s” finds %s first', (query, id) => {
    expect(searchGuides(visibleGuides(GUIDES), query)[0]?.id).toBe(id)
  })
})
