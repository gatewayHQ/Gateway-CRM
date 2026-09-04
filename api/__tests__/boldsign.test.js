import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'node:crypto'
import { boldsign, betaBase, sendDraftDocument, describeDraftSendFailure, backoffMs, verifyWebhookSignature, normalizeKnownStatus, shouldApplyStatus, buildSignerPayload, requiresExplicitFieldPlacement, normalizeTemplateRoles, mergeSharedFormFields, resolveOnBehalfOf, archivePath, listAllTemplates, isOwnSignedStorageUrl, createDraftEditUrl, isMissingLayoutStorage, formatByteSize, buildSigningSummary, buildPrintablePdf, optimizePdfLossless, fitForBoldSign, normalizeFieldType, normalizeCapturedField, normalizeCapturedLayout, matchLayoutSigner, buildLayoutEditPayload, canRemove, dealFilingName, applyFieldLayout, describeLayoutFailure, countPayloadFields, isFieldLevelRejection, supportsFieldReadOnly, isReadOnlyRejection, rolesWantSigningOrder, stripRoleReadOnly, stripLayoutReadOnly, collectFilledFields, resolveBoundsScale, boldsignPageSizes, isCheckedValue, startingFontSize, collectTemplateFieldIds, payloadFieldIds, buildSendOptions, appendSendOptions, normalizeCc, normalizeReminders, summarizeFieldValues, templateMatchesDocument } from '../boldsign.js'

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
    // A GET, or a write the caller has declared repeatable. A plain write is
    // NOT retried on a 5xx — see "a non-idempotent write is never blindly
    // retried" below for why.
    const data = await boldsign('/x', { method: 'GET', maxRetries: 3 })
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
    await boldsign('/x', { method: 'POST', json: {}, maxRetries: 2, idempotent: true })
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

describe('formatByteSize', () => {
  it('reads the way a person would say it', () => {
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(2048)).toBe('2 KB')
    expect(formatByteSize(5 * 1048576)).toBe('5.0 MB')
    expect(formatByteSize(null)).toBe('0 B')
  })
})

describe('optimizePdfLossless — shrink the container, never the content', () => {
  // A PDF built here rather than fixtured, so the test proves the real pdf-lib
  // round trip rather than a stub of it.
  const makePdf = async (pages = 30) => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib')
    const doc  = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < pages; i++) {
      const page = doc.addPage([612, 792])
      page.drawText(`EXCLUSIVE LISTING AGREEMENT — page ${i + 1}`, { x: 40, y: 720, size: 12, font })
    }
    return Buffer.from(await doc.save({ useObjectStreams: false }))
  }

  it('keeps the page count and the text — nothing is rasterized away', async () => {
    const original = await makePdf(12)
    const { buffer } = await optimizePdfLossless(original, 'listing.pdf')
    const { PDFDocument } = await import('pdf-lib')
    const reloaded = await PDFDocument.load(buffer)
    expect(reloaded.getPageCount()).toBe(12)
    // Same page geometry: no downscaling of the page box, which is how a
    // "compressed" PDF ends up looking soft when it is rendered back up to size.
    expect(reloaded.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
  })

  it('never returns something bigger than what it was given', async () => {
    const original = await makePdf(4)
    const { buffer, before, after } = await optimizePdfLossless(original, 'small.pdf')
    expect(after).toBeLessThanOrEqual(before)
    expect(buffer.length).toBe(after)
  })

  it('returns the original untouched when the bytes are not a readable PDF', async () => {
    const junk = Buffer.from('not a pdf at all')
    const { buffer, saved } = await optimizePdfLossless(junk, 'junk.pdf')
    expect(buffer).toBe(junk)     // same object — nothing was substituted
    expect(saved).toBe(0)
  })
})

describe('fitForBoldSign — a file too big is split, never re-compressed', () => {
  it('passes a normal file straight through, untouched', async () => {
    const small = Buffer.from('%PDF-1.7 tiny')
    const res = await fitForBoldSign(small, 'small.pdf')
    expect(res.buffer).toBe(small)
    expect(res.optimized).toBe(false)
  })

  it('refuses an oversized file with the sizes and the real remedy', async () => {
    // 26 MB of unreadable bytes: nothing to optimize, so it must fail loudly
    // rather than quietly degrading the page images — the exact operation that
    // produced the blurry packets in the first place.
    const huge = Buffer.alloc(26 * 1024 * 1024, 0x41)
    await expect(fitForBoldSign(huge, 'packet.pdf')).rejects.toThrow(/26\.0 MB.*25\.0 MB/s)
    await expect(fitForBoldSign(huge, 'packet.pdf')).rejects.toThrow(/Split the packet/)
    await expect(fitForBoldSign(huge, 'packet.pdf')).rejects.toMatchObject({ status: 400 })
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

describe('mergeSharedFormFields — Label values every signer sees at once', () => {
  // BoldSign hides a role-scoped field from every recipient except its own signer
  // until that signer finishes. A Label is a common field: prefilled through ONE
  // role's existingFormFields and visible to everyone immediately. This is where
  // the API guarantees that, whatever the caller supplied.
  const roles = () => ([
    { roleIndex: 1, signerName: 'Jean', signerEmail: 'jean@x.com', existingFormFields: [{ id: 'county', value: 'Dickinson', isReadOnly: true }] },
    { roleIndex: 2, signerName: 'Dan',  signerEmail: 'dan@x.com',  existingFormFields: [{ id: 'agent_license', value: 'S-609', isReadOnly: true }] },
  ])
  const shared = [{ id: 'property_full', value: '2212 Okoboji Ave' }, { id: 'list_price', value: '$1,350,000' }]

  it('puts every shared value on the FIRST role, read-only', () => {
    const out = mergeSharedFormFields(roles(), shared)
    expect(out[0].existingFormFields).toEqual([
      { id: 'county',        value: 'Dickinson',        isReadOnly: true },
      { id: 'property_full', value: '2212 Okoboji Ave', isReadOnly: true },
      { id: 'list_price',    value: '$1,350,000',       isReadOnly: true },
    ])
    expect(out[1].existingFormFields).toEqual([{ id: 'agent_license', value: 'S-609', isReadOnly: true }])
  })

  it('forces isReadOnly even when the caller omitted or contradicted it', () => {
    const out = mergeSharedFormFields(roles(), [{ id: 'ref_no', value: 'RE-1', isReadOnly: false }])
    expect(out[0].existingFormFields.at(-1)).toEqual({ id: 'ref_no', value: 'RE-1', isReadOnly: true })
  })

  it('strips a role-scoped copy of a shared id, so a per-signer value cannot shadow the Label', () => {
    const withDupe = roles()
    withDupe[1].existingFormFields.push({ id: 'list_price', value: 'WRONG', isReadOnly: true })
    const out = mergeSharedFormFields(withDupe, shared)
    expect(out[1].existingFormFields.map(f => f.id)).toEqual(['agent_license'])
    expect(out[0].existingFormFields.find(f => f.id === 'list_price').value).toBe('$1,350,000')
  })

  it('collapses a duplicated shared id rather than sending an ambiguous pair', () => {
    const out = mergeSharedFormFields(roles(), [{ id: 'ref_no', value: 'RE-1' }, { id: 'ref_no', value: 'RE-2' }])
    const refs = out[0].existingFormFields.filter(f => f.id === 'ref_no')
    expect(refs).toEqual([{ id: 'ref_no', value: 'RE-2', isReadOnly: true }])
  })

  it('is idempotent — re-running it on its own output changes nothing', () => {
    const once  = mergeSharedFormFields(roles(), shared)
    const twice = mergeSharedFormFields(once, shared)
    expect(twice).toEqual(once)
  })

  it('does not mutate the roles it was given', () => {
    const input = roles()
    mergeSharedFormFields(input, shared)
    expect(input[0].existingFormFields.map(f => f.id)).toEqual(['county'])
  })

  it('stringifies a value and drops an entry with no id', () => {
    const out = mergeSharedFormFields(roles(), [{ id: 'count', value: 3 }, { id: '  ' }, { value: 'orphan' }])
    expect(out[0].existingFormFields.at(-1)).toEqual({ id: 'count', value: '3', isReadOnly: true })
    expect(out[0].existingFormFields).toHaveLength(2)
  })

  it('returns the roles untouched when there is nothing shared to add', () => {
    const input = roles()
    expect(mergeSharedFormFields(input, [])).toBe(input)
    expect(mergeSharedFormFields(input, undefined)).toBe(input)
    expect(mergeSharedFormFields(input, null)).toBe(input)
  })

  it('survives an empty or missing roles array', () => {
    expect(mergeSharedFormFields([], shared)).toEqual([])
    expect(mergeSharedFormFields(undefined, shared)).toBeUndefined()
  })

  it('gives a single-role send its shared fields too', () => {
    const out = mergeSharedFormFields([{ roleIndex: 1, signerName: 'Solo', signerEmail: 's@x.com' }], shared)
    expect(out[0].existingFormFields.map(f => f.id)).toEqual(['property_full', 'list_price'])
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

describe('betaBase — draftSend lives on /v1-beta, and must stay in its region', () => {
  it('swaps the version segment on the default US base', () => {
    expect(betaBase('https://api.boldsign.com/v1')).toBe('https://api.boldsign.com/v1-beta')
  })
  it('keeps an EU account on its own host', () => {
    // The whole reason this is derived rather than hard-coded: an EU account's
    // documents must not be routed through the US host by a beta endpoint.
    expect(betaBase('https://api-eu.boldsign.com/v1')).toBe('https://api-eu.boldsign.com/v1-beta')
  })
  it('tolerates a trailing slash and an already-beta base', () => {
    expect(betaBase('https://api.boldsign.com/v1/')).toBe('https://api.boldsign.com/v1-beta')
    expect(betaBase('https://api.boldsign.com/v1-beta')).toBe('https://api.boldsign.com/v1-beta')
  })
  it('appends the version when the base has none', () => {
    expect(betaBase('https://api.boldsign.com')).toBe('https://api.boldsign.com/v1-beta')
  })
})

describe('sendDraftDocument — the one call that puts a document in front of a client', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('POSTs draftSend on the beta base, carrying the draft\'s own sender identity', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn((url, opts) => {
      calls.push({ url, method: opts.method })
      return Promise.resolve(okResp('{"documentId":"doc-1"}'))
    }))
    await sendDraftDocument({ documentId: 'doc 1', onBehalfOf: 'agent@x.com' })

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('POST')
    // /v1-beta, not /v1 — on /v1 BoldSign answers a bare 404.
    expect(calls[0].url).toContain('/v1-beta/document/draftSend')
    expect(calls[0].url).toContain('documentId=doc+1')
    expect(calls[0].url).toContain('onBehalfOf=agent%40x.com')
  })

  it('omits onBehalfOf entirely when there is no approved identity', async () => {
    let seen = ''
    vi.stubGlobal('fetch', vi.fn((url) => { seen = url; return Promise.resolve(okResp()) }))
    await sendDraftDocument({ documentId: 'doc-1' })
    expect(seen).not.toContain('onBehalfOf')
  })

  it('is NOT retried on a 5xx — a repeat is a second binding agreement in the inbox', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(errResp(500)))
    vi.stubGlobal('fetch', fetchMock)
    await expect(sendDraftDocument({ documentId: 'doc-1' })).rejects.toMatchObject({ status: 500 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports an UNKNOWN outcome when the connection dies mid-send', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('socket hang up'))))
    // Must not read as "nothing happened" — BoldSign may already have sent it.
    await expect(sendDraftDocument({ documentId: 'doc-1' })).rejects.toMatchObject({ indeterminate: true })
  })
})

describe('describeDraftSendFailure — a refusal an agent can act on', () => {
  const err = (status, message) => ({ status, message })

  it('names the rate limit and says the draft is untouched', () => {
    const msg = describeDraftSendFailure(err(429, 'Too many requests'))
    expect(msg).toMatch(/rate-limit/i)
    expect(msg).toMatch(/Nothing was sent/i)
  })

  it('points a missing-signer rejection at Edit Fields, keeping BoldSign\'s own words', () => {
    const msg = describeDraftSendFailure(err(400, 'SignerName or SignerEmail is missing in roles'))
    expect(msg).toMatch(/Edit Fields/)
    // BoldSign's text says WHICH problem; dropping it turns a one-look fix into guesswork.
    expect(msg).toContain('SignerName or SignerEmail is missing in roles')
  })

  it('explains a form-field rejection as unplaced fields', () => {
    expect(describeDraftSendFailure(err(400, 'Form field is invalid'))).toMatch(/signature field has been placed/i)
  })

  it('tells the agent to rebuild when BoldSign no longer has the draft', () => {
    expect(describeDraftSendFailure(err(404, 'Not found'))).toMatch(/rebuild it from the template/i)
  })

  it('passes an unrecognized message through rather than inventing one', () => {
    expect(describeDraftSendFailure(err(400, 'Labels exceed the maximum'))).toBe('Labels exceed the maximum')
  })

  it('never returns an empty string, even with nothing to go on', () => {
    expect(describeDraftSendFailure({})).toMatch(/BoldSign refused the send/)
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
      // The button whose absence made the whole flow a dead end: the editor
      // rendered no Save, so nothing typed there could reach
      // /document/properties — and everything the CRM composes is built from
      // that. Asserted so it cannot quietly go missing again.
      showSaveButton:    true,
      showSendButton:    true,
      showPreviewButton: true,
      redirectUrl:       'https://crm/x',
      onBehalfOf:        'agent@x.com',
    })
  })

  // The Save button is what makes the draft workflow work at all, but it is still
  // only a toolbar preference: an agent who cannot reopen their draft is a worse
  // outcome than one whose editor opens with the old toolbar.
  it('retries without the Save button if BoldSign refuses that option', async () => {
    const bodies = []
    vi.stubGlobal('fetch', vi.fn((_u, opts) => {
      const parsed = JSON.parse(opts.body)
      bodies.push(parsed)
      return Promise.resolve(parsed.showSaveButton
        ? status(400, "The ShowSaveButton option is not supported for this document.")
        : editResp('https://app.boldsign.com/edit/nosave'))
    }))
    const url = await createDraftEditUrl({ documentId: 'd1' })

    expect(url).toBe('https://app.boldsign.com/edit/nosave')
    expect(bodies).toHaveLength(2)
    expect(bodies[0].showSaveButton).toBe(true)
    expect(bodies[1]).not.toHaveProperty('showSaveButton')
    // Not mistaken for a stale edit lock — cancelEditing must never be called.
    expect(bodies.every(b => b.sendViewOption)).toBe(true)
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
    // No isReadOnly: the fixture is a Signature, and BoldSign refuses the
    // property on that type. See "IsReadOnly is not accepted on every type".
    expect(normalizeCapturedField(field())).toEqual({
      id: 'f1', fieldType: 'Signature', pageNumber: 2,
      bounds: { x: 100, y: 200, width: 180, height: 35 },
      isRequired: true,
    })
  })

  it('keeps isReadOnly on a type that accepts it', () => {
    expect(normalizeCapturedField(field({ type: 'Textbox', isReadOnly: true })).isReadOnly).toBe(true)
    expect(normalizeCapturedField(field({ type: 'Textbox', isReadOnly: false })).isReadOnly).toBe(false)
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

  it('names the fields it could not store, not just how many', () => {
    const { layout, dropped } = normalizeCapturedLayout({
      signerDetails: [{ id: 's1', formFields: [field(), field({ id: 'x', type: 'QuantumFlux' })] }],
      commonFields:  [field({ id: 'c9', type: 'AlsoUnknown' })],
    })
    expect(dropped).toBe(2)
    expect(layout.unrestorableIds).toEqual(['x', 'c9'])
  })

  it('always carries the list, even when nothing was lost', () => {
    // Presence is the marker that this layout can be reasoned about at all.
    expect(normalizeCapturedLayout(props).layout.unrestorableIds).toEqual([])
  })
})

// THE SEAM THAT HAD NO TEST. Capture and restore were each covered alone, on
// hand-written fixtures, and the bug lived in the space between them: capture
// dropped a type, restore read the gap as a deletion, and the field was gone.
// This drives a realistic /document/properties payload through both halves.
describe('capture → restore, on a packet full of types a capture cannot store', () => {
  // What an agency packet's signature block actually looks like: a signature, a
  // date, and the Name/Email/Phone fields BoldSign will not take back through
  // /document/edit — Name and Email are types this CRM handles all over
  // boldsignFields.js, so they are not exotic.
  const packet = {
    signerDetails: [{
      id: 's1', signerRole: 'Seller', signerEmail: 'seller@x.com', order: 1,
      formFields: [
        field({ id: 'sig1',   type: 'Signature' }),
        field({ id: 'date1',  type: 'DateSigned' }),
        field({ id: 'name1',  type: 'Name' }),
        field({ id: 'email1', type: 'Email' }),
        field({ id: 'phone1', type: 'Phone' }),
      ],
    }],
  }

  it('does not delete the signature block it could not store', () => {
    const { layout, fieldCount, dropped } = normalizeCapturedLayout(packet)
    // Two of the five survive the capture. That is the lossiness the restore has
    // to account for rather than act on.
    expect(fieldCount).toBe(2)
    expect(dropped).toBe(3)

    // The next prepare hands back a fresh draft carrying the template's full set.
    const payload = buildLayoutEditPayload({
      layout,
      signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: packet.signerDetails[0].formFields.map(f => ({ id: f.id })) }],
    })
    const removed = (payload?.signers?.[0]?.formFields || []).filter(f => f.editAction === 'Remove')
    expect(removed, 'a lossy capture must never delete what it could not represent').toEqual([])
  })

  it('is stable across repeated prepares rather than stripping the form each time', () => {
    // The ratchet: capture → restore → capture again. Before the fix the second
    // capture read a document three fields shorter than the first.
    let live = packet.signerDetails[0].formFields.map(f => ({ ...f }))
    for (let round = 0; round < 3; round++) {
      const { layout } = normalizeCapturedLayout({ signerDetails: [{ ...packet.signerDetails[0], formFields: live }] })
      const payload = buildLayoutEditPayload({
        layout, signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: live.map(f => ({ id: f.id })) }],
      })
      const removedIds = new Set((payload?.signers?.[0]?.formFields || [])
        .filter(f => f.editAction === 'Remove').map(f => String(f.id)))
      live = live.filter(f => !removedIds.has(String(f.id)))
    }
    expect(live.map(f => f.id)).toEqual(['sig1', 'date1', 'name1', 'email1', 'phone1'])
  })
})

// The one line between "filed on the deal" and "uploaded somewhere nobody looks".
// The Documents tab lists ONE FLAT PREFIX (`deal-<id>/`) and filters out anything
// that is a sub-folder, so a slash surviving into this name files the document a
// level down where it is invisible — which is exactly the shape composed document
// names have: `<template name> — <street line>`.
describe('dealFilingName', () => {
  it('strips the slash a composed packet name routinely carries', () => {
    const out = dealFilingName('Listing agreement/SD agency packet — 79 Northshore Drive')
    expect(out).not.toContain('/')
    expect(out).toBe('Listing-agreement-SD-agency-packet-79-Northshore-Drive-filled.pdf')
  })

  it('strips the em dash and spaces the name always has', () => {
    expect(dealFilingName('Buyer Agency — 123 Main St')).toBe('Buyer-Agency-123-Main-St-filled.pdf')
  })

  it('never doubles the extension', () => {
    expect(dealFilingName('disclosure.pdf')).toBe('disclosure-filled.pdf')
    expect(dealFilingName('disclosure.PDF')).toBe('disclosure-filled.pdf')
  })

  it('always yields a usable name, never an empty one', () => {
    for (const empty of [null, undefined, '', '   ', '///', '— —']) {
      expect(dealFilingName(empty), JSON.stringify(empty)).toBe('document-filled.pdf')
    }
  })

  it('cannot be walked out of the deal’s own folder', () => {
    expect(dealFilingName('../../etc/passwd')).toBe('etc-passwd-filled.pdf')
    expect(dealFilingName('../../../secret')).not.toContain('..')
  })

  it('stays readable — no runs of separators, none on either end', () => {
    const out = dealFilingName('  A  //  B —— C  ')
    expect(out).toBe('A-B-C-filled.pdf')
    expect(out).not.toMatch(/--/)
    expect(out).not.toMatch(/^[-._]/)
  })
})

describe('canRemove — the evidence a deletion needs', () => {
  it('refuses on a layout captured before unrestorableIds existed', () => {
    expect(canRemove({ signers: [] }, 'anything')).toBe(false)
    expect(canRemove(null, 'anything')).toBe(false)
  })

  it('refuses for an id the capture could not represent', () => {
    expect(canRemove({ unrestorableIds: ['name1'] }, 'name1')).toBe(false)
  })

  it('refuses for a sender-filled common field', () => {
    expect(canRemove({ unrestorableIds: [], commonFields: [{ id: 'listPrice' }] }, 'listPrice')).toBe(false)
  })

  it('allows a genuine deletion', () => {
    expect(canRemove({ unrestorableIds: [], commonFields: [] }, 'unwantedDate')).toBe(true)
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
    // Captured by a version that records what it could not store, so an absent
    // field really is an absent field. Without this the restore refuses to
    // delete anything — see the legacy test below.
    unrestorableIds: [],
  }

  it('UPDATES a field the new draft already has, and ADDS one it lacks', () => {
    const payload = buildLayoutEditPayload({
      layout: savedLayout,
      signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: [{ id: 'tplSig' }] }],
    })
    expect(payload.signers).toHaveLength(1)
    expect(payload.signers[0]).toMatchObject({ editAction: 'Update', id: 'n1' })
    const fields = payload.signers[0].formFields
    // The template's own field is addressed by id; the one the agent added last time
    // is re-created by NAME, because to BoldSign an id means "this already exists".
    expect(fields.find(f => f.id === 'tplSig').editAction).toBe('Update')
    const added = fields.find(f => f.editAction === 'Add')
    expect(added.name).toBe('agentAdded')
    expect(added.id).toBeUndefined()
    expect(added.bounds).toEqual({ x: 20, y: 30, width: 60, height: 25 })
  })

  it('REMOVES a template field the agent had deleted — it must not creep back', () => {
    const payload = buildLayoutEditPayload({
      layout: savedLayout,
      signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: [{ id: 'tplSig' }, { id: 'unwantedDate' }] }],
    })
    const removed = payload.signers[0].formFields.filter(f => f.editAction === 'Remove')
    expect(removed).toEqual([{ editAction: 'Remove', id: 'unwantedDate' }])
  })

  // THE BUG THIS FILE SHIPPED WITH. Absence from the saved layout was read as
  // "the agent deleted it", but a capture cannot store a Name/Email/Phone field,
  // so every one of them was deleted from the next draft on a 200 that reported
  // success. On an agency packet that is the signature block.
  it('does NOT remove a field the capture could not store', () => {
    const lossy = {
      ...savedLayout,
      unrestorableIds: ['sellerName', 'sellerPhone'],
    }
    const payload = buildLayoutEditPayload({
      layout: lossy,
      signerDetails: [{
        id: 'n1', signerRole: 'Seller',
        formFields: [{ id: 'tplSig' }, { id: 'sellerName' }, { id: 'sellerPhone' }, { id: 'unwantedDate' }],
      }],
    })
    const removed = payload.signers[0].formFields.filter(f => f.editAction === 'Remove').map(f => f.id)
    // The genuine deletion still goes; the two we simply could not represent stay.
    expect(removed).toEqual(['unwantedDate'])
  })

  // Our own sends put every Label on the anchor signer, so these are the common
  // case. They are captured into `commonFields` and never into `signers`, which
  // made all of them look deleted to a check that only read `signers`.
  it('does NOT remove a sender-filled common field', () => {
    const withCommon = {
      ...savedLayout,
      commonFields: [{ id: 'listPrice', fieldType: 'Label', pageNumber: 1, bounds: { x: 1, y: 2, width: 80, height: 20 } }],
    }
    const payload = buildLayoutEditPayload({
      layout: withCommon,
      signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: [{ id: 'tplSig' }, { id: 'listPrice' }] }],
    })
    expect(payload.signers[0].formFields.filter(f => f.editAction === 'Remove')).toEqual([])
  })

  // Every row already in the database was written without unrestorableIds. It
  // cannot tell loss from deletion, so it gets no say: a stale field creeping
  // back is a nuisance, a deleted signature block is a broken agreement.
  it('removes NOTHING from a layout captured before this was recorded', () => {
    const { unrestorableIds, ...legacy } = savedLayout
    const payload = buildLayoutEditPayload({
      layout: legacy,
      signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: [{ id: 'tplSig' }, { id: 'unwantedDate' }] }],
    })
    expect(payload.signers[0].formFields.filter(f => f.editAction === 'Remove')).toEqual([])
    // …and it still restores, which is the point of not simply disabling the feature.
    expect(payload.signers[0].formFields.some(f => f.editAction === 'Update')).toBe(true)
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

  it('ADDS a field under a NAME, never the saved id — an id means "this already exists"', () => {
    // The bug: a checkbox the agent added by hand last time ('CheckBox2') does not
    // exist on a draft built fresh from the template, and sending its old id made
    // BoldSign reject the entire request:
    //   "The document does not have a form field with the ID: 'CheckBox2' …"
    const payload = buildLayoutEditPayload({
      layout: savedLayout,
      signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: [{ id: 'tplSig' }] }],
    })
    const added = payload.signers[0].formFields.find(f => f.editAction === 'Add')
    expect(added.id).toBeUndefined()
    expect(added.name).toBe('agentAdded')
    // The field that DOES exist is still addressed by its id.
    const updated = payload.signers[0].formFields.find(f => f.editAction === 'Update')
    expect(updated.id).toBe('tplSig')
  })

  it('keeps a captured name over the id when both are present', () => {
    const layout = { signers: [{ signerRole: 'Seller', formFields: [
      { id: 'oldId', name: 'Buyer initials', fieldType: 'Initial', pageNumber: 1, bounds: { x: 1, y: 2, width: 30, height: 20 } },
    ] }] }
    const payload = buildLayoutEditPayload({ layout, signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: [] }] })
    expect(payload.signers[0].formFields[0]).toMatchObject({ editAction: 'Add', name: 'Buyer initials' })
  })

  it('confirmedOnly drops the Adds and keeps what BoldSign already holds', () => {
    // The fallback for an atomic rejection: better most of the arrangement than none.
    const signerDetails = [{ id: 'n1', signerRole: 'Seller', formFields: [{ id: 'tplSig' }, { id: 'stray' }] }]
    const full      = buildLayoutEditPayload({ layout: savedLayout, signerDetails })
    const confirmed = buildLayoutEditPayload({ layout: savedLayout, signerDetails, confirmedOnly: true })
    expect(countPayloadFields(full)).toBe(3)        // Update + Add + Remove
    expect(countPayloadFields(confirmed)).toBe(2)   // Update + Remove — the Add is gone
    expect(confirmed.signers[0].formFields.some(f => f.editAction === 'Add')).toBe(false)
  })

  it('returns null when there is nothing to apply, so no API call is made', () => {
    expect(buildLayoutEditPayload({ layout: { signers: [] } })).toBeNull()
    expect(buildLayoutEditPayload({})).toBeNull()
    expect(buildLayoutEditPayload({ layout: savedLayout, signerDetails: [] })).toBeNull()
  })
})

describe('applyFieldLayout — the request BoldSign actually accepts', () => {
  beforeEach(() => vi.restoreAllMocks())

  // One saved layout, one matching signer on the new draft. Enough to produce a
  // real /document/edit payload so the transport is what's under test.
  const savedRows = {
    'template_id=tpl1': {
      field_count: 2,
      layout: { signers: [{ signerRole: 'Seller', order: 1, formFields: [
        { id: 'sig', fieldType: 'Signature', pageNumber: 1, bounds: { x: 10, y: 20, width: 180, height: 35 } },
        { id: 'ini', fieldType: 'Initial',   pageNumber: 2, bounds: { x: 10, y: 20, width: 60,  height: 25 } },
      ] }] },
    },
  }
  const draftProps = (fieldCount = 2) => JSON.stringify({
    signerDetails: [{ id: 'n1', signerRole: 'Seller', formFields: Array.from({ length: fieldCount }, (_, i) => ({ id: `f${i}` })) }],
  })

  it('sends the edit as PUT — a POST is what returned 405 and lost every layout', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn((url, opts) => {
      calls.push(`${opts.method || 'GET'} ${String(url).replace(/^https:\/\/api\.boldsign\.com/, '')}`)
      return Promise.resolve(okResp(String(url).includes('/document/properties') ? draftProps() : '{}'))
    }))

    const res = await applyFieldLayout(fakeSupabase(savedRows), {
      documentId: 'd1', dealId: 'deal1', templateId: 'tpl1',
    })
    expect(res.applied).toBe(true)
    expect(calls).toContain('PUT /v1/document/edit?documentId=d1')
    expect(calls.filter(c => c.startsWith('POST'))).toHaveLength(0)
  })

  it('reports the applied count BoldSign confirms, not the count we hoped for', async () => {
    // The draft comes back with 3 fields; the saved row said 2. What the agent is
    // told has to be what is really on the document.
    let seenProps = 0
    vi.stubGlobal('fetch', vi.fn((url) => Promise.resolve(
      String(url).includes('/document/properties')
        ? okResp(draftProps(++seenProps === 1 ? 2 : 3))
        : okResp('{}'))))

    const res = await applyFieldLayout(fakeSupabase(savedRows), {
      documentId: 'd1', dealId: 'deal1', templateId: 'tpl1',
    })
    expect(res).toEqual({ applied: true, fieldCount: 3 })
  })

  it('does not claim success when the draft comes back with no fields at all', async () => {
    let seenProps = 0
    vi.stubGlobal('fetch', vi.fn((url) => Promise.resolve(
      String(url).includes('/document/properties')
        ? okResp(++seenProps === 1 ? draftProps(2) : JSON.stringify({ signerDetails: [{ id: 'n1', formFields: [] }] }))
        : okResp('{}'))))

    const res = await applyFieldLayout(fakeSupabase(savedRows), {
      documentId: 'd1', dealId: 'deal1', templateId: 'tpl1',
    })
    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/no fields/i)
  })

  it('degrades to the template defaults — never throws — when BoldSign refuses', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => Promise.resolve(
      String(url).includes('/document/properties') ? okResp(draftProps()) : errResp(403))))

    const res = await applyFieldLayout(fakeSupabase(savedRows), {
      documentId: 'd1', dealId: 'deal1', templateId: 'tpl1',
    })
    expect(res.applied).toBe(false)
    expect(res.reason).toMatch(/permission/i)
  })

  it('retries without the unplaceable field instead of losing the whole arrangement', async () => {
    // BoldSign rejects the request as a WHOLE over one field it cannot place. The
    // second attempt keeps every field it does hold.
    const bodies = []
    const rejectOnce = { ok: false, status: 400, headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ message: "The document does not have a form field with the ID: 'CheckBox2'." })) }
    vi.stubGlobal('fetch', vi.fn((url, opts) => {
      if (String(url).includes('/document/properties')) return Promise.resolve(okResp(draftProps()))
      bodies.push(JSON.parse(opts.body))
      return Promise.resolve(bodies.length === 1 ? rejectOnce : okResp('{}'))
    }))

    // unrestorableIds present and empty: this capture lost nothing, so f1's
    // absence really is the agent having deleted it and the Remove is genuine.
    const layout = { unrestorableIds: [], signers: [{ signerRole: 'Seller', order: 1, formFields: [
      { id: 'f0',        fieldType: 'Signature', pageNumber: 1, bounds: { x: 1, y: 2, width: 80, height: 20 } },
      { id: 'CheckBox2', fieldType: 'CheckBox',  pageNumber: 1, bounds: { x: 9, y: 9, width: 12, height: 12 } },
    ] }] }
    const res = await applyFieldLayout(fakeSupabase({ 'template_id=tpl1': { field_count: 2, layout } }), {
      documentId: 'd1', dealId: 'deal1', templateId: 'tpl1',
    })

    expect(res.applied).toBe(true)
    expect(res.partial).toBe(true)
    expect(res.skipped).toBe(1)
    expect(res.reason).toMatch(/could not be re-created/)
    // The retry dropped the Add and kept the field BoldSign holds.
    expect(bodies).toHaveLength(2)
    expect(countPayloadFields(bodies[0])).toBe(3)   // Update f0 + Add CheckBox2 + Remove f1
    expect(countPayloadFields(bodies[1])).toBe(2)   // the Add is dropped, the rest survives
    expect(bodies[1].signers[0].formFields.some(f => f.editAction === 'Add')).toBe(false)
    expect(bodies[1].signers[0].formFields[0]).toMatchObject({ editAction: 'Update', id: 'f0' })
  })

  it('does not retry a failure that is not about a single field', async () => {
    let edits = 0
    vi.stubGlobal('fetch', vi.fn((url) => {
      if (String(url).includes('/document/properties')) return Promise.resolve(okResp(draftProps()))
      edits++
      return Promise.resolve(errResp(403))
    }))
    const res = await applyFieldLayout(fakeSupabase(savedRows), { documentId: 'd1', dealId: 'deal1', templateId: 'tpl1' })
    expect(res.applied).toBe(false)
    expect(edits).toBe(1)
  })

  it('skips the API call entirely when the deal has nothing saved', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResp('{}')))
    vi.stubGlobal('fetch', fetchMock)
    const res = await applyFieldLayout(fakeSupabase({}), { documentId: 'd1', dealId: 'deal1', templateId: 'tpl1' })
    expect(res).toEqual({ applied: false, reason: 'no saved layout' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('describeLayoutFailure — a reason an agent can act on', () => {
  it('translates the bare statuses that carry no body', () => {
    expect(describeLayoutFailure({ status: 405, message: 'BoldSign API 405' })).toMatch(/request method/)
    expect(describeLayoutFailure({ status: 404, message: 'BoldSign API 404' })).toMatch(/no longer has this draft/)
    expect(describeLayoutFailure({ status: 401, message: '' })).toMatch(/permission/)
    expect(describeLayoutFailure({ status: 503, message: 'BoldSign API 503' })).toMatch(/server error/)
  })

  it('recognizes a single-field rejection as retryable, and a blanket one as not', () => {
    expect(isFieldLevelRejection({ status: 400, message: "The document does not have a form field with the ID: 'CheckBox2'." })).toBe(true)
    expect(isFieldLevelRejection({ status: 400, message: 'Document is already sent' })).toBe(false)
    expect(isFieldLevelRejection({ status: 403, message: 'form field denied' })).toBe(false)
  })

  it("keeps BoldSign's own validation text — it says more than we could", () => {
    expect(describeLayoutFailure({ status: 400, message: 'Bounds is invalid for field sig' }))
      .toBe('Bounds is invalid for field sig')
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

describe('isOwnSignedStorageUrl — bucket allow-list', () => {
  const PROJECT = 'https://twgwemkihpwlgliftagg.supabase.co'
  const packetUrl = `${PROJECT}/storage/v1/object/sign/form-packets/IA/seller/1-0-listing.pdf?token=abc`
  const dealUrl   = `${PROJECT}/storage/v1/object/sign/deal-documents/deal-1111/contract.pdf?token=abc`

  it('rejects a form-packets URL by default — widening it for templates must not widen it for sends', () => {
    expect(isOwnSignedStorageUrl(packetUrl, PROJECT)).toBe(false)
  })

  it('accepts a form-packets URL only when that bucket is asked for', () => {
    expect(isOwnSignedStorageUrl(packetUrl, PROJECT, ['form-packets'])).toBe(true)
  })

  it('does not let the packet allow-list smuggle in a deal document', () => {
    expect(isOwnSignedStorageUrl(dealUrl, PROJECT, ['form-packets'])).toBe(false)
  })

  it('still refuses another host wearing the right path', () => {
    expect(isOwnSignedStorageUrl('https://evil.example.com/storage/v1/object/sign/form-packets/x.pdf', PROJECT, ['form-packets'])).toBe(false)
  })
})

// ─── Printable review copy ────────────────────────────────────────────────────
describe('buildSigningSummary — what the paper copy tells the agent', () => {
  const props = {
    status: 'Draft',
    signerDetails: [
      { signerRole: 'Listing Agent', signerName: 'Daniel Stillson', signerEmail: 'd@x.com', order: 2,
        formFields: [{ type: 'Signature', pageNumber: 1, bounds: {}, isRequired: true }] },
      { signerRole: 'Seller', signerName: 'Curtis Epling', signerEmail: 'c@x.com', order: 1,
        formFields: [
          { type: 'Initial', pageNumber: 3, isRequired: true },
          { type: 'Signature', pageNumber: 1, isRequired: true },
          { type: 'Textbox', pageNumber: 1, label: 'County', value: 'Polk', isRequired: false },
        ] },
    ],
  }

  it('orders signers by signing order, not by however the API listed them', () => {
    const { signers } = buildSigningSummary(props)
    expect(signers.map(s => s.role)).toEqual(['Seller', 'Listing Agent'])
  })

  it('orders each signer\'s fields by page — the order someone reads the packet in', () => {
    const { signers } = buildSigningSummary(props)
    expect(signers[0].fields.map(f => f.page)).toEqual([1, 1, 3])
  })

  it('normalizes the field type so the printout says TextBox, not Textbox', () => {
    const { signers } = buildSigningSummary(props)
    expect(signers[0].fields.find(f => f.label === 'County').type).toBe('TextBox')
  })

  it('carries label, value and optionality — what will be asked, and what is prefilled', () => {
    const county = buildSigningSummary(props).signers[0].fields.find(f => f.label === 'County')
    expect(county).toMatchObject({ label: 'County', value: 'Polk', required: false })
  })

  it('counts every field across every signer', () => {
    expect(buildSigningSummary(props).total).toBe(4)
  })

  it('survives a document with no signers or no fields', () => {
    expect(buildSigningSummary({}).total).toBe(0)
    expect(buildSigningSummary({ signerDetails: [{ signerRole: 'Seller' }] }).signers[0].fields).toEqual([])
  })

  it('does not invent a type for a field BoldSign named oddly', () => {
    const { signers } = buildSigningSummary({ signerDetails: [{ formFields: [{ type: 'MysteryBox', pageNumber: 2 }] }] })
    expect(signers[0].fields[0].type).toBe('MysteryBox')
  })
})

describe('buildPrintablePdf — the document, plus a summary that cannot be subtly wrong', () => {
  const sourcePdf = async (pages = 3) => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < pages; i++) {
      doc.addPage([612, 792]).drawText(`AGREEMENT PAGE ${i + 1}`, { x: 40, y: 720, size: 12, font })
    }
    return Buffer.from(await doc.save())
  }
  const props = {
    status: 'Draft',
    signerDetails: [{ signerRole: 'Seller', signerName: 'Curtis Epling', order: 1,
      formFields: [{ type: 'Signature', pageNumber: 1, isRequired: true }, { type: 'Initial', pageNumber: 3, isRequired: true }] }],
  }

  it('keeps every original page and appends the summary AFTER them', async () => {
    // Appended, not prepended: page 1 of the printout must still be page 1 of the
    // agreement, or "initial page 3" stops meaning anything.
    const out = await buildPrintablePdf({ pdfBytes: await sourcePdf(3), props, documentName: 'Iowa Listing' })
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(4)
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 })
  })

  it('adds more summary pages rather than truncating a packet full of fields', async () => {
    const many = { signerDetails: [{ signerRole: 'Seller', order: 1,
      formFields: Array.from({ length: 120 }, (_, i) => ({ type: 'Initial', pageNumber: i + 1, isRequired: true })) }] }
    const out = await buildPrintablePdf({ pdfBytes: await sourcePdf(1), props: many, documentName: 'Big packet' })
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBeGreaterThan(3)   // 1 source + several summary pages
  })

  it('still produces a printable copy for a document with no fields placed yet', async () => {
    const out = await buildPrintablePdf({ pdfBytes: await sourcePdf(2), props: { status: 'Draft' }, documentName: 'Empty' })
    const { PDFDocument } = await import('pdf-lib')
    expect((await PDFDocument.load(out)).getPageCount()).toBe(3)
  })

  it('flattens an interactive form in the source — an unflattened one prints blank', async () => {
    // Plenty of county/board forms ship as AcroForms whose widgets have no
    // appearance streams. They look filled on screen and come out of a print
    // driver empty, which is the "Print produces a blank document" report this
    // whole path exists to answer. Flattening bakes the value into the page.
    const { PDFDocument } = await import('pdf-lib')
    const src = await PDFDocument.create()
    const page = src.addPage([612, 792])
    const form = src.getForm()
    const field = form.createTextField('county')
    field.setText('Polk')
    field.addToPage(page, { x: 60, y: 600, width: 160, height: 20 })
    const bytes = Buffer.from(await src.save())
    expect((await PDFDocument.load(bytes)).getForm().getFields()).toHaveLength(1)

    const out = await buildPrintablePdf({ pdfBytes: bytes, props: { status: 'Draft' }, documentName: 'County form' })
    const flat = await PDFDocument.load(out)
    expect(flat.getForm().getFields()).toHaveLength(0)
    // The value survives as page content (a form XObject drawn into the page)
    // rather than as a widget a print driver may decline to render.
    expect(out.toString('latin1')).toContain('/Subtype /Form')
  })

  it('prints a filled draft with its values on the pages, not just in the summary', async () => {
    // The bug this covers: BoldSign hands back the ORIGINAL file for an unsent
    // document, so a draft an agent had filled out printed completely blank.
    const filled = {
      status: 'Draft',
      signerDetails: [{ signerRole: 'Seller', order: 1, formFields: [
        { type: 'CheckBox', pageNumber: 1, value: 'true',   bounds: { x: 60, y: 100, width: 12, height: 12 } },
        { type: 'Textbox',  pageNumber: 1, value: 'Polk',   bounds: { x: 200, y: 140, width: 120, height: 18 } },
      ] }],
    }
    const before = await buildPrintablePdf({ pdfBytes: await sourcePdf(1), props: { status: 'Draft' }, documentName: 'x' })
    const after  = await buildPrintablePdf({ pdfBytes: await sourcePdf(1), props: filled, documentName: 'x' })
    // Same source, same page count — the difference is drawn content on page 1.
    const { PDFDocument } = await import('pdf-lib')
    expect((await PDFDocument.load(after)).getPageCount()).toBe(2)
    expect(after.length).toBeGreaterThan(before.length)
  })
})

// ─── Printing a draft's own entries ───────────────────────────────────────────
describe('collectFilledFields — only what the agent actually entered', () => {
  const bounds = { x: 10, y: 20, width: 100, height: 16 }

  it('takes valued fields from signers and from sender-filled common fields', () => {
    const out = collectFilledFields({
      signerDetails: [{ formFields: [{ type: 'Textbox', pageNumber: 2, value: 'Polk', bounds }] }],
      commonFields:  [{ type: 'Label', pageNumber: 1, value: 'Gateway', bounds }],
    })
    expect(out.map(f => f.value)).toEqual(['Polk', 'Gateway'])
    expect(out[0].page).toBe(2)
  })

  it('skips empty fields — an unfilled box must never be drawn onto the form', () => {
    expect(collectFilledFields({ signerDetails: [{ formFields: [
      { type: 'Textbox',   pageNumber: 1, value: '',   bounds },
      { type: 'Textbox',   pageNumber: 1, value: '  ', bounds },
      { type: 'Signature', pageNumber: 1, bounds },
    ] }] })).toEqual([])
  })

  it('marks a ticked box with an X and ignores one that is merely present', () => {
    const on = collectFilledFields({ signerDetails: [{ formFields: [{ type: 'CheckBox', pageNumber: 1, value: 'true', bounds }] }] })
    expect(on[0]).toMatchObject({ value: 'X', ticked: true })
    for (const v of ['false', '', 'off', 'no', null]) {
      expect(collectFilledFields({ signerDetails: [{ formFields: [{ type: 'CheckBox', pageNumber: 1, value: v, bounds }] }] })).toEqual([])
    }
  })

  it('drops a field with no usable geometry rather than stacking it at the corner', () => {
    expect(collectFilledFields({ commonFields: [{ type: 'Textbox', pageNumber: 1, value: 'x' }] })).toEqual([])
  })

  // Regression: a BoldSign **Name** field always prints its assigned signer's
  // own name and ignores any value sent for it, and on a document that hasn't
  // been signed yet /document/properties can report no `value` for one at all
  // — even though the name it will show is already known, from the signer row
  // right beside it. Without this fallback the "Save PDF" copy of a filled-out
  // draft printed a blank box for exactly the field an agent most wants to
  // check (the buyer's/agent's own name) before sending, while a fully
  // completed document (where BoldSign has since resolved the value) printed
  // fine — the "Save PDF vs Save & Close" discrepancy this fixes.
  it('falls back to the signer\'s own name for an unresolved Name field', () => {
    const out = collectFilledFields({
      signerDetails: [{ signerName: 'Daniel Stillson', formFields: [
        { type: 'Name', pageNumber: 1, value: null, bounds },
      ] }],
    })
    expect(out).toEqual([expect.objectContaining({ value: 'Daniel Stillson', type: 'Name' })])
  })

  it('does not borrow the signer name for a common (sender-filled) field', () => {
    expect(collectFilledFields({
      signerDetails: [{ signerName: 'Daniel Stillson', formFields: [] }],
      commonFields:  [{ type: 'Name', pageNumber: 1, value: '', bounds }],
    })).toEqual([])
  })

  it('prefers the field\'s own value over the signer-name fallback', () => {
    const out = collectFilledFields({
      signerDetails: [{ signerName: 'Daniel Stillson', formFields: [
        { type: 'Name', pageNumber: 1, value: 'Explicit Name', bounds },
      ] }],
    })
    expect(out[0].value).toBe('Explicit Name')
  })
})

describe('resolveBoundsScale — derived from evidence, never assumed', () => {
  const pdfPages = [{ width: 612, height: 792 }]
  const field = (o = {}) => ({ page: 1, x: 100, y: 100, width: 100, height: 20, ...o })

  it('uses BoldSign\'s own page width when the payload carries it', () => {
    const sizes = new Map([[1, { width: 816, height: 1056 }]])   // letter at 96 DPI
    expect(resolveBoundsScale({ fields: [field()], pdfPages, boldsignSizes: sizes })).toBeCloseTo(0.75)
  })

  it('falls back to points (1:1) when every field fits at that scale', () => {
    expect(resolveBoundsScale({ fields: [field()], pdfPages })).toBe(1)
  })

  it('picks the 96-DPI mapping when a field would otherwise run off the page', () => {
    expect(resolveBoundsScale({ fields: [field({ x: 700, width: 80 })], pdfPages })).toBe(0.75)
  })

  it('gives up rather than guess when nothing fits — the summary then carries the values', () => {
    expect(resolveBoundsScale({ fields: [field({ x: 5000 })], pdfPages })).toBeNull()
    expect(resolveBoundsScale({ fields: [], pdfPages })).toBeNull()
    expect(resolveBoundsScale({ fields: [field()], pdfPages: [] })).toBeNull()
  })

  it('reads page sizes under whichever key the properties payload used', () => {
    for (const key of ['documentPageDetails', 'pageDetails', 'pages']) {
      const sizes = boldsignPageSizes({ [key]: [{ pageNumber: 1, width: 816, height: 1056 }] })
      expect(sizes.get(1)).toEqual({ width: 816, height: 1056 })
    }
    expect(boldsignPageSizes({}).size).toBe(0)
  })
})

describe('startingFontSize — a short box must not shrink a correct fontSize', () => {
  // Regression: this used to be Math.min(fontSize * scale, boxH * 0.8), so a
  // field configured with the SAME fontSize as every other label on the
  // template rendered tiny whenever its own box happened to be drawn short —
  // the box height silently overrode a perfectly correct, equal font size down
  // to as little as 5pt, with nothing wrong in the field's own settings.
  it('trusts the stored fontSize outright, even against a short box', () => {
    expect(startingFontSize({ fontSize: 11, scale: 1, boxH: 8 })).toBe(11)
  })

  it('scales the stored fontSize the same way bounds are scaled', () => {
    expect(startingFontSize({ fontSize: 11, scale: 0.75, boxH: 20 })).toBeCloseTo(8.25)
  })

  it('falls back to a height-derived size only when no fontSize is stored', () => {
    expect(startingFontSize({ fontSize: null, scale: 1, boxH: 20 })).toBe(10)
    expect(startingFontSize({ fontSize: 0, scale: 1, boxH: 4 })).toBe(5)   // floor
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Go-live hardening (Sandbox → Live)
// ─────────────────────────────────────────────────────────────────────────────

describe('verifyWebhookSignature', () => {
  const secret = 'whsec_test_key'
  const body   = '{"event":{"eventType":"Completed"},"data":{"documentId":"doc-1"}}'
  const t      = 1700000000
  const hmac   = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex')

  it('reports "unconfigured" when no secret is set — never "ok"', () => {
    // The old behavior returned 'ok' here, which is how an unverified endpoint
    // could accept status changes on real, legally binding documents.
    expect(verifyWebhookSignature(body, `t=${t}, s0=${hmac(`${t}.${body}`)}`, { secret: '', nowSec: t }))
      .toBe('unconfigured')
  })

  it('accepts the documented t.body payload', () => {
    expect(verifyWebhookSignature(body, `t=${t}, s0=${hmac(`${t}.${body}`)}`, { secret, nowSec: t })).toBe('ok')
  })

  it('accepts a signature under ANY s<N> — a rolled secret sends s0 and s1', () => {
    const header = `t=${t}, s0=${'0'.repeat(64)}, s1=${hmac(`${t}.${body}`)}`
    expect(verifyWebhookSignature(body, header, { secret, nowSec: t })).toBe('ok')
  })

  it('rejects a wrong signature, a missing header, and a missing timestamp', () => {
    expect(verifyWebhookSignature(body, `t=${t}, s0=${'a'.repeat(64)}`, { secret, nowSec: t })).toBe('invalid')
    expect(verifyWebhookSignature(body, '', { secret, nowSec: t })).toBe('invalid')
    expect(verifyWebhookSignature(body, `s0=${hmac(`${t}.${body}`)}`, { secret, nowSec: t })).toBe('invalid')
  })

  it('rejects a replay outside the 5-minute window', () => {
    const header = `t=${t}, s0=${hmac(`${t}.${body}`)}`
    expect(verifyWebhookSignature(body, header, { secret, nowSec: t + 301 })).toBe('invalid')
    expect(verifyWebhookSignature(body, header, { secret, nowSec: t + 299 })).toBe('ok')
  })

  it('rejects a body that was altered after signing', () => {
    const header = `t=${t}, s0=${hmac(`${t}.${body}`)}`
    expect(verifyWebhookSignature(body.replace('doc-1', 'doc-2'), header, { secret, nowSec: t })).toBe('invalid')
  })
})

describe('boldsign() — a non-idempotent write is never blindly retried', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('does NOT retry a send on a 5xx — a retry can be a second signed document', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(errResp(500)))
    vi.stubGlobal('fetch', fetchMock)
    await expect(boldsign('/document/send', { method: 'POST', json: {} })).rejects.toMatchObject({ status: 500 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('DOES retry a write on 429 — rate limited means it was never processed', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errResp(429))
      .mockResolvedValueOnce(okResp('{"documentId":"d1"}'))
    vi.stubGlobal('fetch', fetchMock)
    const data = await boldsign('/document/send', { method: 'POST', json: {} })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(data.documentId).toBe('d1')
  })

  it('retries a write the caller marked idempotent (revoke, delete, url minting)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errResp(503))
      .mockResolvedValueOnce(okResp())
    vi.stubGlobal('fetch', fetchMock)
    await boldsign('/document/revoke', { method: 'POST', json: {}, idempotent: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reports an UNKNOWN outcome when the connection dies mid-send', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('socket hang up')))
    vi.stubGlobal('fetch', fetchMock)
    await expect(boldsign('/document/send', { method: 'POST', json: {} }))
      .rejects.toMatchObject({ indeterminate: true, message: expect.stringContaining('may or may not') })
    expect(fetchMock).toHaveBeenCalledTimes(1)   // not retried
  })

  it('still retries a GET on a 5xx', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errResp(502))
      .mockResolvedValueOnce(okResp())
    vi.stubGlobal('fetch', fetchMock)
    await boldsign('/document/properties?documentId=x')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('normalizeKnownStatus — only statuses the app will store', () => {
  it('maps BoldSign\'s vocabulary onto the stored set', () => {
    expect(normalizeKnownStatus('Completed')).toBe('completed')
    expect(normalizeKnownStatus('InProgress')).toBe('sent')
    expect(normalizeKnownStatus('WaitingForOthers')).toBe('sent')
    expect(normalizeKnownStatus('Viewed')).toBe('delivered')
    expect(normalizeKnownStatus('Revoked')).toBe('voided')
    // Its own status, not folded into 'voided' — folding it made the webhook's
    // expiry-notification branch unreachable, so nobody was told.
    expect(normalizeKnownStatus('Expired')).toBe('expired')
    expect(normalizeKnownStatus('Draft')).toBe('draft')
    expect(normalizeKnownStatus('None')).toBe('draft')
  })

  it('returns null for anything else, rather than storing it', () => {
    // An event name that is not a status, or a future BoldSign value. Writing it
    // would drop the document out of the portal, the reminder sweep and the
    // closing gate, all of which filter on the known strings.
    expect(normalizeKnownStatus('ReminderSent')).toBeNull()
    expect(normalizeKnownStatus('SomethingNew')).toBeNull()
    expect(normalizeKnownStatus('')).toBeNull()
  })
})

describe('shouldApplyStatus — out-of-order webhooks cannot rewind a document', () => {
  it('lets the lifecycle move forward', () => {
    expect(shouldApplyStatus('draft', 'sent')).toBe(true)
    expect(shouldApplyStatus('sent', 'delivered')).toBe(true)
    expect(shouldApplyStatus('delivered', 'completed')).toBe(true)
  })

  it('refuses to move a signed document back to awaiting-signature', () => {
    // The failure this prevents: a redelivered "Sent" landing after "Completed"
    // put a fully-signed agreement back in the portal as unsigned, restarted the
    // reminder emails to a client who had already signed, and removed it from
    // the closing compliance gate.
    expect(shouldApplyStatus('completed', 'sent')).toBe(false)
    expect(shouldApplyStatus('completed', 'delivered')).toBe(false)
    expect(shouldApplyStatus('declined', 'sent')).toBe(false)
    expect(shouldApplyStatus('voided', 'delivered')).toBe(false)
  })

  it('treats a repeat of the same status as nothing to do', () => {
    expect(shouldApplyStatus('completed', 'completed')).toBe(false)
    expect(shouldApplyStatus('sent', 'sent')).toBe(false)
  })

  it('never writes an unknown status, and accepts anything onto an unknown one', () => {
    expect(shouldApplyStatus('sent', 'remindersent')).toBe(false)
    expect(shouldApplyStatus('sent', null)).toBe(false)
    expect(shouldApplyStatus('somethingold', 'completed')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// IsReadOnly is not accepted on every type
//
// Reported live, sending the IA Agency Packet:
//   "IsReadOnly property is not supported for the Signature, Initial,
//    Attachment, Date signed, Hyperlink, Title, Formula, Drawing and Company
//    form fields."
//
// /document/edit is ATOMIC, so one Signature carrying the property failed the
// whole layout restore. Every signable template has a signature field, so this
// broke the restore for effectively every layout the feature ever stored.
// ─────────────────────────────────────────────────────────────────────────────
describe('supportsFieldReadOnly — layout restore must not send a refused property', () => {
  it('refuses the nine types BoldSign named', () => {
    for (const t of ['Signature', 'Initial', 'Attachment', 'DateSigned', 'Hyperlink', 'Title', 'Formula', 'Drawing', 'Company']) {
      expect(supportsFieldReadOnly(t)).toBe(false)
    }
  })

  it('allows the types that do accept it', () => {
    // Image is deliberately absent: BoldSign does not refuse it, but we have no
    // confirmation either, and an allowlist errs toward omitting the property.
    for (const t of ['TextBox', 'Label', 'CheckBox', 'RadioButton', 'EditableDate', 'Dropdown']) {
      expect(supportsFieldReadOnly(t)).toBe(true)
    }
  })

  it('every refused type is one normalizeFieldType can actually produce', () => {
    // If a spelling here drifted from EDITABLE_FIELD_TYPES the guard would
    // silently stop matching, which is how this bug behaves when it is present.
    for (const t of ['Signature', 'Initial', 'Attachment', 'DateSigned', 'Hyperlink', 'Title', 'Formula', 'Drawing', 'Company']) {
      expect(normalizeFieldType(t)).toBe(t)
    }
    // The read-back spellings BoldSign uses must land on the same refusal.
    expect(supportsFieldReadOnly(normalizeFieldType('initials'))).toBe(false)
    expect(supportsFieldReadOnly(normalizeFieldType('datesigned'))).toBe(false)
    expect(supportsFieldReadOnly(normalizeFieldType('signaturedate'))).toBe(false)
  })
})

describe('buildLayoutEditPayload — a stored layout heals on use', () => {
  // Exactly what is sitting in deal_field_layouts today: captured before the
  // fix, so every field carries isReadOnly including the signature.
  const legacyLayout = {
    signers: [{
      signerRole: 'Seller', signerEmail: 'old@x.com', order: 1,
      formFields: [
        { id: 'tplSig',  fieldType: 'Signature', pageNumber: 1, bounds: { x: 50, y: 60, width: 180, height: 35 }, isRequired: true, isReadOnly: false },
        { id: 'tplInit', fieldType: 'Initial',   pageNumber: 3, bounds: { x: 20, y: 30, width: 60,  height: 25 }, isRequired: true, isReadOnly: false },
        { id: 'county',  fieldType: 'TextBox',   pageNumber: 1, bounds: { x: 10, y: 10, width: 100, height: 20 }, isRequired: false, isReadOnly: true },
      ],
    }],
  }
  const signerDetails = [{ id: 'n1', signerRole: 'Seller', formFields: [{ id: 'tplSig' }, { id: 'county' }] }]
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

  it('REGRESSION: strips isReadOnly from Signature and Initial on both Update and Add', () => {
    const payload = buildLayoutEditPayload({ layout: legacyLayout, signerDetails })
    const fields  = payload.signers[0].formFields
    const byName  = (n) => fields.find(f => f.id === n || f.name === n)

    // tplSig exists on the draft, so it is an Update; tplInit does not, so Add.
    expect(byName('tplSig').editAction).toBe('Update')
    expect(byName('tplInit').editAction).toBe('Add')
    expect(has(byName('tplSig'),  'isReadOnly')).toBe(false)
    expect(has(byName('tplInit'), 'isReadOnly')).toBe(false)
  })

  it('keeps the lock on a TextBox, which is the whole point of storing it', () => {
    const payload = buildLayoutEditPayload({ layout: legacyLayout, signerDetails })
    expect(payload.signers[0].formFields.find(f => f.id === 'county').isReadOnly).toBe(true)
  })

  it('nothing in the payload carries the property on a refused type', () => {
    const payload = buildLayoutEditPayload({ layout: legacyLayout, signerDetails })
    for (const f of payload.signers[0].formFields) {
      if (f.editAction === 'Remove') continue
      if (has(f, 'isReadOnly')) expect(supportsFieldReadOnly(f.fieldType)).toBe(true)
    }
  })

  it('everything else about the restore is unchanged — position, page, required', () => {
    const payload = buildLayoutEditPayload({ layout: legacyLayout, signerDetails })
    const sig = payload.signers[0].formFields.find(f => f.id === 'tplSig')
    expect(sig).toMatchObject({
      fieldType: 'Signature', pageNumber: 1,
      bounds: { x: 50, y: 60, width: 180, height: 35 }, isRequired: true,
    })
  })
})

describe('supportsFieldReadOnly — allowlist, so a new type cannot reopen this', () => {
  it('allows only the six restorable types that accept a lock', () => {
    for (const t of ['TextBox', 'Label', 'CheckBox', 'RadioButton', 'Dropdown', 'EditableDate']) {
      expect(supportsFieldReadOnly(t)).toBe(true)
    }
  })

  it('excludes Image too, which BoldSign does not refuse but we cannot confirm', () => {
    expect(supportsFieldReadOnly('Image')).toBe(false)
  })

  it('a future or unknown type defaults to NOT carrying the property', () => {
    expect(supportsFieldReadOnly('SomeFutureType')).toBe(false)
    expect(supportsFieldReadOnly(undefined)).toBe(false)
    expect(supportsFieldReadOnly(null)).toBe(false)
  })

  it('every allowlisted spelling is one normalizeFieldType can actually produce', () => {
    // A drift here would silently stop matching, which looks exactly like the bug.
    for (const t of ['TextBox', 'Label', 'CheckBox', 'RadioButton', 'Dropdown', 'EditableDate']) {
      expect(normalizeFieldType(t)).toBe(t)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The IsReadOnly escape hatch
//
// Predicting which types accept the property has now been wrong twice against a
// live template, because the TYPE behind an auto-assigned id is not something
// this code can see for a template it cannot read. These make the send survive
// being wrong about it.
// ─────────────────────────────────────────────────────────────────────────────
describe('isReadOnlyRejection', () => {
  const err = (message, status = 400, data = {}) => Object.assign(new Error(message), { status, data })

  it('matches BoldSign own refusal, however it is cased', () => {
    expect(isReadOnlyRejection(err('IsReadOnly property is not supported for the Signature, Initial, Attachment, Date signed, Hyperlink, Title, Formula, Drawing and Company form fields.'))).toBe(true)
    expect(isReadOnlyRejection(err('isReadOnly property is not supported for the Signature'))).toBe(true)
  })

  it('finds it in the response body as well as the message', () => {
    expect(isReadOnlyRejection(err('BoldSign API 400', 400, { errors: ['IsReadOnly property is not supported'] }))).toBe(true)
  })

  it('ignores anything that is not this refusal', () => {
    expect(isReadOnlyRejection(err('SignerName or SignerEmail is missing in roles'))).toBe(false)
    expect(isReadOnlyRejection(err('The document does not have a form field with the ID'))).toBe(false)
    // Only a 400 means BoldSign validated and refused; a 500 is not a verdict.
    expect(isReadOnlyRejection(err('IsReadOnly property is not supported', 500))).toBe(false)
    expect(isReadOnlyRejection(undefined)).toBe(false)
  })

  it('is checked BEFORE isFieldLevelRejection, which also matches this text', () => {
    // Both match, since the message ends in "form fields". Ordering is what stops
    // it being retried as one unplaceable field and failing identically.
    const e = err('IsReadOnly property is not supported for the Signature, Initial and Company form fields.')
    expect(isReadOnlyRejection(e)).toBe(true)
    expect(isFieldLevelRejection(e)).toBe(true)
  })
})

describe('stripRoleReadOnly / stripLayoutReadOnly', () => {
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

  it('removes the property from every role field, keeping ids and values', () => {
    const roles = [
      { roleIndex: 1, signerName: 'A', existingFormFields: [{ id: 'x', value: '1', isReadOnly: true }, { id: 'y', value: '2' }] },
      { roleIndex: 2, signerName: 'B', existingFormFields: [{ id: 'z', value: '3', isReadOnly: true }] },
    ]
    const out = stripRoleReadOnly(roles)
    expect(out[0].existingFormFields).toEqual([{ id: 'x', value: '1' }, { id: 'y', value: '2' }])
    expect(out[1].existingFormFields).toEqual([{ id: 'z', value: '3' }])
    expect(out[0].signerName).toBe('A')
  })

  it('REMOVES rather than sets false, since the refusal is about presence', () => {
    const out = stripRoleReadOnly([{ existingFormFields: [{ id: 'x', value: '1', isReadOnly: true }] }])
    expect(has(out[0].existingFormFields[0], 'isReadOnly')).toBe(false)
  })

  it('does not mutate its input', () => {
    const roles = [{ existingFormFields: [{ id: 'x', value: '1', isReadOnly: true }] }]
    stripRoleReadOnly(roles)
    expect(roles[0].existingFormFields[0].isReadOnly).toBe(true)
  })

  it('tolerates roles with no fields at all', () => {
    expect(stripRoleReadOnly([{ roleIndex: 1 }])).toEqual([{ roleIndex: 1 }])
    expect(stripRoleReadOnly([{ roleIndex: 1, existingFormFields: [] }])[0].existingFormFields).toEqual([])
    expect(stripRoleReadOnly(undefined)).toBeUndefined()
  })

  it('does the same for a layout edit payload, keeping bounds and type', () => {
    const payload = { signers: [{ editAction: 'Update', id: 'n1', formFields: [
      { editAction: 'Update', id: 'sig', fieldType: 'Signature', bounds: { x: 1, y: 2, width: 3, height: 4 }, isReadOnly: false },
      { editAction: 'Update', id: 'txt', fieldType: 'TextBox',   bounds: { x: 5, y: 6, width: 7, height: 8 }, isReadOnly: true },
    ] }] }
    const out = stripLayoutReadOnly(payload)
    for (const f of out.signers[0].formFields) expect(has(f, 'isReadOnly')).toBe(false)
    expect(out.signers[0].formFields[0]).toMatchObject({ fieldType: 'Signature', bounds: { x: 1, y: 2, width: 3, height: 4 } })
    expect(out.signers[0].id).toBe('n1')
    expect(payload.signers[0].formFields[1].isReadOnly).toBe(true)   // not mutated
  })

  it('leaves a payload with no signers alone', () => {
    expect(stripLayoutReadOnly({})).toEqual({})
    expect(stripLayoutReadOnly(null)).toBeNull()
  })
})

describe('signing order is actually requested, not just numbered', () => {
  it('REGRESSION: distinct signerOrder values mean sequential', () => {
    // BoldSign treats signerOrder as inert unless enableSigningOrder is true,
    // and it defaults to false. The template paths never sent it, so the send
    // modal's "Sign in this order" box was decorative and everything prefilled
    // on a later role was invisible to everyone else for the document's life.
    expect(rolesWantSigningOrder([{ signerOrder: 1 }, { signerOrder: 2 }])).toBe(true)
    expect(rolesWantSigningOrder([{ signerOrder: 1 }, { signerOrder: 2 }, { signerOrder: 3 }])).toBe(true)
  })

  it('all-equal order means notify everyone at once', () => {
    expect(rolesWantSigningOrder([{ signerOrder: 1 }, { signerOrder: 1 }])).toBe(false)
    expect(rolesWantSigningOrder([{ signerOrder: 1 }])).toBe(false)
  })

  it('treats a missing order as 1, the way the ad-hoc paths do', () => {
    expect(rolesWantSigningOrder([{ roleIndex: 1 }, { roleIndex: 2 }])).toBe(false)
    expect(rolesWantSigningOrder([{ roleIndex: 1 }, { signerOrder: 2 }])).toBe(true)
    expect(rolesWantSigningOrder([])).toBe(false)
    expect(rolesWantSigningOrder(undefined)).toBe(false)
  })
})

// ─── The field-id floor under every template send ────────────────────────────
// BoldSign auto-names its fields, so `CheckBox1` exists on every template in the
// account. A client that carried one template's field map onto another's send
// wrote one form's answers onto another form's boxes, as locked terms, with a
// 200 back. The client fix is a panel declared per packet; this is the floor
// under it, so no caller — this app, a future one, an agent driving the API —
// can reproduce that class of bug.
describe('template field index', () => {
  it('collects ids from the top level and from every role', () => {
    const ids = collectTemplateFieldIds({
      formFields: [{ id: 'Label1' }, { fieldId: 'CheckBox1' }],
      roles: [
        { roleIndex: 1, formFields: [{ id: 'TextBox3' }] },
        { roleIndex: 2, fields: [{ name: 'Signature2' }] },
      ],
    })
    expect([...ids].sort()).toEqual(['CheckBox1', 'Label1', 'Signature2', 'TextBox3'])
  })

  it('reads the alternate shapes BoldSign returns a template in', () => {
    expect([...collectTemplateFieldIds({ fields: [{ id: 'A' }], signerRoles: [{ formFields: [{ id: 'B' }] }] })].sort())
      .toEqual(['A', 'B'])
    expect(collectTemplateFieldIds({}).size).toBe(0)
    expect(collectTemplateFieldIds(null).size).toBe(0)
  })
})

describe('payloadFieldIds', () => {
  it('finds every id a send addresses, in all three places one can hide', () => {
    expect(payloadFieldIds({
      roles: [
        { roleIndex: 1, existingFormFields: [{ id: 'TextBox1', value: 'x' }] },
        { roleIndex: 2, existingFormFields: [{ id: 'CheckBox4', value: 'true' }] },
      ],
      sharedFormFields: [{ id: 'Label1', value: 'y' }],
      fieldRemovalIds: ['Label9'],
    }).sort()).toEqual(['CheckBox4', 'Label1', 'Label9', 'TextBox1'])
  })

  it('dedupes, and is empty for a payload that addresses nothing', () => {
    expect(payloadFieldIds({ roles: [{ existingFormFields: [{ id: 'A' }] }], sharedFormFields: [{ id: 'A' }] })).toEqual(['A'])
    expect(payloadFieldIds({})).toEqual([])
    expect(payloadFieldIds({ roles: [{ signerName: 'Jane' }] })).toEqual([])
  })
})

// ─── Send options: brand, CC, expiry, reminders ──────────────────────────────
// Four capabilities the account pays for and nothing exposed. BoldSign fixes
// every one at document CREATION and refuses to change them afterwards, which
// is why they ride on the draft-creating call.
describe('buildSendOptions', () => {
  it('brands every send — a generic BoldSign email is a brand moment given away', () => {
    expect(buildSendOptions({}).brandId).toBeTruthy()
    expect(buildSendOptions({ brandId: 'other-brand' }).brandId).toBe('other-brand')
  })

  // A payload that always carried `expiryDays: null` would be us overriding the
  // account default with nothing.
  it('omits everything the caller did not ask for, so account defaults stand', () => {
    expect(Object.keys(buildSendOptions({})).sort()).toEqual(['brandId'])
    expect(buildSendOptions({ expiryDays: '' })).not.toHaveProperty('expiryDays')
    expect(buildSendOptions({ cc: [] })).not.toHaveProperty('cc')
    expect(buildSendOptions({ reminders: null })).not.toHaveProperty('reminderSettings')
  })

  it('carries a valid expiry and clamps an absurd one', () => {
    expect(buildSendOptions({ expiryDays: 7 }).expiryDays).toBe(7)
    expect(buildSendOptions({ expiryDays: '14' }).expiryDays).toBe(14)
    expect(buildSendOptions({ expiryDays: 99999 }).expiryDays).toBe(180)
    expect(buildSendOptions({ expiryDays: -3 })).not.toHaveProperty('expiryDays')
  })

  it('passes CC through in the shape BoldSign takes', () => {
    expect(buildSendOptions({ cc: ['tc@example.com'] }).cc).toEqual([{ emailAddress: 'tc@example.com' }])
  })
})

describe('normalizeCc', () => {
  it('accepts a bare string, an {email} or an {emailAddress}', () => {
    expect(normalizeCc(['a@x.com', { email: 'b@x.com' }, { emailAddress: 'c@x.com' }]))
      .toEqual([{ emailAddress: 'a@x.com' }, { emailAddress: 'b@x.com' }, { emailAddress: 'c@x.com' }])
  })

  it('drops malformed addresses rather than letting a send fail on one', () => {
    expect(normalizeCc(['good@x.com', 'not-an-email', '', null])).toEqual([{ emailAddress: 'good@x.com' }])
  })

  it('dedupes case-insensitively', () => {
    expect(normalizeCc(['A@x.com', 'a@X.com'])).toEqual([{ emailAddress: 'A@x.com' }])
  })

  // A "copy everyone" list is a way to leak an agreement, not a feature.
  it('caps the list', () => {
    const many = Array.from({ length: 25 }, (_, i) => `p${i}@x.com`)
    expect(normalizeCc(many)).toHaveLength(10)
  })

  it('is empty for nothing', () => {
    expect(normalizeCc(undefined)).toEqual([])
    expect(normalizeCc('nope')).toEqual([])
  })
})

describe('normalizeReminders', () => {
  // Not wired to any UI on purpose — the CRM's nightly sweep owns chasing, and
  // two reminder systems on one document double-email the client. Kept correct
  // and ready for the day that changes.
  it('is off unless asked for', () => {
    expect(normalizeReminders(null)).toBeNull()
    expect(normalizeReminders({ enabled: false })).toBeNull()
  })

  it('clamps to what BoldSign accepts', () => {
    expect(normalizeReminders({ enabled: true })).toEqual({ enableAutoReminder: true, reminderDays: 3, reminderCount: 3 })
    expect(normalizeReminders({ enabled: true, reminderCount: 99 }).reminderCount).toBe(5)
    expect(normalizeReminders({ enabled: true, reminderDays: 0 }).reminderDays).toBe(3)
    expect(normalizeReminders({ enabled: true, reminderDays: 999 }).reminderDays).toBe(30)
  })
})

describe('appendSendOptions (multipart)', () => {
  // Only the scalars. How a multipart body nests cc/reminderSettings is not
  // something this file guesses at — this integration already retired one
  // feature built on a guess about BoldSign's wire format.
  it('brands a multipart send and carries an expiry', () => {
    const form = new FormData()
    appendSendOptions(form, { expiryDays: 10 })
    expect(form.get('BrandId')).toBeTruthy()
    expect(form.get('ExpiryDays')).toBe('10')
  })

  it('omits an expiry that was not asked for', () => {
    const form = new FormData()
    appendSendOptions(form, {})
    expect(form.get('ExpiryDays')).toBeNull()
  })
})

describe('summarizeFieldValues — the log line that says whether the save landed', () => {
  const props = {
    signerDetails: [{
      signerEmail: 'buyer@x.com',
      formFields: [
        { id: 'buyer_name', type: 'TextBox', label: 'Buyer name', value: 'Dana Reyes', pageNumber: 2 },
        { id: 'buyer_init', type: 'CheckBox', label: 'Agrees',    value: '',           pageNumber: 2 },
      ],
    }],
    commonFields: [{ id: 'eff_date', type: 'TextBox', label: 'Effective date', value: '2026-09-03' }],
  }

  it('counts filled fields separately from total, so an empty save is obvious', () => {
    const out = summarizeFieldValues(props)
    expect(out.total).toBe(3)
    expect(out.filled).toBe(2)
  })

  it('carries the id, page, signer and value of every field', () => {
    const { fields } = summarizeFieldValues(props)
    expect(fields[0]).toMatchObject({ id: 'buyer_name', value: 'Dana Reyes', signer: 'buyer@x.com', page: 2, filled: true })
    expect(fields[1]).toMatchObject({ id: 'buyer_init', value: '', filled: false })
    // A sender-filled common field is attributed, not silently dropped.
    expect(fields[2]).toMatchObject({ id: 'eff_date', signer: '(common)', filled: true })
  })

  it('truncates a value rather than logging client data in full', () => {
    const long = 'x'.repeat(200)
    const { fields } = summarizeFieldValues({ commonFields: [{ id: 'f', value: long }] })
    expect(fields[0].value).toHaveLength(61)   // 60 chars + the ellipsis
    expect(fields[0].value.endsWith('\u2026')).toBe(true)
  })

  it('is safe on a properties payload with nothing on it', () => {
    expect(summarizeFieldValues(null)).toEqual({ total: 0, filled: 0, fields: [] })
  })
})

// ── The base layer a printable copy is drawn on ─────────────────────────────
// The watermark fix substitutes the template's PDF for BoldSign's watermarked
// render of a draft. That is only safe while the two still describe the same
// pages, and these are the cases that decide it.
describe('templateMatchesDocument', () => {
  const letter = { width: 612, height: 792 }
  const legal  = { width: 612, height: 1008 }
  const sizes  = (...pages) => new Map(pages.map((p, i) => [i + 1, p]))

  it('accepts a template whose pages match the document', () => {
    expect(templateMatchesDocument({
      pdfPageSizes: [letter, letter, letter],
      boldsignSizes: sizes(letter, letter, letter),
    })).toBe(true)
  })

  it('accepts sizes reported in another unit — it compares ratios, not dimensions', () => {
    // BoldSign's bounds are not necessarily points (see resolveBoundsScale), so a
    // page reported at 1/4 scale is the same page.
    expect(templateMatchesDocument({
      pdfPageSizes: [letter],
      boldsignSizes: sizes({ width: 153, height: 198 }),
    })).toBe(true)
  })

  it('rejects a template that gained or lost a page', () => {
    // The case that matters most: same page size, different count, so every value
    // after the inserted page would be drawn on the wrong one.
    expect(templateMatchesDocument({
      pdfPageSizes: [letter, letter, letter],
      boldsignSizes: sizes(letter, letter),
    })).toBe(false)
  })

  it('rejects a page whose shape changed', () => {
    expect(templateMatchesDocument({
      pdfPageSizes: [letter, legal],
      boldsignSizes: sizes(letter, letter),
    })).toBe(false)
  })

  it('rejects when BoldSign reported no page details — there is nothing to check', () => {
    expect(templateMatchesDocument({ pdfPageSizes: [letter], boldsignSizes: new Map() })).toBe(false)
    expect(templateMatchesDocument({ pdfPageSizes: [letter] })).toBe(false)
    expect(templateMatchesDocument({})).toBe(false)
  })

  it('rejects unusable numbers rather than dividing by zero into a pass', () => {
    expect(templateMatchesDocument({
      pdfPageSizes: [{ width: 612, height: 0 }],
      boldsignSizes: sizes(letter),
    })).toBe(false)
    expect(templateMatchesDocument({
      pdfPageSizes: [letter],
      boldsignSizes: sizes({ width: null, height: 792 }),
    })).toBe(false)
  })

  it('tolerates rounding between systems', () => {
    expect(templateMatchesDocument({
      pdfPageSizes: [letter],
      boldsignSizes: sizes({ width: 611.6, height: 792.4 }),
    })).toBe(true)
  })
})
