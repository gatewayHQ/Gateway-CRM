// Transaction checklist rows for a deal.

import { supabase } from '../supabase.js'
import { checklistTemplate, checklistRows } from '../checklistTemplates.js'

// Fill an empty checklist for a deal. Best-effort and only ever into an EMPTY
// checklist — it is called on deal creation and when the tab first opens, and
// neither may overwrite steps an agent has already worked.
export async function seedChecklist(dealId, state, kind, propCategory) {
  const { count, error } = await supabase.from('transaction_steps')
    .select('id', { count: 'exact', head: true }).eq('deal_id', dealId)
  if (error || count > 0) return null
  const { data } = await supabase.from('transaction_steps')
    .insert(checklistRows(dealId, checklistTemplate(state, kind, propCategory))).select()
  return data || null
}

// ── The Checklist tab's own reads and writes ──────────────────────────────────
// Raw Supabase results; the tab decides what an error means.

export const fetchDealChecklistSteps = (dealId) =>
  supabase.from('transaction_steps').select('*').eq('deal_id', dealId).order('sort_order', { ascending: true })

export const deleteDealChecklistSteps = (dealId) =>
  supabase.from('transaction_steps').delete().eq('deal_id', dealId)

export const insertChecklistSteps = (rows) =>
  supabase.from('transaction_steps').insert(rows).select()

export const insertChecklistStep = (row) =>
  supabase.from('transaction_steps').insert([row]).select().single()

export const updateChecklistStep = (stepId, patch) =>
  supabase.from('transaction_steps').update(patch).eq('id', stepId)

export const deleteChecklistStep = (stepId) =>
  supabase.from('transaction_steps').delete().eq('id', stepId)
