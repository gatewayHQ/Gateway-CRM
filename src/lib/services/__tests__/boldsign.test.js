import { describe, it, expect } from 'vitest'
import { buildTextTag, normalizeState, crmTokenValues, buildPrefill, isFillableField } from '../boldsign.js'

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
