// A property's logged showings (property_showings): read, log, delete.

import { supabase } from '../supabase.js'

export const fetchPropertyShowings = (propertyId) =>
  supabase.from('property_showings').select('*').eq('property_id', propertyId).order('showing_date', { ascending:false })

export const createPropertyShowing = (row) =>
  supabase.from('property_showings').insert([row]).select().single()

export const deletePropertyShowing = (id) =>
  supabase.from('property_showings').delete().eq('id', id)
