// Deal writes made from the property drawer: starting a deal from a listing,
// and retitling its deals when the listing's address changes. These live here
// until they are consolidated with src/lib/services/deals.js.

import { supabase } from '../supabase.js'
import { findOpenDealsOnProperty, requestDealAccess } from './deals.js'

// deals.js helpers bound to the shared client, so the page needn't hold it.
export const findOpenDealsOnListing = (propertyId, side) =>
  findOpenDealsOnProperty(supabase, propertyId, side)

export const requestListingDealAccess = (dealId) =>
  requestDealAccess(supabase, dealId)

// One insert attempt; the caller retries with a slimmer payload when a
// migration's column is missing (0025 co_agent_ids, 0040 seller_contact_id).
export const insertDealFromProperty = (payload) =>
  supabase.from('deals').insert([payload]).select().single()

// Retitle the deals still named after a property's old address.
export const renameDealsForProperty = (dealIds, title) =>
  supabase.from('deals').update({ title }).in('id', dealIds)
