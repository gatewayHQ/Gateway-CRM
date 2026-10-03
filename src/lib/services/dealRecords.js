// ─────────────────────────────────────────────────────────────────────────────
// The `deals` row itself — read, insert, update, delete — for the deal page,
// the pipeline drawer and its tabs.
//
// These hand back the Supabase result (`{ data, error, ... }`) untouched, so the
// screens keep their own error handling and toasts. Scoped multi-deal reads
// (who may see which deals) live in deals.js, which takes the client as an
// argument; everything here uses the shared client.
//
// comp_data is one jsonb shared by several tabs (key dates, portal docs, deal
// terms, checklist settings, document filing). Writers re-read it with
// fetchDealCompData() immediately before merging so a concurrent edit on
// another tab is not clobbered — that read-merge-write stays in the caller.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { fetchVisibleDeals, fetchVisibleCommissions, findOpenDealsOnProperty, requestDealAccess } from './deals.js'

export const fetchDeal = (dealId) =>
  supabase.from('deals').select('*').eq('id', dealId).single()

export const fetchDealCompData = (dealId) =>
  supabase.from('deals').select('comp_data').eq('id', dealId).single()

// The checklist tab needs the category alongside comp_data to pick a template.
export const fetchDealChecklistMeta = (dealId) =>
  supabase.from('deals').select('comp_data, prop_category').eq('id', dealId).single()

export const updateDealCompData = (dealId, comp_data) =>
  supabase.from('deals').update({ comp_data }).eq('id', dealId)

export const updateDeal = (dealId, patch) =>
  supabase.from('deals').update(patch).eq('id', dealId)

/** Insert a deal and read the whole saved row back. */
export const createDeal = (body) =>
  supabase.from('deals').insert([body]).select().single()

/** Insert a deal and read back only its id. */
export const insertDeal = (body) =>
  supabase.from('deals').insert([body]).select('id').single()

/** Retitle several deals at once (a listing's address changed). */
export const renameDeals = (dealIds, title) =>
  supabase.from('deals').update({ title }).in('id', dealIds)

export const deleteDeal = (dealId) =>
  supabase.from('deals').delete().eq('id', dealId)

// ── Shared-client bindings of deals.js ────────────────────────────────────────
// deals.js takes the client as an argument (so its tests can pass a fake);
// screens call these instead of importing the client themselves.

export const loadVisibleDeals = (opts) => fetchVisibleDeals(supabase, opts)

export const loadVisibleCommissions = (opts) => fetchVisibleCommissions(supabase, opts)

export const checkOpenDealsOnProperty = (propertyId, side) =>
  findOpenDealsOnProperty(supabase, propertyId, side)

export const requestAccessToDeal = (dealId) =>
  requestDealAccess(supabase, dealId)
