import { describe, it, expect } from 'vitest'
import {
  announcementTokens, renderTokens, renderAnnouncementHtml, defaultPhotoUrl,
  propertyPhotos, unitCount, announcementPrice, assetTypeLabel, fullAddress,
  defaultAnnouncementBody, defaultAnnouncementSubject, statusLabel,
} from '../dealAnnouncement.js'

const property = {
  id: 'p1',
  address: '1200 Grand Ave', city: 'Des Moines', state: 'IA', zip: '50309',
  type: 'multifamily',
  list_price: 4_250_000,
  details: { total_units: 24, photos: ['https://cdn.example/one.jpg', 'https://cdn.example/two.jpg'] },
}
const agent   = { id: 'a1', name: 'Daniel Stillson' }
const contact = { id: 'c1', first_name: 'Pat', last_name: 'Ryan', email: 'pat@example.com' }

describe('property field extraction', () => {
  it('pulls photos from the property record and defaults to the first', () => {
    expect(propertyPhotos(property)).toHaveLength(2)
    expect(defaultPhotoUrl(property)).toBe('https://cdn.example/one.jpg')
    expect(defaultPhotoUrl({ details: {} })).toBeNull()
    expect(defaultPhotoUrl(null)).toBeNull()
  })

  it('reads unit count from details.total_units and blanks a missing one', () => {
    expect(unitCount(property)).toBe('24')
    expect(unitCount({ details: {} })).toBe('')
    expect(unitCount({ details: { total_units: 0 } })).toBe('')
  })

  it('announces the sold price on a closing and the list price otherwise', () => {
    const closed = { ...property, details: { ...property.details, sold_price: 4_500_000 } }
    expect(announcementPrice(closed, 'closed')).toBe('$4,500,000')
    expect(announcementPrice(closed, 'new-listing')).toBe('$4,250,000')
  })

  it('falls back to the list price on a closing with no recorded sale price', () => {
    expect(announcementPrice(property, 'closed')).toBe('$4,250,000')
  })

  it('renders the asset type as a label, not a raw enum token', () => {
    expect(assetTypeLabel(property)).toBe('Multifamily')
    expect(assetTypeLabel({ type: 'mixed-use' })).toBe('Mixed-Use')
    expect(assetTypeLabel({})).toBe('')
  })

  it('builds a full address and tolerates missing parts', () => {
    expect(fullAddress(property)).toBe('1200 Grand Ave, Des Moines, IA, 50309')
    expect(fullAddress({ address: '5 Elm St' })).toBe('5 Elm St')
  })
})

describe('renderTokens', () => {
  const tokens = announcementTokens({ property, status: 'closed', agent, contact, terms: 'All cash, 30-day close' })

  it('fills every documented token', () => {
    expect(tokens.firstName).toBe('Pat')
    expect(tokens.agentName).toBe('Daniel Stillson')
    expect(tokens.assetType).toBe('Multifamily')
    expect(tokens.unitCount).toBe('24')
    expect(tokens.price).toBe('$4,250,000')
    expect(tokens.terms).toBe('All cash, 30-day close')
    expect(tokens.dealStatus).toBe('Just Closed')
  })

  it('substitutes tokens in a body', () => {
    expect(renderTokens('Hi {{firstName}} — {{dealStatus}} at {{propertyAddress}}.', tokens))
      .toBe('Hi Pat — Just Closed at 1200 Grand Ave, Des Moines, IA, 50309.')
  })

  it('leaves an unknown token visible rather than blanking it', () => {
    expect(renderTokens('{{propertyAdress}}', tokens)).toBe('{{propertyAdress}}')
  })

  it('greets a contact with no first name without an empty gap', () => {
    const t = announcementTokens({ property, status: 'closed', agent, contact: {} })
    expect(renderTokens('Hi {{firstName}},', t)).toBe('Hi there,')
  })
})

describe('renderAnnouncementHtml', () => {
  const html = (over = {}) => renderAnnouncementHtml({
    property, status: 'closed', agent, contact,
    terms: 'All cash', customMessage: 'Third multifamily closing this quarter.',
    ...over,
  })

  it('leads with the status ribbon and the property photo', () => {
    const out = html()
    expect(out).toContain('Just Closed')
    expect(out).toContain('https://cdn.example/one.jpg')
  })

  it('uses an override photo instead of the property default when given', () => {
    const out = html({ photoUrl: 'https://cdn.example/override.jpg' })
    expect(out).toContain('https://cdn.example/override.jpg')
    expect(out).not.toContain('https://cdn.example/one.jpg')
  })

  it('renders without a photo when the property has none', () => {
    const out = html({ property: { ...property, details: { total_units: 24 } } })
    expect(out).not.toContain('<img')
    expect(out).toContain('1200 Grand Ave')
  })

  it('omits fact rows that have no value rather than printing an empty line', () => {
    const office = { ...property, type: 'office', details: { photos: [] } }
    const out = renderAnnouncementHtml({ property: office, status: 'new-listing', agent, contact })
    expect(out).not.toContain('>Units<')
    expect(out).toContain('>Asset type<')
  })

  it('carries the agent custom message into the body', () => {
    expect(html()).toContain('Third multifamily closing this quarter.')
  })

  it('escapes HTML in agent-supplied text so a stray angle bracket cannot break the email', () => {
    const out = html({ customMessage: 'Cap rate <5% — call me' })
    expect(out).toContain('Cap rate &lt;5% — call me')
    expect(out).not.toContain('Cap rate <5%')
  })

  it('personalises per recipient — the same send renders a different greeting each time', () => {
    const a = html({ contact: { first_name: 'Pat' } })
    const b = html({ contact: { first_name: 'Sam' } })
    expect(a).toContain('Hi Pat,')
    expect(b).toContain('Hi Sam,')
  })
})

describe('defaults', () => {
  it('offers a status-specific subject and body', () => {
    expect(defaultAnnouncementSubject('closed')).toBe('Just Closed — {{propertyAddress}}')
    expect(defaultAnnouncementBody('new-listing')).toContain('brought {{propertyAddress}} to market')
    expect(defaultAnnouncementBody('price-reduced')).toContain('reduced')
  })

  it('labels every supported status', () => {
    expect(statusLabel('under-contract')).toBe('Under Contract')
    expect(statusLabel('nonsense')).toBe('Announcement')
  })
})
