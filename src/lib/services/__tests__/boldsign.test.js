import { describe, it, expect } from 'vitest'
import { buildTextTag, normalizeState, crmTokenValues, buildPrefill, isFillableField, seedSignersFromDeal, sendableTemplates, normalizeBoldsignTemplates, resolveDealAgents, dealClientSigners, dealSide, roleKind } from '../boldsign.js'

describe('buildTextTag', () => {
  it('builds the {{fieldType|signerIndex|required|label|fieldId}} syntax', () => {
    expect(buildTextTag({ fieldType: 'Signature', signerIndex: 1, required: true, label: 'Sign', fieldId: 'seller_signature' }))
      .toBe('{{Signature|1|true|Sign|seller_signature}}')
  })
  it('defaults signerIndex to 1 and required to false', () => {
    expect(buildTextTag({ fieldType: 'Textbox', label: 'Address', fieldId: 'property_address' }))
      .toBe('{{Textbox|1|false|Address|property_address}}')
  })
})

describe('normalizeState', () => {
  it('passes through a 2-letter code', () => { expect(normalizeState('ia')).toBe('IA') })
  it('maps a full operating-state name to its code', () => {
    expect(normalizeState('Iowa')).toBe('IA')
    expect(normalizeState('south dakota')).toBe('SD')
    expect(normalizeState('Nebraska')).toBe('NE')
  })
  it('returns empty string for empty input', () => { expect(normalizeState('')).toBe('') })
})

describe('crmTokenValues + buildPrefill', () => {
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

  it('buildPrefill only includes known, non-empty tokens and locks them read-only', () => {
    const fields = buildPrefill(['property_address', 'agent_name', 'unknown_token'], ctx)
    expect(fields).toEqual([
      { id: 'property_address', value: '123 Main St', isReadOnly: true },
      { id: 'agent_name', value: 'Alex Agent', isReadOnly: true },
    ])
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

  it('leaves a second agent role blank when there is only one agent on the deal', () => {
    const roles = [{ index: 1, name: 'Agent' }, { index: 2, name: 'Co-Agent' }]
    const out = seedSignersFromDeal({ roles, contact: null, activeAgent: agent })
    expect(out[1]).toEqual({ name: 'Alex Agent', email: 'alex@brokerage.com' })
    expect(out[2]).toEqual({ name: '', email: '' })
  })

  it('fills BOTH agent roles when the deal has a co-agent', () => {
    const roles = [{ index: 1, name: 'Listing Agent' }, { index: 2, name: 'Co-Listing Agent' }]
    const agents = [agent, { name: 'Nic Madsen', email: 'nic@brokerage.com' }]
    const out = seedSignersFromDeal({ roles, contact: null, agents })
    expect(out[1]).toEqual({ name: 'Alex Agent', email: 'alex@brokerage.com' })
    expect(out[2]).toEqual({ name: 'Nic Madsen', email: 'nic@brokerage.com' })
  })

  it('seeds a full purchase-agreement packet on a buyer deal without touching the seller side', () => {
    // The exact role set that shipped in the screenshot report.
    const roles = [
      { index: 1, name: 'Buyer' },      { index: 2, name: 'Buyer Agent' },
      { index: 3, name: 'Co-buyer' },   { index: 4, name: 'Co-buyer agent' },
      { index: 5, name: 'Seller' },     { index: 6, name: 'Co-seller' },
      { index: 7, name: 'Listing agent' },
    ]
    const out = seedSignersFromDeal({
      roles, side: 'buyer',
      contact: { first_name: 'Jean', last_name: 'Irwin', email: 'jean@x.com' },
      additionalContacts: [{ first_name: 'Pat', last_name: 'Irwin', email: 'pat@x.com' }],
      agents: [{ name: 'Daniel Stillson', email: 'daniel@g.com' }, { name: 'Nic Madsen', email: 'nic@g.com' }],
    })
    expect(out[1]).toEqual({ name: 'Jean Irwin', email: 'jean@x.com' })
    expect(out[2]).toEqual({ name: 'Daniel Stillson', email: 'daniel@g.com' })
    expect(out[3]).toEqual({ name: 'Pat Irwin', email: 'pat@x.com' })
    expect(out[4]).toEqual({ name: 'Nic Madsen', email: 'nic@g.com' })
    // Never auto-fill the other side of the table.
    expect(out[5]).toEqual({ name: '', email: '' })
    expect(out[6]).toEqual({ name: '', email: '' })
    expect(out[7]).toEqual({ name: '', email: '' })
  })

  it('routes a seller deal to the seller rows', () => {
    const roles = [
      { index: 1, name: 'Buyer' }, { index: 2, name: 'Seller' },
      { index: 3, name: 'Co-seller' }, { index: 4, name: 'Listing Agent' },
    ]
    const out = seedSignersFromDeal({
      roles, side: 'seller', contact, agents: [agent],   // contact carries spouse_name
    })
    expect(out[1]).toEqual({ name: '', email: '' })                          // buyer row untouched
    expect(out[2]).toEqual({ name: 'Jane Seller', email: 'jane@x.com' })
    expect(out[3]).toEqual({ name: 'John Seller', email: '' })               // spouse, no email on file
    expect(out[4]).toEqual({ name: 'Alex Agent', email: 'alex@brokerage.com' })
  })

  it('falls back to side-agnostic roles when the template has none for our side', () => {
    const roles = [{ index: 1, name: 'Signer 1' }, { index: 2, name: 'Agent' }]
    const out = seedSignersFromDeal({ roles, side: 'buyer', contact, agents: [agent] })
    expect(out[1]).toEqual({ name: 'Jane Seller', email: 'jane@x.com' })
    expect(out[2]).toEqual({ name: 'Alex Agent', email: 'alex@brokerage.com' })
  })

  it('never invents more signers than the deal has people', () => {
    const roles = [{ index: 1, name: 'Buyer' }, { index: 2, name: 'Co-buyer' }]
    const out = seedSignersFromDeal({ roles, side: 'buyer', contact: { first_name: 'Solo', last_name: 'Buyer', email: 's@x.com' } })
    expect(out[2]).toEqual({ name: '', email: '' })
  })
})

describe('roleKind — classifying a template role', () => {
  it('splits agent rows from client rows and reads the side', () => {
    expect(roleKind('Buyer Agent')).toEqual({ party: 'agent', side: 'buyer' })
    expect(roleKind('Co-buyer agent')).toEqual({ party: 'agent', side: 'buyer' })
    expect(roleKind('Listing agent')).toEqual({ party: 'agent', side: '' })
    expect(roleKind('Co-seller')).toEqual({ party: 'client', side: 'seller' })
    expect(roleKind('Signer 1')).toEqual({ party: 'client', side: '' })
    expect(roleKind('Witness')).toEqual({ party: 'other', side: '' })
  })
  it('does not treat the broker-of-record row as the deal agent', () => {
    expect(roleKind('Broker').party).toBe('other')
  })
})

describe('resolveDealAgents — the deal agent + co-agents, in signing order', () => {
  const agents = [
    { id: 'a1', name: 'Daniel Stillson', email: 'daniel@g.com' },
    { id: 'a2', name: 'Nic Madsen',      email: 'nic@g.com' },
    { id: 'a3', name: 'Someone Else',    email: 'else@g.com' },
  ]

  it('puts the deal agent first and appends the property co-agents', () => {
    const out = resolveDealAgents({
      deal: { agent_id: 'a1' },
      property: { details: { co_agent_ids: ['a2'] } },
      agents,
    })
    expect(out.map(a => a.name)).toEqual(['Daniel Stillson', 'Nic Madsen'])
    expect(out[1].email).toBe('nic@g.com')
  })

  it('dedupes when the co-agent is also the deal agent', () => {
    const out = resolveDealAgents({ deal: { agent_id: 'a1' }, property: { details: { co_agent_ids: ['a1'] } }, agents })
    expect(out).toHaveLength(1)
  })

  it('honors a legacy deal-level co_agent_ids array', () => {
    const out = resolveDealAgents({ deal: { agent_id: 'a1', co_agent_ids: ['a2'] }, agents })
    expect(out.map(a => a.id)).toEqual(['a1', 'a2'])
  })

  it('drops co-agent ids that are not on the roster', () => {
    const out = resolveDealAgents({ deal: { agent_id: 'a1' }, property: { details: { co_agent_ids: ['gone'] } }, agents })
    expect(out.map(a => a.id)).toEqual(['a1'])
  })

  it('falls back to the acting agent only when the deal has no agent', () => {
    expect(resolveDealAgents({ deal: {}, agents, activeAgent: agents[2] }).map(a => a.id)).toEqual(['a3'])
    // …and does NOT substitute the viewer when the deal has its own agent.
    expect(resolveDealAgents({ deal: { agent_id: 'a1' }, agents, activeAgent: agents[2] }).map(a => a.id)).toEqual(['a1'])
  })
})

describe('dealClientSigners / dealSide', () => {
  it('orders primary, additional contacts, and dedupes by email', () => {
    const out = dealClientSigners({
      contact: { first_name: 'Jean', last_name: 'Irwin', email: 'jean@x.com' },
      additionalContacts: [
        { first_name: 'Pat', last_name: 'Irwin', email: 'pat@x.com' },
        { first_name: 'Jean', last_name: 'Irwin', email: 'JEAN@x.com' },   // same person, different case
      ],
    })
    expect(out).toEqual([
      { name: 'Jean Irwin', email: 'jean@x.com' },
      { name: 'Pat Irwin',  email: 'pat@x.com' },
    ])
  })

  it('keeps a party with no email so the UI can flag them', () => {
    const out = dealClientSigners({ contact: { first_name: 'No', last_name: 'Email' } })
    expect(out).toEqual([{ name: 'No Email', email: '' }])
  })

  it('reads the side off comp_data.transaction_type, and only buyer/seller', () => {
    expect(dealSide({ comp_data: { transaction_type: 'buyer' } })).toBe('buyer')
    expect(dealSide({ comp_data: { transaction_type: 'Seller' } })).toBe('seller')
    expect(dealSide({ comp_data: { transaction_type: 'lease' } })).toBe('')
    expect(dealSide({})).toBe('')
  })
})

describe('sendableTemplates — which Form Library rows can be sent for signature', () => {
  it('keeps rows with a boldsign template id and drops the rest', () => {
    const out = sendableTemplates([
      { name: 'Iowa Listing',  boldsign_template_id: 'tpl-1', state: 'IA', doc_type: 'listing' },
      { name: 'Plain Handout', boldsign_template_id: null },
      { name: 'Blank id',      boldsign_template_id: '   ' },
    ])
    expect(out.map(t => t.template_id)).toEqual(['tpl-1'])
    expect(out[0]).toMatchObject({ name: 'Iowa Listing', state: 'IA', doc_type: 'listing', source: 'library' })
  })

  it('drops deactivated packets but keeps rows where active is missing (pre-migration)', () => {
    const out = sendableTemplates([
      { name: 'Off',     boldsign_template_id: 'a', active: false },
      { name: 'On',      boldsign_template_id: 'b', active: true },
      { name: 'Unknown', boldsign_template_id: 'c' },
      { name: 'Null',    boldsign_template_id: 'd', active: null },
    ])
    expect(out.map(t => t.name)).toEqual(['Null', 'On', 'Unknown'])
  })

  it('accepts the retired boldsign_templates shape (template_id column)', () => {
    expect(sendableTemplates([{ name: 'Legacy', template_id: 'tpl-9', active: true }])[0])
      .toMatchObject({ template_id: 'tpl-9', name: 'Legacy' })
  })

  it('dedupes by template id, sorts by name, and defaults field_tokens to an array', () => {
    const out = sendableTemplates([
      { name: 'Zeta', boldsign_template_id: 'z' },
      { name: 'Alpha', boldsign_template_id: 'a', field_tokens: ['property_address'] },
      { name: 'Zeta copy', boldsign_template_id: 'z' },
    ])
    expect(out.map(t => t.name)).toEqual(['Alpha', 'Zeta'])
    expect(out[0].field_tokens).toEqual(['property_address'])
    expect(out[1].field_tokens).toEqual([])
  })

  it('tolerates junk input', () => {
    expect(sendableTemplates()).toEqual([])
    expect(sendableTemplates([null, undefined, {}])).toEqual([])
  })
})

describe('normalizeBoldsignTemplates — fallback list straight from BoldSign', () => {
  it('reads the varying id/name field names BoldSign returns', () => {
    const out = normalizeBoldsignTemplates([
      { templateId: 't1', templateName: 'Listing Agreement' },
      { documentId: 't2', documentName: 'Agency Disclosure' },
    ])
    expect(out).toEqual([
      { template_id: 't2', name: 'Agency Disclosure', state: '', doc_type: '', field_tokens: [], source: 'boldsign' },
      { template_id: 't1', name: 'Listing Agreement', state: '', doc_type: '', field_tokens: [], source: 'boldsign' },
    ])
  })
  it('skips entries with no id and tolerates junk', () => {
    expect(normalizeBoldsignTemplates([{ templateName: 'No id' }])).toEqual([])
    expect(normalizeBoldsignTemplates()).toEqual([])
  })
})
