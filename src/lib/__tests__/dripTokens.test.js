// ─────────────────────────────────────────────────────────────────────────────
// Drip personalization — src/lib/dripTokens.js.
//
// The one promise this module makes: a lead who set a search on the website
// gets an email written around that search, and a lead who did not gets an
// email that still reads naturally. A literal "{{beds}}" or "Hi ," in a
// client's inbox is the failure these guard.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import {
  renderDripText, dripTokens, searchSummary, searchCriteria, matchListings,
  renderDripEmail, formatMoney, wantsListings, STARTER_BUYER_SEQUENCE, DRIP_TOKENS,
} from '../dripTokens.js'

const LEAD = {
  first_name: 'Jordan', last_name: 'Miller', email: 'jordan@example.com',
  search_beds_min: 3, search_baths_min: 4, search_price_max: 250000, submarket: 'Sioux City',
}
const AGENT = { name: 'Alex Agent', phone: '(712) 555-0100', email: 'alex@gw.com' }

describe('searchSummary', () => {
  it('reads like a sentence from whatever the lead set', () => {
    expect(searchSummary(searchCriteria(LEAD))).toBe('3+ bed, 4+ bath homes up to $250,000 in Sioux City')
  })
  it('handles a price range and partial criteria', () => {
    expect(searchSummary({ priceMin: 150000, priceMax: 250000 })).toBe('homes between $150,000 and $250,000')
    expect(searchSummary({ bedsMin: 2 })).toBe('2+ bed homes')
    expect(searchSummary({ bathsMin: 2.5 })).toBe('2.5+ bath homes')
  })
  it('is empty when nothing is known, so the fallback shows', () => {
    expect(searchSummary({})).toBe('')
  })
})

describe('renderDripText', () => {
  const tokens = dripTokens({ contact: LEAD, agent: AGENT, propertyViewed: '1234 Jackson St' })

  it('fills tokens from the lead, the agent and the viewed home', () => {
    expect(renderDripText('Hi {{firstName}}, {{agentFirstName}} here about {{propertyViewed}} ({{beds}} bd / {{maxPrice}})', tokens))
      .toBe('Hi Jordan, Alex here about 1234 Jackson St (3 bd / $250,000)')
  })

  it('uses the inline fallback when the value is unknown', () => {
    const bare = dripTokens({ contact: { first_name: '' }, agent: AGENT })
    expect(renderDripText('Hi {{firstName|there}}, a few {{searchSummary|homes}} for you', bare))
      .toBe('Hi there, a few homes for you')
  })

  it('never leaves a raw token or a dangling comma behind', () => {
    const bare = dripTokens({ contact: {}, agent: {} })
    const out = renderDripText('Hi {{firstName}}, see {{unknownToken}} now.', bare)
    expect(out).not.toMatch(/\{\{|\}\}/)
    expect(out).toBe('Hi, see now.')
  })

  it('matches token names without regard to case', () => {
    expect(renderDripText('{{FIRSTNAME}}', tokens)).toBe('Jordan')
  })

  it('drops the placeholder last name the website intake stores for one-word names', () => {
    expect(dripTokens({ contact: { first_name: 'Cher', last_name: '—' } }).lastName).toBe('')
  })
})

describe('matchListings', () => {
  const props = [
    { id: 'a', address: '1 A St', city: 'Sioux City', type: 'residential', status: 'active', list_price: 240000, beds: 3, baths: 4 },
    { id: 'b', address: '2 B St', city: 'Sioux City', type: 'residential', status: 'active', list_price: 260000, beds: 4, baths: 4 },  // over budget
    { id: 'c', address: '3 C St', city: 'Sioux City', type: 'residential', status: 'sold',   list_price: 200000, beds: 3, baths: 4 },  // not active
    { id: 'd', address: '4 D St', city: 'Omaha',      type: 'residential', status: 'active', list_price: 200000, beds: 3, baths: 4 },  // wrong area
    { id: 'e', address: '5 E St', city: 'Sioux City', type: 'multifamily', status: 'active', list_price: 200000, beds: 3, baths: 4 },  // not a house
    { id: 'f', address: '6 F St', city: 'Sioux City', type: 'residential', status: 'active', list_price: 180000, beds: 2, baths: 4 },  // too few beds
    { id: 'g', address: '7 G St', city: 'Sioux City', type: 'residential', status: 'active', list_price: 210000, beds: 5, baths: 4.5 },
  ]

  it('applies every criterion the lead set, closest to the top of budget first', () => {
    expect(matchListings(props, searchCriteria(LEAD)).map(p => p.id)).toEqual(['a', 'g'])
  })

  it('returns nothing when the lead set no criteria — random houses read as spam', () => {
    expect(matchListings(props, {})).toEqual([])
  })

  it('caps the number of cards', () => {
    expect(matchListings(props, { priceMax: 1e7 }, { limit: 2 })).toHaveLength(2)
  })
})

describe('renderDripEmail', () => {
  const tokens = dripTokens({ contact: LEAD, agent: AGENT })
  const listings = [{ id: 'p1', address: '1 A St', city: 'Sioux City', state: 'IA', list_price: 240000, beds: 3, baths: 4 }]

  it('puts the listing cards where the agent placed the token, with links to the listing page', () => {
    const { html, text } = renderDripEmail({
      subject: 'Homes for {{firstName}}',
      body: 'Here you go:\n\n{{matchingListings}}\n\nCall me.',
      tokens, listings, agent: AGENT, baseUrl: 'https://crm.example.com', unsubscribeUrl: 'https://crm.example.com/u/x',
    })
    expect(html.indexOf('Here you go')).toBeLessThan(html.indexOf('1 A St'))
    expect(html.indexOf('1 A St')).toBeLessThan(html.indexOf('Call me'))
    expect(html).toContain('https://crm.example.com/listing/p1')
    expect(html).toContain('$240,000')
    expect(text).toContain('https://crm.example.com/listing/p1')
  })

  it('carries a working opt-out and the office postal address', () => {
    const { html } = renderDripEmail({ body: 'Hi', tokens, agent: AGENT, unsubscribeUrl: 'https://crm.example.com/u/tok' })
    expect(html).toContain('https://crm.example.com/u/tok')
    expect(html).toMatch(/Unsubscribe/)
  })

  it('escapes what the agent typed — a step body is not HTML', () => {
    const { html } = renderDripEmail({ body: '<script>alert(1)</script>', tokens, agent: AGENT })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('omits the cards cleanly when nothing matches', () => {
    const { html } = renderDripEmail({ body: 'A\n\n{{matchingListings}}\n\nB', tokens, listings: [], agent: AGENT })
    expect(html).not.toContain('matchingListings')
    expect(html).not.toContain('\u0000')
  })

  it('renders the subject with tokens', () => {
    expect(renderDripEmail({ subject: 'Hi {{firstName}}', tokens }).subject).toBe('Hi Jordan')
  })
})

describe('starter sequence', () => {
  it('only uses tokens the editor offers, and opens with a Day-0 email', () => {
    const known = new Set(DRIP_TOKENS.map(t => t.key.toLowerCase()))
    for (const step of STARTER_BUYER_SEQUENCE.steps) {
      for (const [, key] of `${step.subject} ${step.body}`.matchAll(/\{\{\s*([a-zA-Z]+)/g)) {
        expect(known.has(key.toLowerCase()), `unknown token {{${key}}}`).toBe(true)
      }
    }
    expect(STARTER_BUYER_SEQUENCE.steps[0]).toMatchObject({ step_type: 'email', delay_days: 0 })
    expect(STARTER_BUYER_SEQUENCE.steps.some(s => s.step_type === 'call')).toBe(true)
    expect(wantsListings(STARTER_BUYER_SEQUENCE.steps[0].body)).toBe(true)
  })

  it('formats money plainly', () => {
    expect(formatMoney(250000)).toBe('$250,000')
    expect(formatMoney(null)).toBe('')
  })
})
