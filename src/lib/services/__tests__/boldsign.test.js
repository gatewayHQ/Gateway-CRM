import { describe, it, expect } from 'vitest'
import { describeTransportFailure, normalizeState, crmTokenValues, isFillableField, isTickableField, isPrefillableField, isSharedField, partitionPrefillFields, buildPrefillFields, sharedDataOnSignerFields, SHARED_PREFILL_TOKENS, dealClientList, joinNames, appointedAgent, tokenValueFor, fieldTokenValue, fieldTokenKey, prefillFieldEntry, seedSignersFromDeal, dealAgentList, orderAgentSigners, buildTemplateRoles } from '../boldsign.js'

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
    expect(partitionPrefillFields()).toEqual({ shared: [], signerSpecific: [] })
    expect(partitionPrefillFields([])).toEqual({ shared: [], signerSpecific: [] })
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

  it('says nothing about a field left blank — nothing is being hidden', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'list_price', type: 'Textbox', roleIndex: 2 }], values: {},
    })).toEqual([])
  })

  it('says nothing about a signer’s own input — a licence number is not shared data', () => {
    expect(sharedDataOnSignerFields({
      fields: [{ id: 'agent_license', type: 'Textbox', roleIndex: 2 }], values: { agent_license: 'S-60912' },
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
