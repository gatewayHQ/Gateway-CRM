import { describe, it, expect } from 'vitest'
import {
  normalize, searchGuides, guidesForRoute, groupByCategory, formatText, validateGuides, visibleGuides,
} from '../guideModel.js'

const g = (id, extra = {}) => ({
  id, category: 'contacts', title: id, summary: 's', steps: [{ title: 't', body: 'b' }], ...extra,
})

const GUIDES = [
  g('add-contact', { title: 'Add a contact', keywords: ['new client'], routes: ['contacts'] }),
  g('import-contacts', { title: 'Import contacts from a spreadsheet', keywords: ['csv', 'excel'], routes: ['contacts'] }),
  g('split-pdf', { category: 'documents', title: 'Split a PDF into separate documents', routes: ['pipeline'],
    steps: [{ title: 'Open the deal', body: 'Go to **Documents** and choose **Split**.' }] }),
  g('merge-docs', { category: 'documents', title: 'Merge documents into one PDF', summary: 'Combine several contact files.' }),
  g('admin-thing', { title: 'Approve a closing', adminOnly: true }),
]

describe('normalize', () => {
  it('lower-cases, strips accents, bold markers and punctuation', () => {
    expect(normalize('  Café — **Save** & E-Sign!  ')).toBe('cafe save e sign')
  })
})

describe('searchGuides', () => {
  it('returns everything for an empty query', () => {
    expect(searchGuides(GUIDES, '   ')).toBe(GUIDES)
  })
  it('ranks title matches first and requires every word', () => {
    expect(searchGuides(GUIDES, 'split pdf').map(x => x.id)).toEqual(['split-pdf'])
  })
  it('finds keywords and plurals', () => {
    expect(searchGuides(GUIDES, 'CSV').map(x => x.id)).toEqual(['import-contacts'])
    expect(searchGuides(GUIDES, 'contacts').map(x => x.id)).toContain('add-contact')
  })
  it('matches word prefixes as you type', () => {
    expect(searchGuides(GUIDES, 'spre').map(x => x.id)).toEqual(['import-contacts'])
  })
  it('ranks a summary or step match below a title match', () => {
    // merge-docs only mentions "contact" in its summary.
    expect(searchGuides(GUIDES, 'contact').map(x => x.id)).toEqual(['add-contact', 'import-contacts', 'merge-docs'])
    // split-pdf only mentions "deal" in a step.
    expect(searchGuides(GUIDES, 'deal').map(x => x.id)).toEqual(['split-pdf'])
  })
  it('returns nothing when a word matches nowhere', () => {
    expect(searchGuides(GUIDES, 'split zebra')).toEqual([])
  })
})

describe('filters', () => {
  it('hides admin-only guides from agents', () => {
    expect(visibleGuides(GUIDES).map(x => x.id)).not.toContain('admin-thing')
    expect(visibleGuides(GUIDES, { isAdmin: true }).map(x => x.id)).toContain('admin-thing')
  })
  it('finds the guides for a screen', () => {
    expect(guidesForRoute(GUIDES, 'contacts').map(x => x.id)).toEqual(['add-contact', 'import-contacts'])
    expect(guidesForRoute(GUIDES, 'nowhere')).toEqual([])
  })
  it('groups by category in category order, dropping empty ones', () => {
    const cats = [{ id: 'documents', label: 'Docs' }, { id: 'empty', label: 'E' }, { id: 'contacts', label: 'C' }]
    expect(groupByCategory(GUIDES, cats).map(c => [c.id, c.guides.length])).toEqual([['documents', 2], ['contacts', 3]])
  })
})

describe('formatText', () => {
  it('splits **bold** labels without parsing HTML', () => {
    expect(formatText('Click **Save** now <b>')).toEqual([
      { text: 'Click ', bold: false }, { text: 'Save', bold: true }, { text: ' now <b>', bold: false },
    ])
  })
  it('leaves an unmatched marker as literal text', () => {
    expect(formatText('a ** b')).toEqual([{ text: 'a ** b' }])
  })
})

describe('validateGuides', () => {
  const opts = { categories: [{ id: 'contacts' }, { id: 'documents' }], routes: ['contacts', 'pipeline'] }
  it('passes good content', () => {
    expect(validateGuides(GUIDES, opts)).toEqual([])
  })
  it('reports every kind of broken guide', () => {
    const bad = [
      g('dup'), g('dup'),
      g('x', { category: 'nope', routes: ['ghost'], action: { label: 'Go', route: 'ghost', startNew: 'unicorn' },
        related: ['missing'], steps: [{ title: 'only', body: 'an **open marker' }] }),
      g('y', { steps: [] }),
    ]
    const problems = validateGuides(bad, opts).join('\n')
    expect(problems).toMatch(/"dup" is defined twice/)
    expect(problems).toMatch(/unknown category "nope"/)
    expect(problems).toMatch(/unknown screen "ghost"/)
    expect(problems).toMatch(/can't start a new "unicorn"/)
    expect(problems).toMatch(/missing guide "missing"/)
    expect(problems).toMatch(/unmatched \*\*/)
    expect(problems).toMatch(/"y" has no steps/)
  })
})
