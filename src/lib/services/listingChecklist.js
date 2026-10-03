// A listing's marketing checklist (listing_checklist_steps): read, seed,
// toggle, add, remove.

import { supabase } from '../supabase.js'

export const fetchListingChecklistSteps = (propertyId) =>
  supabase.from('listing_checklist_steps').select('*').eq('property_id', propertyId).order('sort_order', { ascending:true })

// Seeds several steps at once (the default checklist); returns the inserted rows.
export const createListingChecklistSteps = (rows) =>
  supabase.from('listing_checklist_steps').insert(rows).select()

export const createListingChecklistStep = (row) =>
  supabase.from('listing_checklist_steps').insert([row]).select().single()

export const updateListingChecklistStep = (id, patch) =>
  supabase.from('listing_checklist_steps').update(patch).eq('id', id)

export const deleteListingChecklistStep = (id) =>
  supabase.from('listing_checklist_steps').delete().eq('id', id)
