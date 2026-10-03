// ─────────────────────────────────────────────────────────────────────────────
// Quick-add writes from the dashboard's "+ New" drawers (src/pages/QuickAdd.jsx).
//
// Quick-add tasks go through createTask in tasks.js; the deal insert lives here
// until the deals service grows a plain create.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

/** Insert one deal from the quick-add drawer and read the saved row back. */
export const createQuickDeal = (deal) =>
  supabase.from('deals').insert([deal]).select().single()
