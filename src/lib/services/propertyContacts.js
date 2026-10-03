// A property's additional contacts (property_contacts): reconcile and read,
// plus seeding a new deal's contacts (deal_contacts) from a property's list.

import { supabase } from '../supabase.js'

// Seed a freshly-created deal's additional contacts from a property's list.
// Returns the inserted link rows so the caller can put them in global state —
// the deal page and the deal drawer both read `db.dealContacts`, and without
// this the co-owner reads as property-only until the next full reload.
// A property's extra contacts are its OWNERS, so they arrive on the new deal's
// seller side (migration 0040). Falls back to writing the links without a side
// on a database where 0040 hasn't run — they then read as the deal's represented
// side, which for a deal started from a listing is the seller side anyway.
export async function syncDealContactsFromProperty(dealId, contactIds) {
  const rows = contactIds.map(contact_id => ({ deal_id: dealId, contact_id, side: 'seller' }))
  try {
    const { data, error } = await supabase.from('deal_contacts').insert(rows).select()
    if (!error) return data || []
    const retry = await supabase.from('deal_contacts')
      .insert(rows.map(({ side, ...rest }) => rest)).select()
    return retry.data || []
  } catch (e) { console.error('[syncDealContactsFromProperty]', e); return [] }
}

// Reconcile a property's additional-contact link rows (property_contacts) to
// match the chosen id list — inserts new links, deletes removed ones. Best-effort.
export async function syncPropertyContacts(propertyId, contactIds) {
  try {
    const { data: existing } = await supabase.from('property_contacts').select('contact_id').eq('property_id', propertyId)
    const have = new Set((existing || []).map(r => r.contact_id))
    const want = new Set(contactIds)
    const toAdd    = contactIds.filter(id => !have.has(id))
    const toRemove = [...have].filter(id => !want.has(id))
    if (toAdd.length)    await supabase.from('property_contacts').insert(toAdd.map(contact_id => ({ property_id: propertyId, contact_id })))
    if (toRemove.length) await supabase.from('property_contacts').delete().eq('property_id', propertyId).in('contact_id', toRemove)
    return toAdd.length + toRemove.length > 0
  } catch (e) { console.error('[syncPropertyContacts]', e); return false }
}

export const fetchPropertyContacts = (propertyId) =>
  supabase.from('property_contacts').select('*').eq('property_id', propertyId)
