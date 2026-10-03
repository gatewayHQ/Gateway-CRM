// A deal's additional contacts (deal_contacts): reconcile, reload, and read.

import { supabase } from '../supabase.js'
import { isMissingSideColumn } from '../dealPeople.js'

// Reconcile a deal's additional-contact link rows (deal_contacts) to match the
// chosen ids PER SIDE — inserts new links, deletes removed ones, and moves
// anyone whose side changed. Best-effort.
//
// `bySide` is { buyer: [id], seller: [id] }. The side matters as much as the
// membership: on a deal representing both parties, the same list without sides
// cannot say which names belong to the buyer, so a form captioned "Seller"
// would print whoever happened to be first.
//
// Returns true when rows actually changed, so the caller only refreshes state
// (which re-runs the drawer's seeding effect) when there is something new.
export async function syncDealContacts(dealId, bySide) {
  const wanted = new Map()
  for (const side of ['buyer', 'seller']) {
    for (const id of (bySide?.[side] || [])) if (id && !wanted.has(id)) wanted.set(id, side)
  }
  try {
    const { data: existing } = await supabase.from('deal_contacts').select('contact_id, side').eq('deal_id', dealId)
    const have = new Map((existing || []).map(r => [r.contact_id, r.side || null]))
    const toAdd    = [...wanted.keys()].filter(id => !have.has(id))
    const toRemove = [...have.keys()].filter(id => !wanted.has(id))
    // A row whose side is wrong (or was never set, on a legacy link) is updated
    // in place rather than deleted and re-inserted, so its created_at — the row
    // order the picker and the signer list read — survives.
    const toMove   = [...wanted.entries()].filter(([id, side]) => have.has(id) && have.get(id) !== side)

    if (toAdd.length) {
      const rows = toAdd.map(contact_id => ({ deal_id: dealId, contact_id, side: wanted.get(contact_id) }))
      const { error } = await supabase.from('deal_contacts').insert(rows)
      // deal_contacts.side arrives with migration 0040. Until it is applied the
      // links are written without a side and read back as the deal's
      // represented side — the pre-0040 behavior, not a lost contact.
      if (error && isMissingSideColumn(error)) {
        await supabase.from('deal_contacts').insert(rows.map(({ side, ...rest }) => rest))
      }
    }
    if (toRemove.length) await supabase.from('deal_contacts').delete().eq('deal_id', dealId).in('contact_id', toRemove)
    for (const [contact_id, side] of toMove) {
      const { error } = await supabase.from('deal_contacts').update({ side }).eq('deal_id', dealId).eq('contact_id', contact_id)
      if (error && isMissingSideColumn(error)) break
    }
    return toAdd.length + toRemove.length + toMove.length > 0
  } catch (e) { console.error('[syncDealContacts]', e); return false }
}

// Pull a deal's link rows back into global state after writing them. The drawer
// re-seeds its picker from `db.dealContacts` — with a stale (pre-save) copy it
// would reopen empty, and the reconcile above would then delete the very links
// that were just inserted. App's loader only refetches these on a full reload.
export async function reloadDealContacts(setDb, dealId) {
  if (!setDb || !dealId) return
  const { data, error } = await supabase.from('deal_contacts').select('*').eq('deal_id', dealId)
  if (error) return   // table missing (pre-0021) — leave state as it was
  setDb(p => ({
    ...p,
    dealContacts: [...(p.dealContacts || []).filter(r => r?.deal_id !== dealId), ...(data || [])],
  }))
}

// The contacts linked to a deal, as a SORTED id list — a stable content key, so a
// refetch that returns the same people in a different order (or simply a new array)
// doesn't read as a change. Pure and exported for testing: the whole tab-switch bug
// lived in treating array identity as meaning.
export function dealContactIdsFor(dealContacts, dealId) {
  if (!dealId) return []
  return (dealContacts || [])
    .filter(dc => dc?.deal_id === dealId)
    .map(dc => dc?.contact_id)
    .filter(Boolean)
    .sort()
}

// The same stable key, but including each link's SIDE — so moving someone from
// the buyer side to the seller side re-seeds the drawer, which a plain id list
// would read as "nothing changed".
export function dealContactKeyFor(dealContacts, dealId) {
  if (!dealId) return ''
  return (dealContacts || [])
    .filter(dc => dc?.deal_id === dealId && dc?.contact_id)
    .map(dc => `${dc.contact_id}:${dc.side || ''}`)
    .sort()
    .join(',')
}

// A signer saved to the CRM from the send screen. Lives here rather than in
// contacts.js because it is always followed by linkContactToDeal() below.
export const createSignerContact = (row) =>
  supabase.from('contacts').insert([row]).select('id, first_name, last_name, email').single()

// One deal_contacts link. A duplicate is reported as an error by the database;
// the caller decides whether that matters.
export const linkContactToDeal = (dealId, contactId) =>
  supabase.from('deal_contacts').insert([{ deal_id: dealId, contact_id: contactId }])
