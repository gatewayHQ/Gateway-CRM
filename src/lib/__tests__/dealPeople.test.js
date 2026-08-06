import { describe, it, expect } from 'vitest'
import { additionalContactsForDeal, dealContactIds, propertyContactIds } from '../dealPeople.js'

// The bug this guards: a co-owner entered in the property drawer's "Additional
// Contacts" was invisible on the deal, because the deal page only read the
// primary `deals.contact_id`. Deals created before the property→deal carry-over
// have NO deal_contacts row at all — the property's list is the only record.

const contacts = [
  { id: 'c-curtis', first_name: 'Curtis', last_name: 'Epling' },
  { id: 'c-seth',   first_name: 'Seth',   last_name: 'Epling' },
  { id: 'c-pat',    first_name: 'Pat',    last_name: 'Cobuyer' },
]
const deal = { id: 'deal-1', contact_id: 'c-curtis', property_id: 'prop-1' }

describe('dealContactIds / propertyContactIds', () => {
  it('pick out only the rows for that record', () => {
    const rows = [
      { deal_id: 'deal-1', contact_id: 'c-seth' },
      { deal_id: 'deal-2', contact_id: 'c-pat' },
    ]
    expect(dealContactIds(rows, 'deal-1')).toEqual(['c-seth'])
    expect(propertyContactIds([{ property_id: 'prop-1', contact_id: 'c-seth' }], 'prop-1')).toEqual(['c-seth'])
  })

  it('return nothing without an id, and tolerate junk rows', () => {
    expect(dealContactIds([{ deal_id: 'deal-1', contact_id: 'c-seth' }], null)).toEqual([])
    expect(propertyContactIds(null, 'prop-1')).toEqual([])
    expect(dealContactIds([null, { deal_id: 'deal-1' }], 'deal-1')).toEqual([])
  })
})

describe('additionalContactsForDeal', () => {
  it("shows the property's extra contact on the deal, even with no deal link", () => {
    const out = additionalContactsForDeal({
      deal, contacts,
      dealContacts: [],
      propertyContacts: [{ property_id: 'prop-1', contact_id: 'c-seth' }],
    })
    expect(out).toEqual([{ contact: contacts[1], source: 'property' }])
  })

  it('lists the deal links first, then property-only extras', () => {
    const out = additionalContactsForDeal({
      deal, contacts,
      dealContacts: [{ deal_id: 'deal-1', contact_id: 'c-pat' }],
      propertyContacts: [{ property_id: 'prop-1', contact_id: 'c-seth' }],
    })
    expect(out.map(p => [p.contact.id, p.source])).toEqual([['c-pat', 'deal'], ['c-seth', 'property']])
  })

  it('never lists the same person twice, and marks a shared one as the deal link', () => {
    const out = additionalContactsForDeal({
      deal, contacts,
      dealContacts: [{ deal_id: 'deal-1', contact_id: 'c-seth' }],
      propertyContacts: [{ property_id: 'prop-1', contact_id: 'c-seth' }],
    })
    expect(out).toEqual([{ contact: contacts[1], source: 'deal' }])
  })

  it("never repeats the deal's primary contact as an extra", () => {
    const out = additionalContactsForDeal({
      deal, contacts,
      dealContacts: [{ deal_id: 'deal-1', contact_id: 'c-curtis' }],
      propertyContacts: [{ property_id: 'prop-1', contact_id: 'c-curtis' }],
    })
    expect(out).toEqual([])
  })

  it('ignores links to contacts outside the agent’s visible set', () => {
    const out = additionalContactsForDeal({
      deal, contacts,
      propertyContacts: [{ property_id: 'prop-1', contact_id: 'c-not-loaded' }],
    })
    expect(out).toEqual([])
  })

  it('ignores other deals and other properties', () => {
    const out = additionalContactsForDeal({
      deal, contacts,
      dealContacts: [{ deal_id: 'deal-2', contact_id: 'c-pat' }],
      propertyContacts: [{ property_id: 'prop-2', contact_id: 'c-seth' }],
    })
    expect(out).toEqual([])
  })

  it('degrades to empty without a deal, or with the tables missing', () => {
    expect(additionalContactsForDeal({})).toEqual([])
    expect(additionalContactsForDeal({ deal, contacts })).toEqual([])
    expect(additionalContactsForDeal({ deal: { id: 'd', contact_id: 'c-curtis' }, contacts, propertyContacts: [{ property_id: 'prop-1', contact_id: 'c-seth' }] })).toEqual([])
  })
})
