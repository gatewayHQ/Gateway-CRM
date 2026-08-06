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
 */

/** Contact ids linked to a deal via `deal_contacts`, in row order. */
export function dealContactIds(dealContacts, dealId) {
  if (!dealId) return []
  return (dealContacts || []).filter(r => r?.deal_id === dealId).map(r => r?.contact_id).filter(Boolean)
}

/** Contact ids linked to a property via `property_contacts`, in row order. */
export function propertyContactIds(propertyContacts, propertyId) {
  if (!propertyId) return []
  return (propertyContacts || []).filter(r => r?.property_id === propertyId).map(r => r?.contact_id).filter(Boolean)
}

/**
 * Everyone on the client side of a deal, besides the primary contact.
 *
 * Deal links come first (the agent picked them ON this deal), then any the
 * property carries that the deal doesn't. The deal's primary contact is never
 * repeated as an extra.
 *
 * @returns {Array<{ contact: object, source: 'deal' | 'property' }>}
 */
export function additionalContactsForDeal({ deal, contacts = [], dealContacts = [], propertyContacts = [] } = {}) {
  if (!deal) return []
  const skip = new Set([deal.contact_id].filter(Boolean))
  const seen = new Set()
  const out = []

  const push = (id, source) => {
    if (!id || skip.has(id) || seen.has(id)) return
    const contact = contacts.find(c => c.id === id)
    if (!contact) return   // out of the agent's visible set — nothing to render
    seen.add(id)
    out.push({ contact, source })
  }

  for (const id of dealContactIds(dealContacts, deal.id)) push(id, 'deal')
  for (const id of propertyContactIds(propertyContacts, deal.property_id)) push(id, 'property')
  return out
}
