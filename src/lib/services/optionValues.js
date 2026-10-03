// ─────────────────────────────────────────────────────────────────────────────
// Controlled vocabularies (option_values): the values a field offers, adding,
// merging/renaming (an RPC that also rewrites every referencing row), deleting,
// and per-value usage counts for Data Management.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

export const fetchOptionValues = (fieldKey) =>
  supabase
    .from('option_values')
    .select('value')
    .eq('field_key', fieldKey)
    .order('value', { ascending: true })

export const insertOptionValue = (fieldKey, value) =>
  supabase
    .from('option_values')
    .insert({ field_key: fieldKey, value })

/** Fold `from` into `to` everywhere it is used. Resolves to the affected-row count. */
export const mergeOptionValues = (fieldKey, from, to) =>
  supabase.rpc('merge_option_values', {
    p_field: fieldKey,
    p_from:  from,
    p_to:    to,
  })

export const deleteOptionValue = (fieldKey, value) =>
  supabase
    .from('option_values')
    .delete()
    .eq('field_key', fieldKey)
    .eq('value', value)

/** How many records use each value of a field (the option_value_counts view). */
export const fetchOptionValueCounts = (fieldKey) =>
  supabase
    .from('option_value_counts')
    .select('value, record_count')
    .eq('field_key', fieldKey)
