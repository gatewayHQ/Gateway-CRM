import { describe, it, expect } from 'vitest'
import {
  matchesAudience, resolveAudience, dedupeByEmail, isReachable,
  unreachableReason, typesForSides, describeAudience, BLANK_AUDIENCE,
} from '../audience.js'

const contact = (over = {}) => ({
  id: over.id || 'c1',
  first_name: 'Pat', last_name: 'Ryan',
  email: 'pat@example.com',
  type: 'buyer', status: 'active',
  asset_types: ['multifamily'],
  ...over,
})

describe('matchesAudience', () => {
  const mf = { assetTypes: ['multifamily'], sides: ['buyer', 'seller'] }

  it('matches a buyer whose criteria include the selected asset type', () => {
    expect(matchesAudience(contact(), mf)).toBe(true)
  })

  it('matches a seller of the same asset type (buyer OR seller in one send)', () => {
    expect(matchesAudience(contact({ type: 'seller' }), mf)).toBe(true)
  })

  it('excludes the other side when only one side is selected', () => {
    const buyersOnly = { assetTypes: ['multifamily'], sides: ['buyer'] }
    expect(matchesAudience(contact({ type: 'buyer' }),  buyersOnly)).toBe(true)
    expect(matchesAudience(contact({ type: 'seller' }), buyersOnly)).toBe(false)
    expect(matchesAudience(contact({ type: 'landlord' }), { assetTypes: ['multifamily'], sides: ['seller'] })).toBe(true)
  })

  it('ORs across several selected asset types', () => {
    const audience = { assetTypes: ['retail', 'office'], sides: ['buyer'] }
    expect(matchesAudience(contact({ asset_types: ['office'] }), audience)).toBe(true)
    expect(matchesAudience(contact({ asset_types: ['land'] }),   audience)).toBe(false)
  })

  it('matches a contact with several criteria if any one overlaps', () => {
    expect(matchesAudience(contact({ asset_types: ['land', 'retail'] }),
      { assetTypes: ['retail'], sides: ['buyer'] })).toBe(true)
  })

  it('is case-insensitive on asset type', () => {
    expect(matchesAudience(contact({ asset_types: ['Multifamily'] }), mf)).toBe(true)
  })

  it('never matches on an empty selection — a blank filter selects nobody', () => {
    expect(matchesAudience(contact(), BLANK_AUDIENCE)).toBe(false)
    expect(matchesAudience(contact(), { assetTypes: ['multifamily'], sides: [] })).toBe(false)
  })

  it('never matches a contact who stated no criteria', () => {
    expect(matchesAudience(contact({ asset_types: [] }), mf)).toBe(false)
    expect(matchesAudience(contact({ asset_types: null }), mf)).toBe(false)
  })

  it('excludes tenants — neither side expresses buy/sell criteria', () => {
    expect(matchesAudience(contact({ type: 'tenant' }), mf)).toBe(false)
  })

  it('excludes the unreachable regardless of criteria', () => {
    expect(matchesAudience(contact({ email: null }), mf)).toBe(false)
    expect(matchesAudience(contact({ email: '   ' }), mf)).toBe(false)
    expect(matchesAudience(contact({ email_opt_out: true }), mf)).toBe(false)
    expect(matchesAudience(contact({ status: 'closed' }), mf)).toBe(false)
    expect(matchesAudience(contact({ deleted_at: '2026-01-01' }), mf)).toBe(false)
  })
})

describe('typesForSides', () => {
  it('maps sides to the contact types that express that criteria', () => {
    expect(typesForSides(['buyer'])).toEqual(['buyer', 'investor'])
    expect(typesForSides(['seller'])).toEqual(['seller', 'landlord'])
    expect(typesForSides(['buyer', 'seller'])).toEqual(['buyer', 'investor', 'seller', 'landlord'])
    expect(typesForSides([])).toEqual([])
  })
})

describe('isReachable / unreachableReason', () => {
  it('names the specific reason so the UI can explain an absence', () => {
    expect(unreachableReason(contact())).toBeNull()
    expect(unreachableReason(contact({ email: null }))).toBe('No email on file')
    expect(unreachableReason(contact({ email_opt_out: true }))).toBe('Opted out of email')
    expect(unreachableReason(contact({ status: 'closed' }))).toBe('Closed contact')
    expect(isReachable(contact({ email_opt_out: true }))).toBe(false)
  })
})

describe('resolveAudience', () => {
  const contacts = [
    contact({ id: 'a', last_name: 'Zender', asset_types: ['multifamily'] }),
    contact({ id: 'b', last_name: 'Adams',  asset_types: ['retail'], email: 'b@example.com' }),
    contact({ id: 'c', last_name: 'Baker',  asset_types: ['multifamily'], type: 'seller', email: 'c@example.com' }),
  ]
  const mf = { assetTypes: ['multifamily'], sides: ['buyer', 'seller'] }

  it('returns only matching, reachable contacts sorted by name', () => {
    const { recipients } = resolveAudience(contacts, mf)
    expect(recipients.map(r => r.id)).toEqual(['c', 'a'])   // Baker before Zender
  })

  it('honours a manual removal of a matched contact', () => {
    const { recipients } = resolveAudience(contacts, mf, { removed: ['a'] })
    expect(recipients.map(r => r.id)).toEqual(['c'])
  })

  it('honours a manual add of a contact the filter did not match', () => {
    const { recipients } = resolveAudience(contacts, mf, { added: ['b'] })
    expect(recipients.map(r => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('reports a manually added contact who cannot be mailed instead of dropping them silently', () => {
    const noEmail = contact({ id: 'd', last_name: 'Vance', email: null, asset_types: ['land'] })
    const { recipients, skipped } = resolveAudience([...contacts, noEmail], mf, { added: ['d'] })
    expect(recipients.map(r => r.id)).not.toContain('d')
    expect(skipped).toEqual([{ contact: noEmail, reason: 'No email on file' }])
  })

  it('a removal beats an add for the same contact', () => {
    const { recipients } = resolveAudience(contacts, mf, { added: ['b'], removed: ['b'] })
    expect(recipients.map(r => r.id)).toEqual(['c', 'a'])
  })
})

describe('dedupeByEmail', () => {
  it('mails a shared address once and reports the duplicate', () => {
    const spouseA = contact({ id: 'a', first_name: 'Jo',  email: 'household@example.com' })
    const spouseB = contact({ id: 'b', first_name: 'Sam', email: 'HOUSEHOLD@example.com' })
    const { unique, duplicates } = dedupeByEmail([spouseA, spouseB])
    expect(unique.map(c => c.id)).toEqual(['a'])
    expect(duplicates).toHaveLength(1)
    expect(duplicates[0].contact.id).toBe('b')
  })
})

describe('describeAudience', () => {
  it('summarises the filter for the review step', () => {
    expect(describeAudience({ assetTypes: ['multifamily'], sides: ['buyer', 'seller'] }))
      .toBe('multifamily — buyers & sellers')
    expect(describeAudience({ assetTypes: ['retail', 'office'], sides: ['buyer'] }))
      .toBe('retail, office — buyers')
    expect(describeAudience(BLANK_AUDIENCE)).toBe('No audience selected')
  })
})
