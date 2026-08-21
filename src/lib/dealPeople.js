/**
 * Gateway CRM — People on a deal
 *
 * A deal's client side is rarely one person: husband & wife, co-buyers,
 * co-owners. Those extras live in two places (migration 0021):
 *
 *   • `deal_contacts`     — additional contacts picked on the DEAL
 *   • `property_contacts` — additional contacts picked on the PROPERTY
 *
 * Starting a deal from a property copies the property's list onto the new deal,
 * but deals created before that (or built from scratch and linked to a property
 * later) only ever had the property's row. The deal page used to show the
 * primary contact alone, so a co-owner entered on the property was invisible
 * everywhere the deal was worked — the agent had to open the property to
 * remember who else signs.
 *
 * `dealPeople` is the forgiving read: the primary contact plus both lists,
 * deduped, so the deal shows the whole client side with no data backfill. Each
 * extra carries its `source` ('deal' | 'property') so the UI can say where an
 * unexpected name came from.
 *
 * The side-blind version of that read — `additionalContactsForDeal()` and the
 * `dealContactIds()` it was built on — was removed when sides arrived
 * (migration 0040, the SIDES section at the bottom of this file). Everything now
 * reads through `dealSideBreakdown()`, which answers the same question per side;
 * a side-blind read left exported is a side-blind read something eventually
 * calls, and "which party is this name" is the whole point. See git history.
 */

/** Contact ids linked to a property via `property_contacts`, in row order. */
export function propertyContactIds(propertyContacts, propertyId) {
  if (!propertyId) return []
  return (propertyContacts || []).filter(r => r?.property_id === propertyId).map(r => r?.contact_id).filter(Boolean)
}

/**
 * The property's extra contacts that this deal doesn't carry yet.
 *
 * The deal drawer uses this twice: to SEED an empty picker (a deal converted
 * before the carry-over existed has no `deal_contacts` rows at all, so nothing
 * would reach the signature packet), and to OFFER the rest as a one-click add
 * when the deal already has a curated list.
 *
 * Seeding stops at the curated list on purpose: silently re-adding someone the
 * agent removed from the deal would put them back on the next packet. Anything
 * already selected, or the deal's primary contact, is filtered out either way.
 */
export function propertyExtrasNotOnDeal({ propertyId, propertyContacts = [], selectedIds = [], primaryContactId = null, excludeIds = [] } = {}) {
  const skip = new Set([...(selectedIds || []), ...(excludeIds || []), primaryContactId].filter(Boolean))
  const out = []
  for (const id of propertyContactIds(propertyContacts, propertyId)) {
    if (skip.has(id) || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/**
 * What the deal drawer's Additional Contacts picker should hold: the agent's
 * current selection if there is one, otherwise the linked property's list.
 *
 * `excludeIds` is the people the agent has taken OFF this deal. Removing the
 * only extra empties the picker, which would otherwise look exactly like "never
 * had one" and seed them straight back — a removal that won't stick is worse
 * than no seeding at all. They stay available as an explicit suggestion.
 *
 * Returns `selectedIds` unchanged (same reference) when there is nothing to
 * seed, so the drawer's state update is a no-op rather than a re-render.
 */
export function seedPickerFromProperty({ selectedIds = [], propertyId, propertyContacts = [], primaryContactId = null, excludeIds = [] } = {}) {
  if ((selectedIds || []).length) return selectedIds
  const seeded = propertyExtrasNotOnDeal({ propertyId, propertyContacts, primaryContactId, excludeIds })
  return seeded.length ? seeded : selectedIds
}

// ═════════════════════════════════════════════════════════════════════════════
// SIDES — buyer, seller, or both (migration 0040)
//
// A deal used to have one client set: `deals.contact_id` plus the
// `deal_contacts` rows above, with `comp_data.transaction_type` recording which
// side of the table those people sat on. That works right up until the same
// agent represents BOTH sides of one transaction, which is routine here — then
// one set has to hold two unrelated groups, editing the buyer wipes the seller,
// and no form can tell which party a name belongs to.
//
// So each side now has its own primary (`deals.buyer_contact_id` /
// `seller_contact_id`) and its own additional contacts (`deal_contacts.side`).
//
// Everything below is forgiving about legacy rows, because most rows ARE legacy:
// a deal with only `contact_id`, and link rows with a null `side`, read as
// belonging to the side the deal represents. Nobody disappears off a deal
// because their row predates the column.
// ═════════════════════════════════════════════════════════════════════════════

/** The Representing control's options, in display order. */
export const REPRESENTING_OPTIONS = [['buyer', 'Buyer'], ['seller', 'Seller'], ['both', 'Both']]

export const SIDE_LABELS = { buyer: 'Buyer', seller: 'Seller' }

/**
 * Which side(s) a deal represents: 'buyer' | 'seller' | 'both'.
 *
 * Read from `comp_data.transaction_type`, the same field the old two-way toggle
 * wrote and that the Form Library filters packets by. A deal that never recorded
 * one reads as 'buyer' — exactly what the old toggle displayed, where anything
 * other than 'seller' rendered as Buyer.
 */
export function representingFor(deal) {
  const t = String(deal?.comp_data?.transaction_type || '').trim().toLowerCase()
  if (t === 'both') return 'both'
  if (t === 'seller') return 'seller'
  return 'buyer'
}

/** The sides to show for a representation, in display order. */
export function sidesFor(representing) {
  if (representing === 'both') return ['buyer', 'seller']
  return [representing === 'seller' ? 'seller' : 'buyer']
}

/** True when this deal has people on `side` at all. */
export function representsSide(deal, side) {
  return sidesFor(representingFor(deal)).includes(side)
}

/**
 * The primary contact id for one side.
 *
 * Falls back to `deals.contact_id` for a deal saved before the per-side columns
 * existed: its single contact belongs to the side it represents. On a 'both'
 * deal with no per-side columns filled (only reachable if migration 0040's
 * backfill hasn't run), the legacy contact lands on the buyer side rather than
 * being claimed by both.
 */
export function primaryContactIdFor(deal, side) {
  if (!deal) return null
  const own = side === 'seller' ? deal.seller_contact_id : deal.buyer_contact_id
  if (own) return own
  if (deal.buyer_contact_id || deal.seller_contact_id) return null   // sides are set; this one is empty
  const representing = representingFor(deal)
  if (representing === 'both') return side === 'buyer' ? (deal.contact_id || null) : null
  return representing === side ? (deal.contact_id || null) : null
}

/**
 * The side a `deal_contacts` row sits on.
 *
 * A null `side` means the row predates the column, so it reads as the side the
 * deal represents — and as the BUYER side on a 'both' deal, matching
 * primaryContactIdFor()'s fallback so a legacy client set stays together.
 */
export function sideOfDealContact(row, deal) {
  const side = String(row?.side || '').trim().toLowerCase()
  if (side === 'buyer' || side === 'seller') return side
  const representing = representingFor(deal)
  return representing === 'seller' ? 'seller' : 'buyer'
}

/** Additional-contact ids on one side of a deal, in row order. */
export function dealContactIdsForSide(dealContacts, deal, side) {
  if (!deal?.id) return []
  return (dealContacts || [])
    .filter(r => r?.deal_id === deal.id && r?.contact_id && sideOfDealContact(r, deal) === side)
    .map(r => r.contact_id)
}

/**
 * The side a PROPERTY's additional contacts belong to.
 *
 * They are the owners, so they are seller-side whenever the deal has one. On a
 * buyer-only deal there is no seller side to put them on and they stay where
 * they have always been — with the deal's single client set.
 */
export function propertyContactSide(deal) {
  return representsSide(deal, 'seller') ? 'seller' : 'buyer'
}

/**
 * The whole client side of a deal, split by side — what the deal page's People
 * card and the drawer's contact sections both render.
 *
 * Each side carries its primary contact and its extras, with each extra's
 * `source` ('deal' | 'property') so the UI can explain an unexpected name, same
 * as additionalContactsForDeal() above. Nobody is listed twice, and a contact
 * who is a primary on either side is never repeated as an extra.
 *
 * @returns {{ representing: string, sides: Array<{
 *   side: 'buyer'|'seller', label: string, primary: object|null,
 *   extras: Array<{ contact: object, source: 'deal'|'property' }>,
 * }> }}
 */
export function dealSideBreakdown({ deal, contacts = [], dealContacts = [], propertyContacts = [] } = {}) {
  const representing = representingFor(deal)
  if (!deal) return { representing, sides: [] }

  const find = (id) => (contacts || []).find(c => c.id === id) || null
  const primaries = new Set(
    ['buyer', 'seller'].map(s => primaryContactIdFor(deal, s)).filter(Boolean)
  )
  // A person is listed once per deal, not once per side — the same contact
  // sitting in both lists would read as two different parties.
  const claimed = new Set(primaries)
  const propSide = propertyContactSide(deal)

  const sides = sidesFor(representing).map(side => {
    const extras = []
    const push = (id, source) => {
      if (!id || claimed.has(id)) return
      const contact = find(id)
      if (!contact) return   // outside the agent's visible set — nothing to render
      claimed.add(id)
      extras.push({ contact, source })
    }
    for (const id of dealContactIdsForSide(dealContacts, deal, side)) push(id, 'deal')
    if (side === propSide) {
      for (const id of propertyContactIds(propertyContacts, deal.property_id)) push(id, 'property')
    }
    return { side, label: SIDE_LABELS[side], primary: find(primaryContactIdFor(deal, side)), extras }
  })

  return { representing, sides }
}

/**
 * "The per-side columns aren't in this database yet."
 *
 * `deals.buyer_contact_id` / `seller_contact_id` and `deal_contacts.side` all
 * arrive with migration 0040. Until it is applied, a write carrying them fails
 * with an unknown-column error — every save path drops them and keeps the
 * pre-0040 single-contact behavior rather than refusing the save. Mirrors
 * isMissingCoAgentColumn() (src/lib/coAgents.js), the same pattern for 0025.
 */
export function isMissingSideColumn(error) {
  return /buyer_contact_id|seller_contact_id|\bside\b/.test(error?.message || '')
}
