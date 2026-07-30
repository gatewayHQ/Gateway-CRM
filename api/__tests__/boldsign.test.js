import { describe, it, expect, vi, beforeEach } from 'vitest'
import { boldsign, backoffMs, buildSignerPayload, requiresExplicitFieldPlacement, normalizeTemplateRoles, resolveOnBehalfOf, cleanupFailureAction, normalizeRolePayload, unremovableRolesError } from '../boldsign.js'

// Minimal chainable Supabase-client stub: .from(table).select(...).eq(col, val).maybeSingle()
// resolves { data } from `rows` keyed by `${col}=${val}`.
function fakeSupabase(rows) {
  return {
    from: () => {
      let lastEq = null
      const chain = {
        select: () => chain,
        eq: (col, val) => { lastEq = `${col}=${val}`; return chain },
        maybeSingle: () => Promise.resolve({ data: rows[lastEq] || null }),
      }
      return chain
    },
  }
}

const okResp  = (body = '{}') => ({ ok: true,  status: 200, text: () => Promise.resolve(body), headers: { get: () => null } })
const errResp = (status)      => ({ ok: false, status,      text: () => Promise.resolve('{"message":"boom"}'), headers: { get: () => null } })

describe('backoffMs', () => {
  it('honors Retry-After seconds, capped at 20s', () => {
    expect(backoffMs(0, 3)).toBe(3000)
    expect(backoffMs(0, 999)).toBe(20000)
  })
  it('grows exponentially within a jitter band', () => {
    const d0 = backoffMs(0, 0), d1 = backoffMs(1, 0), d2 = backoffMs(2, 0)
    expect(d0).toBeGreaterThanOrEqual(400); expect(d0).toBeLessThan(700)
    expect(d1).toBeGreaterThanOrEqual(800); expect(d1).toBeLessThan(1100)
    expect(d2).toBeGreaterThanOrEqual(1600); expect(d2).toBeLessThan(1900)
  })
})

describe('boldsign() retry + idempotency', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('retries a transient 5xx then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errResp(503))
      .mockResolvedValueOnce(okResp('{"documentId":"d1"}'))
    vi.stubGlobal('fetch', fetchMock)
    const data = await boldsign('/x', { method: 'POST', json: { a: 1 }, maxRetries: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(data.documentId).toBe('d1')
  })

  it('reuses a stable Idempotency-Key across write retries', async () => {
    const keys = []
    const fetchMock = vi.fn((_url, opts) => {
      keys.push(opts.headers['Idempotency-Key'])
      return Promise.resolve(keys.length < 2 ? errResp(500) : okResp())
    })
    vi.stubGlobal('fetch', fetchMock)
    await boldsign('/x', { method: 'POST', json: {}, maxRetries: 2 })
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBeTruthy()
    expect(keys[0]).toBe(keys[1])   // same key across the retry
  })

  it('does not attach an Idempotency-Key to GETs', async () => {
    let headers
    vi.stubGlobal('fetch', vi.fn((_u, o) => { headers = o.headers; return Promise.resolve(okResp()) }))
    await boldsign('/x', { method: 'GET' })
    expect(headers['Idempotency-Key']).toBeUndefined()
  })

  it('throws with status after exhausting retries', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(errResp(500))))
    await expect(boldsign('/x', { method: 'GET', maxRetries: 1 })).rejects.toMatchObject({ status: 500 })
  })
})

describe('buildSignerPayload — retired coordinate auto-placement', () => {
  it('never invents formFields when no tabs are given', () => {
    const [entry] = buildSignerPayload([{ name: 'Jane', email: 'jane@x.com', routingOrder: 1 }])
    expect(entry).toEqual({ name: 'Jane', emailAddress: 'jane@x.com', signerType: 'Signer', signerOrder: 1 })
    expect(entry.formFields).toBeUndefined()
  })

  it('honors explicit caller-supplied tabs verbatim (not guessed)', () => {
    const [entry] = buildSignerPayload([{
      name: 'Jane', email: 'jane@x.com', routingOrder: 1,
      tabs: [{ type: 'signature', page: 2, xPosition: 100, yPosition: 200, width: 150, height: 40, required: true }],
    }])
    expect(entry.formFields).toEqual([{
      id: 'f_1_1', fieldType: 'Signature', pageNumber: 2,
      bounds: { x: 100, y: 200, width: 150, height: 40 }, isRequired: true,
    }])
  })
})

describe('requiresExplicitFieldPlacement', () => {
  it('allows useTextTags with no per-signer fields', () => {
    expect(requiresExplicitFieldPlacement([{ name: 'A', email: 'a@x.com' }], true)).toBeNull()
  })
  it('allows explicit tabs on every signer', () => {
    expect(requiresExplicitFieldPlacement([{ name: 'A', email: 'a@x.com', tabs: [{ type: 'signature' }] }], false)).toBeNull()
  })
  it('rejects when neither useTextTags nor tabs are provided', () => {
    expect(requiresExplicitFieldPlacement([{ name: 'A', email: 'a@x.com' }], false)).toMatch(/retired/)
  })
  it('rejects when only SOME signers have tabs', () => {
    const signers = [{ name: 'A', email: 'a@x.com', tabs: [{ type: 'signature' }] }, { name: 'B', email: 'b@x.com' }]
    expect(requiresExplicitFieldPlacement(signers, false)).toMatch(/retired/)
  })
})

describe('normalizeTemplateRoles — fixes "Roles cannot be null or empty"', () => {
  it('defaults to a Seller/Listing-Agent pair when no roles are given', () => {
    expect(normalizeTemplateRoles(undefined)).toEqual([
      { name: 'Seller', index: 1 },
      { name: 'Listing Agent', index: 2 },
    ])
  })
  it('defaults for an empty array too', () => {
    expect(normalizeTemplateRoles([])).toHaveLength(2)
  })
  it('honors caller-supplied role names and assigns 1-based indices', () => {
    expect(normalizeTemplateRoles([{ name: 'Buyer' }, { name: "Buyer's Agent" }])).toEqual([
      { name: 'Buyer', index: 1 },
      { name: "Buyer's Agent", index: 2 },
    ])
  })
  it('trims names and falls back to a generic label for a blank one', () => {
    expect(normalizeTemplateRoles([{ name: '  Seller  ' }, { name: '' }])).toEqual([
      { name: 'Seller', index: 1 },
      { name: 'Signer 2', index: 2 },
    ])
  })
  it('honors an explicit index override', () => {
    expect(normalizeTemplateRoles([{ name: 'Witness', index: 5 }])).toEqual([{ name: 'Witness', index: 5 }])
  })
})

describe('resolveOnBehalfOf — agent identity with org-default fallback', () => {
  it("prefers the agent's own approved identity", async () => {
    const svc = fakeSupabase({ 'agent_id=a1': { email: 'agent@x.com', status: 'approved' } })
    expect(await resolveOnBehalfOf(svc, 'a1')).toBe('agent@x.com')
  })

  it("falls back to the org default when the agent's identity isn't approved", async () => {
    const svc = fakeSupabase({
      'agent_id=a1': { email: 'agent@x.com', status: 'pending' },
      'is_default=true': { email: 'default@x.com', status: 'approved' },
    })
    expect(await resolveOnBehalfOf(svc, 'a1')).toBe('default@x.com')
  })

  it('falls back to the org default when the agent has no identity at all', async () => {
    const svc = fakeSupabase({ 'is_default=true': { email: 'default@x.com', status: 'approved' } })
    expect(await resolveOnBehalfOf(svc, 'a1')).toBe('default@x.com')
  })

  it('returns null when neither the agent nor a default identity is approved', async () => {
    const svc = fakeSupabase({ 'is_default=true': { email: 'default@x.com', status: 'pending' } })
    expect(await resolveOnBehalfOf(svc, 'a1')).toBeNull()
  })

  it('returns null with no agentId and no default set', async () => {
    const svc = fakeSupabase({})
    expect(await resolveOnBehalfOf(svc, null)).toBeNull()
  })
})

describe('cleanupFailureAction — deleting a document from the Signatures tab', () => {
  it('lets a draft be removed no matter what BoldSign says', () => {
    // BoldSign rejects revoke on a never-sent document and delete on a draft,
    // so any failure has to be skippable or the row is undeletable.
    for (const status of [400, 401, 403, 404, 409, 500, undefined]) {
      expect(cleanupFailureAction(status, true)).toBe('skip')
    }
  })

  it('for an in-flight document, only skips "already gone / not in progress"', () => {
    expect(cleanupFailureAction(400, false)).toBe('skip')
    expect(cleanupFailureAction(404, false)).toBe('skip')
  })

  it('aborts an in-flight removal on any other error, so a live request is not forgotten', () => {
    expect(cleanupFailureAction(401, false)).toBe('throw')
    expect(cleanupFailureAction(500, false)).toBe('throw')
    expect(cleanupFailureAction(undefined, false)).toBe('throw')
  })
})

describe('normalizeRolePayload — "SignerName or SignerEmail is missing in roles"', () => {
  // The live failure: an 8-role IA packet, three rows filled from the deal.
  const TEMPLATE = [
    { index: 1, name: 'Buyer' },     { index: 2, name: 'Buyer Agent' },
    { index: 3, name: 'Co-buyer' },  { index: 4, name: 'Co-buyer agent' },
    { index: 5, name: 'Seller' },    { index: 6, name: 'Co-seller' },
    { index: 7, name: 'Listing agent' }, { index: 8, name: 'Co-listing agent' },
  ]
  const SENT = [
    { roleIndex: 5, roleName: 'Seller',            signerName: 'Jean Irwin',      signerEmail: 'irwinfam@tcaexpress.net' },
    { roleIndex: 7, roleName: 'Listing agent',     signerName: 'Daniel Stillson', signerEmail: 'daniel@gatewayreadvisors.com' },
    { roleIndex: 8, roleName: 'Co-listing agent',  signerName: 'Nic Madsen',      signerEmail: 'nic@gatewayreadvisors.com' },
  ]

  it('reports the five roles BoldSign would have rejected the send over', () => {
    const out = normalizeRolePayload({ roles: SENT, templateRoles: TEMPLATE, roleRemovalIndices: [1, 2, 3, 4, 6] })
    expect(out.roles).toHaveLength(3)
    expect(out.unfilled.map(u => u.name))
      .toEqual(['Buyer', 'Buyer Agent', 'Co-buyer', 'Co-buyer agent', 'Co-seller'])
  })

  it('passes a complete role set through with contiguous signerOrder', () => {
    const template = [{ index: 5, name: 'Seller' }, { index: 7, name: 'Listing agent' }]
    const out = normalizeRolePayload({ roles: SENT.slice(0, 2), templateRoles: template })
    expect(out.unfilled).toEqual([])
    // Template indices are preserved (they address the template's fields)...
    expect(out.roles.map(r => r.roleIndex)).toEqual([5, 7])
    // ...but signerOrder is 1..N, which is what BoldSign wants.
    expect(out.roles.map(r => r.signerOrder)).toEqual([1, 2])
  })

  it('treats a name without a valid email as unfilled — that IS the error condition', () => {
    const template = [{ index: 1, name: 'Seller' }, { index: 2, name: 'Listing agent' }]
    const out = normalizeRolePayload({
      roles: [
        { roleIndex: 1, signerName: 'Spouse With No Email', signerEmail: '' },
        { roleIndex: 2, signerName: 'Daniel', signerEmail: 'daniel@g.com' },
      ],
      templateRoles: template,
    })
    expect(out.roles.map(r => r.signerName)).toEqual(['Daniel'])
    expect(out.unfilled.map(u => u.name)).toEqual(['Seller'])
  })

  it('rejects a malformed email rather than letting BoldSign do it', () => {
    const out = normalizeRolePayload({
      roles: [{ roleIndex: 1, signerName: 'Typo', signerEmail: 'jean@@x' }],
      templateRoles: [{ index: 1, name: 'Seller' }],
    })
    expect(out.roles).toEqual([])
    expect(out.unfilled.map(u => u.name)).toEqual(['Seller'])
  })

  it('re-resolves a stale index by role name', () => {
    // The browser thought Listing agent was role 2; the template has it at 7.
    const out = normalizeRolePayload({
      roles: [{ roleIndex: 2, roleName: 'Listing agent', signerName: 'Daniel', signerEmail: 'd@g.com' }],
      templateRoles: [{ index: 7, name: 'Listing Agent' }],
    })
    expect(out.roles[0].roleIndex).toBe(7)
    expect(out.unfilled).toEqual([])
  })

  it('drops a role the template does not have instead of sending a bad index', () => {
    const out = normalizeRolePayload({
      roles: [{ roleIndex: 99, roleName: 'Ghost', signerName: 'X', signerEmail: 'x@y.com' }],
      templateRoles: [{ index: 1, name: 'Seller' }],
    })
    expect(out.roles).toEqual([])
  })

  it('keeps the first entry when two rows claim the same role', () => {
    const out = normalizeRolePayload({
      roles: [
        { roleIndex: 1, signerName: 'First',  signerEmail: 'a@x.com' },
        { roleIndex: 1, signerName: 'Second', signerEmail: 'b@x.com' },
      ],
      templateRoles: [{ index: 1, name: 'Seller' }],
    })
    expect(out.roles.map(r => r.signerName)).toEqual(['First'])
  })

  it('strips prefill fields with no id or an empty value', () => {
    const out = normalizeRolePayload({
      roles: [{
        roleIndex: 1, signerName: 'Jean', signerEmail: 'j@x.com',
        existingFormFields: [
          { id: 'property_address', value: '2212 Okoboji Ave', isReadOnly: true },
          { id: 'list_price', value: '' },
          { id: '', value: 'orphan' },
        ],
      }],
      templateRoles: [{ index: 1, name: 'Seller' }],
    })
    expect(out.roles[0].existingFormFields).toEqual([
      { id: 'property_address', value: '2212 Okoboji Ave', isReadOnly: true },
    ])
  })

  it('falls back to the caller removal list when the template roles are unavailable', () => {
    // template/properties failed — trust the client's own view rather than block.
    const out = normalizeRolePayload({ roles: SENT, templateRoles: [], roleRemovalIndices: [1, 2, 3, 4, 6] })
    expect(out.roles.map(r => r.roleIndex)).toEqual([5, 7, 8])
    expect(out.unfilled.map(u => u.index)).toEqual([1, 2, 3, 4, 6])
  })

  it('tolerates junk input', () => {
    expect(normalizeRolePayload()).toEqual({ roles: [], roleRemovalIndices: [], removeFormFields: [], unfilled: [] })
    expect(normalizeRolePayload({ roles: [null, {}] }).roles).toEqual([])
  })
})

describe('normalizeRolePayload — a subset send stays legal', () => {
  it('reports leftovers without implying the send must be blocked', () => {
    // Listing packet on a listing deal: buyer-side rows are legitimately empty
    // and go into roleRemovalIndices, which is how this has always worked.
    const out = normalizeRolePayload({
      roles: [
        { roleIndex: 5, roleName: 'Seller', signerName: 'Jean Irwin', signerEmail: 'j@x.com' },
        { roleIndex: 7, roleName: 'Listing agent', signerName: 'Daniel', signerEmail: 'd@g.com' },
      ],
      templateRoles: [
        { index: 1, name: 'Buyer' }, { index: 5, name: 'Seller' },
        { index: 7, name: 'Listing agent' },
      ],
    })
    expect(out.roles).toHaveLength(2)
    expect(out.roleRemovalIndices).toEqual([1])
    expect(out.unfilled.map(u => u.name)).toEqual(['Buyer'])
  })
})

describe('removal payload casing', () => {
  it('normalizeRolePayload returns the indices the caller must send under both spellings', () => {
    // The handler spreads these as roleRemovalIndices AND RoleRemovalIndices:
    // BoldSign documents PascalCase, and a case-sensitive binder silently drops
    // an unknown property, leaving every unused role in the send.
    const out = normalizeRolePayload({
      roles: [{ roleIndex: 1, roleName: 'Seller', signerName: 'Jean', signerEmail: 'j@x.com' }],
      templateRoles: [
        { index: 1, name: 'Seller' }, { index: 3, name: 'Co-seller' },
        { index: 5, name: 'Buyer' },
      ],
    })
    expect(out.roleRemovalIndices).toEqual([3, 5])
    expect(out.unfilled.map(u => u.name)).toEqual(['Co-seller', 'Buyer'])
  })
})

describe('normalizeRolePayload — removeFormFields (KB 21039)', () => {
  // The scenario from the live report: roleRemovalIndices alone kept failing
  // with "SignerName or SignerEmail is missing in roles" even though the CRM's
  // own bookkeeping was correct (the error named exactly the roles that were
  // supposed to be removed). The remaining explanation: the document's
  // Signature/Initial fields were still physically bound to those role indices,
  // so BoldSign saw fields with no signer behind them — the same error, a
  // different cause. removeFormFields is BoldSign's own mechanism for dropping
  // those fields, orthogonal to (and required alongside) role removal.
  const TEMPLATE_ROLES = [
    { index: 1, name: 'Seller' }, { index: 2, name: 'Listing agent' },
    { index: 3, name: 'Co-seller' }, { index: 4, name: 'Co-listing agent' },
    { index: 5, name: 'Buyer' }, { index: 6, name: 'Co-buyer' },
    { index: 7, name: 'Buyer agent' }, { index: 8, name: 'Co-buyer agent' },
  ]
  const TEMPLATE_FIELDS = [
    { id: 'f-seller-sig',    roleIndex: 1 },
    { id: 'f-agent-sig',     roleIndex: 2 },
    { id: 'f-coseller-sig',  roleIndex: 3 },
    { id: 'f-coagent-sig',   roleIndex: 4 },
    { id: 'f-buyer-sig',     roleIndex: 5 },
    { id: 'f-cobuyer-sig',   roleIndex: 6 },
    { id: 'f-buyeragent-sig',   roleIndex: 7 },
    { id: 'f-cobuyeragent-sig', roleIndex: 8 },
    { id: 'f-doc-date', roleIndex: null },   // unscoped — never removed
  ]
  const KEPT = [
    { roleIndex: 1, roleName: 'Seller',        signerName: 'Jean Irwin',      signerEmail: 'irwinfam@tcaexpress.net' },
    { roleIndex: 2, roleName: 'Listing agent', signerName: 'Daniel Stillson', signerEmail: 'daniel@gatewayreadvisors.com' },
    { roleIndex: 4, roleName: 'Co-listing agent', signerName: 'Nic Madsen',   signerEmail: 'nic@gatewayreadvisors.com' },
  ]

  it('collects the field ids owned by every removed role, and only those', () => {
    const out = normalizeRolePayload({ roles: KEPT, templateRoles: TEMPLATE_ROLES, templateFields: TEMPLATE_FIELDS })
    expect(out.roleRemovalIndices).toEqual([3, 5, 6, 7, 8])
    expect(out.removeFormFields.sort()).toEqual(
      ['f-coseller-sig', 'f-buyer-sig', 'f-cobuyer-sig', 'f-buyeragent-sig', 'f-cobuyeragent-sig'].sort()
    )
    // Fields belonging to KEPT roles, and unscoped fields, are never touched.
    expect(out.removeFormFields).not.toContain('f-seller-sig')
    expect(out.removeFormFields).not.toContain('f-agent-sig')
    expect(out.removeFormFields).not.toContain('f-coagent-sig')
    expect(out.removeFormFields).not.toContain('f-doc-date')
  })

  it('is empty when nothing is being removed', () => {
    const allRoles = TEMPLATE_ROLES.map(t => ({
      roleIndex: t.index, roleName: t.name, signerName: 'X', signerEmail: 'x@y.com',
    }))
    const out = normalizeRolePayload({ roles: allRoles, templateRoles: TEMPLATE_ROLES, templateFields: TEMPLATE_FIELDS })
    expect(out.unfilled).toEqual([])
    expect(out.removeFormFields).toEqual([])
  })

  it('is empty (not blocking) when templateFields is not supplied at all', () => {
    // fetchTemplateShape degrades to {roles:[], fields:[]} on a failed lookup —
    // this must never throw or block the send, only skip the extra safety net.
    const out = normalizeRolePayload({ roles: KEPT, templateRoles: TEMPLATE_ROLES })
    expect(out.roleRemovalIndices).toEqual([3, 5, 6, 7, 8])
    expect(out.removeFormFields).toEqual([])
  })

  it('ignores a field with no id and tolerates junk field entries', () => {
    const out = normalizeRolePayload({
      roles: KEPT, templateRoles: TEMPLATE_ROLES,
      templateFields: [{ roleIndex: 5 }, null, {}, { id: 'f-buyer-sig', roleIndex: 5 }],
    })
    expect(out.removeFormFields).toEqual(['f-buyer-sig'])
  })
})

describe('unremovableRolesError — the agent-facing message', () => {
  const unfilled = [{ index: 5, name: 'Buyer' }, { index: 7, name: 'Buyer Agent' }]

  it('names the refused roles and points at the template permission', () => {
    const out = unremovableRolesError(unfilled, 'SignerName or SignerEmail is missing in roles.')
    expect(out.error).toMatch(/Buyer, Buyer Agent/)
    expect(out.error).toMatch(/Delete this recipient/)
    expect(out.boldsign).toBe('SignerName or SignerEmail is missing in roles.')
    expect(out.unfilled).toBe(unfilled)
    expect(out.attempted).toBeUndefined()
  })

  it('notes that field removal was ALSO tried once norm is supplied with removeFormFields', () => {
    const norm = { roleRemovalIndices: [5, 7], removeFormFields: ['f-buyer-sig', 'f-buyeragent-sig'] }
    const out = unremovableRolesError(unfilled, 'boom', norm)
    expect(out.error).toMatch(/recipient AND its document fields/)
    expect(out.attempted).toEqual({ roleRemovalIndices: [5, 7], removeFormFields: ['f-buyer-sig', 'f-buyeragent-sig'] })
  })

  it('does not claim field removal was tried when removeFormFields came back empty', () => {
    const norm = { roleRemovalIndices: [5, 7], removeFormFields: [] }
    const out = unremovableRolesError(unfilled, 'boom', norm)
    expect(out.error).not.toMatch(/document fields/)
  })
})
