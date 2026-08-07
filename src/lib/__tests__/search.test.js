// ─────────────────────────────────────────────────────────────────────────────
// Global search — the logic behind the topbar box.
//
// The box in App.jsx used to be an <input> with no onChange while
// search_contacts()/search_properties() sat unused in the database. These cover
// the pure half; the wiring assertions at the bottom cover the connection.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MIN_SEARCH_CHARS, PER_SECTION, contactName, propertyLine, matches,
  isSearchable, searchAgentIds, filterContacts, filterProperties, filterDeals,
  flattenResults, moveCursor, routeForResult,
} from '../search.js'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const CONTACTS = [
  { id: 'c1', first_name: 'Dana',  last_name: 'Whitfield', email: 'dana@acme.com', phone: '5155550123', owner_city: 'Des Moines' },
  { id: 'c2', first_name: 'Marcus', last_name: 'Reed',     email: 'm@reed.io',     phone: '6055551000', owner_city: 'Sioux Falls' },
]
const PROPERTIES = [
  { id: 'p1', address: '1420 Grand Ave', city: 'Des Moines', state: 'IA', mls_number: 'MLS900', type: 'multifamily' },
  { id: 'p2', address: '77 Phillips Ave', city: 'Sioux Falls', state: 'SD', mls_number: 'MLS111', type: 'office' },
]
const DEALS = [
  { id: 'd1', title: '1420 Grand — 24 units', stage: 'due-diligence', notes: 'value-add' },
  { id: 'd2', title: 'Reed portfolio',        stage: 'loi',           notes: null },
]

describe('matches', () => {
  it('is case-insensitive across fields', () => {
    expect(matches('DANA', 'Dana Whitfield')).toBe(true)
    expect(matches('whit', 'Dana Whitfield')).toBe(true)
  })
  it('ignores null and undefined fields without throwing', () => {
    expect(matches('x', null, undefined, 'axb')).toBe(true)
    expect(matches('q', null, undefined)).toBe(false)
  })
  it('an empty term never matches — it would return the whole database', () => {
    expect(matches('', 'anything')).toBe(false)
    expect(matches('   ', 'anything')).toBe(false)
  })
})

describe('isSearchable', () => {
  it(`requires at least ${MIN_SEARCH_CHARS} characters`, () => {
    expect(isSearchable('a')).toBe(false)
    expect(isSearchable('ab')).toBe(true)
    expect(isSearchable('  a  ')).toBe(false)
    expect(isSearchable('')).toBe(false)
    expect(isSearchable(undefined)).toBe(false)
  })
})

describe('searchAgentIds', () => {
  const agents = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]
  it('an admin searches the whole roster', () => {
    expect(searchAgentIds({ isAdmin: true, agents, visibleAgentIds: ['a1'] })).toEqual(['a1', 'a2', 'a3'])
  })
  it('a normal agent searches only what they can already see', () => {
    expect(searchAgentIds({ isAdmin: false, agents, visibleAgentIds: ['a1', 'a2'] })).toEqual(['a1', 'a2'])
  })
  it('survives an empty roster', () => {
    expect(searchAgentIds({ isAdmin: true, agents: [], visibleAgentIds: [] })).toEqual([])
    expect(searchAgentIds({ isAdmin: false })).toEqual([])
  })
})

describe('client-side fallbacks (used when the RPC is unavailable)', () => {
  it('finds a contact by name, email, phone or city', () => {
    expect(filterContacts(CONTACTS, 'whitfield').map(c => c.id)).toEqual(['c1'])
    expect(filterContacts(CONTACTS, 'reed.io').map(c => c.id)).toEqual(['c2'])
    expect(filterContacts(CONTACTS, '6055551000').map(c => c.id)).toEqual(['c2'])
    expect(filterContacts(CONTACTS, 'sioux').map(c => c.id)).toEqual(['c2'])
  })
  it('finds a property by address, city or MLS number', () => {
    expect(filterProperties(PROPERTIES, 'grand').map(p => p.id)).toEqual(['p1'])
    expect(filterProperties(PROPERTIES, 'MLS111').map(p => p.id)).toEqual(['p2'])
  })
  it('caps each section', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `x${i}`, first_name: 'Same', last_name: 'Name' }))
    expect(filterContacts(many, 'same')).toHaveLength(PER_SECTION)
  })
  it('handles empty input arrays', () => {
    expect(filterContacts([], 'a')).toEqual([])
    expect(filterProperties(undefined, 'a')).toEqual([])
  })
})

describe('filterDeals', () => {
  it('matches title and notes', () => {
    expect(filterDeals(DEALS, 'grand').map(d => d.id)).toEqual(['d1'])
    expect(filterDeals(DEALS, 'value-add').map(d => d.id)).toEqual(['d1'])
  })
  it('returns nothing below the minimum length rather than everything', () => {
    expect(filterDeals(DEALS, 'a')).toEqual([])
    expect(filterDeals(DEALS, '')).toEqual([])
  })
  it('includes commercial-stage deals — they are the bulk of the pipeline', () => {
    expect(filterDeals(DEALS, 'reed').map(d => d.id)).toEqual(['d2'])
  })
})

describe('flattenResults', () => {
  const flat = flattenResults(
    { contacts: CONTACTS, properties: PROPERTIES, deals: DEALS },
    (s) => ({ 'due-diligence': 'Due Diligence', loi: 'LOI' }[s] || s)
  )

  it('orders contacts, then properties, then deals', () => {
    expect(flat.map(f => f.kind)).toEqual(['contact','contact','property','property','deal','deal'])
  })
  it('labels each row for display', () => {
    expect(flat[0].label).toBe('Dana Whitfield')
    expect(flat[2].label).toBe('1420 Grand Ave · Des Moines, IA')
    expect(flat[4].sub).toBe('Due Diligence')
  })
  it('falls back to a dash rather than rendering blank', () => {
    const [only] = flattenResults({ contacts: [{ id: 'z' }] })
    expect(only.sub).toBe('—')
  })
  it('handles missing sections', () => {
    expect(flattenResults({})).toEqual([])
  })
})

describe('moveCursor', () => {
  it('wraps in both directions', () => {
    expect(moveCursor(0, -1, 3)).toBe(2)
    expect(moveCursor(2,  1, 3)).toBe(0)
    expect(moveCursor(1,  1, 3)).toBe(2)
  })
  it('is safe on an empty list', () => {
    expect(moveCursor(0, 1, 0)).toBe(0)
    expect(moveCursor(5, -1, 0)).toBe(0)
  })
})

describe('routeForResult', () => {
  it('sends a deal straight to its page', () => {
    expect(routeForResult({ kind: 'deal', id: 'd1' })).toEqual({ route: 'deal/d1', focus: null })
  })
  it('sends a contact or property to its list page with a record to open', () => {
    expect(routeForResult({ kind: 'contact', id: 'c1' }))
      .toEqual({ route: 'contacts', focus: { type: 'contact', id: 'c1' } })
    expect(routeForResult({ kind: 'property', id: 'p1' }))
      .toEqual({ route: 'properties', focus: { type: 'property', id: 'p1' } })
  })
  it('returns null for nothing selected', () => {
    expect(routeForResult(null)).toBeNull()
  })
})

describe('the box is actually wired up', () => {
  const app = read('../../App.jsx')
  const cmp = read('../../components/GlobalSearch.jsx')

  it('App.jsx no longer renders the dead handler-less input', () => {
    expect(app).not.toMatch(/<input placeholder="Search contacts, properties, deals…" defaultValue="" \/>/)
    expect(app).toMatch(/<GlobalSearch/)
  })

  it('the component calls both database search functions', () => {
    expect(cmp).toMatch(/supabase\.rpc\('search_contacts'/)
    expect(cmp).toMatch(/supabase\.rpc\('search_properties'/)
  })

  it('the input is controlled and has a change handler', () => {
    expect(cmp).toMatch(/value=\{q\}/)
    expect(cmp).toMatch(/onChange=\{e => \{ setQ\(e\.target\.value\)/)
  })

  it('queries are debounced so typing does not fire a request per keystroke', () => {
    expect(cmp).toMatch(/useDebounce\(q, \d+\)/)
  })

  it('search is no longer hidden on mobile', () => {
    const css = read('../../styles/app.css')
    expect(css).not.toMatch(/\.topbar__search \{ display: none; \}/)
  })
})
