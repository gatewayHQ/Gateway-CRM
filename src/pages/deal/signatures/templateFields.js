// How template fields are labelled and grouped on the Send from Template screen.

import { fieldTokenKey } from '../../../lib/services/boldsign.js'

// ── Prepare from Template modal — dynamic. Reads the template's actual roles +
//    fillable fields from BoldSign, renders a signer input per role and an
//    editable (CRM-prefilled) input per field, then creates the document as a
//    DRAFT on the deal.
//
//    It has no send button, deliberately. Both of its doors end at a draft —
//    "Review Draft" shows the composed packet, "Place Fields in BoldSign" opens
//    the same draft in the embedded editor — and sending is a separate,
//    confirmed act on the draft row or from the review (see
//    sendDraftNow / the draft-send action). That separation is the workflow: an
//    agent prints the filled draft, walks a client through it on paper, edits it
//    as many times as the client asks, and sends only at the end.
export const prettyLabel = (id) => String(id || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

// Presentation only — the field ids and CRM tokens underneath are unchanged.
// A template author names a field `Buyer1NameLabel` because that's the
// account-wide convention (see CANONICAL_LABEL_TOKENS in boldsignFields.js),
// not because it's a caption an agent should have to read and decode on the
// send screen. This maps the same tokens to a short, human description of
// where the value actually lands on the document, which group of fields it
// belongs with, and — for the ones that only apply to some deals — a note
// saying so, so "why is this blank" isn't a mystery.
const FIELD_TOKEN_INFO = {
  party_buyer_1:        { group: 'Buyer names',  text: 'Primary buyer’s name' },
  party_buyer_2:        { group: 'Buyer names',  text: 'Co-buyer’s name', optional: 'only appears when this deal has a co-buyer' },
  party_seller_1:       { group: 'Seller names', text: 'Primary seller’s name' },
  party_seller_2:       { group: 'Seller names', text: 'Co-seller’s name', optional: 'only appears when this deal has a co-seller' },
  seller_name:          { group: 'Buyer/Seller names', text: 'Your client’s name' },
  client_name:          { group: 'Buyer/Seller names', text: 'Your client’s name' },
  client_names:         { group: 'Buyer/Seller names', text: 'Every client, as the "entered into by and between" line reads' },
  seller_names:         { group: 'Buyer/Seller names', text: 'Every client, as the "entered into by and between" line reads' },
  client_2_name:        { group: 'Buyer/Seller names', text: 'Co-buyer / co-seller / spouse', optional: 'only appears when there’s a second client on this deal' },
  seller_2_name:        { group: 'Buyer/Seller names', text: 'Co-buyer / co-seller / spouse', optional: 'only appears when there’s a second client on this deal' },
  agent_name:           { group: 'Agent names', text: 'This deal’s appointed agent' },
  agent_2_name:         { group: 'Agent names', text: 'A co-listing agent', optional: 'only appears when a second agent is on this deal' },
  broker_name:          { group: 'Agent names', text: 'The brokerage name' },
  property_address:     { group: 'Property', text: 'Street address, including the suite / unit' },
  property_unit:        { group: 'Property', text: 'Suite / unit on its own', optional: 'only appears when the listing has one' },
  property_full:        { group: 'Property', text: 'Full one-line address' },
  property_city_state_zip: { group: 'Property', text: 'City, state and ZIP line' },
  property_county:      { group: 'Property', text: 'County' },
  property_type:        { group: 'Property', text: 'Property type' },
  property_mls:         { group: 'Property', text: 'MLS number' },
  list_price:           { group: 'Money', text: 'Price' },
  commission_pct:       { group: 'Money', text: 'Commission percentage' },
  commission_amount:    { group: 'Money', text: 'Commission dollar amount' },
  broker_compensation_flat: { group: 'Money', text: 'Flat-fee commission amount' },
  agreement_date:       { group: 'Dates', text: 'Agreement date, written out whole' },
  agreement_day:        { group: 'Dates', text: '"this ___ day of ______" — the day' },
  agreement_month:      { group: 'Dates', text: '"day of ______, 20__" — the month' },
  agreement_year:       { group: 'Dates', text: '"20__" — last two digits of the year' },
  agreement_year_full:  { group: 'Dates', text: 'Full four-digit year' },
  agreement_term_months:{ group: 'Dates', text: 'Term of representation, in months' },
  retainer_start_date:  { group: 'Dates', text: 'Representation start date' },
  retainer_end_date:    { group: 'Dates', text: 'Representation end date' },
  closing_date_us:      { group: 'Dates', text: 'Closing date' },
  listing_start_us:     { group: 'Dates', text: 'Listing start date' },
  listing_end_us:       { group: 'Dates', text: 'Listing end date' },
  offer_expiration:     { group: 'Dates', text: 'Offer expiration date' },
  additional_agent_name:{ group: 'Additional Agent', text: 'Additional appointed agent’s name', optional: 'only appears when this deal has an additional agent' },
  additional_agent_date:{ group: 'Additional Agent', text: '"this ___ day of ______, 20__" for the additional agent’s appointment', optional: 'only appears when this deal has an additional agent' },
}

export const fieldInfo        = (f) => FIELD_TOKEN_INFO[fieldTokenKey(f)] || null

const FIELD_GROUP_ORDER = ['Buyer names', 'Seller names', 'Buyer/Seller names', 'Agent names', 'Additional Agent', 'Property', 'Money', 'Dates', 'Other']

// Fields in template order, bucketed into the groups above (falling back to
// "Other" for anything the table doesn't name) and returned in a fixed,
// sensible reading order rather than however the template happens to list them.
export const groupFields = (list) => {
  const byGroup = new Map()
  for (const f of list) {
    const g = fieldInfo(f)?.group || 'Other'
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push(f)
  }
  return FIELD_GROUP_ORDER
    .map(g => ({ group: g, fields: byGroup.get(g) || [] }))
    .filter(g => g.fields.length)
}
