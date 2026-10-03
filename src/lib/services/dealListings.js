// ─────────────────────────────────────────────────────────────────────────────
// Listing (`properties`) writes made from the deal screens: the pipeline
// board's listing column and the deal drawer's listing-team edit.
//
// Raw Supabase results; callers handle errors. These are candidates to fold
// into properties.js when the property services are consolidated.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

export const updateListingStatus = (propertyId, status) =>
  supabase.from('properties').update({ status }).eq('id', propertyId)

export const updateListingDetails = (propertyId, details) =>
  supabase.from('properties').update({ details }).eq('id', propertyId)

// deals.property_id is ON DELETE SET NULL — linked deals are kept, just unlinked.
export const deleteListing = (propertyId) =>
  supabase.from('properties').delete().eq('id', propertyId)
