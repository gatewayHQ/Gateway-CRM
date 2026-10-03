// ─────────────────────────────────────────────────────────────────────────────
// A deal's commission row — the split editor's save and the participant list
// the signature screens read.
//
// Raw Supabase results; callers keep their own fallbacks and toasts. Scoped
// multi-deal commission reads live in deals.js (fetchVisibleCommissions).
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

// Commissions are admin-only under RLS, so for a regular agent this quietly
// yields no row.
export const fetchDealCommissionParticipants = (dealId) =>
  supabase.from('commissions').select('participants').eq('deal_id', dealId).maybeSingle()

export const insertCommission = (payload) =>
  supabase.from('commissions').insert([payload])

export const updateCommission = (commissionId, payload) =>
  supabase.from('commissions').update(payload).eq('id', commissionId)
