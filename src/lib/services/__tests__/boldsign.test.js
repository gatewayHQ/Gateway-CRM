import { describe, it, expect } from 'vitest'
import { describeTransportFailure, normalizeState, crmTokenValues, isFillableField, isTickableField, isPrefillableField, isSharedField, isSignerBoundField, signerBoundPrefillFields, partitionPrefillFields, buildPrefillFields, sharedDataOnSignerFields, SHARED_PREFILL_TOKENS, dealClientList, joinNames, appointedAgent, tokenValueFor, fieldTokenValue, fieldTokenKey, prefillFieldEntry, seedSignersFromDeal, dealAgentList, orderAgentSigners, buildTemplateRoles, dealClientSide, dealClientSides, CANONICAL_LABEL_TOKENS, supportsReadOnly, isUnconfiguredField, isDateField, usDateToIso, isoDateToUs, READONLY_SUPPORTED_FIELD_TYPES, FILLABLE_FIELD_TYPES, TICKABLE_FIELD_TYPES, conditionalFieldsToRemove, emptyLabelsToRemove, partyNameGaps } from '../boldsign.js'

describe('normalizeState', () => {
  it('passes through a 2-letter code', () => { expect(normalizeState('ia')).toBe('IA') })
  it('maps a full operating-state name to its code', () => {
    expect(normalizeState('Iowa')).toBe('IA')
    expect(normalizeState('south dakota')).toBe('SD')
    expect(normalizeState('Nebraska')).toBe('NE')
  })
  it('returns empty string for empty input', () => { expect(normalizeState('')).toBe('') })
})

describe('crmTokenValues', () => {
  const ctx = {
    deal: { value: 450000, commission_pct: 3, expected_close_date: '2026-08-15' },
    property: { address: '123 Main St', city: 'Ames', state: 'IA', zip: '50010' },
    contact: { first_name: 'Jane', last_name: 'Buyer' },
    agent: { name: 'Alex Agent', email: 'alex@brokerage.com' },
  }

  it('resolves agent/broker tokens from the acting agent', () => {
    const vals = crmTokenValues(ctx)
    expect(vals.agent_name).toBe('Alex Agent')
    expect(vals.agent_email).toBe('alex@brokerage.com')
    expect(vals.seller_name).toBe('Jane Buyer')
    expect(vals.property_address).toBe('123 Main St')
  })

  it('fills the commission tokens from a percentage deal', () => {
    const vals = crmTokenValues(ctx)
    expect(vals.commission_pct).toBe('3%')
    expect(vals.commission_amount).toBe('$13,500')
  })

  it('a flat-fee deal fills the dollar token and leaves the rate token empty', () => {
    // There is no percentage to print on a listing agreement for a flat fee, so
    // commission_pct stays blank rather than printing a misleading "0%".
    const vals = crmTokenValues({ ...ctx, deal: { ...ctx.deal, commission_type: 'flat', commission_flat: 12500 } })
    expect(vals.commission_pct).toBe('')
    expect(vals.commission_amount).toBe('$12,500')
  })

  it('leaves both commission tokens empty when the agent has entered nothing', () => {
    const vals = crmTokenValues({ ...ctx, deal: { value: 450000 } })
    expect(vals.commission_pct).toBe('')
    expect(vals.commission_amount).toBe('')
  })
})

describe('isFillableField', () => {
  it('treats Textbox/Label/Dropdown as fillable', () => {
    expect(isFillableField('Textbox')).toBe(true)
    expect(isFillableField('label')).toBe(true)
  })
  it('treats Signature/Initial as NOT fillable (signer actions)', () => {
    expect(isFillableField('Signature')).toBe(false)
    expect(isFillableField('Initial')).toBe(false)
  })
  it('keeps tick boxes out of the text inputs but inside the prefillable set', () => {
    expect(isFillableField('CheckBox')).toBe(false)
    expect(isTickableField('CheckBox')).toBe(true)
    expect(isTickableField('RadioButton')).toBe(true)
    expect(isPrefillableField('CheckBox')).toBe(true)
    expect(isPrefillableField('Signature')).toBe(false)
  })
})

describe('prefillFieldEntry — what the agent decided reaches the signers, locked', () => {
  const tick = { id: 'exclusive_agency', type: 'CheckBox' }
  const text = { id: 'county', type: 'Textbox' }

  it('sends a ticked box as a real value the signer cannot change', () => {
    // The reported bug: a box the agent ticked in BoldSign's editor showed
    // unchecked when the client opened the document. Ticked in the CRM it goes
    // out as an actual field value, read-only.
    expect(prefillFieldEntry(tick, true)).toEqual({ id: 'exclusive_agency', value: 'true', isReadOnly: true })
  })

  it('sends a deliberately cleared box too — an unticked term is still a term', () => {
    expect(prefillFieldEntry(tick, false)).toEqual({ id: 'exclusive_agency', value: 'false', isReadOnly: true })
  })

  it('leaves an untouched box for the signer rather than locking it', () => {
    expect(prefillFieldEntry(tick, null)).toBeNull()
    expect(prefillFieldEntry(tick, undefined)).toBeNull()
    expect(prefillFieldEntry(tick, '')).toBeNull()
  })

  it('locks typed text and skips blanks', () => {
    expect(prefillFieldEntry(text, ' Polk ')).toEqual({ id: 'county', value: 'Polk', isReadOnly: true })
    expect(prefillFieldEntry(text, '   ')).toBeNull()
  })

  it('ignores a field with no id — there is nothing to address it by', () => {
    expect(prefillFieldEntry({ type: 'Textbox' }, 'Polk')).toBeNull()
  })
})

describe('seedSignersFromDeal — auto-fill signer name/email from the deal', () => {
  const contact = { first_name: 'Jane', last_name: 'Seller', email: 'jane@x.com', spouse_name: 'John Seller' }
  const agent   = { name: 'Alex Agent', email: 'alex@brokerage.com' }

  it('fills a client role with the contact and an agent role with the acting agent', () => {
    const roles = [{ index: 1, name: 'Seller' }, { index: 2, name: 'Listing Agent' }]
    expect(seedSignersFromDeal({ roles, contact, activeAgent: agent })).toEqual({
      1: { name: 'Jane Seller', email: 'jane@x.com' },
      2: { name: 'Alex Agent',  email: 'alex@brokerage.com' },
    })
  })

  it('works the same for a Buyer role (broad client matching)', () => {
    const roles = [{ index: 1, name: 'Buyer' }]
    expect(seedSignersFromDeal({ roles, contact, activeAgent: agent })[1]).toEqual({ name: 'Jane Seller', email: 'jane@x.com' })
  })

  it('puts the spouse in a second client role (husband & wife)', () => {
    const roles = [{ index: 1, name: 'Seller 1' }, { index: 2, name: 'Seller 2' }]
    const out = seedSignersFromDeal({ roles, contact, activeAgent: agent })
    expect(out[1]).toEqual({ name: 'Jane Seller', email: 'jane@x.com' })
    expect(out[2]).toEqual({ name: 'John Seller', email: '' })  // spouse_name fallback — no email stored
  })

  it('prefers real linked additional contacts (with their own email) over spouse_name', () => {
    const roles = [{ index: 1, name: 'Buyer 1' }, { index: 2, name: 'Buyer 2' }]
    const additionalContacts = [{ first_name: 'Sam', last_name: 'Cobuyer', email: 'sam@x.com' }]
    const out = seedSignersFromDeal({ roles, contact, additionalContacts, activeAgent: agent })
    expect(out[1]).toEqual({ name: 'Jane Seller', email: 'jane@x.com' })
    expect(out[2]).toEqual({ name: 'Sam Cobuyer', email: 'sam@x.com' })  // linked contact wins, carries email
  })

  it('fills three client roles from primary + two linked contacts', () => {
    const roles = [{ index: 1, name: 'Signer 1' }, { index: 2, name: 'Signer 2' }, { index: 3, name: 'Signer 3' }]
    const additionalContacts = [
      { first_name: 'Sam', last_name: 'Two', email: 'sam@x.com' },
      { first_name: 'Pat', last_name: 'Three', email: 'pat@x.com' },
    ]
    const out = seedSignersFromDeal({ roles, contact, additionalContacts, activeAgent: agent })
    expect(out[2]).toEqual({ name: 'Sam Two', email: 'sam@x.com' })
    expect(out[3]).toEqual({ name: 'Pat Three', email: 'pat@x.com' })
  })

  it('falls back to the template placeholder when there is no deal contact', () => {
    const roles = [{ index: 1, name: 'Seller', defaultName: 'Placeholder', defaultEmail: 'p@x.com' }]
    expect(seedSignersFromDeal({ roles, contact: null, activeAgent: agent })[1]).toEqual({ name: 'Placeholder', email: 'p@x.com' })
  })

  it('leaves non-client, non-agent roles (e.g. Witness) on the template default', () => {
    const roles = [{ index: 1, name: 'Witness' }]
    expect(seedSignersFromDeal({ roles, contact, activeAgent: agent })[1]).toEqual({ name: '', email: '' })
  })

  it('fills only one agent role when the deal has no co-agent to assign', () => {
    // With a co-agent on the deal, role 2 IS filled — see the dealAgents suite.
    const roles = [{ index: 1, name: 'Agent' }, { index: 2, name: 'Co-Agent' }]
    const out = seedSignersFromDeal({ roles, contact: null, activeAgent: agent })
    expect(out[1]).toEqual({ name: 'Alex Agent', email: 'alex@brokerage.com' })
    expect(out[2]).toEqual({ name: '', email: '' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Co-agents on a deal → agent signer roles.
//
// The source of truth is the same one the "Agents on deal" card uses
// (src/pages/DealPage.jsx): deal.agent_id, then legacy co_agent_ids, then
// commission participants — so the send modal seeds the people the deal page
// shows, in the same order.
// ─────────────────────────────────────────────────────────────────────────────
describe('dealAgentList — mirrors the "Agents on deal" card', () => {
  const agents = [
    { id: 'a1', name: 'Daniel Stillson', email: 'daniel@gw.com' },
    { id: 'a2', name: 'Nic Madsen',      email: 'nic@gw.com' },
    { id: 'a3', name: 'Third Agent',     email: 'third@gw.com' },
  ]

  it('puts the primary agent first, then co-agents', () => {
    const deal = { agent_id: 'a1', co_agent_ids: ['a2'] }
    expect(dealAgentList({ deal, agents })).toEqual([
      { id: 'a1', name: 'Daniel Stillson', email: 'daniel@gw.com' },
      { id: 'a2', name: 'Nic Madsen',      email: 'nic@gw.com' },
    ])
  })

  it('picks up a co-agent that only exists as a commission participant', () => {
    const deal = { agent_id: 'a1' }
    expect(dealAgentList({ deal, agents, participantAgentIds: ['a2'] }).map(a => a.id)).toEqual(['a1', 'a2'])
  })

  it('dedupes an agent listed in more than one source', () => {
    const deal = { agent_id: 'a1', co_agent_ids: ['a2', 'a1'] }
    expect(dealAgentList({ deal, agents, participantAgentIds: ['a2', 'a1'] }).map(a => a.id)).toEqual(['a1', 'a2'])
  })

  it('ignores ids with no matching agent row, and tolerates a bare deal', () => {
    expect(dealAgentList({ deal: { agent_id: 'ghost' }, agents })).toEqual([])
    expect(dealAgentList({ deal: null, agents })).toEqual([])
    expect(dealAgentList({})).toEqual([])
  })
})

describe('orderAgentSigners — who signs the agent block', () => {
  const me  = { name: 'Daniel Stillson', email: 'daniel@gw.com' }
  const nic = { name: 'Nic Madsen',      email: 'nic@gw.com' }

  it('promotes the acting agent to the front when they are on the deal', () => {
    expect(orderAgentSigners({ activeAgent: me, dealAgents: [nic, me] })).toEqual([me, nic])
  })

  it('leaves the deal order alone when the sender is NOT on the deal', () => {
    // An admin / transaction coordinator sending on someone's deal: the listing
    // agent signs the listing agreement, not whoever clicked Send.
    const tc = { name: 'Office Admin', email: 'admin@gw.com' }
    expect(orderAgentSigners({ activeAgent: tc, dealAgents: [me, nic] })).toEqual([me, nic])
  })

  it('falls back to the acting agent when the deal has no resolved agents', () => {
    expect(orderAgentSigners({ activeAgent: me, dealAgents: [] })).toEqual([me])
    expect(orderAgentSigners({ activeAgent: null, dealAgents: [] })).toEqual([])
  })
})

describe('seedSignersFromDeal — agent roles never take a client', () => {
  const contact = { first_name: 'Jane', last_name: 'Seller', email: 'jane@x.com' }
  const cobuyer = { first_name: 'John', last_name: 'CoBuyer', email: 'john@x.com' }
  const me      = { name: 'Daniel Stillson', email: 'daniel@gw.com' }
  const nic     = { name: 'Nic Madsen',      email: 'nic@gw.com' }

  it("REGRESSION: a second agent role must not be seeded with the co-buyer", () => {
    // Seller / Listing Agent / Buyer's Agent used to put John CoBuyer in role 3,
    // because the acting agent consumed the first agent role and "buyer's agent"
    // matches /buyer/. Sending it asked a client to sign as their own agent.
    const roles = [{ index: 1, name: 'Seller' }, { index: 2, name: 'Listing Agent' }, { index: 3, name: "Buyer's Agent" }]
    const out = seedSignersFromDeal({ roles, contact, additionalContacts: [cobuyer], activeAgent: me })
    expect(out[1]).toEqual({ name: 'Jane Seller', email: 'jane@x.com' })
    expect(out[2]).toEqual({ name: 'Daniel Stillson', email: 'daniel@gw.com' })
    expect(out[3]).toEqual({ name: '', email: '' })            // blank, NOT the co-buyer
    expect(out[3].email).not.toBe('john@x.com')
  })

  it('fills a second agent role with the co-agent on the deal', () => {
    const roles = [{ index: 1, name: 'Seller' }, { index: 2, name: 'Listing Agent' }, { index: 3, name: 'Co-Listing Agent' }]
    const out = seedSignersFromDeal({ roles, contact, activeAgent: me, dealAgents: [me, nic] })
    expect(out[2]).toEqual({ name: 'Daniel Stillson', email: 'daniel@gw.com' })
    expect(out[3]).toEqual({ name: 'Nic Madsen', email: 'nic@gw.com' })
  })

  it('is order-independent — the same roles reversed seed the same people', () => {
    // The old logic was order-dependent, which is why the bug was hard to spot.
    const a = seedSignersFromDeal({
      roles: [{ index: 1, name: 'Buyer' }, { index: 2, name: "Buyer's Agent" }, { index: 3, name: 'Listing Agent' }],
      contact, additionalContacts: [cobuyer], activeAgent: me, dealAgents: [me, nic],
    })
    const b = seedSignersFromDeal({
      roles: [{ index: 1, name: 'Buyer' }, { index: 2, name: 'Listing Agent' }, { index: 3, name: "Buyer's Agent" }],
      contact, additionalContacts: [cobuyer], activeAgent: me, dealAgents: [me, nic],
    })
    // Whichever agent role comes first gets the acting agent; the other gets the
    // co-agent. Neither ever gets a client.
    expect([a[2], a[3]]).toEqual([{ name: 'Daniel Stillson', email: 'daniel@gw.com' }, { name: 'Nic Madsen', email: 'nic@gw.com' }])
    expect([b[2], b[3]]).toEqual([{ name: 'Daniel Stillson', email: 'daniel@gw.com' }, { name: 'Nic Madsen', email: 'nic@gw.com' }])
  })

  it('leaves other professional roles blank rather than seeding a client', () => {
    const roles = [
      { index: 1, name: 'Seller' },
      { index: 2, name: "Seller's Attorney" },
      { index: 3, name: 'Title Company' },
      { index: 4, name: 'Escrow Officer' },
    ]
    const out = seedSignersFromDeal({ roles, contact, additionalContacts: [cobuyer], activeAgent: me })
    expect(out[1]).toEqual({ name: 'Jane Seller', email: 'jane@x.com' })
    for (const i of [2, 3, 4]) expect(out[i]).toEqual({ name: '', email: '' })
  })

  it('keeps a professional role\'s own template placeholder when it has one', () => {
    const roles = [{ index: 1, name: 'Title Company', defaultName: 'Dickinson Title', defaultEmail: 'closings@dtitle.com' }]
    expect(seedSignersFromDeal({ roles, contact, activeAgent: me })[1])
      .toEqual({ name: 'Dickinson Title', email: 'closings@dtitle.com' })
  })

  it('falls back to the template placeholder when there is no agent left to assign', () => {
    const roles = [{ index: 1, name: 'Listing Agent' }, { index: 2, name: 'Co-Listing Agent', defaultName: 'TBD', defaultEmail: '' }]
    const out = seedSignersFromDeal({ roles, activeAgent: me, dealAgents: [me] })
    expect(out[1]).toEqual({ name: 'Daniel Stillson', email: 'daniel@gw.com' })
    expect(out[2]).toEqual({ name: 'TBD', email: '' })
  })

  it('seeds the deal\'s own agents when an admin sends on their behalf', () => {
    const tc = { name: 'Office Admin', email: 'admin@gw.com' }
    const roles = [{ index: 1, name: 'Seller' }, { index: 2, name: 'Listing Agent' }]
    const out = seedSignersFromDeal({ roles, contact, activeAgent: tc, dealAgents: [me, nic] })
    expect(out[2]).toEqual({ name: 'Daniel Stillson', email: 'daniel@gw.com' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildTemplateRoles — BoldSign's post-removal index shift.
//
// BoldSign applies roleRemovalIndices first, then expects each supplied role's
// roleIndex to be its position in the REMAINING list. Verified against the live
// API on the Iowa Agency Packet (5 roles: Seller, Listing Agent, Co-seller,
// Co-listing agent, Buyer):
//   roles [1,2]   + removals [3,4,5] → accepted
//   roles [1,2,4] + removals [3,5]   → "SignerName or SignerEmail is missing in roles"
// ─────────────────────────────────────────────────────────────────────────────
describe('buildTemplateRoles — index shift after role removal', () => {
  const IOWA_PACKET = [
    { index: 1, name: 'Seller' },
    { index: 2, name: 'Listing Agent' },
    { index: 3, name: 'Co-seller' },
    { index: 4, name: 'Co-listing agent' },
    { index: 5, name: 'Buyer' },
  ]
  const jean = { name: 'Jean Irwin',      email: 'irwinfam@tcaexpress.net' }
  const dan  = { name: 'Daniel Stillson', email: 'daniel@gatewayreadvisors.com' }
  const nic  = { name: 'Nic Madsen',      email: 'nic@gatewayreadvisors.com' }

  it('REGRESSION: shifts a co-listing agent down past the skipped co-seller', () => {
    // The exact payload that failed: Seller + Listing Agent + Co-listing agent,
    // with Co-seller and Buyer left blank.
    const { roles, roleRemovalIndices } = buildTemplateRoles({
      roleList: IOWA_PACKET, signers: { 1: jean, 2: dan, 4: nic },
    })
    expect(roleRemovalIndices).toEqual([3, 5])          // original numbering
    expect(roles.map(r => r.roleIndex)).toEqual([1, 2, 3])  // was [1,2,4] → rejected
    expect(roles[2]).toMatchObject({ roleIndex: 3, signerName: 'Nic Madsen', signerEmail: nic.email })
  })

  it('leaves a payload that already worked completely unchanged', () => {
    // Trailing-only removal: nothing is dropped below role 1 or 2, so no shift.
    const { roles, roleRemovalIndices } = buildTemplateRoles({
      roleList: IOWA_PACKET, signers: { 1: jean, 2: dan },
    })
    expect(roleRemovalIndices).toEqual([3, 4, 5])
    expect(roles.map(r => r.roleIndex)).toEqual([1, 2])
  })

  it('shifts correctly with several interior gaps', () => {
    const { roles, roleRemovalIndices } = buildTemplateRoles({
      roleList: IOWA_PACKET, signers: { 2: dan, 5: nic },   // skip 1, 3, 4
    })
    expect(roleRemovalIndices).toEqual([1, 3, 4])
    expect(roles.map(r => r.roleIndex)).toEqual([1, 2])     // 2→1, 5→2
  })

  it('emits a dense 1..N sequence for every skip pattern', () => {
    // Whatever the agent leaves blank, the result must be contiguous from 1 —
    // that is the property BoldSign actually enforces.
    const people = [jean, dan, nic, jean, dan]
    for (let mask = 1; mask < 32; mask++) {
      const signers = {}
      IOWA_PACKET.forEach((r, i) => { if (mask & (1 << i)) signers[r.index] = people[i] })
      const { roles } = buildTemplateRoles({ roleList: IOWA_PACKET, signers })
      expect(roles.map(r => r.roleIndex)).toEqual(roles.map((_, i) => i + 1))
    }
  })

  it('keeps every role when they are all filled', () => {
    const signers = { 1: jean, 2: dan, 3: jean, 4: nic, 5: dan }
    const { roles, roleRemovalIndices } = buildTemplateRoles({ roleList: IOWA_PACKET, signers })
    expect(roleRemovalIndices).toEqual([])
    expect(roles.map(r => r.roleIndex)).toEqual([1, 2, 3, 4, 5])
  })

  it('treats a name-only or email-only row as unfilled, and trims values', () => {
    const signers = { 1: jean, 2: { name: 'No Email', email: '  ' }, 3: { name: '', email: 'x@y.com' }, 4: { name: ' Nic Madsen ', email: ' nic@x.com ' } }
    const { roles, roleRemovalIndices } = buildTemplateRoles({ roleList: IOWA_PACKET, signers })
    expect(roleRemovalIndices).toEqual([2, 3, 5])
    expect(roles.map(r => r.roleIndex)).toEqual([1, 2])
    expect(roles[1]).toMatchObject({ signerName: 'Nic Madsen', signerEmail: 'nic@x.com' })
  })

  it('looks up prefilled fields by ORIGINAL role index, not the shifted one', () => {
    // Field metadata comes from the template and is unaffected by removal, so a
    // shift must not misroute a role's prefilled values.
    const fieldsByRole = { 4: [{ id: 'property_address', value: '2212 Okoboji Ave', isReadOnly: true }] }
    const { roles } = buildTemplateRoles({
      roleList: IOWA_PACKET, signers: { 1: jean, 2: dan, 4: nic }, fieldsByRole,
    })
    const nicRole = roles.find(r => r.signerName === 'Nic Madsen')
    expect(nicRole.roleIndex).toBe(3)
    expect(nicRole.existingFormFields).toEqual(fieldsByRole[4])
  })

  it('numbers signing order over the surviving roles, not the original indices', () => {
    const parallel = buildTemplateRoles({ roleList: IOWA_PACKET, signers: { 1: jean, 2: dan, 4: nic } })
    expect(parallel.roles.map(r => r.signerOrder)).toEqual([1, 1, 1])   // everyone at once
    const ordered = buildTemplateRoles({ roleList: IOWA_PACKET, signers: { 1: jean, 2: dan, 4: nic }, inOrder: true })
    expect(ordered.roles.map(r => r.signerOrder)).toEqual([1, 2, 3])
  })

  it('handles an empty role list and an empty signer map', () => {
    expect(buildTemplateRoles({})).toEqual({ roles: [], roleRemovalIndices: [], filledCount: 0 })
    expect(buildTemplateRoles({ roleList: IOWA_PACKET, signers: {} }).roleRemovalIndices).toEqual([1, 2, 3, 4, 5])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Label (shared) fields — prefilled data every signer can read immediately.
//
// BoldSign hides a role-scoped field from every recipient except its own signer
// until that signer has finished. A Label is a COMMON field: visible to all from
// the moment the document is sent, editable by none, prefilled through ONE role's
// existingFormFields. These tests pin the routing that makes that true.
// ─────────────────────────────────────────────────────────────────────────────
describe('client name tokens — every party named, not just the primary contact', () => {
  const jane = { first_name: 'Jane', last_name: 'Doe', email: 'jane@x.com' }
  const john = { first_name: 'John', last_name: 'Doe', email: 'john@x.com' }
  const acme = { first_name: 'Acme', last_name: 'Holdings LLC', email: 'ops@acme.com' }

  it('prints both buyers on the parties line — naming one misstates who is bound', () => {
    const v = crmTokenValues({ contact: jane, additionalContacts: [john] })
    expect(v.client_names).toBe('Jane Doe and John Doe')
    expect(v.seller_names).toBe('Jane Doe and John Doe')
    expect(v.client_name).toBe('Jane Doe')      // the primary alone, unchanged
    expect(v.client_2_name).toBe('John Doe')
  })

  it('reads as a sentence with three or more parties', () => {
    expect(crmTokenValues({ contact: jane, additionalContacts: [john, acme] }).client_names)
      .toBe('Jane Doe, John Doe and Acme Holdings LLC')
  })

  it('falls back to the stored spouse name when no additional contact is linked', () => {
    const v = crmTokenValues({ contact: { ...jane, spouse_name: 'John Doe' } })
    expect(v.client_names).toBe('Jane Doe and John Doe')
    expect(v.client_2_name).toBe('John Doe')
  })

  it('ignores the spouse name once a real co-buyer is linked — no duplicate party', () => {
    const v = crmTokenValues({ contact: { ...jane, spouse_name: 'Stale Spouse' }, additionalContacts: [john] })
    expect(v.client_names).toBe('Jane Doe and John Doe')
  })

  it('is just the one name on a single-buyer deal, with no dangling "and"', () => {
    const v = crmTokenValues({ contact: jane })
    expect(v.client_names).toBe('Jane Doe')
    expect(v.client_2_name).toBe('')
  })

  it('leaves every client token blank when the deal has no contact', () => {
    const v = crmTokenValues({})
    expect(v.client_names).toBe('')
    expect(v.client_name).toBe('')
    expect(v.client_2_name).toBe('')
  })

  it('seeds signer rows from the same list the printed names come from', () => {
    // The parties clause and the signature rows must never disagree about who
    // the clients are.
    const roles = [{ index: 1, name: 'Buyer' }, { index: 2, name: 'Co-Buyer' }]
    const seeded = seedSignersFromDeal({ roles, contact: jane, additionalContacts: [john] })
    const printed = crmTokenValues({ contact: jane, additionalContacts: [john] })
    expect([seeded[1].name, seeded[2].name]).toEqual(['Jane Doe', 'John Doe'])
    expect(printed.client_names).toBe('Jane Doe and John Doe')
  })
})

describe('appointedAgent — the agreement names the deal’s agent, not the sender', () => {
  const alex  = { name: 'Alex Agent',  email: 'alex@brokerage.com' }
  const nic   = { name: 'Nic Madsen',  email: 'nic@brokerage.com' }
  const admin = { name: 'Office Admin', email: 'admin@brokerage.com' }

  it('REGRESSION: a TC sending on an agent’s behalf does not get named as the agent', () => {
    // An Appointed Agency form states who is licensed to represent the client.
    // Printing the coordinator's name there is a statement about the wrong
    // person — and the signature row below already named the agent correctly.
    expect(appointedAgent({ activeAgent: admin, dealAgents: [alex] })).toEqual(alex)
    expect(crmTokenValues({ agent: appointedAgent({ activeAgent: admin, dealAgents: [alex] }) }).agent_name)
      .toBe('Alex Agent')
  })

  it('keeps the acting agent when they are actually on the deal', () => {
    expect(appointedAgent({ activeAgent: nic, dealAgents: [alex, nic] })).toEqual(nic)
  })

  it('matches the acting agent by email regardless of how the name is stored', () => {
    expect(appointedAgent({ activeAgent: { name: 'A. Agent', email: 'ALEX@brokerage.com' }, dealAgents: [alex] }))
      .toMatchObject({ email: 'ALEX@brokerage.com' })
  })

  it('falls back to the sender when the deal has no agents on it', () => {
    expect(appointedAgent({ activeAgent: admin, dealAgents: [] })).toEqual(admin)
  })

  it('returns null when there is nobody to name', () => {
    expect(appointedAgent()).toBeNull()
    expect(appointedAgent({ activeAgent: { name: '', email: '' }, dealAgents: [] })).toBeNull()
  })

  it('agrees with the agent-signer ordering the rows already use', () => {
    expect(appointedAgent({ activeAgent: admin, dealAgents: [alex, nic] }).email)
      .toBe(orderAgentSigners({ activeAgent: admin, dealAgents: [alex, nic] })[0].email)
  })
})

describe('fieldTokenValue — finding the token wherever BoldSign put it', () => {
  const vals = crmTokenValues({ contact: { first_name: 'Jane', last_name: 'Doe' }, agent: { name: 'Alex Agent' } })

  it('REGRESSION: matches the field NAME, because BoldSign auto-assigns the id', () => {
    // The reported failure: a template carefully labelled `client_names` arrived
    // blank. BoldSign had assigned the field id `Label1` (the ids in its own API
    // examples), the CRM matched on id alone, and the send screen showed an empty
    // box with nothing to explain it.
    expect(fieldTokenValue(vals, { id: 'Label1', name: 'client_names' })).toBe('Jane Doe')
    expect(fieldTokenValue(vals, { id: 'Label2', name: 'agent_name' })).toBe('Alex Agent')
  })

  it('matches the label too, for a field whose caption carries the token', () => {
    expect(fieldTokenValue(vals, { id: 'Label3', label: 'agent_name' })).toBe('Alex Agent')
  })

  it('prefers the id when the id is itself a token', () => {
    expect(fieldTokenValue(vals, { id: 'agent_name', name: 'client_name' })).toBe('Alex Agent')
  })

  it('normalizes case, spaces and dashes — all one token', () => {
    expect(fieldTokenValue(vals, { id: 'Agent_Name' })).toBe('Alex Agent')
    expect(fieldTokenValue(vals, { id: 'x', name: 'Agent Name' })).toBe('Alex Agent')
    expect(fieldTokenValue(vals, { id: 'x', name: 'AGENT-NAME' })).toBe('Alex Agent')
    expect(fieldTokenValue(vals, 'Client_names')).toBe('Jane Doe')
  })

  it('names which token a field resolved to, for the send screen’s field id hint', () => {
    expect(fieldTokenKey({ id: 'Label1', name: 'Client Names' })).toBe('client_names')
    expect(fieldTokenKey({ id: 'Label9', name: 'Buyer licence' })).toBe('')
  })

  it('returns empty for a field that is not one of our tokens', () => {
    expect(fieldTokenValue(vals, { id: 'Label7', name: 'buyer_license_no' })).toBe('')
    expect(fieldTokenValue(vals, { id: '' })).toBe('')
    expect(fieldTokenValue(vals, null)).toBe('')
    expect(fieldTokenValue(undefined, { id: 'agent_name' })).toBe('')
  })

  it('flags shared data on a signer field however the token was spelled', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'List_Price', type: 'Textbox', roleIndex: 2 }], values: { List_Price: '$1,350,000' },
    }).map(f => f.id)).toEqual(['List_Price'])
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'Label4', name: 'list_price', type: 'Textbox', roleIndex: 2 }], values: { Label4: '$1,350,000' },
    }).map(f => f.id)).toEqual(['Label4'])
  })
})

describe('Name fields — BoldSign prints the signer’s own name and ignores ours', () => {
  it('classifies Name as signer-bound, and nothing else as signer-bound', () => {
    expect(isSignerBoundField('Name')).toBe(true)
    expect(isSignerBoundField('name')).toBe(true)
    expect(isSignerBoundField('Textbox')).toBe(false)
    expect(isSignerBoundField('Label')).toBe(false)
    expect(isSignerBoundField('CheckBox')).toBe(false)
    expect(isSignerBoundField(undefined)).toBe(false)
  })

  it('never offers a Name field as something to fill in', () => {
    expect(isFillableField('Name')).toBe(false)
    // …but still DISCOVERS it, so a misused one gets reported rather than hidden.
    expect(isPrefillableField('Name')).toBe(true)
  })

  it('THE REQUIREMENT: no value is ever sent for a Name field', () => {
    // BoldSign would accept this and discard it, leaving the send screen, the
    // payload and the audit log all claiming a value the document never shows.
    expect(prefillFieldEntry({ id: 'agent_name', type: 'Name' }, 'Alex Agent')).toBeNull()
    expect(prefillFieldEntry({ id: 'Name1', type: 'name' }, 'Jane Buyer')).toBeNull()
  })

  it('keeps Name values out of both the shared list and every role’s list', () => {
    const { sharedFormFields, byRole, signerScopedIds } = buildPrefillFields({
      fields: [
        { id: 'agent_name',    type: 'Name',    roleIndex: 1 },
        { id: 'property_full', type: 'Label',   roleIndex: 1 },
        { id: 'county',        type: 'Textbox', roleIndex: 1 },
      ],
      values: { agent_name: 'Alex Agent', property_full: '2212 Okoboji Ave', county: 'Dickinson' },
      filledRoleIndices: [1],
    })
    expect(sharedFormFields.map(f => f.id)).toEqual(['property_full'])
    expect(byRole[1].map(f => f.id)).toEqual(['county'])
    expect(signerScopedIds).not.toContain('agent_name')
  })

  it('reports a Name field carrying a CRM token — the wrong-name defect', () => {
    const bad = signerBoundPrefillFields({
      fields: [
        { id: 'Name1', name: 'agent_name', type: 'Name', roleIndex: 1 },
        { id: 'Name2', type: 'Name', roleIndex: 2 },
      ],
      values: {},
    })
    expect(bad.map(f => f.id)).toEqual(['Name1'])
  })

  it('reports a Name field the agent typed into, token or not', () => {
    expect(signerBoundPrefillFields({
      fields: [{ id: 'Name3', label: 'Trustee', type: 'Name', roleIndex: 1 }],
      values: { Name3: 'The Doe Family Trust' },
    }).map(f => f.id)).toEqual(['Name3'])
  })

  it('leaves a plain Name field alone — that one really is the signer’s own name', () => {
    expect(signerBoundPrefillFields({
      fields: [{ id: 'Name1', type: 'Name', roleIndex: 1 }],
      values: { Name1: '' },
    })).toEqual([])
    expect(signerBoundPrefillFields()).toEqual([])
  })

  it('ignores every other field type — this audit is about Name fields only', () => {
    expect(signerBoundPrefillFields({
      fields: [
        { id: 'agent_name', type: 'Textbox', roleIndex: 1 },
        { id: 'list_price', type: 'Label',   roleIndex: 1 },
      ],
      values: { agent_name: 'Alex Agent', list_price: '$1,350,000' },
    })).toEqual([])
  })
})

describe('joinNames', () => {
  it('reads as a parties clause rather than a comma list', () => {
    expect(joinNames(['Jane'])).toBe('Jane')
    expect(joinNames(['Jane', 'John'])).toBe('Jane and John')
    expect(joinNames(['Jane', 'John', 'Acme LLC'])).toBe('Jane, John and Acme LLC')
  })
  it('drops blanks and handles nothing at all', () => {
    expect(joinNames(['Jane', '', '  ', 'John'])).toBe('Jane and John')
    expect(joinNames([])).toBe('')
    expect(joinNames()).toBe('')
  })
})

describe('isSharedField / partitionPrefillFields — which fields everyone can see', () => {
  it('treats Label (only) as the shared field type', () => {
    expect(isSharedField('Label')).toBe(true)
    expect(isSharedField('label')).toBe(true)
    expect(isSharedField('Textbox')).toBe(false)
    expect(isSharedField('CheckBox')).toBe(false)
    expect(isSharedField('Name')).toBe(false)
    expect(isSharedField('Email')).toBe(false)
    expect(isSharedField(undefined)).toBe(false)
  })

  it('splits a template into the shared set and the signer-private set', () => {
    const fields = [
      { id: 'property_full', type: 'Label',   roleIndex: 1 },
      { id: 'list_price',    type: 'Label',   roleIndex: 2 },
      { id: 'county',        type: 'Textbox', roleIndex: 2 },
      { id: 'exclusive',     type: 'CheckBox', roleIndex: 1 },
    ]
    const { shared, signerSpecific } = partitionPrefillFields(fields)
    expect(shared.map(f => f.id)).toEqual(['property_full', 'list_price'])
    expect(signerSpecific.map(f => f.id)).toEqual(['county', 'exclusive'])
  })

  it('drops signer actions and id-less fields — there is nothing to prefill', () => {
    const { shared, signerSpecific } = partitionPrefillFields([
      { id: 'sig', type: 'Signature', roleIndex: 1 },
      { id: 'ini', type: 'Initial',   roleIndex: 1 },
      { type: 'Label' },
    ])
    expect(shared).toEqual([])
    expect(signerSpecific).toEqual([])
  })

  it('survives an empty or missing field list', () => {
    expect(partitionPrefillFields()).toEqual({ shared: [], signerSpecific: [], signerBound: [] })
    expect(partitionPrefillFields([])).toEqual({ shared: [], signerSpecific: [], signerBound: [] })
  })

  it('keeps Name fields in their own bucket — they are neither shared nor prefillable', () => {
    const { shared, signerSpecific, signerBound } = partitionPrefillFields([
      { id: 'property_full', type: 'Label',   roleIndex: 1 },
      { id: 'county',        type: 'Textbox', roleIndex: 2 },
      { id: 'agent_name',    type: 'Name',    roleIndex: 2 },
    ])
    expect(shared.map(f => f.id)).toEqual(['property_full'])
    expect(signerSpecific.map(f => f.id)).toEqual(['county'])
    expect(signerBound.map(f => f.id)).toEqual(['agent_name'])
  })
})

describe('buildPrefillFields — Labels go out shared, role fields stay with their signer', () => {
  const FIELDS = [
    { id: 'property_full',  type: 'Label',    roleIndex: 2 },
    { id: 'list_price',     type: 'Label',    roleIndex: 1 },
    { id: 'ref_no',         type: 'Label',    roleIndex: null },
    { id: 'agent_license',  type: 'Textbox',  roleIndex: 2 },
    { id: 'county',         type: 'Textbox',  roleIndex: null },
    { id: 'exclusive',      type: 'CheckBox', roleIndex: 1 },
  ]
  const VALUES = {
    property_full: '2212 Okoboji Ave, Milford, IA',
    list_price:    '$1,350,000',
    ref_no:        'RE-98765432',
    agent_license: 'S-60912',
    county:        'Dickinson',
    exclusive:     true,
  }

  it('THE REQUIREMENT: every Label value goes on ONE shared list, whatever role the template assigned it to', () => {
    // property_full is a role-2 Label in the template. Left on role 2 it would be
    // invisible to the seller until the agent signed. As a shared field it is
    // visible to everyone the moment the document is sent.
    const { sharedFormFields, byRole } = buildPrefillFields({
      fields: FIELDS, values: VALUES, filledRoleIndices: [1, 2],
    })
    expect(sharedFormFields).toEqual([
      { id: 'property_full', value: '2212 Okoboji Ave, Milford, IA', isReadOnly: true },
      { id: 'list_price',    value: '$1,350,000',                   isReadOnly: true },
      { id: 'ref_no',        value: 'RE-98765432',                  isReadOnly: true },
    ])
    // …and no role carries a copy of them.
    const allRoleIds = Object.values(byRole).flat().map(f => f.id)
    expect(allRoleIds).not.toContain('property_full')
    expect(allRoleIds).not.toContain('list_price')
    expect(allRoleIds).not.toContain('ref_no')
  })

  it('every shared entry is read-only — a Label is not the signer’s to change', () => {
    const { sharedFormFields } = buildPrefillFields({ fields: FIELDS, values: VALUES, filledRoleIndices: [1, 2] })
    expect(sharedFormFields.every(f => f.isReadOnly === true)).toBe(true)
  })

  it('keeps a role-scoped field on its own signer', () => {
    const { byRole } = buildPrefillFields({ fields: FIELDS, values: VALUES, filledRoleIndices: [1, 2] })
    expect(byRole[2].map(f => f.id)).toEqual(['agent_license'])
    expect(byRole[1].map(f => f.id)).toContain('exclusive')
  })

  it('parks an unscoped role field on the anchor role, and reports which role that is', () => {
    const { byRole, anchorRoleIndex } = buildPrefillFields({ fields: FIELDS, values: VALUES, filledRoleIndices: [1, 2] })
    expect(anchorRoleIndex).toBe(1)
    expect(byRole[1].map(f => f.id)).toContain('county')
  })

  it('re-homes a role field whose role this send is dropping, rather than losing it', () => {
    // Role 2 left blank → removed. Its Textbox value still has to travel, so it
    // falls back to the anchor role instead of addressing a role that is gone.
    const { byRole, sharedFormFields } = buildPrefillFields({ fields: FIELDS, values: VALUES, filledRoleIndices: [1] })
    expect(byRole[1].map(f => f.id)).toEqual(['agent_license', 'county', 'exclusive'])
    expect(byRole[2]).toBeUndefined()
    expect(sharedFormFields).toHaveLength(3)      // Labels are unaffected by removal
  })

  it('honours an explicit anchor role, and ignores one that is not being sent', () => {
    expect(buildPrefillFields({ fields: FIELDS, values: VALUES, filledRoleIndices: [1, 2], anchorRoleIndex: 2 }).anchorRoleIndex).toBe(2)
    expect(buildPrefillFields({ fields: FIELDS, values: VALUES, filledRoleIndices: [1, 2], anchorRoleIndex: 9 }).anchorRoleIndex).toBe(1)
  })

  it('omits a field the agent left blank, and a box left to the signer', () => {
    const { sharedFormFields, byRole } = buildPrefillFields({
      fields: FIELDS,
      values: { list_price: '  ', exclusive: null, ref_no: 'RE-1' },
      filledRoleIndices: [1, 2],
    })
    expect(sharedFormFields.map(f => f.id)).toEqual(['ref_no'])
    expect(Object.values(byRole).flat()).toEqual([])
  })

  it('sends a deliberately unticked box, since an unticked term is still a term', () => {
    const { byRole } = buildPrefillFields({ fields: FIELDS, values: { exclusive: false }, filledRoleIndices: [1] })
    expect(byRole[1]).toEqual([{ id: 'exclusive', value: 'false', isReadOnly: true }])
  })

  it('produces nothing at all when no role has a signer', () => {
    expect(buildPrefillFields({ fields: FIELDS, values: VALUES, filledRoleIndices: [] })).toEqual({
      sharedFormFields: [], byRole: {}, sharedIds: [], signerScopedIds: [], anchorRoleIndex: null,
    })
    expect(buildPrefillFields()).toMatchObject({ sharedFormFields: [], byRole: {} })
  })
})

describe('sharedDataOnSignerFields — templates that will hide deal data from a party', () => {
  it('flags a CRM token sitting on a role-scoped field', () => {
    const gaps = sharedDataOnSignerFields({
      fields: [
        { id: 'property_full', type: 'Label',   roleIndex: 1 },
        { id: 'list_price',    type: 'Textbox', roleIndex: 2 },
      ],
      values: { property_full: 'Somewhere', list_price: '$1,350,000' },
    })
    expect(gaps.map(f => f.id)).toEqual(['list_price'])
  })

  // The sanctioned template pattern: prefilled data lives on the FIRST signer's
  // role, read-only, and every later signer sees it once that signer completes.
  // Flagging it would train agents to ignore the warning that matters.
  it('stays quiet when the first signer carries the data on an in-order send', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'agent_name', type: 'Name', roleIndex: 1 }],
      values: { agent_name: 'Alex Agent' },
      firstSignerIndex: 1, inOrder: true,
    })).toEqual([])
  })

  it('flags it when the field belongs to someone who signs LATER', () => {
    // Nobody ahead of role 2 ever sees this — the exact Appointed Agency bug.
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'agent_name', type: 'Textbox', roleIndex: 2 }],
      values: { agent_name: 'Alex Agent' },
      firstSignerIndex: 1, inOrder: true,
    }).map(f => f.id)).toEqual(['agent_name'])
  })

  it('flags it on a PARALLEL send even when the first signer carries it', () => {
    // Everyone opens at once, so nobody has completed and nobody sees anybody
    // else's fields.
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'agent_name', type: 'Textbox', roleIndex: 1 }],
      values: { agent_name: 'Alex Agent' },
      firstSignerIndex: 1, inOrder: false,
    }).map(f => f.id)).toEqual(['agent_name'])
  })

  // A pre-ticked box is OUR decision — a term of the agreement, not the signer's
  // own input — so it is subject to exactly the same visibility rule as a price.
  // Nothing reported this before: the old CRM-token gate could never match a
  // checkbox, so "Exclusive Agency" on the agent's role went out invisible to the
  // seller with no warning anywhere.
  it('flags a checkbox WE pre-ticked that the other parties cannot see', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'exclusive_agency', type: 'CheckBox', roleIndex: 2 }],
      values: { exclusive_agency: true },
      firstSignerIndex: 1, inOrder: true,
    }).map(f => f.id)).toEqual(['exclusive_agency'])
  })

  it('flags a deliberately UNticked box too — an unticked box is itself a term', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'seller_pays', type: 'CheckBox', roleIndex: 2 }],
      values: { seller_pays: false },
      firstSignerIndex: 1, inOrder: true,
    }).map(f => f.id)).toEqual(['seller_pays'])
  })

  it('says nothing about a box left to the signer — we are hiding nothing', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'exclusive_agency', type: 'CheckBox', roleIndex: 2 }],
      values: { exclusive_agency: null },
      firstSignerIndex: 1, inOrder: true,
    })).toEqual([])
  })

  it('never flags a Name field — nothing we send reaches one at all', () => {
    // Reported by signerBoundPrefillFields instead, which is a louder problem:
    // not "hidden from someone" but "will print the wrong name for everyone".
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'agent_name', type: 'Name', roleIndex: 2 }],
      values: { agent_name: 'Alex Agent' },
      firstSignerIndex: 1, inOrder: true,
    })).toEqual([])
  })

  it('treats a field naming no role as the first signer’s — it rides the anchor role', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'list_price', type: 'Textbox', roleIndex: null }],
      values: { list_price: '$1,350,000' },
      firstSignerIndex: 1, inOrder: true,
    })).toEqual([])
  })

  it('never flags a Label, whatever the order or the role', () => {
    for (const inOrder of [true, false]) {
      expect(sharedDataOnSignerFields({
        fields: [{ id: 'list_price', type: 'Label', roleIndex: 2 }],
        values: { list_price: '$1,350,000' },
        firstSignerIndex: 1, inOrder,
      })).toEqual([])
    }
  })

  it('says nothing about a field left blank — nothing is being hidden', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'list_price', type: 'Textbox', roleIndex: 2 }], values: {},
    })).toEqual([])
  })

  // DELIBERATE CHANGE. This used to be exempt, on the reasoning that a licence
  // number is the agent's own detail rather than shared deal data. But the value
  // is one WE put on the document before anyone opened it, and the party being
  // asked to sign cannot see it — which is the same defect whatever the caption
  // says. The exemption also could not be drawn accurately: it keyed off "is this
  // a CRM token", which silently excused every pre-ticked checkbox as well.
  it('flags any value the SENDER supplied, not only the ones matching a CRM token', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'agent_license', type: 'Textbox', roleIndex: 2 }],
      values: { agent_license: 'S-60912' },
      firstSignerIndex: 1, inOrder: true,
    }).map(f => f.id)).toEqual(['agent_license'])
  })

  it('still stays quiet when that same value rides the first signer in order', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'agent_license', type: 'Textbox', roleIndex: 1 }],
      values: { agent_license: 'S-60912' },
      firstSignerIndex: 1, inOrder: true,
    })).toEqual([])
  })

  it('is empty for a healthy Label-based template', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'list_price', type: 'Label', roleIndex: 2 }], values: { list_price: '$1,350,000' },
    })).toEqual([])
  })

  it('covers every CRM token, so a new one is shared-by-default the day it is added', () => {
    for (const token of Object.keys(crmTokenValues())) expect(SHARED_PREFILL_TOKENS.has(token)).toBe(true)
    expect(SHARED_PREFILL_TOKENS.has('property_full')).toBe(true)
    expect(SHARED_PREFILL_TOKENS.has('commission_amount')).toBe(true)
  })
})

describe('describeTransportFailure — turning "Failed to fetch" into something actionable', () => {
  const err = new TypeError('Failed to fetch')

  it('says so plainly when the browser is offline', () => {
    const msg = describeTransportFailure(err, { online: false })
    expect(msg).toMatch(/No network connection/)
    expect(msg).toMatch(/Reconnect/)
  })

  it('states that nothing was sent — the agent needs to know a send did not half-happen', () => {
    expect(describeTransportFailure(err, { online: true })).toMatch(/never reached the server, so nothing was sent/)
  })

  it('names all three causes rather than guessing, because the browser hides which it was', () => {
    const msg = describeTransportFailure(err, { online: true })
    expect(msg).toMatch(/preview deployment/i)   // Vercel SSO redirect
    expect(msg).toMatch(/extension/i)            // ad/privacy blocker
    expect(msg).toMatch(/VPN|proxy/i)            // dropped connection
  })

  it('tells the agent exactly where to look to tell them apart', () => {
    const msg = describeTransportFailure(err, { online: true })
    expect(msg).toMatch(/DevTools/)
    expect(msg).toMatch(/vercel\.com/)
  })

  it('keeps the original browser message, and survives one without a message', () => {
    expect(describeTransportFailure(err, { online: true })).toMatch(/Failed to fetch/)
    expect(describeTransportFailure({}, { online: true })).toMatch(/network error/)
    expect(describeTransportFailure(undefined, { online: true })).toMatch(/network error/)
  })

  it('names the endpoint it could not reach', () => {
    expect(describeTransportFailure(err, { online: true, url: '/api/portal' })).toMatch(/\/api\/portal/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Canonical Label field ids — the template-side vocabulary
//
// The templates name their fields `Agent1NameLabel`; the CRM names the same
// value `agent_name`. normalizeTokenKey() bridges case and separators, but
// there are no separators in `Agent1NameLabel`, so before CANONICAL_LABEL_TOKENS
// a correctly authored template matched nothing and every one of these fields
// went out blank with no error anywhere.
// ─────────────────────────────────────────────────────────────────────────────
describe('dealClientSide — which side of the table our clients are on', () => {
  const side = (t) => dealClientSide({ comp_data: { transaction_type: t } })

  it('reads buyer and seller off the deal', () => {
    expect(side('buyer')).toBe('buyer')
    expect(side('seller')).toBe('seller')
  })

  it('refuses to guess a side for a lease or a general deal', () => {
    // A lease has a lessor and a lessee, not a buyer and a seller.
    expect(side('lease')).toBeNull()
    expect(side('general')).toBeNull()
  })

  it('reads an unset, missing or oddly-cased value safely', () => {
    expect(side('')).toBeNull()
    expect(side(undefined)).toBeNull()
    expect(dealClientSide({})).toBeNull()
    expect(dealClientSide(null)).toBeNull()
    expect(dealClientSide(undefined)).toBeNull()
    expect(side(' Buyer ')).toBe('buyer')
  })
})

describe('canonical Label ids resolve to CRM tokens', () => {
  const ctx = {
    deal:     { comp_data: { transaction_type: 'buyer' } },
    contact:  { first_name: 'Jane', last_name: 'Buyer' },
    additionalContacts: [{ first_name: 'John', last_name: 'Buyer', email: 'john@x.com' }],
    agent:    { name: 'Nic Madsen', email: 'nic@gateway.com' },
    agents:   [{ name: 'Nic Madsen', email: 'nic@gateway.com' }, { name: 'Dana Co', email: 'dana@gateway.com' }],
  }

  it('REGRESSION: Agent1NameLabel resolves — it normalizes to agent1namelabel and used to match nothing', () => {
    expect(fieldTokenKey({ id: 'Agent1NameLabel' })).toBe('agent_name')
    expect(fieldTokenValue(crmTokenValues(ctx), { id: 'Agent1NameLabel' })).toBe('Nic Madsen')
  })

  it('resolves all four ids on the live test template', () => {
    const vals = crmTokenValues(ctx)
    expect(fieldTokenValue(vals, { id: 'Agent1NameLabel' })).toBe('Nic Madsen')
    expect(fieldTokenValue(vals, { id: 'Agent2NameLabel' })).toBe('Dana Co')
    expect(fieldTokenValue(vals, { id: 'Buyer1NameLabel' })).toBe('Jane Buyer')
    expect(fieldTokenValue(vals, { id: 'Buyer2NameLabel' })).toBe('John Buyer')
  })

  it('matches however an admin typed the id, since BoldSign auto-assigns the real one', () => {
    expect(fieldTokenKey({ id: 'agent1namelabel' })).toBe('agent_name')
    expect(fieldTokenKey({ id: 'AGENT1NAMELABEL' })).toBe('agent_name')
    expect(fieldTokenKey({ id: 'Agent1_Name_Label' })).toBe('agent_name')
    expect(fieldTokenKey({ id: ' Agent1NameLabel ' })).toBe('agent_name')
  })

  it('matches on the field NAME when BoldSign minted the id (Label1, Label2, ...)', () => {
    // The box an admin types into in the template editor is the field's name;
    // the id is auto-assigned and is not a stable identifier.
    expect(fieldTokenKey({ id: 'Label1', name: 'Buyer1NameLabel' })).toBe('party_buyer_1')
    expect(fieldTokenKey({ id: 'Label7', label: 'Agent2NameLabel' })).toBe('agent_2_name')
  })

  it('leaves the CRM vocabulary working exactly as before', () => {
    expect(fieldTokenKey({ id: 'agent_name' })).toBe('agent_name')
    expect(fieldTokenKey({ id: 'Agent_Name' })).toBe('agent_name')
    expect(fieldTokenKey({ id: 'property_address' })).toBe('property_address')
  })

  it('still returns nothing for a field that is not ours', () => {
    expect(fieldTokenKey({ id: 'WitnessInitials' })).toBe('')
    expect(fieldTokenKey({ id: 'Label3' })).toBe('')
    expect(fieldTokenKey(null)).toBe('')
  })

  it('every id in the table has a real token behind it', () => {
    // An entry pointing at a token that does not exist would resolve to
    // undefined and silently send nothing, which is the bug this table fixes.
    for (const token of Object.values(CANONICAL_LABEL_TOKENS)) {
      expect(SHARED_PREFILL_TOKENS.has(token)).toBe(true)
    }
  })
})

describe('side-aware buyer tokens', () => {
  const people = {
    contact: { first_name: 'Jane', last_name: 'Client' },
    additionalContacts: [{ first_name: 'John', last_name: 'Client', email: 'john@x.com' }],
  }
  const on = (transaction_type) => crmTokenValues({ ...people, deal: { comp_data: { transaction_type } } })

  it('fills the buyer lines when our clients ARE the buyers', () => {
    const vals = on('buyer')
    expect(vals.buyer_1_name).toBe('Jane Client')
    expect(vals.buyer_2_name).toBe('John Client')
  })

  it('REGRESSION: a seller-side deal must not print our seller under a Buyer caption', () => {
    // The counterparty is not stored anywhere in the CRM. A blank is visible on
    // the send screen and fixable by hand; a plausible wrong name is not.
    const vals = on('seller')
    expect(vals.buyer_1_name).toBe('')
    expect(vals.buyer_2_name).toBe('')
    // The side-agnostic tokens still carry our clients, as they always did.
    expect(vals.client_name).toBe('Jane Client')
    expect(vals.client_2_name).toBe('John Client')
  })

  it('blanks the buyer lines when the deal never recorded a side', () => {
    expect(on(undefined).buyer_1_name).toBe('')
    expect(on('lease').buyer_1_name).toBe('')
    expect(crmTokenValues(people).buyer_1_name).toBe('')
  })

  it('skips Buyer2 entirely on a single-buyer deal', () => {
    const vals = crmTokenValues({ contact: people.contact, deal: { comp_data: { transaction_type: 'buyer' } } })
    expect(vals.buyer_1_name).toBe('Jane Client')
    expect(vals.buyer_2_name).toBe('')
  })
})

describe('agent_2_name — the second agent line', () => {
  const agents = [{ name: 'Nic Madsen' }, { name: 'Dana Co' }]

  it('takes the second agent from the same ordered list the signature rows use', () => {
    expect(crmTokenValues({ agents }).agent_2_name).toBe('Dana Co')
  })

  it('is blank when the deal has only one agent, and when none was passed', () => {
    expect(crmTokenValues({ agents: [agents[0]] }).agent_2_name).toBe('')
    expect(crmTokenValues({}).agent_2_name).toBe('')
  })

  it('agrees with appointedAgent about who agent 1 is', () => {
    // appointedAgent() is orderAgentSigners()[0] in every branch, so the body's
    // agent_name and agent_2_name can never name the same person twice.
    const dealAgents  = [{ name: 'Nic Madsen', email: 'nic@g.com' }, { name: 'Dana Co', email: 'dana@g.com' }]
    const activeAgent = { name: 'Dana Co', email: 'dana@g.com' }
    const ordered = orderAgentSigners({ activeAgent, dealAgents })
    const vals = crmTokenValues({ agent: appointedAgent({ activeAgent, dealAgents }), agents: ordered })
    expect(vals.agent_name).toBe('Dana Co')
    expect(vals.agent_2_name).toBe('Nic Madsen')
    expect(vals.agent_name).not.toBe(vals.agent_2_name)
  })
})

describe('additional_agent_date — only meaningful once there is an additional agent', () => {
  // Regression test: this used to fall back to `today`/the listing start
  // whether or not an additional agent existed, so the "this __ day of
  // ______, 20__" blanks in the ADDITIONAL APPOINTED AGENT section filled
  // themselves in on every deal — including ones with no second agent — while
  // additional_agent_name correctly stayed blank right beside it.
  it('is blank when there is no additional agent, name and date alike', () => {
    const vals = crmTokenValues({ agents: [{ name: 'Nic Madsen' }], today: '2026-08-18' })
    expect(vals.additional_agent_name).toBe('')
    expect(vals.additional_agent_date).toBe('')
  })

  it('is blank with no deal context at all', () => {
    expect(crmTokenValues({}).additional_agent_date).toBe('')
  })

  it('fills once a second agent is on the deal', () => {
    const agents = [{ name: 'Nic Madsen' }, { name: 'Dana Co' }]
    const vals = crmTokenValues({ agents, today: '2026-08-18' })
    expect(vals.additional_agent_name).toBe('Dana Co')
    expect(vals.additional_agent_date).toBe('08/18/2026')
  })

  it('fills from comp_data even with no second agent, when explicitly named there', () => {
    const deal = { comp_data: { additional_agent_name: 'Pat Broker', additional_agent_date: '2026-09-01' } }
    const vals = crmTokenValues({ deal, today: '2026-08-18' })
    expect(vals.additional_agent_name).toBe('Pat Broker')
    expect(vals.additional_agent_date).toBe('09/01/2026')
  })
})

// BoldSign renders an unfilled Label as the literal word "Label" ON THE PAGE. An
// Appointed Agency Agreement came back from a real send with "Label" printed on
// both lines where the client's name belongs.
// THE REPORTED FAILURE. An Appointed Agency Agreement went out with the literal
// word "Label" on both client-name lines while the brokerage and the appointed
// agent filled in correctly — because those two were named with separators and
// the client's Label was not. normalizeTokenKey only turns SEPARATORS into
// underscores, so "Client Name" matched and `ClientName` could never match.
describe('fieldTokenKey — a Label named the way a person would name it', () => {
  const vals = crmTokenValues({
    contact: { first_name: 'nic', last_name: 'madsen', type: 'buyer' },
    deal:    { comp_data: { transaction_type: 'buyer' } },
    agent:   { name: 'Daniel Stillson' },
    property:{ address: '79 Northshore Drive', city: 'Sioux City', state: 'IA' },
  })
  const fill = (name) => fieldTokenValue(vals, { id: 'Label1', name })

  it('matches with no separator at all — the case that failed', () => {
    for (const n of ['ClientName', 'clientname', 'CLIENTNAME', 'Client-Name']) {
      expect(fill(n), n).toBe('nic madsen')
    }
  })

  it('still matches the spellings that already worked', () => {
    expect(fill('client_name')).toBe('nic madsen')
    expect(fill('Client Name')).toBe('nic madsen')
    expect(fill('agent_name')).toBe('Daniel Stillson')
    expect(fill('Agent1NameLabel')).toBe('Daniel Stillson')
    expect(fill('property_address')).toBe('79 Northshore Drive')
  })

  it('drops a trailing Label/Field the author added to say what the thing is', () => {
    expect(fill('ClientNameLabel')).toBe('nic madsen')
    expect(fill('BuyerNameLabel')).toBe('nic madsen')
    expect(fill('PropertyAddressLabel')).toBe('79 Northshore Drive')
  })

  // client_2_name IS a token, so naming two Labels client_1_name / client_2_name
  // used to fill the second and leave the first blank, which reads as random.
  it('closes the client_1_name trap', () => {
    expect(fill('client_1_name')).toBe('nic madsen')
    expect(fill('client_2_name')).toBe('')      // genuinely no second client
  })

  it('accepts the obvious human words for the party', () => {
    for (const n of ['Client', 'Clients', 'Buyer Name', 'BuyerName', 'Purchaser']) {
      expect(fill(n), n).toBe('nic madsen')
    }
  })

  // The whole point of the strictness: an unnamed field must stay unnamed.
  it('still refuses a field nobody named', () => {
    for (const n of ['Label', 'Label1', 'CheckBox2', '', null]) {
      expect(fill(n), String(n)).toBe('')
    }
  })

  it('does not invent a match for an unrelated word', () => {
    for (const n of ['Witness', 'Notary', 'Escrow Officer']) {
      expect(fill(n), n).toBe('')
    }
  })
})

describe('emptyLabelsToRemove — an empty Label must not print "Label"', () => {
  const fields = [
    { id: 'Label1', type: 'label',   name: 'client_names' },
    { id: 'Label2', type: 'label',   name: 'agent_name' },
    { id: 'Label3', type: 'label' },                        // never named by anyone
    { id: 'Text1',  type: 'textbox', name: 'notes' },        // a signer's to fill
    { id: 'Chk1',   type: 'checkbox' },
  ]

  it('removes every Label going out blank, named or not', () => {
    expect(emptyLabelsToRemove({ fields, values: { Label2: 'Daniel Stillson' } }).sort())
      .toEqual(['Label1', 'Label3'])
  })

  it('keeps a Label that carries a value', () => {
    expect(emptyLabelsToRemove({ fields, values: { Label1: 'Jane Doe', Label2: 'D S', Label3: 'x' } }))
      .toEqual([])
  })

  // The distinction that matters: an empty Label is noise on the page, an empty
  // TEXTBOX is the signer's job. Removing the latter would take the form away
  // from the person meant to fill it in.
  it('never removes a field a signer is supposed to fill', () => {
    const out = emptyLabelsToRemove({ fields, values: {} })
    expect(out).not.toContain('Text1')
    expect(out).not.toContain('Chk1')
  })

  it('is empty rather than broken with nothing to work on', () => {
    expect(emptyLabelsToRemove()).toEqual([])
    expect(emptyLabelsToRemove({ fields: [], values: {} })).toEqual([])
  })
})

// Two causes look identical on the page and need different fixes, so they are
// reported apart. This is the gap that made a half-filled agreement read as "the
// CRM stopped pulling data over": the brokerage and agent names fill from a
// constant and the agent record, the client's name from the deal's contact.
describe('partyNameGaps — why the client line is blank', () => {
  const fields = [
    { id: 'Label1', type: 'label', name: 'client_names' },
    { id: 'Label2', type: 'label', name: 'agent_name' },
  ]

  it('names the party fields that resolved to nothing', () => {
    const g = partyNameGaps({ fields, values: { Label2: 'Daniel Stillson' } })
    expect(g.empty.map(f => f.id)).toEqual(['Label1'])
    expect(g.noneNamed).toBe(false)
  })

  it('says nothing when the client name came through', () => {
    expect(partyNameGaps({ fields, values: { Label1: 'Jane Doe', Label2: 'D S' } }).empty).toEqual([])
  })

  it('reports the other cause when no field asks for a party name at all', () => {
    // A template whose client lines were never named: nothing can ever fill them,
    // and no amount of linking contacts to the deal will change that.
    const g = partyNameGaps({ fields: [{ id: 'Label9', type: 'label' }], values: {} })
    expect(g.noneNamed).toBe(true)
    expect(g.empty).toEqual([])
  })

  it('counts an agent-only template as unnamed for the party, not as filled', () => {
    expect(partyNameGaps({ fields: [fields[1]], values: { Label2: 'D S' } }).noneNamed).toBe(true)
  })
})

describe('conditionalFieldsToRemove — fields with no second party to fill them', () => {
  it('flags Buyer2NameLabel-family and additional-agent fields only when their token is blank', () => {
    const fields = [
      { id: 'Buyer2NameLabel_2', type: 'Label' },
      { id: 'AdditionalAgentNameLabel', type: 'Label' },
      { id: 'AdditionalAgentDateLabel', type: 'Label' },
      { id: 'Buyer1NameLabel', type: 'Label' },
    ]
    const values = {
      Buyer2NameLabel_2: '', AdditionalAgentNameLabel: '', AdditionalAgentDateLabel: '',
      Buyer1NameLabel: 'Jane Doe',
    }
    expect(conditionalFieldsToRemove({ fields, values }).sort()).toEqual(
      ['AdditionalAgentDateLabel', 'AdditionalAgentNameLabel', 'Buyer2NameLabel_2'].sort()
    )
  })

  it('leaves a conditional field alone once it actually has a value', () => {
    const fields = [{ id: 'Buyer2NameLabel_2', type: 'Label' }]
    expect(conditionalFieldsToRemove({ fields, values: { Buyer2NameLabel_2: 'John Doe' } })).toEqual([])
  })

  it('never touches a field whose token is not one of the conditional ones', () => {
    const fields = [{ id: 'Buyer1NameLabel', type: 'Label' }]
    expect(conditionalFieldsToRemove({ fields, values: { Buyer1NameLabel: '' } })).toEqual([])
  })
})

describe('canonical Labels reach every signer, end to end', () => {
  // The four fields on the live test template, as BoldSign returns them.
  const fields = [
    { id: 'Agent1NameLabel', type: 'Label' },
    { id: 'Agent2NameLabel', type: 'Label' },
    { id: 'Buyer1NameLabel', type: 'Label' },
    { id: 'Buyer2NameLabel', type: 'Label' },
  ]
  const seed = (vals) => Object.fromEntries(fields.map(f => [f.id, fieldTokenValue(vals, f)]))

  const twoBuyers = crmTokenValues({
    deal:    { comp_data: { transaction_type: 'buyer' } },
    contact: { first_name: 'Jane', last_name: 'Buyer' },
    additionalContacts: [{ first_name: 'John', last_name: 'Buyer', email: 'john@x.com' }],
    agent:   { name: 'Nic Madsen' },
    agents:  [{ name: 'Nic Madsen' }, { name: 'Dana Co' }],
  })

  it('routes all four to sharedFormFields, not to any one signer', () => {
    const out = buildPrefillFields({ fields, values: seed(twoBuyers), filledRoleIndices: [1, 2] })
    expect(out.sharedFormFields).toEqual([
      { id: 'Agent1NameLabel', value: 'Nic Madsen', isReadOnly: true },
      { id: 'Agent2NameLabel', value: 'Dana Co',    isReadOnly: true },
      { id: 'Buyer1NameLabel', value: 'Jane Buyer', isReadOnly: true },
      { id: 'Buyer2NameLabel', value: 'John Buyer', isReadOnly: true },
    ])
    // Nothing lands on a role, which is what makes them visible to everyone
    // immediately rather than gated behind whoever signs first.
    expect(out.byRole).toEqual({})
    expect(out.signerScopedIds).toEqual([])
  })

  it('ACCEPTANCE: a single-buyer deal sends no Buyer2 field at all, not an empty one', () => {
    const oneBuyer = crmTokenValues({
      deal:    { comp_data: { transaction_type: 'buyer' } },
      contact: { first_name: 'Jane', last_name: 'Buyer' },
      agent:   { name: 'Nic Madsen' },
      agents:  [{ name: 'Nic Madsen' }],
    })
    const out = buildPrefillFields({ fields, values: seed(oneBuyer), filledRoleIndices: [1] })
    const ids = out.sharedFormFields.map(f => f.id)
    expect(ids).toEqual(['Agent1NameLabel', 'Buyer1NameLabel'])
    expect(ids).not.toContain('Buyer2NameLabel')
    expect(ids).not.toContain('Agent2NameLabel')
    // No entry means no empty string and no malformed field on the wire.
    expect(out.sharedFormFields.every(f => f.value)).toBe(true)
  })

  it('none of them trips the hidden-data audit, because a Label is common', () => {
    const values = seed(twoBuyers)
    expect(sharedDataOnSignerFields({ fields, values, firstSignerIndex: 1, inOrder: false })).toEqual([])
  })

  it('the same ids on a Name field are reported as a template defect', () => {
    // A Name field prints its own signer's name and discards ours, so this has
    // to be caught in the template rather than worked around in the payload.
    const broken = [{ id: 'Agent1NameLabel', type: 'Name', roleIndex: 1 }]
    expect(signerBoundPrefillFields({ fields: broken, values: {} })).toHaveLength(1)
    expect(prefillFieldEntry(broken[0], 'Nic Madsen')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IsReadOnly is not universally accepted
//
// Live failure, sending the IA Agency Packet:
//   "IsReadOnly property is not supported for the Signature, Initial,
//    Attachment, Date signed, Hyperlink, Title, Formula, Drawing and Company
//    form fields."
// It fails the WHOLE send, so one brokerage box took the entire packet down.
// ─────────────────────────────────────────────────────────────────────────────
describe('supportsReadOnly — the types BoldSign refuses to lock', () => {
  it('refuses every type BoldSign named in the error', () => {
    for (const t of ['Signature', 'Initial', 'Attachment', 'DateSigned', 'Hyperlink', 'Title', 'Formula', 'Drawing', 'Company']) {
      expect(supportsReadOnly(t)).toBe(false)
    }
  })

  it('matches however the type is spelled or spaced', () => {
    expect(supportsReadOnly('Date signed')).toBe(false)
    expect(supportsReadOnly('date_signed')).toBe(false)
    expect(supportsReadOnly('datesigned')).toBe(false)
    expect(supportsReadOnly('COMPANY')).toBe(false)
    // BoldSign reads Initial back under both spellings.
    expect(supportsReadOnly('Initials')).toBe(false)
  })

  it('leaves the types that DO take a lock alone', () => {
    for (const t of ['Textbox', 'TextBox', 'Label', 'Dropdown', 'CheckBox', 'RadioButton', 'EditableDate', 'Email']) {
      expect(supportsReadOnly(t)).toBe(true)
    }
  })

  it('the two reachable ones are offered as inputs on the send screen', () => {
    // Company and Title are offered as inputs, which is how a value ever reached
    // them and how this became a send-breaking bug rather than a theoretical one.
    expect(isFillableField('Company')).toBe(true)
    expect(isFillableField('Title')).toBe(true)
    expect(supportsReadOnly('Company')).toBe(false)
    expect(supportsReadOnly('Title')).toBe(false)
  })

  it('ALLOWLIST: an unknown or future field type is not locked', () => {
    // The point of the allowlist. A denylist would let a new BoldSign type
    // through and break the send exactly the way Signature and Company did.
    expect(supportsReadOnly('SomeFutureType')).toBe(false)
    expect(supportsReadOnly('Image')).toBe(false)
    expect(supportsReadOnly(undefined)).toBe(false)
    expect(supportsReadOnly('')).toBe(false)
  })

  it('covers every type we actually prefill, so nothing silently unlocks', () => {
    // Each fillable/tickable type is either lockable or one BoldSign refuses.
    // A type in neither bucket would be a value going out editable by accident.
    const refused = ['company', 'title']
    for (const t of [...FILLABLE_FIELD_TYPES, ...TICKABLE_FIELD_TYPES]) {
      expect(supportsReadOnly(t)).toBe(!refused.includes(t))
    }
  })
})

describe('prefillFieldEntry — the lock is conditional, the value is not', () => {
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

  it('REGRESSION: a Company field sends its value with NO isReadOnly key at all', () => {
    // Sent as `false` it would still be the unsupported property; BoldSign's
    // message is about presence, so it is omitted entirely.
    const entry = prefillFieldEntry({ id: 'BrokerageCompany', type: 'Company' }, 'Gateway Real Estate Advisors')
    expect(entry).toEqual({ id: 'BrokerageCompany', value: 'Gateway Real Estate Advisors' })
    expect(has(entry, 'isReadOnly')).toBe(false)
  })

  it('same for a Title field', () => {
    const entry = prefillFieldEntry({ id: 'AgentTitle', type: 'Title' }, 'Managing Broker')
    expect(entry).toEqual({ id: 'AgentTitle', value: 'Managing Broker' })
    expect(has(entry, 'isReadOnly')).toBe(false)
  })

  it('still locks every type that accepts a lock', () => {
    expect(prefillFieldEntry({ id: 'a', type: 'Textbox' }, 'x')).toEqual({ id: 'a', value: 'x', isReadOnly: true })
    expect(prefillFieldEntry({ id: 'b', type: 'Label' }, 'x')).toEqual({ id: 'b', value: 'x', isReadOnly: true })
    expect(prefillFieldEntry({ id: 'c', type: 'Dropdown' }, 'x')).toEqual({ id: 'c', value: 'x', isReadOnly: true })
    // A ticked box is a term of the agreement and stays locked.
    expect(prefillFieldEntry({ id: 'd', type: 'CheckBox' }, true)).toEqual({ id: 'd', value: 'true', isReadOnly: true })
    expect(prefillFieldEntry({ id: 'e', type: 'CheckBox' }, false)).toEqual({ id: 'e', value: 'false', isReadOnly: true })
  })

  it('the earlier rules are unchanged — a blank sends nothing, a Name sends nothing', () => {
    expect(prefillFieldEntry({ id: 'a', type: 'Company' }, '')).toBeNull()
    expect(prefillFieldEntry({ id: 'a', type: 'Company' }, '   ')).toBeNull()
    expect(prefillFieldEntry({ id: 'a', type: 'Name' }, 'Nic Madsen')).toBeNull()
    expect(prefillFieldEntry({ id: 'a', type: 'CheckBox' }, null)).toBeNull()
  })

  it('ACCEPTANCE: a packet mixing a Company box with locked fields builds a payload BoldSign accepts', () => {
    const fields = [
      { id: 'PropertyAddressLabel', type: 'Label' },
      { id: 'BrokerageCompany',     type: 'Company', roleIndex: 2 },
      { id: 'AgentTitle',           type: 'Title',   roleIndex: 2 },
      { id: 'agent_license',        type: 'Textbox', roleIndex: 2 },
    ]
    const values = {
      PropertyAddressLabel: '2212 Okoboji Ave',
      BrokerageCompany:     'Gateway Real Estate Advisors',
      AgentTitle:           'Managing Broker',
      agent_license:        'S-609',
    }
    const out = buildPrefillFields({ fields, values, filledRoleIndices: [1, 2] })

    // The Label is still shared and still locked.
    expect(out.sharedFormFields).toEqual([
      { id: 'PropertyAddressLabel', value: '2212 Okoboji Ave', isReadOnly: true },
    ])
    // The role-scoped ones carry their values; only the two BoldSign refuses to
    // lock go out unlocked.
    expect(out.byRole[2]).toEqual([
      { id: 'BrokerageCompany', value: 'Gateway Real Estate Advisors' },
      { id: 'AgentTitle',       value: 'Managing Broker' },
      { id: 'agent_license',    value: 'S-609', isReadOnly: true },
    ])
    // Nothing anywhere in the payload carries isReadOnly on an unsupported type.
    const all = [...out.sharedFormFields, ...Object.values(out.byRole).flat()]
    const typeOf = (id) => fields.find(f => f.id === id).type
    for (const entry of all) {
      if (has(entry, 'isReadOnly')) expect(supportsReadOnly(typeOf(entry.id))).toBe(true)
    }
  })
})

describe('sharedFormFields can only ever contain a lockable type', () => {
  // mergeSharedFormFields() in api/boldsign.js stamps isReadOnly: true on every
  // shared entry unconditionally, and it has no field type to check against.
  // That is only safe while buildPrefillFields() routes nothing but Labels into
  // that list, so the invariant is pinned here rather than left as a comment.
  it('routes only Label fields into the shared list', () => {
    const fields = [
      { id: 'a', type: 'Label' },
      { id: 'b', type: 'Company', roleIndex: 1 },
      { id: 'c', type: 'Title',   roleIndex: 1 },
      { id: 'd', type: 'Textbox', roleIndex: 1 },
      { id: 'e', type: 'CheckBox', roleIndex: 1 },
    ]
    const values = { a: 'x', b: 'x', c: 'x', d: 'x', e: true }
    const out = buildPrefillFields({ fields, values, filledRoleIndices: [1] })
    expect(out.sharedIds).toEqual(['a'])
    for (const id of out.sharedIds) {
      expect(isSharedField(fields.find(f => f.id === id).type)).toBe(true)
    }
  })

  it('and every shared type is one that accepts a lock', () => {
    // If a type is ever added to SHARED_FIELD_TYPES that BoldSign refuses,
    // mergeSharedFormFields would force the property onto it and break sends.
    for (const t of ['label']) expect(supportsReadOnly(t)).toBe(true)
  })
})

describe('isUnconfiguredField — what the send screen folds away', () => {
  it('hides a field with an auto id, no name, no label and no token', () => {
    expect(isUnconfiguredField({ id: 'Label1',       type: 'Label' })).toBe(true)
    expect(isUnconfiguredField({ id: 'Checkbox2',    type: 'CheckBox' })).toBe(true)
    expect(isUnconfiguredField({ id: 'Name3',        type: 'Name' })).toBe(true)
    expect(isUnconfiguredField({ id: 'EditableDate1', type: 'EditableDate' })).toBe(true)
    expect(isUnconfiguredField({ id: 'Label27',      type: 'Label' })).toBe(true)
  })

  it('KEEPS a field carrying a CRM token, however its id was assigned', () => {
    expect(isUnconfiguredField({ id: 'Agent1NameLabel', type: 'Label' })).toBe(false)
    expect(isUnconfiguredField({ id: 'agent_name',      type: 'Label' })).toBe(false)
    // The normal case: BoldSign minted the id, the admin put the token in the name.
    expect(isUnconfiguredField({ id: 'Label4', name: 'Buyer1NameLabel', type: 'Label' })).toBe(false)
  })

  it('KEEPS a hand-named field even when it matches no token', () => {
    // The name is the admin telling the agent what belongs there.
    expect(isUnconfiguredField({ id: 'Label9', name: 'Earnest money', type: 'Label' })).toBe(false)
    expect(isUnconfiguredField({ id: 'Label9', label: 'Closing date',  type: 'Label' })).toBe(false)
  })

  it('KEEPS an id that is not one of BoldSign auto-counter names', () => {
    expect(isUnconfiguredField({ id: 'ParcelNo', type: 'Label' })).toBe(false)
    expect(isUnconfiguredField({ id: 'Label',    type: 'Label' })).toBe(false)
  })

  it('folds away the bulk of a real agency packet but keeps what matters', () => {
    // The live "Buyer Agreement/IA Agency Packet (IA)" shape.
    const fields = [
      ...Array.from({ length: 27 }, (_, i) => ({ id: `Label${i + 1}`, type: 'Label' })),
      ...Array.from({ length: 14 }, (_, i) => ({ id: `Checkbox${i + 1}`, type: 'CheckBox' })),
      { id: 'Agent1NameLabel', type: 'Label' },
      { id: 'Agent2NameLabel', type: 'Label' },
      { id: 'Buyer1NameLevel', type: 'Label' },   // template typo, kept and visible
    ]
    const kept = fields.filter(f => !isUnconfiguredField(f))
    expect(kept.map(f => f.id)).toEqual(['Agent1NameLabel', 'Agent2NameLabel', 'Buyer1NameLevel'])
  })
})

describe('the expanded canonical vocabulary', () => {
  const ctx = {
    deal: {
      comp_data: { transaction_type: 'buyer', listing_start: '2026-08-01', listing_end: '2027-02-01' },
      expected_close_date: '2026-09-15', value: 450000, commission_pct: 3,
    },
    property: { address: '123 Main St', city: 'Ames', state: 'IA', zip: '50010', county: 'Story', mls_number: 'MLS-1', type: 'residential', price: 450000 },
    contact: { first_name: 'Daniel', last_name: 'Stilson' },
    agent:  { name: 'Daniel Stillson' },
    agents: [{ name: 'Daniel Stillson' }],
    today:  '2026-08-17',
  }
  const val = (id) => fieldTokenValue(crmTokenValues(ctx), { id })

  it('every id in the table has a real token behind it', () => {
    for (const token of Object.values(CANONICAL_LABEL_TOKENS)) {
      expect(SHARED_PREFILL_TOKENS.has(token)).toBe(true)
    }
  })

  it('fills property, money and party ids from the deal', () => {
    expect(val('PropertyAddressLabel')).toBe('123 Main St')
    expect(val('PropertyCityStateZipLabel')).toBe('Ames, IA 50010')
    expect(val('PropertyCountyLabel')).toBe('Story')
    expect(val('MlsNumberLabel')).toBe('MLS-1')
    expect(val('PurchasePriceLabel')).toBe('$450,000')
    expect(val('CommissionRateLabel')).toBe('3%')
    expect(val('Buyer1NameLabel')).toBe('Daniel Stilson')
    expect(val('Agent1NameLabel')).toBe('Daniel Stillson')
  })

  it('the retainer period is the deal representation window, as US dates', () => {
    expect(val('RetainerDate1')).toBe('08/01/2026')
    expect(val('RetainerDate2')).toBe('02/01/2027')
    // Both the bare spelling and the ...Label form, since the live packet used
    // the bare one.
    expect(val('RetainerDate1Label')).toBe('08/01/2026')
    expect(val('RetainerStartLabel')).toBe('08/01/2026')
    expect(val('ClosingDateLabel')).toBe('09/15/2026')
  })

  it('formats dates without letting a timezone move the day', () => {
    // `new Date('2026-08-01')` is midnight UTC, which is 31 July in the US.
    const vals = crmTokenValues({ deal: { expected_close_date: '2026-01-01' } })
    expect(vals.closing_date_us).toBe('01/01/2026')
  })

  it('city/state/zip degrades without a dangling comma when parts are missing', () => {
    expect(crmTokenValues({ property: { city: 'Ames' } }).property_city_state_zip).toBe('Ames')
    expect(crmTokenValues({ property: { state: 'IA', zip: '50010' } }).property_city_state_zip).toBe('IA 50010')
    expect(crmTokenValues({ property: {} }).property_city_state_zip).toBe('')
  })

  it('seller ids stay blank on a buyer deal, and swap over on a seller deal', () => {
    expect(val('Seller1NameLabel')).toBe('')
    const seller = { ...ctx, deal: { ...ctx.deal, comp_data: { ...ctx.deal.comp_data, transaction_type: 'seller' } } }
    expect(fieldTokenValue(crmTokenValues(seller), { id: 'Seller1NameLabel' })).toBe('Daniel Stilson')
    expect(fieldTokenValue(crmTokenValues(seller), { id: 'Buyer1NameLabel' })).toBe('')
  })

  it('agreement_date falls back to today only when the deal has no start date', () => {
    expect(val('AgreementDateLabel')).toBe('08/01/2026')
    const noStart = { ...ctx, deal: { ...ctx.deal, comp_data: { transaction_type: 'buyer' } } }
    expect(fieldTokenValue(crmTokenValues(noStart), { id: 'AgreementDateLabel' })).toBe('08/17/2026')
    // Pure: omit `today` and it is blank rather than whatever the clock says.
    expect(crmTokenValues({}).agreement_date).toBe('')
  })
})

describe('date fields get a picker, not a text box', () => {
  it('spots a date by BoldSign type or by the CRM token behind it', () => {
    expect(isDateField({ id: 'x', type: 'EditableDate' })).toBe(true)
    expect(isDateField({ id: 'RetainerDate1', type: 'Label' })).toBe(true)
    expect(isDateField({ id: 'ClosingDateLabel', type: 'Label' })).toBe(true)
    expect(isDateField({ id: 'OfferExpirationLabel', type: 'Label' })).toBe(true)
    expect(isDateField({ id: 'Buyer1NameLabel', type: 'Label' })).toBe(false)
    expect(isDateField({ id: 'Label7', type: 'Label' })).toBe(false)
  })

  it('round-trips between what the document shows and what the input speaks', () => {
    expect(usDateToIso('08/01/2026')).toBe('2026-08-01')
    expect(usDateToIso('8/1/2026')).toBe('2026-08-01')
    expect(isoDateToUs('2026-08-01')).toBe('08/01/2026')
    expect(isoDateToUs(usDateToIso('12/31/2027'))).toBe('12/31/2027')
  })

  it('returns blank rather than guessing at a partial date', () => {
    for (const bad of ['', '08/2026', 'next Tuesday', undefined, '2026-08-01']) {
      expect(usDateToIso(bad)).toBe('')
    }
    expect(isoDateToUs('not a date')).toBe('')
  })
})

describe('isUnconfiguredField — BoldSign echoes the id back as the name', () => {
  it('REGRESSION: name equal to the id is not somebody naming the field', () => {
    // BoldSign populates `name` with the auto id when nobody typed one, so
    // without this the rule matched almost nothing and the screen stayed long.
    expect(isUnconfiguredField({ id: 'Label7', name: 'Label7', type: 'Label' })).toBe(true)
    expect(isUnconfiguredField({ id: 'Checkbox2', name: 'checkbox2', type: 'CheckBox' })).toBe(true)
  })

  it('but a real name still keeps the field on screen', () => {
    expect(isUnconfiguredField({ id: 'Label7', name: 'Earnest money', type: 'Label' })).toBe(false)
  })

  it('a field carrying any canonical id is always shown', () => {
    for (const id of Object.keys(CANONICAL_LABEL_TOKENS)) {
      expect(isUnconfiguredField({ id, type: 'Label' })).toBe(false)
    }
  })
})

describe('per-deal agreement terms, stored in comp_data', () => {
  const withTerms = (terms = {}) => crmTokenValues({
    deal: { comp_data: { transaction_type: 'buyer', listing_start: '2026-08-01', ...terms }, value: 450000, commission_pct: 3 },
    property: { address: '123 Main St', city: 'Ames', county: 'Story', state: 'IA', zip: '50010' },
    agent: { name: 'Daniel Stillson' },
    agents: [{ name: 'Daniel Stillson' }, { name: 'Jane Co-Agent' }],
    today: '2026-08-17',
  })
  const val = (id, terms) => fieldTokenValue(withTerms(terms), { id })

  it('every canonical id resolves to a token that exists', () => {
    for (const [id, token] of Object.entries(CANONICAL_LABEL_TOKENS)) {
      expect(SHARED_PREFILL_TOKENS.has(token), `${id} -> ${token}`).toBe(true)
    }
  })

  it('reads buyer representation terms straight off the deal', () => {
    const terms = {
      protection_period_days: '180',
      property_types_sought:  'Residential, Condo, Acreage',
      search_area:            'Ames, Ankeny, Story County',
    }
    expect(val('ProtectionPeriodDaysLabel', terms)).toBe('180')
    expect(val('PropertyTypesSoughtLabel', terms)).toBe('Residential, Condo, Acreage')
    expect(val('SearchAreaLabel', terms)).toBe('Ames, Ankeny, Story County')
  })

  it('a term with nothing stored is blank, so the agent fills it once', () => {
    // Blank is the point: the field still renders as a named box on the send
    // screen, and starts filling itself the day the value lands on the deal.
    expect(val('ProtectionPeriodDaysLabel')).toBe('')
    expect(val('EarnestMoneyLabel')).toBe('')
    expect(val('TitleCompanyLabel')).toBe('')
  })

  it('search area falls back to the property city and county', () => {
    expect(val('SearchAreaLabel')).toBe('Ames, Story')
    expect(val('SearchAreaLabel', { search_area: 'Des Moines Metro' })).toBe('Des Moines Metro')
  })

  it('REGRESSION: compensation is two bare numbers, not a combined sentence', () => {
    // BrokerCompensationLabel used to write the whole clause ("3% of the gross
    // sales price"). A Buyer Agency form has its own wording around TWO
    // separate blanks, so the value now has to be a bare number for each.
    const pct = withTerms()   // the shared fixture is a 3% percentage deal
    expect(val('BrokerCompensationLabel')).toBe('')          // flat blank stays a bare blank on a percent deal
    expect(val('BrokerCompensationLabelPct')).toBe('3%')
  })

  it('the flat-fee blank stays truly BLANK on a percentage deal, not a computed equivalent', () => {
    // commission_amount ($13,500) is what 3% comes to in dollars on THIS deal —
    // exactly the number that must NOT appear on a "flat fee" line for a deal
    // that isn't one.
    expect(withTerms().commission_amount).toBe('$13,500')
    expect(val('BrokerCompensationLabel')).toBe('')
  })

  it('a flat-fee deal fills the flat blank and leaves the percentage blank', () => {
    const flat = crmTokenValues({ deal: { commission_type: 'flat', commission_flat: 5000 } })
    expect(flat.broker_compensation_flat).toBe('$5,000')
    expect(flat.commission_pct).toBe('')
  })

  it('no commission entered leaves both blank, rather than a misleading value', () => {
    const vals = crmTokenValues({ deal: {} })
    expect(vals.broker_compensation_flat).toBe('')
    expect(vals.commission_pct).toBe('')
  })

  it('comp_data can override the flat-fee blank for a packet that names a different figure', () => {
    expect(val('BrokerCompensationLabel', { broker_compensation_flat: '$2,500 processing fee' })).toBe('$2,500 processing fee')
  })

  it('BrokerCompensationLabelPct is commission_pct under another name, not a second value to keep in sync', () => {
    const vals = withTerms()
    expect(fieldTokenValue(vals, { id: 'BrokerCompensationLabelPct' })).toBe(fieldTokenValue(vals, { id: 'CommissionRateLabel' }))
    expect(fieldTokenValue(vals, { id: 'BrokerCompensationLabelPct' })).toBe('3%')
  })

  it('splits the agreement date into the three blanks a form prints', () => {
    expect(val('AgreementDayLabel')).toBe('1')
    expect(val('AgreementMonthLabel')).toBe('August')
    // Two digits: the form pre-prints "20", so a four-digit year reads "202026".
    expect(val('AgreementYearLabel')).toBe('26')
    expect(val('AgreementYearFullLabel')).toBe('2026')
    // And the whole date still agrees with its parts.
    expect(val('AgreementDateLabel')).toBe('08/01/2026')
  })

  it('the additional appointed agent defaults to the deal second agent', () => {
    expect(val('AdditionalAgentNameLabel')).toBe('Jane Co-Agent')
    expect(val('AdditionalAgentDateLabel')).toBe('08/01/2026')
    expect(val('AdditionalAgentNameLabel', { additional_agent_name: 'Pat Broker' })).toBe('Pat Broker')
  })

  it('formats every stored date the same way as the rest', () => {
    expect(val('PossessionDateLabel', { possession_date: '2026-10-01' })).toBe('10/01/2026')
    expect(val('ChangeEffectiveDateLabel', { change_effective_date: '2026-12-25' })).toBe('12/25/2026')
  })
})

describe('agreement term and end date', () => {
  const span = (start, end) => crmTokenValues({ deal: { comp_data: { listing_start: start, listing_end: end } } })
  const val = (id, start = '2026-08-17', end = '2027-08-17') => fieldTokenValue(span(start, end), { id })

  it('AgreementMonthLabel is the MONTH NAME, not a term length', () => {
    // Named for the "this __ day of ______, 20__" blank. Using it for a term
    // would print "for a term of August months".
    expect(val('AgreementMonthLabel')).toBe('August')
    expect(val('AgreementTermMonthsLabel')).toBe('12')
  })

  it('the end date has one value under every spelling', () => {
    for (const id of ['AgreementEndDateLabel', 'RetainerDate2', 'RetainerDate2Label', 'RetainerEndLabel']) {
      expect(val(id)).toBe('08/17/2027')
    }
    expect(val('AgreementStartDateLabel')).toBe('08/17/2026')
  })

  it('counts whole calendar months, not days divided', () => {
    expect(val('AgreementTermMonthsLabel', '2026-08-17', '2027-02-17')).toBe('6')
    expect(val('AgreementTermMonthsLabel', '2026-01-31', '2026-02-28')).toBe('')   // under one month
    // An end day earlier in the month has not completed that month.
    expect(val('AgreementTermMonthsLabel', '2026-08-17', '2027-08-15')).toBe('11')
    expect(val('AgreementTermMonthsLabel', '2026-08-17', '2027-08-18')).toBe('12')
  })

  it('is blank rather than wrong when a date is missing', () => {
    expect(crmTokenValues({}).agreement_term_months).toBe('')
    expect(val('AgreementTermMonthsLabel', '2026-08-17', '')).toBe('')
  })

  it('an explicitly stored term wins over the derived one', () => {
    const vals = crmTokenValues({ deal: { comp_data: { listing_start: '2026-08-17', listing_end: '2027-08-17', agreement_term_months: '18' } } })
    expect(vals.agreement_term_months).toBe('18')
  })
})

describe('repeated instances of the same logical field (_2, _3, ...)', () => {
  const ctx = {
    deal: { comp_data: { transaction_type: 'buyer', listing_start: '2026-08-17', listing_end: '2027-08-17' } },
    contact: { first_name: 'Daniel', last_name: 'Stilson' },
    property: { address: '123 Main St' },
    agent: { name: 'Nic Madsen' },
  }
  const val = (id) => fieldTokenValue(crmTokenValues(ctx), { id })

  it('a second instance resolves to the same value as the primary', () => {
    expect(val('Buyer1NameLabel')).toBe('Daniel Stilson')
    expect(val('Buyer1NameLabel_2')).toBe('Daniel Stilson')
    expect(val('Buyer1NameLabel_3')).toBe('Daniel Stilson')
  })

  it('works through the canonical alias table too, not just the CRM spelling', () => {
    expect(val('PropertyAddressLabel_2')).toBe('123 Main St')
    expect(val('Agent1NameLabel_2')).toBe('Nic Madsen')
  })

  it('REGRESSION: RetainerDate2 keeps its OWN meaning — never "instance 2 of RetainerDate1"', () => {
    // Exact/alias match is attempted before the suffix is ever stripped, so a
    // canonical id that legitimately ends in digits is never reinterpreted.
    expect(fieldTokenKey({ id: 'RetainerDate2' })).toBe('retainer_end_date')
    expect(fieldTokenKey({ id: 'RetainerDate1' })).toBe('retainer_start_date')
    // Even a repeat of RetainerDate2 itself keeps the same meaning.
    expect(fieldTokenKey({ id: 'RetainerDate2_2' })).toBe('retainer_end_date')
  })

  it('only an underscore+digits suffix counts — a bare trailing digit is not a repeat', () => {
    expect(fieldTokenKey({ id: 'Buyer1NameLabel2' })).toBe('')      // not authored this way
    expect(fieldTokenKey({ id: 'not_a_real_field_2' })).toBe('')
  })

  it('matches on name or label too, the same as the primary id does', () => {
    expect(fieldTokenKey({ id: 'Label14', name: 'Buyer1NameLabel_2' })).toBe('party_buyer_1')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// BOTH SIDES OF THE TABLE (migration 0040)
//
// The bug this guards, and it is the worst kind — pre-filled, plausible, and the
// wrong party on a signature line. A deal representing BOTH the buyer and the
// seller keeps two client sets, but the prefill drew from one flat list built
// from `deals.contact_id` plus the additional contacts. The other side's PRIMARY
// was not in that list at all, so a template whose roles read [Seller, Buyer]
// filled the Buyer row with whatever came next: a co-buyer if there was one, a
// co-OWNER if there wasn't. Same class of failure NON_CLIENT_ROLE_RE exists to
// stop in the agent slots, and a blank is always safer.
// ═════════════════════════════════════════════════════════════════════════════

const HOPE   = { first_name: 'Hope',   last_name: 'Cerda', email: 'hope@x.com' }      // buyer
const NATHAN = { first_name: 'Nathan', last_name: 'Miss',  email: 'nathan@x.com' }    // co-buyer
const JANET  = { first_name: 'Janet',  last_name: 'Hala',  email: 'janet@x.com' }     // seller
const JASON  = { first_name: 'Jason',  last_name: 'Beck',  email: 'jason@x.com' }     // co-owner
const BOTH   = { buyerClients: [HOPE, NATHAN], sellerClients: [JANET, JASON] }

describe('dealClientSides — two client sets, kept apart', () => {
  it('keeps each side in its own list, primary first', () => {
    const { buyer, seller } = dealClientSides(BOTH)
    expect(buyer.map(p => p.name)).toEqual(['Hope Cerda', 'Nathan Miss'])
    expect(seller.map(p => p.name)).toEqual(['Janet Hala', 'Jason Beck'])
  })

  it('puts the seller side first in the side-agnostic pool', () => {
    // The seller is the party the listing, title and price belong to — the same
    // rule the deal drawer uses to pick what `deals.contact_id` mirrors.
    expect(dealClientSides(BOTH).all.map(p => p.name))
      .toEqual(['Janet Hala', 'Jason Beck', 'Hope Cerda', 'Nathan Miss'])
  })

  it('never lists the same person twice, even filed on both sides', () => {
    const { all } = dealClientSides({ buyerClients: [JANET], sellerClients: [JANET] })
    expect(all.map(p => p.name)).toEqual(['Janet Hala'])
  })

  it('still honours a stored spouse name on a side with no co-party', () => {
    const { seller } = dealClientSides({ sellerClients: [{ ...JANET, spouse_name: 'Mr Hala' }] })
    expect(seller.map(p => p.name)).toEqual(['Janet Hala', 'Mr Hala'])
  })

  it('degrades to empty lists', () => {
    expect(dealClientSides()).toEqual({ buyer: [], seller: [], all: [] })
    expect(dealClientSides({ buyerClients: null, sellerClients: undefined })).toEqual({ buyer: [], seller: [], all: [] })
  })
})

describe('seedSignersFromDeal — a named side takes only that side', () => {
  const seed = (roles, extra = {}) => seedSignersFromDeal({ roles, ...BOTH, ...extra })

  it('REGRESSION: the Buyer row gets the buyer, not the next name in a flat list', () => {
    const out = seed([{ index: 1, name: 'Seller' }, { index: 2, name: 'Buyer' }])
    expect(out[1]).toEqual({ name: 'Janet Hala', email: 'janet@x.com' })
    expect(out[2]).toEqual({ name: 'Hope Cerda', email: 'hope@x.com' })
  })

  it('is not order-dependent — the same roles reversed still name the same parties', () => {
    // The old positional cursor gave a different (and sometimes correct) answer
    // depending on role order, which is why it never reproduced reliably.
    const out = seed([{ index: 1, name: 'Buyer' }, { index: 2, name: 'Seller' }])
    expect(out[1].name).toBe('Hope Cerda')
    expect(out[2].name).toBe('Janet Hala')
  })

  it('fills the co-party rows from their own side', () => {
    const out = seed([
      { index: 1, name: 'Seller 1' }, { index: 2, name: 'Seller 2' },
      { index: 3, name: 'Buyer 1' },  { index: 4, name: 'Buyer 2' },
    ])
    expect([out[1].name, out[2].name]).toEqual(['Janet Hala', 'Jason Beck'])
    expect([out[3].name, out[4].name]).toEqual(['Hope Cerda', 'Nathan Miss'])
  })

  it('leaves a blank rather than borrowing the other party when a side runs out', () => {
    const out = seedSignersFromDeal({
      roles: [{ index: 1, name: 'Seller' }, { index: 2, name: 'Buyer' }, { index: 3, name: 'Buyer 2' }],
      buyerClients: [HOPE], sellerClients: [JANET],
    })
    expect(out[3]).toEqual({ name: '', email: '' })
  })

  it('still never lets a client into an agent row', () => {
    // "Buyer's Agent" matches the buyer side AND the non-client veto; the veto wins.
    const out = seed([
      { index: 1, name: 'Seller' }, { index: 2, name: 'Listing Agent' }, { index: 3, name: "Buyer's Agent" },
    ], { activeAgent: { name: 'Daniel Stillson', email: 'daniel@gateway.com' }, dealAgents: [] })
    expect(out[1].name).toBe('Janet Hala')
    expect(out[2].name).toBe('Daniel Stillson')
    expect(out[3]).toEqual({ name: '', email: '' })
  })

  it('fills a side-agnostic role from whoever is not already signing', () => {
    const out = seed([{ index: 1, name: 'Seller' }, { index: 2, name: 'Buyer' }, { index: 3, name: 'Signer 3' }])
    // Janet and Hope are taken above; the next unclaimed person gets the generic row.
    expect(out[3].name).toBe('Jason Beck')
  })

  it('a generic-only template still fills from the shared pool, seller side first', () => {
    const out = seed([{ index: 1, name: 'Client 1' }, { index: 2, name: 'Client 2' }])
    expect([out[1].name, out[2].name]).toEqual(['Janet Hala', 'Jason Beck'])
  })

  it('leaves a ONE-SIDED deal exactly as it was', () => {
    // No per-side lists → the original flat, positional behavior, untouched.
    const roles = [{ index: 1, name: 'Seller' }, { index: 2, name: 'Seller 2' }]
    expect(seedSignersFromDeal({ roles, contact: JANET, additionalContacts: [JASON] }))
      .toEqual({
        1: { name: 'Janet Hala', email: 'janet@x.com' },
        2: { name: 'Jason Beck', email: 'jason@x.com' },
      })
  })
})

describe('party tokens on a both-sided deal', () => {
  const deal = { comp_data: { transaction_type: 'both' } }

  it('prints each party on the line that names them', () => {
    const v = crmTokenValues({ deal, ...BOTH })
    expect(v.party_seller_1).toBe('Janet Hala')
    expect(v.party_seller_2).toBe('Jason Beck')
    expect(v.party_buyer_1).toBe('Hope Cerda')
    expect(v.party_buyer_2).toBe('Nathan Miss')
    expect(v.buyer_1_name).toBe('Hope Cerda')
  })

  it('names every party on the side-agnostic parties line', () => {
    // The other side's primary used to be missing from this entirely.
    expect(crmTokenValues({ deal, ...BOTH }).client_names)
      .toBe('Janet Hala, Jason Beck, Hope Cerda and Nathan Miss')
  })

  it('still leaves the other side blank on a ONE-SIDED deal', () => {
    // The CRM stores nothing about the party across the table there, and a blank
    // the agent can see and fill beats a plausible wrong name.
    const v = crmTokenValues({ deal: { comp_data: { transaction_type: 'seller' } }, contact: JANET })
    expect(v.party_seller_1).toBe('Janet Hala')
    expect(v.party_buyer_1).toBe('')
    expect(v.buyer_1_name).toBe('')
  })
})
