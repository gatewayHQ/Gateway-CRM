// ─────────────────────────────────────────────────────────────────────────────
// Required forms — which packets a deal's state makes mandatory.
//
// The Form Library already knew that a packet belongs to a (state,
// transaction_type); nothing ever consulted it at closing time, so an Iowa
// listing could close without an executed Iowa listing agreement. The
// `required` flag (migration 0028) turns a packet into a closing blocker, and
// this loads the applicable set for one deal.
//
// A deal with no state recorded returns [] — the gate cannot assert what a
// state requires when it does not know the state. See the TODO at the bottom.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

/** The (state, transaction_type) a deal's required forms hang off. */
export function formScopeForDeal(deal) {
  const state = (deal?.comp_data?.state || '').trim().toUpperCase()
  // The Forms tab's buyer/seller field. 'general' packets apply to any side.
  const txType = (deal?.comp_data?.transaction_type || '').trim().toLowerCase()
  return { state: state || null, transactionType: txType || null }
}

/**
 * Active, template-linked packets marked required for this deal's state.
 * Includes packets filed under 'general', which apply to either side.
 *
 * Returns { forms, error }. On any error — including the `required` column not
 * existing yet because 0028 has not been applied — it returns an empty list so
 * the closing gate keeps working exactly as it did before.
 */
export async function listRequiredForms(deal) {
  const { state, transactionType } = formScopeForDeal(deal)
  if (!state) return { forms: [], error: null }

  const types = transactionType ? [transactionType, 'general'] : ['general']

  const { data, error } = await supabase
    .from('form_packets')
    .select('id, name, state, transaction_type, boldsign_template_id, required, active')
    .eq('state', state)
    .in('transaction_type', types)
    .eq('required', true)
    .eq('active', true)
    .not('boldsign_template_id', 'is', null)

  if (error) {
    // Column missing (migration not applied) or table unreachable — degrade to
    // the pre-0028 gate rather than blocking every deal in the brokerage.
    return { forms: [], error: error.message }
  }
  return { forms: data || [], error: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO — deals whose state is unknown.
// comp_data.state is typed by hand on the Forms tab, so a deal can reach
// closing with no state and this returns []: the gate then asserts nothing
// about forms. The durable fix is to derive comp_data.state from the linked
// property (properties.state) at conversion, and to make it a gate blocker in
// its own right when neither is set. That belongs with the address-first
// intake work (item B1 of the architecture review), not here — doing it now
// would block every existing deal that predates the field.
// ─────────────────────────────────────────────────────────────────────────────
