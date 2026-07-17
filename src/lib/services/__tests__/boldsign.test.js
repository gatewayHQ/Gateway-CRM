import { describe, it, expect } from 'vitest'
import { buildTextTag, normalizeState, crmTokenValues, buildPrefill, isFillableField, seedSignersFromDeal } from '../boldsign.js'

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

  it('only fills the first agent role, not a second', () => {
    const roles = [{ index: 1, name: 'Agent' }, { index: 2, name: 'Co-Agent' }]
    const out = seedSignersFromDeal({ roles, contact: null, activeAgent: agent })
    expect(out[1]).toEqual({ name: 'Alex Agent', email: 'alex@brokerage.com' })
    expect(out[2]).toEqual({ name: '', email: '' })
  })
})
