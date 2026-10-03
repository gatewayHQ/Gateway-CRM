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
