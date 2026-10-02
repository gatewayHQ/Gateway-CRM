import { describe, it, expect } from 'vitest'
import {
  checklistKindFor, checklistStateFor, checklistTemplate, checklistRows,
  STATE_DOC_TEMPLATES, DEFAULT_STEPS_COMMERCIAL, DEFAULT_STEPS_RESIDENTIAL,
} from '../checklistTemplates.js'

describe('checklistKindFor', () => {
  it('follows who the deal represents', () => {
    expect(checklistKindFor({ comp_data: { transaction_type: 'seller' } })).toBe('seller')
    expect(checklistKindFor({ comp_data: { transaction_type: 'both' } })).toBe('both')
    expect(checklistKindFor({ comp_data: { transaction_type: 'buyer' } })).toBe('buyer')
    expect(checklistKindFor({})).toBe('buyer')
  })
  it('uses the commercial list for a commercial deal, and lease for a lease', () => {
    expect(checklistKindFor({ prop_category: 'commercial', comp_data: { transaction_type: 'seller' } })).toBe('commercial')
    expect(checklistKindFor({ prop_category: 'commercial', comp_data: { transaction_type: 'lease' } })).toBe('lease')
  })
  it('keeps the agent’s own pick, which lives in its own field', () => {
    expect(checklistKindFor({ prop_category: 'commercial', comp_data: { checklist_type: 'seller', transaction_type: 'buyer' } })).toBe('seller')
    expect(checklistKindFor({ comp_data: { checklist_type: 'nonsense', transaction_type: 'seller' } })).toBe('seller')
  })
})

describe('checklistStateFor', () => {
  it('prefers the deal, then the property', () => {
    expect(checklistStateFor({ comp_data: { state: 'ia' } }, { state: 'NE' })).toBe('IA')
    expect(checklistStateFor({ comp_data: {} }, { state: 'NE' })).toBe('NE')
    expect(checklistStateFor({}, null)).toBe('')
  })
})

describe('checklistTemplate', () => {
  it('returns the state list when there is one', () => {
    expect(checklistTemplate('IA', 'seller')).toBe(STATE_DOC_TEMPLATES['IA-seller'])
    expect(checklistTemplate('sd', 'commercial')).toBe(STATE_DOC_TEMPLATES['SD-commercial'])
  })
  it('falls back to the generic list for the deal’s category', () => {
    expect(checklistTemplate('NE', 'commercial').map(s => s.title)).toEqual(DEFAULT_STEPS_COMMERCIAL)
    expect(checklistTemplate('MN', 'buyer').map(s => s.title)).toEqual(DEFAULT_STEPS_RESIDENTIAL)
    expect(checklistTemplate('IA', 'lease', 'commercial').map(s => s.title)).toEqual(DEFAULT_STEPS_COMMERCIAL)
  })
  it('gives a both-sides deal the seller and buyer lists, without repeats', () => {
    const titles = checklistTemplate('IA', 'both').map(s => s.title)
    expect(titles.length).toBe(new Set(titles).size)
    for (const t of STATE_DOC_TEMPLATES['IA-seller']) expect(titles).toContain(t.title)
    for (const t of STATE_DOC_TEMPLATES['IA-buyer'])  expect(titles).toContain(t.title)
  })
})

describe('checklistRows', () => {
  it('numbers the steps and starts them pending', () => {
    const rows = checklistRows('d1', [{ title: 'A', doc_action: 'upload' }, { title: 'B', if_applicable: true }])
    expect(rows).toEqual([
      { deal_id: 'd1', title: 'A', completed: false, sort_order: 0, doc_action: 'upload', doc_status: 'pending', if_applicable: false },
      { deal_id: 'd1', title: 'B', completed: false, sort_order: 1, doc_action: 'manual', doc_status: 'pending', if_applicable: true },
    ])
  })
})
