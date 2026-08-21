import { describe, it, expect } from 'vitest'
import { propertyContactIds, propertyExtrasNotOnDeal, seedPickerFromProperty } from '../dealPeople.js'

// The bug this guards: a co-owner entered in the property drawer's "Additional
// Contacts" was invisible on the deal, because the deal page only read the
// primary `deals.contact_id`. Deals created before the property→deal carry-over
// have NO deal_contacts row at all — the property's list is the only record.

// The per-side reads that replaced additionalContactsForDeal() when a deal grew
// two client sides live in dealSides.test.js.
describe('propertyContactIds', () => {
  it('picks out only the rows for that property', () => {
    expect(propertyContactIds([
      { property_id: 'prop-1', contact_id: 'c-seth' },
      { property_id: 'prop-2', contact_id: 'c-pat' },
    ], 'prop-1')).toEqual(['c-seth'])
  })

  it('returns nothing without an id, and tolerates junk rows', () => {
    expect(propertyContactIds([{ property_id: 'prop-1', contact_id: 'c-seth' }], null)).toEqual([])
    expect(propertyContactIds(null, 'prop-1')).toEqual([])
    expect(propertyContactIds([null, { property_id: 'prop-1' }], 'prop-1')).toEqual([])
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
