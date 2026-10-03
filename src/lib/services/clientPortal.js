// ─────────────────────────────────────────────────────────────────────────────
// A deal's client portal switch — the token in the share link and whether the
// link currently works. (Which documents the portal shows lives in
// comp_data.portal_docs; see dealRecords.js.)
//
// Results come back as Supabase returns them; the Portal tab handles errors.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

export const fetchDealPortalAccess = (dealId) =>
  supabase.from('deals').select('portal_token, portal_enabled').eq('id', dealId).single()

export const enableDealPortal = (dealId, portalToken) =>
  supabase.from('deals').update({ portal_token: portalToken, portal_enabled: true }).eq('id', dealId)

export const disableDealPortal = (dealId) =>
  supabase.from('deals').update({ portal_enabled: false }).eq('id', dealId)
