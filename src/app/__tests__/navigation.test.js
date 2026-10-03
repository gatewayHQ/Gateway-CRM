import { describe, it, expect } from 'vitest'
import {
  buildNav, hiddenNavFor, mobileTabsFor, mobileMoreGroups,
  pageTitleFor, parseDealRoute, navRouteFor, isAdminOnlyRoute,
} from '../navigation.js'

const ids = (items) => items.map(n => n.id)

describe('hiddenNavFor', () => {
  it('adds Messages for an agent without a Twilio number', () => {
    expect(hiddenNavFor({ nav_hidden: ['reports'] })).toEqual(['reports', 'messages'])
  })
  it('leaves Messages for an agent with one', () => {
    expect(hiddenNavFor({ nav_hidden: ['reports'], twilio_number: '+15155550123' })).toEqual(['reports'])
  })
  it('hides nothing before the agent has loaded', () => {
    expect(hiddenNavFor(undefined)).toEqual([])
  })
})

describe('buildNav', () => {
  it('drops admin-only entries for a regular agent', () => {
    const nav = buildNav({ isAdmin: false, hiddenNav: [] })
    expect(ids(nav.office)).not.toContain('review')
    expect(ids(nav.admin)).not.toContain('data-management')
  })
  it('keeps them for an admin', () => {
    const nav = buildNav({ isAdmin: true, hiddenNav: [] })
    expect(ids(nav.office)).toContain('review')
    expect(ids(nav.admin)).toContain('data-management')
  })
  it('hides the entries an agent hid, everywhere but the admin block', () => {
    const nav = buildNav({ isAdmin: false, hiddenNav: ['tasks', 'reports', 'leads', 'settings'] })
    expect(ids(nav.all)).not.toEqual(expect.arrayContaining(['tasks', 'reports', 'leads']))
    expect(ids(nav.admin)).toContain('settings')
  })
  it('lists every entry in sidebar order', () => {
    const nav = buildNav({ isAdmin: false, hiddenNav: [] })
    expect(ids(nav.all)).toEqual([...nav.core, ...nav.office, ...nav.tools, ...nav.admin].map(n => n.id))
  })
})

describe('mobile navigation', () => {
  const nav = buildNav({ isAdmin: false, hiddenNav: [] })
  it('puts the four daily screens on the bottom bar', () => {
    expect(ids(mobileTabsFor(nav, false))).toEqual(['dashboard', 'contacts', 'pipeline', 'tasks'])
  })
  it('gives Contacts way for an admin', () => {
    expect(ids(mobileTabsFor(buildNav({ isAdmin: true, hiddenNav: [] }), true)))
      .toEqual(['dashboard', 'pipeline', 'tasks'])
  })
  it('skips a hidden tab', () => {
    expect(ids(mobileTabsFor(buildNav({ isAdmin: false, hiddenNav: ['tasks'] }), false)))
      .toEqual(['dashboard', 'contacts', 'pipeline'])
  })
  it('lists everything else under More, grouped, with no bottom-bar duplicates', () => {
    const groups = mobileMoreGroups(nav)
    expect(groups.map(([label]) => label)).toEqual(['Work', 'Marketing & Tools', 'Settings'])
    const listed = groups.flatMap(([, rows]) => ids(rows))
    expect(listed).not.toEqual(expect.arrayContaining(['dashboard', 'contacts', 'pipeline', 'tasks']))
    expect(listed).toContain('properties')
  })
})

describe('routes', () => {
  it('parses a deal route with and without a drawer tab', () => {
    expect(parseDealRoute('deal/d1')).toEqual({ dealId: 'd1', openTab: null })
    expect(parseDealRoute('deal/d1/signatures')).toEqual({ dealId: 'd1', openTab: 'signatures' })
  })
  it('lights up Pipeline for a deal', () => {
    expect(navRouteFor('deal/d1')).toBe('pipeline')
    expect(navRouteFor('tasks')).toBe('tasks')
  })
  it('knows which routes are admin-only', () => {
    expect(isAdminOnlyRoute('review')).toBe(true)
    expect(isAdminOnlyRoute('data-management')).toBe(true)
    expect(isAdminOnlyRoute('commission')).toBe(false)
  })
  it('titles a deal page after the deal', () => {
    expect(pageTitleFor('deal/d1/docs', [{ id: 'd1', title: '12 Main St' }]))
      .toEqual({ title: '12 Main St', crumb: 'Pipeline · Deal' })
    expect(pageTitleFor('deal/zz', [])).toEqual({ title: 'Deal', crumb: 'Pipeline · Deal' })
  })
  it('titles a page from its entry, and an unknown route as nothing', () => {
    expect(pageTitleFor('tasks')).toEqual({ title: 'Tasks', crumb: 'Follow-ups · Reminders' })
    expect(pageTitleFor('nope')).toEqual({})
  })
})
