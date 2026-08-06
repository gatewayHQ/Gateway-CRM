import { describe, it, expect, vi, beforeEach } from 'vitest'
import { boldsign, backoffMs, buildSignerPayload, requiresExplicitFieldPlacement, normalizeTemplateRoles, resolveOnBehalfOf, archivePath, listAllTemplates, isOwnSignedStorageUrl, createDraftEditUrl, isMissingLayoutStorage, normalizeFieldType, normalizeCapturedField, normalizeCapturedLayout, matchLayoutSigner, buildLayoutEditPayload } from '../boldsign.js'

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

describe('isOwnSignedStorageUrl — the send payload cannot become an SSRF', () => {
  const PROJECT = 'https://twgwemkihpwlgliftagg.supabase.co'
  const ok = `${PROJECT}/storage/v1/object/sign/deal-documents/deal-1111/contract.pdf?token=abc`

  it('accepts a signed deal-documents URL on our own project', () => {
    expect(isOwnSignedStorageUrl(ok, PROJECT)).toBe(true)
    expect(isOwnSignedStorageUrl(ok, `${PROJECT}/`)).toBe(true)   // trailing slash tolerated
  })

  it('rejects another host, including a look-alike prefix', () => {
    expect(isOwnSignedStorageUrl('https://evil.example.com/storage/v1/object/sign/deal-documents/x.pdf', PROJECT)).toBe(false)
    // Prefix-confusion: our project string appearing later in the URL.
    expect(isOwnSignedStorageUrl(`https://evil.example.com/?u=${PROJECT}/storage/v1/object/sign/deal-documents/x.pdf`, PROJECT)).toBe(false)
  })

  it('rejects internal / metadata targets', () => {
    expect(isOwnSignedStorageUrl('http://169.254.169.254/latest/meta-data/', PROJECT)).toBe(false)
    expect(isOwnSignedStorageUrl('http://localhost:3000/secret', PROJECT)).toBe(false)
    expect(isOwnSignedStorageUrl('file:///etc/passwd', PROJECT)).toBe(false)
  })

  it('rejects another bucket on our own project', () => {
    // form-packets holds blank templates; only deal documents are sendable here.
    expect(isOwnSignedStorageUrl(`${PROJECT}/storage/v1/object/sign/form-packets/IA/x.pdf`, PROJECT)).toBe(false)
    // A public (unsigned) object URL is not a signed one.
    expect(isOwnSignedStorageUrl(`${PROJECT}/storage/v1/object/public/deal-documents/x.pdf`, PROJECT)).toBe(false)
  })

  it('rejects non-strings without throwing', () => {
    for (const v of [null, undefined, 42, {}, []]) expect(isOwnSignedStorageUrl(v, PROJECT)).toBe(false)
  })
})

describe('archivePath — one document, one file', () => {
  const DEAL = '11111111-1111-1111-1111-111111111111'
  const DOC  = 'abcdef12-3456-7890-abcd-ef1234567890'

  it('is deterministic, so a webhook redelivery overwrites instead of duplicating', () => {
    const a = archivePath({ dealId: DEAL, documentId: DOC, baseName: 'Listing Agreement.pdf', kind: 'signed' })
    const b = archivePath({ dealId: DEAL, documentId: DOC, baseName: 'Listing Agreement.pdf', kind: 'signed' })
    expect(a).toBe(b)
    // The old scheme used Date.now(), so every retry wrote another copy.
    expect(a).not.toMatch(/\d{13}/)
  })

  it('gives two documents on the SAME deal different paths', () => {
    // This is the wrong-PDF bug: the UI matched "signed-" against the deal's
    // whole folder, so two documents resolved to the same file.
    const one = archivePath({ dealId: DEAL, documentId: DOC, baseName: 'Listing Agreement', kind: 'signed' })
    const two = archivePath({ dealId: DEAL, documentId: '99999999-0000-0000-0000-000000000000', baseName: 'Listing Agreement', kind: 'signed' })
    expect(one).not.toBe(two)
  })

  it('keeps the signed PDF and the audit trail apart', () => {
    const signed = archivePath({ dealId: DEAL, documentId: DOC, baseName: 'Disclosure', kind: 'signed' })
    const audit  = archivePath({ dealId: DEAL, documentId: DOC, baseName: 'Disclosure', kind: 'audit' })
    expect(signed).not.toBe(audit)
    expect(signed).toContain('/signed-')
    expect(audit).toContain('/audit-')
  })

  it('files it in the deal folder and stays a readable single-segment name', () => {
    const p = archivePath({ dealId: DEAL, documentId: DOC, baseName: '2117 Grand Ave — Listing/Agreement (final).pdf', kind: 'signed' })
    expect(p.startsWith(`deal-${DEAL}/`)).toBe(true)
    // Storage-hostile characters are stripped — notably the slash, which would
    // otherwise create a phantom subfolder the Documents tab never lists.
    expect(p.split('/')).toHaveLength(2)
    expect(p.endsWith('.pdf')).toBe(true)
  })

  it('survives a missing or junk document name', () => {
    expect(archivePath({ dealId: DEAL, documentId: DOC, baseName: '', kind: 'signed' })).toContain('signed-document-')
    expect(archivePath({ dealId: DEAL, documentId: DOC, baseName: '///', kind: 'signed' })).toContain('signed-document-')
    expect(archivePath({ dealId: DEAL, documentId: DOC, baseName: undefined, kind: 'audit' })).toContain('audit-document-')
  })
})

describe('listAllTemplates — pagination (the silent-deactivation bug)', () => {
  beforeEach(() => vi.restoreAllMocks())

  const page = (n) => okResp(JSON.stringify({ result: Array.from({ length: n }, (_, i) => ({ templateId: `t${i}` })) }))

  it('walks every page instead of stopping at the first 100', () => {
    // Reading page 1 only made the nightly sync believe templates 101+ were
    // deleted, and it deactivated their Form Library entries.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce(page(100))
      .mockResolvedValueOnce(page(7))
    vi.stubGlobal('fetch', fetchMock)
    return listAllTemplates().then(({ templates, complete }) => {
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(templates).toHaveLength(207)
      expect(complete).toBe(true)
    })
  })

  it('reports complete on a single short page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(12)))
    const { templates, complete } = await listAllTemplates()
    expect(templates).toHaveLength(12)
    expect(complete).toBe(true)
  })

  it('reports an empty account as complete (so nothing is inferred as deleted by accident)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(0)))
    const { templates, complete } = await listAllTemplates()
    expect(templates).toEqual([])
    expect(complete).toBe(true)
  })

  it('flags an unterminated walk as INCOMPLETE rather than looping forever', async () => {
    // Every page comes back full: the guard must trip and say so, because the
    // caller uses `complete` to decide whether deactivation is safe.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(page(100)))
    const { complete } = await listAllTemplates()
    expect(complete).toBe(false)
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

describe('createDraftEditUrl — getting an agent back into an abandoned draft', () => {
  beforeEach(() => vi.restoreAllMocks())

  const editResp = (url) => okResp(JSON.stringify({ editUrl: url }))
  // 400s are never retried by boldsign(), so these tests don't sleep.
  const status = (code, msg) => ({
    ok: false, status: code,
    text: () => Promise.resolve(JSON.stringify({ message: msg })),
    headers: { get: () => null },
  })

  it('opens the draft on the filling page, as the original sender', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn((url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) })
      return Promise.resolve(editResp('https://app.boldsign.com/edit/abc'))
    }))
    const url = await createDraftEditUrl({ documentId: 'doc 1', redirectUrl: 'https://crm/x', onBehalfOf: 'agent@x.com' })

    expect(url).toBe('https://app.boldsign.com/edit/abc')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/document/createEmbeddedEditUrl?documentId=doc%201')
    expect(calls[0].body).toMatchObject({
      // A draft MUST open on FillingPage — BoldSign refuses PreparePage outright
      // for a draft ("...because the document is in the draft state").
      sendViewOption:    'FillingPage',
      showSendButton:    true,
      showPreviewButton: true,
      redirectUrl:       'https://crm/x',
      onBehalfOf:        'agent@x.com',
    })
  })

  it('falls back to the other view option when BoldSign refuses this one', async () => {
    const views = []
    vi.stubGlobal('fetch', vi.fn((_u, opts) => {
      const view = JSON.parse(opts.body).sendViewOption
      views.push(view)
      // Mirror of the real refusal, with the states swapped — proves the fallback
      // is driven by BoldSign's answer, not by a hard-coded state→view guess.
      return Promise.resolve(view === 'FillingPage'
        ? status(400, "The embedded editing link cannot be generated when SendViewOption is set to 'FillingPage'.")
        : editResp('https://app.boldsign.com/edit/prep'))
    }))
    const url = await createDraftEditUrl({ documentId: 'd1' })

    expect(url).toBe('https://app.boldsign.com/edit/prep')
    expect(views).toEqual(['FillingPage', 'PreparePage'])
  })

  it('does not mistake a view-option refusal for an edit lock', async () => {
    const paths = []
    vi.stubGlobal('fetch', vi.fn((url, opts) => {
      paths.push(String(url).replace('https://api.boldsign.com/v1', '').split('?')[0])
      return Promise.resolve(JSON.parse(opts.body || '{}').sendViewOption === 'FillingPage'
        ? status(400, 'SendViewOption is not valid for this document')
        : editResp('https://app.boldsign.com/edit/prep'))
    }))
    await createDraftEditUrl({ documentId: 'd1' })
    // No cancelEditing — clearing an edit lock would not have fixed this, and
    // cancelling editing on someone else's in-flight session is not free.
    expect(paths).not.toContain('/document/cancelEditing')
  })

  it('honors a caller-specified view option first', async () => {
    const views = []
    vi.stubGlobal('fetch', vi.fn((_u, opts) => {
      views.push(JSON.parse(opts.body).sendViewOption)
      return Promise.resolve(editResp('https://app.boldsign.com/edit/x'))
    }))
    await createDraftEditUrl({ documentId: 'd1', sendViewOption: 'PreparePage' })
    expect(views).toEqual(['PreparePage'])
  })

  it('surfaces the last refusal when neither view option is accepted', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      status(400, 'SendViewOption cannot be used for this document')
    )))
    await expect(createDraftEditUrl({ documentId: 'd1' })).rejects.toThrow(/SendViewOption/)
  })

  it('clears a stale edit lock and retries — the closed-the-tab case', async () => {
    const paths = []
    vi.stubGlobal('fetch', vi.fn((url) => {
      paths.push(String(url).replace('https://api.boldsign.com/v1', '').split('?')[0])
      if (paths.length === 1) return Promise.resolve(status(400, 'Document is in edit mode'))
      if (paths.length === 2) return Promise.resolve(okResp())
      return Promise.resolve(editResp('https://app.boldsign.com/edit/retry'))
    }))
    const url = await createDraftEditUrl({ documentId: 'd1', onBehalfOf: 'agent@x.com' })

    expect(url).toBe('https://app.boldsign.com/edit/retry')
    expect(paths).toEqual([
      '/document/createEmbeddedEditUrl',
      '/document/cancelEditing',
      '/document/createEmbeddedEditUrl',
    ])
  })

  it('surfaces the retry\'s own refusal when the document really cannot be edited', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      n++
      if (n === 2) return Promise.resolve(okResp())                        // cancelEditing
      return Promise.resolve(status(400, 'Document is already sent'))       // both edit attempts
    }))
    await expect(createDraftEditUrl({ documentId: 'd1' })).rejects.toThrow(/already sent/)
  })

  it('reports the original error when the lock cannot be cleared', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => Promise.resolve(
      String(url).includes('cancelEditing')
        ? status(403, 'Not permitted')
        : status(400, 'Document is in edit mode')
    )))
    await expect(createDraftEditUrl({ documentId: 'd1' })).rejects.toThrow(/edit mode/)
  })

  it('omits onBehalfOf when there is no approved sender identity', async () => {
    let body
    vi.stubGlobal('fetch', vi.fn((_u, opts) => {
      body = JSON.parse(opts.body)
      return Promise.resolve(editResp('https://app.boldsign.com/edit/x'))
    }))
    await createDraftEditUrl({ documentId: 'd1' })
    expect(body.onBehalfOf).toBeUndefined()
    expect(body.redirectUrl).toBe('')
  })
})

// ─── Per-deal field layouts ───────────────────────────────────────────────────
const field = (over = {}) => ({
  id: 'f1', type: 'Signature', pageNumber: 2,
  bounds: { x: 100, y: 200, width: 180, height: 35 },
  isRequired: true, ...over,
})

describe('normalizeFieldType — read spelling → write enum', () => {
  it('passes through the types BoldSign accepts verbatim', () => {
    expect(normalizeFieldType('Signature')).toBe('Signature')
    expect(normalizeFieldType('DateSigned')).toBe('DateSigned')
  })

  it('maps the spellings BoldSign READS BACK but does not accept on write', () => {
    // Read as "Textbox", written as "TextBox". Unmapped, every text box an agent
    // placed would be dropped from the saved layout without a word.
    expect(normalizeFieldType('Textbox')).toBe('TextBox')
    expect(normalizeFieldType('initials')).toBe('Initial')
    expect(normalizeFieldType('editabledate')).toBe('EditableDate')
  })

  it('is case-insensitive', () => {
    expect(normalizeFieldType('CHECKBOX')).toBe('CheckBox')
  })

  it('returns null for a type it cannot re-create', () => {
    expect(normalizeFieldType('QuantumFlux')).toBeNull()
    expect(normalizeFieldType('')).toBeNull()
    expect(normalizeFieldType(undefined)).toBeNull()
  })
})

describe('normalizeCapturedField', () => {
  it('keeps type, page, bounds and the flags needed to re-create the field', () => {
    expect(normalizeCapturedField(field())).toEqual({
      id: 'f1', fieldType: 'Signature', pageNumber: 2,
      bounds: { x: 100, y: 200, width: 180, height: 35 },
      isRequired: true, isReadOnly: false,
    })
  })

  it('drops a field with no usable bounds rather than stacking it at (0,0)', () => {
    expect(normalizeCapturedField(field({ bounds: null }))).toBeNull()
    expect(normalizeCapturedField(field({ bounds: { x: 10, y: 10, width: 0, height: 20 } }))).toBeNull()
  })

  it('keeps x/y of 0 — a field at the page origin is legitimate', () => {
    const f = normalizeCapturedField(field({ bounds: { x: 0, y: 0, width: 100, height: 20 } }))
    expect(f.bounds).toEqual({ x: 0, y: 0, width: 100, height: 20 })
  })

  it('carries label, value and placeholder — the hand-typed content of a packet', () => {
    const f = normalizeCapturedField(field({ type: 'Textbox', label: 'County', value: 'Polk', placeholder: 'County' }))
    expect(f).toMatchObject({ fieldType: 'TextBox', label: 'County', value: 'Polk', placeHolder: 'County' })
  })

  it('omits a font outside BoldSign\'s enum, which would fail the whole request', () => {
    expect(normalizeCapturedField(field({ font: 'Comic Sans' })).font).toBeUndefined()
    expect(normalizeCapturedField(field({ font: 'Helvetica' })).font).toBe('Helvetica')
  })
})

describe('normalizeCapturedLayout', () => {
  const props = {
    signerDetails: [
      { id: 's1', signerRole: 'Seller', signerName: 'Curtis Epling', signerEmail: 'c@x.com', order: 1,
        formFields: [field(), field({ id: 'f2', type: 'Initial' })] },
      { id: 's2', signerRole: 'Listing Agent', signerEmail: 'a@x.com', order: 2,
        formFields: [field({ id: 'f3', type: 'Textbox' })] },
    ],
    commonFields: [field({ id: 'c1', type: 'Label' })],
  }

  it("captures every signer's fields, counting only what a restore can put back", () => {
    // 3 signer fields + 1 common field. Common fields are recorded but not
    // counted: /document/edit only accepts fields nested under a signer, so
    // counting them would promise the agent a field that never comes back.
    const { layout, fieldCount, dropped } = normalizeCapturedLayout(props)
    expect(fieldCount).toBe(3)
    expect(dropped).toBe(0)
    expect(layout.signers).toHaveLength(2)
    expect(layout.signers[0]).toMatchObject({ signerRole: 'Seller', signerEmail: 'c@x.com', order: 1 })
    expect(layout.signers[0].formFields.map(f => f.id)).toEqual(['f1', 'f2'])
    expect(layout.commonFields.map(f => f.fieldType)).toEqual(['Label'])
  })

  it('reports unrestorable fields instead of silently shrinking the layout', () => {
    const { fieldCount, dropped } = normalizeCapturedLayout({
      signerDetails: [{ id: 's1', formFields: [field(), field({ id: 'x', type: 'QuantumFlux' })] }],
    })
    expect(fieldCount).toBe(1)
    expect(dropped).toBe(1)
  })

  it('handles an empty or malformed properties payload without throwing', () => {
    expect(normalizeCapturedLayout({}).fieldCount).toBe(0)
    expect(normalizeCapturedLayout(null).fieldCount).toBe(0)
  })
})

describe('matchLayoutSigner — the saved arrangement finds the new document\'s signers', () => {
  const live = [
    { id: 'n1', signerRole: 'Seller', signerEmail: 'new-seller@x.com', order: 1 },
    { id: 'n2', signerRole: 'Listing Agent', signerEmail: 'agent@x.com', order: 2 },
  ]

  it('matches on ROLE first — the client changed, the role did not', () => {
    // This is the whole point: a listing packet re-sent to a different seller must
    // still put the seller's signature where the agent put it.
    const m = matchLayoutSigner({ signerRole: 'Seller', signerEmail: 'old-seller@x.com', order: 2 }, live)
    expect(m.id).toBe('n1')
  })

  it('falls back to email when the role is blank', () => {
    expect(matchLayoutSigner({ signerRole: '', signerEmail: 'agent@x.com' }, live).id).toBe('n2')
  })

  it('falls back to position when neither role nor email matches', () => {
    expect(matchLayoutSigner({ signerRole: 'Witness', signerEmail: 'w@x.com', order: 2 }, live).id).toBe('n2')
  })

  it('returns null rather than guessing when nothing lines up', () => {
    expect(matchLayoutSigner({ signerRole: 'Witness', order: 9 }, live)).toBeNull()
  })
})

describe('buildLayoutEditPayload — restoring a layout onto a fresh draft', () => {
  const savedLayout = {
    signers: [{
      signerRole: 'Seller', signerEmail: 'old@x.com', order: 1,
      formFields: [
        { id: 'tplSig', fieldType: 'Signature', pageNumber: 1, bounds: { x: 50, y: 60, width: 180, height: 35 } },
        { id: 'agentAdded', fieldType: 'Initial', pageNumber: 3, bounds: { x: 20, y: 30, width: 60, height: 25 } },
      ],
    }],
  }

  it('UPDATES a field the new draft already has, and ADDS one it lacks', () => {
    const payload = buildLayoutEditPayload({
      layout: savedLayout,
      signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: [{ id: 'tplSig' }] }],
    })
    expect(payload.signers).toHaveLength(1)
    expect(payload.signers[0]).toMatchObject({ editAction: 'Update', id: 'n1' })
    const byId = Object.fromEntries(payload.signers[0].formFields.map(f => [f.id, f]))
    expect(byId.tplSig.editAction).toBe('Update')       // reposition the template's own field
    expect(byId.agentAdded.editAction).toBe('Add')       // the initials the agent added last time
    expect(byId.agentAdded.bounds).toEqual({ x: 20, y: 30, width: 60, height: 25 })
  })

  it('REMOVES a template field the agent had deleted — it must not creep back', () => {
    const payload = buildLayoutEditPayload({
      layout: savedLayout,
      signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: [{ id: 'tplSig' }, { id: 'unwantedDate' }] }],
    })
    const removed = payload.signers[0].formFields.filter(f => f.editAction === 'Remove')
    expect(removed).toEqual([{ editAction: 'Remove', id: 'unwantedDate' }])
  })

  it('does NOT clobber a value the new draft already carries (fresh CRM prefill)', () => {
    // The saved copy of list_price is from the last send. Restoring it would
    // reprint a stale price on a live listing agreement.
    const layout = { signers: [{ signerRole: 'Seller', formFields: [
      { id: 'price', fieldType: 'TextBox', pageNumber: 1, bounds: { x: 1, y: 2, width: 80, height: 20 }, value: '$1,200,000' },
    ] }] }
    const payload = buildLayoutEditPayload({
      layout,
      signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: [{ id: 'price', value: '$1,350,000' }] }],
    })
    expect(payload.signers[0].formFields[0].value).toBe('$1,350,000')
  })

  it('DOES restore a saved value into a field the new draft left empty', () => {
    // The hand-typed label the CRM knows nothing about — the case the layout exists for.
    const layout = { signers: [{ signerRole: 'Seller', formFields: [
      { id: 'county', fieldType: 'TextBox', pageNumber: 1, bounds: { x: 1, y: 2, width: 80, height: 20 }, value: 'Polk' },
    ] }] }
    const payload = buildLayoutEditPayload({
      layout,
      signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: [{ id: 'county', value: '' }] }],
    })
    expect(payload.signers[0].formFields[0].value).toBe('Polk')
  })

  it('skips a saved signer that matches nobody instead of failing the whole apply', () => {
    const payload = buildLayoutEditPayload({
      layout: { signers: [
        { signerRole: 'Seller', order: 1, formFields: [{ id: 'a', fieldType: 'Signature', pageNumber: 1, bounds: { x: 1, y: 1, width: 10, height: 10 } }] },
        { signerRole: 'Witness', order: 7, formFields: [{ id: 'b', fieldType: 'Signature', pageNumber: 1, bounds: { x: 1, y: 1, width: 10, height: 10 } }] },
      ] },
      signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: [] }],
    })
    expect(payload.signers).toHaveLength(1)
    expect(payload.signers[0].id).toBe('n1')
  })

  it('returns null when there is nothing to apply, so no API call is made', () => {
    expect(buildLayoutEditPayload({ layout: { signers: [] } })).toBeNull()
    expect(buildLayoutEditPayload({})).toBeNull()
    expect(buildLayoutEditPayload({ layout: savedLayout, signerDetails: [] })).toBeNull()
  })
})

describe('isMissingLayoutStorage — un-migrated database is a provisioning state', () => {
  it('recognizes the missing table by code and by message', () => {
    expect(isMissingLayoutStorage({ code: '42P01', message: 'relation "deal_field_layouts" does not exist' })).toBe(true)
    expect(isMissingLayoutStorage({ message: "Could not find the table 'public.deal_field_layouts' in the schema cache" })).toBe(true)
  })

  it('does NOT swallow a real failure — those must still surface', () => {
    expect(isMissingLayoutStorage({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(false)
    expect(isMissingLayoutStorage({ message: 'permission denied for table deal_field_layouts' })).toBe(false)
    expect(isMissingLayoutStorage(null)).toBe(false)
  })
})
