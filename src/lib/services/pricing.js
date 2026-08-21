// ─────────────────────────────────────────────────────────────────────────────
// Pricing history & price sync — the IO half.
//
// The rules live in src/lib/pricing.js (pure, unit-tested). This file executes
// them: reading a property's history from both places it can exist, and writing
// one price edit out to the property, its open deals, and the log.
//
// EVERYTHING HERE IS BEST-EFFORT ON PURPOSE. The price the agent typed is
// already saved on the record they typed it on by the time these run — the deal
// drawer has saved the deal, the property drawer has saved the property. If the
// propagation or the log write fails, the agent must still keep their save; they
// get a warning naming what did not happen (usually "run migration 0040")
// instead of losing the edit. That is the same degrade-don't-block posture the
// commission columns (0024) and co-agents (0025) already use.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { mergeHistory, planPriceSync } from '../pricing.js'

/** Postgres/PostgREST "that table or column isn't there yet". */
const isMissingSchema = (error) =>
  error?.code === '42P01' || error?.code === '42703' || error?.code === 'PGRST205' ||
  /pricing_history|does not exist|schema cache/i.test(error?.message || '')

/**
 * A property's price history, oldest first, normalized (src/lib/pricing.js).
 *
 * Read from BOTH sources and merged: the `pricing_history` table is canonical,
 * and the property's legacy `price_history` jsonb covers a database where
 * migration 0040 hasn't been applied (the table read simply fails, and the tab
 * still shows every change that was ever recorded).
 *
 * @param {object} args
 * @param {string} [args.propertyId]  the property to read
 * @param {object} [args.property]    the already-loaded property row, for its jsonb mirror
 * @returns {Promise<{ entries: Array, tableReady: boolean, error: string|null }>}
 */
export async function loadPricingHistory({ propertyId, property = null } = {}) {
  const legacy = Array.isArray(property?.price_history) ? property.price_history : []
  if (!propertyId) return { entries: mergeHistory([], legacy), tableReady: true, error: null }

  const { data, error } = await supabase
    .from('pricing_history')
    .select('*')
    .eq('property_id', propertyId)
    .order('created_at', { ascending: true })

  if (error) {
    return {
      entries: mergeHistory([], legacy),
      tableReady: !isMissingSchema(error),
      error: error.message,
    }
  }
  return { entries: mergeHistory(data || [], legacy), tableReady: true, error: null }
}

/**
 * Price changes recorded THROUGH a particular deal — the deal's own edits,
 * plus (when it has a property) everything that property's price has ever done.
 *
 * A deal shows the property's whole history rather than only its own entries:
 * the price is the property's, and an agent looking at a deal needs to see a
 * reduction a colleague made on the listing.
 */
export async function loadDealPricingHistory({ deal, property = null } = {}) {
  if (deal?.property_id) return loadPricingHistory({ propertyId: deal.property_id, property })
  if (!deal?.id) return { entries: [], tableReady: true, error: null }

  // No property linked yet — the deal's own entries are the whole history.
  const { data, error } = await supabase
    .from('pricing_history')
    .select('*')
    .eq('deal_id', deal.id)
    .order('created_at', { ascending: true })

  if (error) return { entries: [], tableReady: !isMissingSchema(error), error: error.message }
  return { entries: mergeHistory(data || [], []), tableReady: true, error: null }
}

/**
 * Propagate one price edit and log it.
 *
 * Call AFTER the originating record is saved, with `previousPrice` read from
 * before the save. Returns what actually happened so the caller can toast a
 * warning and patch its own state.
 *
 * @param {object} args  — see planPriceSync() for the shape; identical.
 * @returns {Promise<{
 *   changed: boolean,
 *   repricedDealIds: string[],   // deals whose value we moved
 *   propertyPatch: object|null,  // what we wrote to the property, for local state
 *   logged: boolean,             // did the canonical history row land
 *   warning: string|null,        // user-facing, when something degraded
 * }>}
 */
export async function syncPriceChange(args) {
  const plan = planPriceSync(args)
  const result = { changed: plan.changed, repricedDealIds: [], propertyPatch: null, logged: false, warning: null }
  if (!plan.changed) return result

  const propertyId = args?.property?.id || null
  const failures = []

  // ── 1. The property: the canonical list price + its jsonb mirror ──────────
  // Both go in one update so the number and its history can't diverge. When the
  // edit came FROM the property drawer, `propertyUpdate` is null and only the
  // mirror is appended — its own save already carried the price.
  if (propertyId && plan.legacyHistory) {
    const patch = { ...(plan.propertyUpdate || {}), price_history: plan.legacyHistory }
    const { error } = await supabase.from('properties').update(patch).eq('id', propertyId)
    if (error) failures.push('the property')
    else result.propertyPatch = patch
  }

  // ── 2. The other open deals on this property ──────────────────────────────
  // One update per deal: they get the same value, but PostgREST has no
  // multi-row-different-values update and the id list is small (deals on one
  // property), so a loop is honest here.
  for (const upd of plan.dealUpdates) {
    const { error } = await supabase.from('deals').update({ value: upd.value }).eq('id', upd.id)
    if (error) { failures.push('a linked deal'); break }
    result.repricedDealIds.push(upd.id)
  }

  // ── 3. The canonical log ──────────────────────────────────────────────────
  const { error: logError } = await supabase.from('pricing_history').insert([plan.historyRow])
  if (logError) {
    result.logged = false
    result.warning = isMissingSchema(logError)
      ? 'Price synced, but the change was not added to Pricing History — ask an admin to apply database migration 0040.'
      : 'Price synced, but the change was not added to Pricing History.'
  } else {
    result.logged = true
  }

  if (failures.length) {
    const what = [...new Set(failures)].join(' and ')
    result.warning = `Price saved, but ${what} could not be updated — the deal and the listing may disagree until you retry.`
  }
  return result
}

/**
 * The price a deal and its property should agree on, for a drawer that is about
 * to open. Used to show the deal's value field pre-filled from the listing when
 * the deal has no value of its own.
 */
export function reconciledPrice({ deal, property } = {}) {
  const dealValue = deal?.value
  if (dealValue !== null && dealValue !== undefined && dealValue !== '') return dealValue
  return property?.list_price ?? ''
}
