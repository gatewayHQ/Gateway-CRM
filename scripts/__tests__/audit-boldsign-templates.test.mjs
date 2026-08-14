import { describe, it, expect } from 'vitest'
import { classifyField, auditTemplate } from '../audit-boldsign-templates.mjs'

// The two defects this sweep exists to find, plus the healthy shapes it must NOT
// report — a noisy audit is one nobody runs. Rationale for each rule:
// docs/boldsign-integration.md → "Prefilled data every signer must see".

describe('classifyField — Name fields used for somebody else', () => {
  it('THE DEFECT: a Name field carrying a CRM token prints the wrong name', () => {
    const v = classifyField({ id: 'Name1', name: 'agent_name', type: 'Name', roleIndex: 1 })
    expect(v.severity).toBe('wrong-name')
    expect(v.token).toBe('agent_name')
    expect(v.fix).toMatch(/Label/)
  })

  it('finds it however the token was spelled, and on any role', () => {
    expect(classifyField({ id: 'Name2', label: 'Client Names', type: 'Name', roleIndex: 2 }).severity).toBe('wrong-name')
    expect(classifyField({ id: 'seller_2_name', type: 'name', roleIndex: 1 }).severity).toBe('wrong-name')
  })

  it('leaves a plain Name field alone — that is the signer’s own name', () => {
    expect(classifyField({ id: 'Name9', type: 'Name', roleIndex: 1 }).severity).toBe('ok')
  })
})

describe('classifyField — values a party cannot see', () => {
  it('flags a CRM token on a role that is not the first signer', () => {
    const v = classifyField({ id: 'list_price', type: 'Textbox', roleIndex: 2 }, { firstRoleIndex: 1 })
    expect(v.severity).toBe('hidden')
    expect(v.fix).toMatch(/Label/)
  })

  it('flags a checkbox off the first signer — a pre-tick would be invisible', () => {
    expect(classifyField({ id: 'exclusive', type: 'CheckBox', roleIndex: 2 }, { firstRoleIndex: 1 }).severity).toBe('hidden')
  })

  it('downgrades to review on the first signer — correct, but order-dependent', () => {
    const v = classifyField({ id: 'list_price', type: 'Textbox', roleIndex: 1 }, { firstRoleIndex: 1 })
    expect(v.severity).toBe('review')
    expect(v.why).toMatch(/in-order/)
  })

  it('never complains about a Label, whatever role the template put it on', () => {
    expect(classifyField({ id: 'list_price', type: 'Label', roleIndex: 2 }).severity).toBe('ok')
  })

  it('says nothing about a field that is the signer’s own input', () => {
    expect(classifyField({ id: 'agent_license', type: 'Textbox', roleIndex: 2 }).severity).toBe('ok')
    expect(classifyField({ id: 'sig', type: 'Signature', roleIndex: 2 }).severity).toBe('ok')
  })

  it('treats a field naming no role as the first signer’s — it rides the anchor', () => {
    expect(classifyField({ id: 'list_price', type: 'Textbox', roleIndex: null }, { firstRoleIndex: 1 }).severity).toBe('review')
  })
})

describe('auditTemplate', () => {
  const TEMPLATE = {
    roles: [{ index: 1, name: 'Seller' }, { index: 2, name: 'Listing Agent' }],
    fields: [
      { id: 'Label1', name: 'property_full', type: 'Label',     roleIndex: 1, page: 1 },
      { id: 'Name1',  name: 'agent_name',    type: 'Name',      roleIndex: 1, page: 1 },
      { id: 'Text3',  name: 'list_price',    type: 'Textbox',   roleIndex: 2, page: 1 },
      { id: 'Check1', label: 'Exclusive',    type: 'CheckBox',  roleIndex: 2, page: 2 },
      { id: 'Sig1',   type: 'Signature', roleIndex: 1, page: 3 },
    ],
  }

  it('names the role each defect belongs to, so the fix is findable in the editor', () => {
    const rows = auditTemplate(TEMPLATE)
    const byId = Object.fromEntries(rows.map(r => [r.id, r]))
    expect(byId.Name1.severity).toBe('wrong-name')
    expect(byId.Name1.role).toBe('Seller')
    expect(byId.Text3.severity).toBe('hidden')
    expect(byId.Text3.role).toBe('Listing Agent')
    expect(byId.Check1.severity).toBe('hidden')
    expect(byId.Label1.severity).toBe('ok')
    expect(byId.Sig1.severity).toBe('ok')
  })

  it('derives the first signer from the lowest role index, not a hard-coded 1', () => {
    const rows = auditTemplate({
      roles:  [{ index: 2, name: 'Buyer' }, { index: 3, name: 'Agent' }],
      fields: [{ id: 'list_price', type: 'Textbox', roleIndex: 2, page: 1 }],
    })
    expect(rows[0].severity).toBe('review')
  })
})
