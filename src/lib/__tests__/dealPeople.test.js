import { describe, it, expect } from 'vitest'
import { additionalContactsForDeal, dealContactIds, propertyContactIds, propertyExtrasNotOnDeal, seedPickerFromProperty } from '../dealPeople.js'

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

// The deal drawer's picker seeds from this: an empty picker takes the property's
// list (so a legacy deal's co-owner reaches the signature packet), and whatever
// is left over is offered as a one-click add. It must never hand back someone
// already selected — that is what stops a removed co-signer coming back.
describe('propertyExtrasNotOnDeal', () => {
  const propertyContacts = [
    { property_id: 'prop-1', contact_id: 'c-seth' },
    { property_id: 'prop-1', contact_id: 'c-pat' },
    { property_id: 'prop-2', contact_id: 'c-elsewhere' },
  ]

  it('returns the property list for an empty picker, in row order', () => {
    expect(propertyExtrasNotOnDeal({ propertyId: 'prop-1', propertyContacts, selectedIds: [] }))
      .toEqual(['c-seth', 'c-pat'])
  })

  it('leaves out anyone already picked on the deal', () => {
    expect(propertyExtrasNotOnDeal({ propertyId: 'prop-1', propertyContacts, selectedIds: ['c-seth'] }))
      .toEqual(['c-pat'])
  })

  it('never offers the deal’s primary contact', () => {
    expect(propertyExtrasNotOnDeal({ propertyId: 'prop-1', propertyContacts, primaryContactId: 'c-seth' }))
      .toEqual(['c-pat'])
  })

  it('is empty with no property linked, or when the deal already has everyone', () => {
    expect(propertyExtrasNotOnDeal({ propertyId: null, propertyContacts })).toEqual([])
    expect(propertyExtrasNotOnDeal({ propertyId: 'prop-1', propertyContacts, selectedIds: ['c-pat', 'c-seth'] })).toEqual([])
    expect(propertyExtrasNotOnDeal({})).toEqual([])
  })

  it('dedupes a property listing the same contact twice', () => {
    const dupes = [{ property_id: 'prop-1', contact_id: 'c-seth' }, { property_id: 'prop-1', contact_id: 'c-seth' }]
    expect(propertyExtrasNotOnDeal({ propertyId: 'prop-1', propertyContacts: dupes })).toEqual(['c-seth'])
  })
})

// The one rule that decides whether a co-owner reaches the signature packet.
describe('seedPickerFromProperty', () => {
  const propertyContacts = [{ property_id: 'prop-1', contact_id: 'c-seth' }]

  it('fills an empty picker from the property — the legacy deal case', () => {
    expect(seedPickerFromProperty({ selectedIds: [], propertyId: 'prop-1', propertyContacts }))
      .toEqual(['c-seth'])
  })

  it('never overwrites a curated list — a removed co-signer stays removed', () => {
    const selectedIds = ['c-pat']
    expect(seedPickerFromProperty({ selectedIds, propertyId: 'prop-1', propertyContacts }))
      .toBe(selectedIds)
  })

  it('returns the same empty list when there is nothing to seed', () => {
    const selectedIds = []
    expect(seedPickerFromProperty({ selectedIds, propertyId: null, propertyContacts })).toBe(selectedIds)
    expect(seedPickerFromProperty({ selectedIds, propertyId: 'prop-2', propertyContacts })).toBe(selectedIds)
    expect(seedPickerFromProperty({ selectedIds, propertyId: 'prop-1', propertyContacts, primaryContactId: 'c-seth' })).toBe(selectedIds)
  })
})

// Removing the last extra empties the picker, which looks identical to "this
// deal never had one" — the drawer remembers the removal so the property can't
// seed the person straight back on the next open.
describe('seedPickerFromProperty — removals stick', () => {
  const propertyContacts = [
    { property_id: 'prop-1', contact_id: 'c-seth' },
    { property_id: 'prop-1', contact_id: 'c-pat' },
  ]

  it('does not re-seed someone the agent took off the deal', () => {
    const selectedIds = []
    expect(seedPickerFromProperty({ selectedIds, propertyId: 'prop-1', propertyContacts, excludeIds: ['c-seth'] }))
      .toEqual(['c-pat'])
    expect(seedPickerFromProperty({ selectedIds, propertyId: 'prop-1', propertyContacts, excludeIds: ['c-seth', 'c-pat'] }))
      .toBe(selectedIds)
  })

  it('still offers a removed person as an explicit suggestion', () => {
    // The suggestion row deliberately ignores the removal memory — that is the
    // one-click way back after an accidental remove.
    expect(propertyExtrasNotOnDeal({ propertyId: 'prop-1', propertyContacts, selectedIds: [] }))
      .toEqual(['c-seth', 'c-pat'])
  })
})
