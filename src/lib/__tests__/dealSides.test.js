import { describe, it, expect } from 'vitest'
import {
  representingFor, sidesFor, representsSide, primaryContactIdFor,
  sideOfDealContact, dealContactIdsForSide, propertyContactSide, dealSideBreakdown,
} from '../dealPeople.js'

// The bug this guards: when the same agent represents BOTH the buyer and the
// seller, a deal's single client set (`deals.contact_id` + `deal_contacts`) has
// to hold two unrelated groups of people. Editing one side overwrote the other,
// and nothing downstream could tell which party a name belonged to.
//
// The other half of the job is not losing anyone: almost every existing deal has
// only `contact_id` and link rows with a null `side`, and those people must keep
// showing up exactly where they always did.

const contacts = [
  { id: 'c-buyer',    first_name: 'Hope',   last_name: 'Cerda' },
  { id: 'c-cobuyer',  first_name: 'Nathan', last_name: 'Miss' },
  { id: 'c-seller',   first_name: 'Janet',  last_name: 'Hala' },
  { id: 'c-coowner',  first_name: 'Jason',  last_name: 'Beck' },
]

describe('representingFor', () => {
  it('reads the three states off comp_data.transaction_type', () => {
    expect(representingFor({ comp_data: { transaction_type: 'buyer' } })).toBe('buyer')
    expect(representingFor({ comp_data: { transaction_type: 'seller' } })).toBe('seller')
    expect(representingFor({ comp_data: { transaction_type: 'both' } })).toBe('both')
    expect(representingFor({ comp_data: { transaction_type: 'SELLER' } })).toBe('seller')
  })

  it('reads a deal that never recorded a side the way the old toggle displayed it', () => {
    // The two-way toggle rendered anything other than 'seller' as Buyer.
    expect(representingFor({})).toBe('buyer')
    expect(representingFor(null)).toBe('buyer')
    expect(representingFor({ comp_data: { transaction_type: 'lease' } })).toBe('buyer')
  })
})

describe('sidesFor / representsSide', () => {
  it('gives one side, or both in buyer-then-seller order', () => {
    expect(sidesFor('buyer')).toEqual(['buyer'])
    expect(sidesFor('seller')).toEqual(['seller'])
    expect(sidesFor('both')).toEqual(['buyer', 'seller'])
  })

  it('says which sides a deal actually has people on', () => {
    const both = { comp_data: { transaction_type: 'both' } }
    expect(representsSide(both, 'buyer')).toBe(true)
    expect(representsSide(both, 'seller')).toBe(true)
    expect(representsSide({ comp_data: { transaction_type: 'seller' } }, 'buyer')).toBe(false)
  })
})

describe('primaryContactIdFor', () => {
  it('reads the per-side column when it is set', () => {
    const deal = { id: 'd1', buyer_contact_id: 'c-buyer', seller_contact_id: 'c-seller', comp_data: { transaction_type: 'both' } }
    expect(primaryContactIdFor(deal, 'buyer')).toBe('c-buyer')
    expect(primaryContactIdFor(deal, 'seller')).toBe('c-seller')
  })

  it("files a legacy deal's single contact onto the side it represents", () => {
    const legacySeller = { id: 'd1', contact_id: 'c-seller', comp_data: { transaction_type: 'seller' } }
    expect(primaryContactIdFor(legacySeller, 'seller')).toBe('c-seller')
    expect(primaryContactIdFor(legacySeller, 'buyer')).toBeNull()

    const legacyBuyer = { id: 'd2', contact_id: 'c-buyer' }
    expect(primaryContactIdFor(legacyBuyer, 'buyer')).toBe('c-buyer')
    expect(primaryContactIdFor(legacyBuyer, 'seller')).toBeNull()
  })

  it('never claims the same legacy contact for both sides', () => {
    // Only reachable if 0040's backfill hasn't run. The buyer side takes it; the
    // seller side reads as empty and waits to be filled in.
    const deal = { id: 'd1', contact_id: 'c-buyer', comp_data: { transaction_type: 'both' } }
    expect(primaryContactIdFor(deal, 'buyer')).toBe('c-buyer')
    expect(primaryContactIdFor(deal, 'seller')).toBeNull()
  })

  it('does not fall back once either side has been set', () => {
    // A both-sided deal whose seller was deliberately cleared must stay cleared,
    // not silently inherit the stale `contact_id` mirror.
    const deal = { id: 'd1', contact_id: 'c-buyer', buyer_contact_id: 'c-buyer', comp_data: { transaction_type: 'both' } }
    expect(primaryContactIdFor(deal, 'seller')).toBeNull()
  })

  it('degrades to null without a deal', () => {
    expect(primaryContactIdFor(null, 'buyer')).toBeNull()
  })
})

describe('sideOfDealContact / dealContactIdsForSide', () => {
  const deal = { id: 'd1', comp_data: { transaction_type: 'both' } }
  const rows = [
    { deal_id: 'd1', contact_id: 'c-cobuyer', side: 'buyer' },
    { deal_id: 'd1', contact_id: 'c-coowner', side: 'seller' },
    { deal_id: 'd1', contact_id: 'c-legacy',  side: null },
    { deal_id: 'd2', contact_id: 'c-other',   side: 'buyer' },
  ]

  it('splits the additional contacts by side', () => {
    expect(dealContactIdsForSide(rows, deal, 'seller')).toEqual(['c-coowner'])
  })

  it('keeps a row from before the column on the deal rather than dropping it', () => {
    // A null side reads as the represented side — the buyer side on a 'both'
    // deal, matching where primaryContactIdFor() puts the legacy primary.
    expect(dealContactIdsForSide(rows, deal, 'buyer')).toEqual(['c-cobuyer', 'c-legacy'])
    expect(sideOfDealContact({ side: null }, { comp_data: { transaction_type: 'seller' } })).toBe('seller')
    expect(sideOfDealContact({ side: 'junk' }, deal)).toBe('buyer')
  })

  it('ignores other deals, and needs a deal id', () => {
    expect(dealContactIdsForSide(rows, { id: 'd2' }, 'buyer')).toEqual(['c-other'])
    expect(dealContactIdsForSide(rows, {}, 'buyer')).toEqual([])
    expect(dealContactIdsForSide(null, deal, 'buyer')).toEqual([])
  })
})

describe('propertyContactSide', () => {
  it('puts the property owners on the seller side whenever there is one', () => {
    expect(propertyContactSide({ comp_data: { transaction_type: 'both' } })).toBe('seller')
    expect(propertyContactSide({ comp_data: { transaction_type: 'seller' } })).toBe('seller')
  })

  it('leaves them with the single client set on a buyer-only deal', () => {
    // There is no seller side to file them under, and they have always shown up
    // on the deal — losing them would lose a signer.
    expect(propertyContactSide({ comp_data: { transaction_type: 'buyer' } })).toBe('buyer')
  })
})

describe('dealSideBreakdown', () => {
  const dealContacts = [
    { deal_id: 'd1', contact_id: 'c-cobuyer', side: 'buyer' },
    { deal_id: 'd1', contact_id: 'c-coowner', side: 'seller' },
  ]
  const propertyContacts = [{ property_id: 'prop-1', contact_id: 'c-coowner' }]

  it('keeps the two sides apart on a both-sided deal', () => {
    const deal = {
      id: 'd1', property_id: 'prop-1',
      buyer_contact_id: 'c-buyer', seller_contact_id: 'c-seller',
      comp_data: { transaction_type: 'both' },
    }
    const { representing, sides } = dealSideBreakdown({ deal, contacts, dealContacts, propertyContacts })
    expect(representing).toBe('both')
    expect(sides.map(s => s.side)).toEqual(['buyer', 'seller'])
    expect(sides[0].primary.id).toBe('c-buyer')
    expect(sides[0].extras.map(e => e.contact.id)).toEqual(['c-cobuyer'])
    expect(sides[1].primary.id).toBe('c-seller')
    expect(sides[1].extras.map(e => e.contact.id)).toEqual(['c-coowner'])
  })

  it('shows only the represented side on a one-sided deal', () => {
    const deal = { id: 'd1', property_id: 'prop-1', contact_id: 'c-seller', comp_data: { transaction_type: 'seller' } }
    const { sides } = dealSideBreakdown({ deal, contacts, dealContacts, propertyContacts })
    expect(sides).toHaveLength(1)
    expect(sides[0].side).toBe('seller')
    expect(sides[0].primary.id).toBe('c-seller')
    expect(sides[0].extras.map(e => e.contact.id)).toEqual(['c-coowner'])
  })

  it("carries the property's co-owners onto the seller side, marked as such", () => {
    const deal = {
      id: 'd-no-links', property_id: 'prop-1',
      buyer_contact_id: 'c-buyer', seller_contact_id: 'c-seller',
      comp_data: { transaction_type: 'both' },
    }
    const { sides } = dealSideBreakdown({ deal, contacts, dealContacts: [], propertyContacts })
    expect(sides[0].extras).toEqual([])
    expect(sides[1].extras).toEqual([{ contact: contacts[3], source: 'property' }])
  })

  it('never lists the same person twice, or repeats a primary as an extra', () => {
    const deal = {
      id: 'd1', property_id: 'prop-1',
      buyer_contact_id: 'c-buyer', seller_contact_id: 'c-coowner',
      comp_data: { transaction_type: 'both' },
    }
    const { sides } = dealSideBreakdown({
      deal, contacts, propertyContacts,
      dealContacts: [
        { deal_id: 'd1', contact_id: 'c-coowner', side: 'buyer' },   // also the seller primary
        { deal_id: 'd1', contact_id: 'c-cobuyer', side: 'buyer' },
      ],
    })
    expect(sides[0].extras.map(e => e.contact.id)).toEqual(['c-cobuyer'])
    expect(sides[1].extras).toEqual([])
  })

  it('ignores links to contacts outside the agent’s visible set', () => {
    const deal = { id: 'd1', property_id: 'prop-1', buyer_contact_id: 'c-buyer', comp_data: { transaction_type: 'buyer' } }
    const { sides } = dealSideBreakdown({
      deal, contacts, dealContacts: [{ deal_id: 'd1', contact_id: 'c-not-loaded', side: 'buyer' }],
    })
    expect(sides[0].extras).toEqual([])
  })

  it('degrades to nothing without a deal', () => {
    expect(dealSideBreakdown({}).sides).toEqual([])
    expect(dealSideBreakdown().sides).toEqual([])
  })
})
