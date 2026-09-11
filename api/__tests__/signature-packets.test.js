import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  documentFiles, readDownloadOption, packetSnapshot, assertEditableSigner,
  buildAcknowledgementEdit, ACK_DEFAULT_LABEL, ACK_LABEL_BOUNDS, ACK_INITIAL_BOUNDS,
  buildMergePayload, createEmbeddedCloneUrl, downloadDocumentParts, editDocumentFields,
  archiveCompletedPacket, linkValidTill, EDIT_LINK_HOURS,
  packetEventKey, recordPacketEvent, patchPacket, missingColumnName, trackDocument,
  normalizeKnownStatus, shouldApplyStatus, KNOWN_STATUSES, dealMlsNumber,
} from '../boldsign.js'
import { zip } from '../_lib/zip.js'

const okResp = (body = '{}') => ({
  ok: true, status: 200, text: () => Promise.resolve(body), headers: { get: () => null },
})
const errResp = (status, body = '{"message":"boom"}') => ({
  ok: false, status, text: () => Promise.resolve(body), headers: { get: () => null },
})
const rawResp = (buf, status = 200) => ({
  ok: status < 400, status, arrayBuffer: () => Promise.resolve(buf), headers: { get: () => null },
})

// A REAL one-page PDF, not just the magic bytes: archiveCompletedPacket
// concatenates the parts with pdf-lib to build the combined copy, and a fake
// that only looks like a PDF would make that step fail for the wrong reason.
async function pdf(marker) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([612, 792]).drawText(marker, { x: 50, y: 700, size: 14, font })
  return Buffer.from(await doc.save())
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.unstubAllGlobals())

// ─────────────────────────────────────────────────────────────────────────────
// Reading a packet out of BoldSign's properties
// ─────────────────────────────────────────────────────────────────────────────
describe('packet snapshot', () => {
  it('reads the file list under any of the names BoldSign uses for it', () => {
    expect(documentFiles({ documentFiles: [{ id: 'f1', name: 'Purchase.pdf', pageCount: 9 }] }))
      .toEqual([{ id: 'f1', name: 'Purchase.pdf', pages: 9 }])
    expect(documentFiles({ files: [{ fileId: 'f2', fileName: 'Disc.pdf' }] }))
      .toEqual([{ id: 'f2', name: 'Disc.pdf', pages: null }])
    expect(documentFiles({})).toEqual([])
  })

  it('drops an entry that identifies nothing rather than listing a blank file', () => {
    expect(documentFiles({ files: [{ pageCount: 3 }, { id: 'f1' }] }))
      .toEqual([{ id: 'f1', name: null, pages: null }])
  })

  it('normalizes the download option to the two words the API itself uses', () => {
    expect(readDownloadOption({ documentDownloadOption: 'Individually' })).toBe('Individually')
    expect(readDownloadOption({ documentDownloadOption: 'individual' })).toBe('Individually')
    expect(readDownloadOption({ downloadOption: 'Combined' })).toBe('Combined')
    expect(readDownloadOption({})).toBeNull()
  })

  it('gathers status, files, option and signers in one shape', () => {
    const snap = packetSnapshot({
      status: 'InProgress',
      documentFiles: [{ id: 'f1', name: 'A.pdf', pageCount: 2 }],
      documentDownloadOption: 'Individually',
      signerDetails: [{ id: 's1', signerName: 'Ann', signerEmail: 'a@x.com', status: 'NotCompleted' }],
    })
    expect(snap.status).toBe('sent')
    expect(snap.rawStatus).toBe('InProgress')
    expect(snap.files).toHaveLength(1)
    expect(snap.downloadOption).toBe('Individually')
    expect(snap.signers[0]).toMatchObject({ id: 's1', name: 'Ann', status: 'waiting' })
  })
})

describe('the needs_attention status', () => {
  it('is stored as its own value, never folded into "sent"', () => {
    expect(normalizeKnownStatus('NeedsAttention')).toBe('needs_attention')
    expect(normalizeKnownStatus('needs attention')).toBe('needs_attention')
    expect(KNOWN_STATUSES).toContain('needs_attention')
  })

  it('is in flight, not terminal — it can still move on, and back', () => {
    expect(shouldApplyStatus('sent', 'needs_attention')).toBe(true)
    expect(shouldApplyStatus('needs_attention', 'delivered')).toBe(true)
    expect(shouldApplyStatus('needs_attention', 'completed')).toBe(true)
    // …but never backwards out of a terminal state.
    expect(shouldApplyStatus('completed', 'needs_attention')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 1 — an in-progress packet can be corrected; a completed signer's
// fields are never touched.
// ─────────────────────────────────────────────────────────────────────────────
describe('assertEditableSigner — the guard on an in-progress edit', () => {
  const props = (over = {}) => ({
    status: 'InProgress',
    signerDetails: [
      { id: 's1', signerName: 'Ann', signerEmail: 'a@x.com', status: 'Completed' },
      { id: 's2', signerName: 'Bob', signerEmail: 'b@x.com', status: 'NotCompleted' },
    ],
    ...over,
  })

  it('allows a signer who has not finished', () => {
    expect(assertEditableSigner(props(), 's2')).toMatchObject({ name: 'Bob', status: 'waiting' })
  })

  it('refuses a signer who has already signed, and says to send a correction', () => {
    expect(() => assertEditableSigner(props(), 's1')).toThrowError(/already signed/i)
    try { assertEditableSigner(props(), 's1') } catch (e) { expect(e.status).toBe(409) }
  })

  it('refuses a signer who declined', () => {
    const declined = props({
      signerDetails: [{ id: 's3', signerName: 'Cara', signerEmail: 'c@x.com', status: 'Declined' }],
    })
    expect(() => assertEditableSigner(declined, 's3')).toThrowError(/declined/i)
  })

  it('refuses somebody who is not on the document at all', () => {
    expect(() => assertEditableSigner(props(), 'nobody')).toThrowError(/not on this packet/i)
  })

  it('refuses ANY edit to a completed document — that is what a clone is for', () => {
    const done = props({ status: 'Completed' })
    expect(() => assertEditableSigner(done, 's2')).toThrowError(/fully signed/i)
    try { assertEditableSigner(done, 's2') } catch (e) { expect(e.status).toBe(409) }
  })
})

describe('buildAcknowledgementEdit', () => {
  it('builds exactly a Label plus a required Initial, addressed to one signer', () => {
    const payload = buildAcknowledgementEdit({ signerId: 's2', pageNumber: 3 })
    expect(payload.Signers).toHaveLength(1)
    const signer = payload.Signers[0]
    // Update, not Add: the party is already on the document, and adding them
    // again is a duplicate request in the same inbox.
    expect(signer.EditAction).toBe('Update')
    expect(signer.Id).toBe('s2')

    const [label, initial] = signer.FormFields
    expect(label).toMatchObject({
      EditAction: 'Add', FieldType: 'Label', PageNumber: 3,
      Bounds: ACK_LABEL_BOUNDS, Value: ACK_DEFAULT_LABEL,
    })
    expect(initial).toMatchObject({
      EditAction: 'Add', FieldType: 'Initial', PageNumber: 3,
      Bounds: ACK_INITIAL_BOUNDS, IsRequired: true,
    })
  })

  it('never sends a page below 1, whatever it is handed', () => {
    expect(buildAcknowledgementEdit({ signerId: 's1', pageNumber: 0 }).Signers[0].FormFields[0].PageNumber).toBe(1)
    expect(buildAcknowledgementEdit({ signerId: 's1', pageNumber: -4 }).Signers[0].FormFields[0].PageNumber).toBe(1)
    expect(buildAcknowledgementEdit({ signerId: 's1' }).Signers[0].FormFields[0].PageNumber).toBe(1)
  })

  it('copies the bounds rather than sharing the frozen defaults', () => {
    const a = buildAcknowledgementEdit({ signerId: 's1' })
    expect(a.Signers[0].FormFields[0].Bounds).not.toBe(ACK_LABEL_BOUNDS)
  })

  it('refuses to build an acknowledgement addressed to nobody', () => {
    expect(() => buildAcknowledgementEdit({})).toThrowError(/specific signer/i)
  })
})

describe('editDocumentFields — host fallback', () => {
  it('uses v1 and does not retry when it answers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResp('{"ok":true}'))
    vi.stubGlobal('fetch', fetchMock)
    await editDocumentFields('d1', { Message: 'x' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/document\/edit\?documentId=d1$/)
  })

  it('retries once on v1-beta when v1 does not serve the endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errResp(404))
      .mockResolvedValueOnce(okResp('{"ok":true}'))
    vi.stubGlobal('fetch', fetchMock)
    await editDocumentFields('d1', { Message: 'x' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/v1-beta\/document\/edit/)
  })

  it('does NOT retry a 400 — that is BoldSign rejecting the payload, not the host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResp(400, '{"message":"bad field"}'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(editDocumentFields('d1', {})).rejects.toThrow(/bad field/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 3 — a completed packet is cloned, never mutated.
// ─────────────────────────────────────────────────────────────────────────────
describe('createEmbeddedCloneUrl', () => {
  it('posts the prepare options as multipart, keeping the filled values', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResp('{"sendUrl":"https://app.boldsign.com/clone","documentId":"new-1"}'))
    vi.stubGlobal('fetch', fetchMock)

    const out = await createEmbeddedCloneUrl({ documentId: 'old-1', redirectUrl: 'https://crm/x' })
    expect(out).toEqual({ url: 'https://app.boldsign.com/clone', documentId: 'new-1' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toMatch(/\/document\/createEmbeddedCloneUrl\?documentId=old-1$/)
    expect(init.method).toBe('POST')
    const form = Object.fromEntries(init.body.entries())
    expect(form.ViewOption).toBe('PreparePage')
    expect(form.IncludeFormFieldValues).toBe('true')
    expect(form.ShowSendButton).toBe('true')
    expect(form.RedirectURL).toBe('https://crm/x')
    expect(Date.parse(form.LinkValidTill)).toBeGreaterThan(Date.now())
  })

  it('can be told not to carry the filled values over', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResp('{"sendUrl":"u"}'))
    vi.stubGlobal('fetch', fetchMock)
    await createEmbeddedCloneUrl({ documentId: 'old-1', includeValues: false })
    const form = Object.fromEntries(fetchMock.mock.calls[0][1].body.entries())
    expect(form.IncludeFormFieldValues).toBe('false')
  })

  it('answers with a null id when BoldSign does not mint one yet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResp('{"sendUrl":"u"}')))
    expect((await createEmbeddedCloneUrl({ documentId: 'old-1' })).documentId).toBeNull()
  })
})

describe('link expiry', () => {
  it('defaults to a day out and is a real ISO instant', () => {
    const now = Date.parse('2026-09-11T10:00:00Z')
    expect(linkValidTill(EDIT_LINK_HOURS, now)).toBe('2026-09-12T10:00:00.000Z')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 4 — a multi-template send asks for per-form downloads.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildMergePayload', () => {
  it('carries the templates, the roles and the download option', () => {
    const p = buildMergePayload({
      templateIds: ['t1', 't2'], title: '123 Main packet',
      roles: [{ roleIndex: 1, signerName: 'Ann', signerEmail: 'a@x.com' }],
      downloadOption: 'Individually',
    })
    expect(p.templateIds).toEqual(['t1', 't2'])
    expect(p.title).toBe('123 Main packet')
    expect(p.documentDownloadOption).toBe('Individually')
    expect(p.enableSigningOrder).toBe(true)
  })

  it('refuses a "merge" of one form — that is just a send', () => {
    expect(() => buildMergePayload({ templateIds: ['t1'] })).toThrowError(/at least two/i)
    expect(() => buildMergePayload({ templateIds: [] })).toThrowError(/at least two/i)
  })

  it('drops blank template ids before counting them', () => {
    expect(() => buildMergePayload({ templateIds: ['t1', '', null] })).toThrowError(/at least two/i)
  })

  it('omits the download option entirely rather than sending an empty one', () => {
    expect('documentDownloadOption' in buildMergePayload({ templateIds: ['a', 'b'] })).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ACCEPTANCE 4 + 6 — a completed Individually packet yields separate files.
// ─────────────────────────────────────────────────────────────────────────────
describe('downloadDocumentParts', () => {
  it('returns one combined PDF when BoldSign sends a PDF', async () => {
    const bytes = await pdf('combined')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawResp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))))
    const out = await downloadDocumentParts('d1')
    expect(out.parts).toEqual([])
    expect(out.combined.subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('unpacks the parts when BoldSign sends an archive', async () => {
    const archive = await zip([
      { name: 'Purchase Agreement.pdf', bytes: await pdf('purchase') },
      { name: 'Disclosures.pdf',        bytes: await pdf('disclosures') },
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawResp(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.length))))
    const out = await downloadDocumentParts('d1')
    expect(out.combined).toBeNull()
    expect(out.parts.map(p => p.name)).toEqual(['Purchase Agreement.pdf', 'Disclosures.pdf'])
    // Round-tripped intact, not just present: a part that unzips to something a
    // PDF reader cannot open is an upload a board rejects.
    expect(out.parts.every(p => p.bytes.subarray(0, 5).toString() === '%PDF-')).toBe(true)
    expect(out.parts[0].bytes.equals(out.parts[1].bytes)).toBe(false)
  })

  it('refuses an archive with no PDFs rather than filing an empty manifest', async () => {
    const archive = await zip([{ name: 'readme.txt', bytes: Buffer.from('not a pdf') }])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawResp(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.length))))
    await expect(downloadDocumentParts('d1')).rejects.toThrow(/no PDFs/i)
  })

  it('refuses an empty body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawResp(new ArrayBuffer(0))))
    await expect(downloadDocumentParts('d1')).rejects.toThrow(/empty file/i)
  })

  it('surfaces the refusal BoldSign itself gave, with its status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawResp(new ArrayBuffer(0), 404)))
    await expect(downloadDocumentParts('d1')).rejects.toMatchObject({ status: 404 })
  })
})

// A Supabase-shaped stub that records what was uploaded.
function fakeStorage() {
  const uploads = new Map()
  const client = {
    storage: {
      from: () => ({
        upload: (path, bytes) => { uploads.set(path, bytes); return Promise.resolve({ error: null }) },
      }),
    },
  }
  return { uploads, storage: client }
}

describe('archiveCompletedPacket', () => {
  it('stores one signed PDF for a Combined packet', async () => {
    const bytes = await pdf('combined')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawResp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))))
    const { storage, uploads } = fakeStorage()

    const out = await archiveCompletedPacket(storage, {
      dealId: 'deal-1', documentId: 'abcdefgh-1111', baseName: 'Purchase Agreement',
    })
    expect(uploads.size).toBe(1)
    expect(out.parts).toEqual([])
    expect(out.localFiles).toEqual([
      { kind: 'signed_pdf', path: out.signed.storagePath, form_name: 'Purchase Agreement' },
    ])
  })

  it('stores each part AND a locally-assembled whole for an Individually packet', async () => {
    const archive = await zip([
      { name: 'Purchase Agreement.pdf', bytes: await pdf('purchase') },
      { name: 'Disclosures.pdf',        bytes: await pdf('disclosures') },
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawResp(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.length))))
    const { storage, uploads } = fakeStorage()

    const out = await archiveCompletedPacket(storage, {
      dealId: 'deal-1', documentId: 'abcdefgh-1111', baseName: 'Listing packet',
    })

    // Two parts plus the assembled combined file — the Signatures tab's
    // "Download Signed PDF" resolves signed_storage_path and must not be a
    // button that cannot work.
    expect(uploads.size).toBe(3)
    expect(out.parts.map(p => p.form)).toEqual(['Purchase Agreement', 'Disclosures'])
    expect(out.signed).toBeTruthy()

    const kinds = out.localFiles.map(f => f.kind)
    expect(kinds[0]).toBe('signed_pdf')          // leads the manifest
    expect(kinds.filter(k => k === 'split_part')).toHaveLength(2)
    // Parts are numbered so two identically-named disclosures cannot overwrite
    // each other, and so they sort into signing order.
    expect(out.localFiles[1].path).toMatch(/part-01-Purchase-Agreement/)
    expect(out.localFiles[2].path).toMatch(/part-02-Disclosures/)
  })

  it('keeps the per-form parts even when the combined copy cannot be assembled', async () => {
    // The parts ARE the MLS deliverable; the assembled whole is a convenience
    // for the tab's Download Signed PDF button. Losing the parts because pdf-lib
    // choked on one file would throw away the only thing that cannot be rebuilt.
    const archive = await zip([
      { name: 'Good.pdf',   bytes: await pdf('good') },
      { name: 'Broken.pdf', bytes: Buffer.from('%PDF-1.4 not really a pdf') },
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawResp(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.length))))
    const { storage, uploads } = fakeStorage()

    const out = await archiveCompletedPacket(storage, {
      dealId: 'deal-1', documentId: 'abcdefgh-1111', baseName: 'Listing packet',
    })
    expect(out.parts).toHaveLength(2)
    expect(out.signed).toBeNull()
    expect(uploads.size).toBe(2)
    expect(out.localFiles.every(f => f.kind === 'split_part')).toBe(true)
  })

  it('returns nothing and reports the status when BoldSign refuses the download', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(rawResp(new ArrayBuffer(0), 404)))
    const { storage, uploads } = fakeStorage()
    const report = {}
    const out = await archiveCompletedPacket(storage, {
      dealId: 'deal-1', documentId: 'd1', baseName: 'x', report,
    })
    expect(out).toEqual({ signed: null, parts: [], localFiles: [] })
    expect(uploads.size).toBe(0)
    expect(report.status).toBe(404)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The timeline, and writing to a database that may be a migration behind.
// ─────────────────────────────────────────────────────────────────────────────
describe('packetEventKey', () => {
  it('is stable for the same delivery, so a redelivery updates one row', () => {
    const a = { documentId: 'd1', event: 'Signed', occurredAt: '2026-09-11T10:00:00Z', signerEmail: 'A@x.com' }
    expect(packetEventKey(a)).toBe(packetEventKey({ ...a, event: 'signed', signerEmail: 'a@x.com' }))
  })

  it('separates two different events on the same document', () => {
    expect(packetEventKey({ documentId: 'd1', event: 'Sent', occurredAt: '2026-09-11T10:00:00Z' }))
      .not.toBe(packetEventKey({ documentId: 'd1', event: 'Viewed', occurredAt: '2026-09-11T10:00:00Z' }))
  })

  it('does not fall back to "now" for a delivery with no timestamp', () => {
    // A key built from the clock would be unique on every retry, which is the
    // duplicate this exists to prevent.
    const k1 = packetEventKey({ documentId: 'd1', event: 'Sent' })
    const k2 = packetEventKey({ documentId: 'd1', event: 'Sent' })
    expect(k1).toBe(k2)
  })
})

describe('recordPacketEvent', () => {
  const upsertClient = (result) => {
    const calls = []
    return {
      calls,
      from: () => ({ upsert: (rows, opts) => { calls.push({ rows, opts }); return Promise.resolve(result) } }),
    }
  }

  it('upserts on the dedupe key', async () => {
    const svc = upsertClient({ error: null })
    const ok = await recordPacketEvent(svc, {
      dealId: 'deal-1', packetId: 'row-1', documentId: 'd1', event: 'Signed',
      status: 'sent', signerEmail: 'a@x.com', occurredAt: '2026-09-11T10:00:00Z',
    })
    expect(ok).toBe(true)
    expect(svc.calls[0].opts).toEqual({ onConflict: 'dedupe_key' })
    expect(svc.calls[0].rows[0].dedupe_key).toBe(packetEventKey({
      documentId: 'd1', event: 'Signed', occurredAt: '2026-09-11T10:00:00Z', signerEmail: 'a@x.com',
    }))
  })

  it('degrades quietly on a database without the table', async () => {
    const svc = upsertClient({ error: { code: '42P01', message: 'relation does not exist' } })
    expect(await recordPacketEvent(svc, { documentId: 'd1', event: 'Sent' })).toBe(false)
  })

  it('does nothing without a document or an event', async () => {
    const svc = upsertClient({ error: null })
    expect(await recordPacketEvent(svc, { event: 'Sent' })).toBe(false)
    expect(await recordPacketEvent(svc, { documentId: 'd1' })).toBe(false)
    expect(svc.calls).toHaveLength(0)
  })
})

describe('missingColumnName', () => {
  it('names the optional column a rejected write complained about', () => {
    expect(missingColumnName({ code: '42703', message: 'column "local_files" does not exist' })).toBe('local_files')
    expect(missingColumnName({ code: 'PGRST204', message: "Could not find the 'mode' column" })).toBe('mode')
  })

  it('returns nothing for an error that is not about a column we can drop', () => {
    expect(missingColumnName({ code: '23505', message: 'duplicate key value' })).toBeNull()
    expect(missingColumnName({ code: '42703', message: 'column "wat" does not exist' })).toBeNull()
  })
})

describe('patchPacket', () => {
  // An update client that rejects the named columns the way Postgres would.
  const client = (unknown = []) => {
    const seen = []
    return {
      seen,
      from: () => ({
        update: (patch) => ({
          eq: () => {
            seen.push(patch)
            const bad = unknown.find(c => c in patch)
            return Promise.resolve(bad
              ? { error: { code: '42703', message: `column "${bad}" does not exist` } }
              : { error: null })
          },
        }),
      }),
    }
  }

  it('writes everything when the database has every column', async () => {
    const svc = client()
    const out = await patchPacket(svc, 'row-1', { status: 'sent', local_files: [], mode: 'merged' })
    expect(out).toEqual({ ok: true, dropped: [] })
    expect(svc.seen).toHaveLength(1)
  })

  it('drops the columns a database behind on migrations cannot take, and says which', async () => {
    const svc = client(['local_files', 'mode'])
    const out = await patchPacket(svc, 'row-1', { status: 'completed', local_files: [], mode: 'merged' })
    expect(out.ok).toBe(true)
    expect(out.dropped.sort()).toEqual(['local_files', 'mode'])
    // The lifecycle status — the part that actually matters — still landed.
    expect(svc.seen.at(-1)).toEqual({ status: 'completed' })
  })

  it('gives up on an error that is not a missing column', async () => {
    const svc = {
      from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: { code: '23505', message: 'duplicate' } }) }) }),
    }
    expect((await patchPacket(svc, 'row-1', { status: 'sent' })).ok).toBe(false)
  })
})

describe('trackDocument with packet columns', () => {
  const insertClient = (unknown = []) => {
    const rows = []
    return {
      rows,
      from: () => ({
        insert: ([row]) => {
          rows.push(row)
          const bad = unknown.find(c => c in row)
          return Promise.resolve(bad
            ? { error: { code: '42703', message: `column "${bad}" does not exist` } }
            : { error: null })
        },
      }),
    }
  }

  it('records how the packet was composed and the settings BoldSign fixes at creation', async () => {
    const svc = insertClient()
    expect(await trackDocument(svc, {
      dealId: 'deal-1', agentId: 'ag-1', documentId: 'd1',
      signers: [{ signerName: 'Ann', signerEmail: 'a@x.com' }],
      documentName: 'Packet', status: 'sent',
      mode: 'merged', templateIds: ['t1', 't2'], mlsNumber: 'DM-1',
      downloadOption: 'Individually', files: [{ id: 'f1', name: 'A.pdf' }],
    })).toBe(true)
    expect(svc.rows[0]).toMatchObject({
      mode: 'merged', template_ids: ['t1', 't2'], mls_number: 'DM-1',
      download_option: 'Individually', signer_email: 'a@x.com',
    })
    // A merged packet has no single template, so the layout key stays null.
    expect(svc.rows[0].boldsign_template_id).toBeNull()
  })

  it('keeps the layout key when exactly one template went in', async () => {
    const svc = insertClient()
    await trackDocument(svc, { dealId: 'd', documentId: 'x', templateIds: ['t1'], mode: 'split' })
    expect(svc.rows[0].boldsign_template_id).toBe('t1')
  })

  it('still tracks the document on a database missing the packet columns', async () => {
    // An untracked document is the worst outcome in this file: it reaches a
    // client and then never updates, archives, or appears in the tab.
    const svc = insertClient(['mode', 'template_ids', 'download_option', 'mls_number', 'file_ids'])
    expect(await trackDocument(svc, {
      dealId: 'deal-1', documentId: 'd1', documentName: 'Packet', status: 'sent',
      mode: 'merged', templateIds: ['t1', 't2'], mlsNumber: 'DM-1',
      downloadOption: 'Individually', files: [{ id: 'f1' }],
    })).toBe(true)
    const last = svc.rows.at(-1)
    expect(last.document_id).toBe('d1')
    expect(last.status).toBe('sent')
    expect('mode' in last).toBe(false)
  })

  it('reports failure for an error it cannot work around', async () => {
    const svc = {
      from: () => ({ insert: () => Promise.resolve({ error: { code: '23505', message: 'duplicate key' } }) }),
    }
    expect(await trackDocument(svc, { dealId: 'd', documentId: 'x' })).toBe(false)
  })
})

describe('dealMlsNumber', () => {
  const dealClient = (data) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data }) }) }) }),
  })

  it('reads the number off the deal\'s property', async () => {
    expect(await dealMlsNumber(dealClient({ properties: { mls_number: 'DM-99213' } }), 'deal-1')).toBe('DM-99213')
  })

  it('answers null rather than failing a send when there is no listing number', async () => {
    expect(await dealMlsNumber(dealClient({ properties: null }), 'deal-1')).toBeNull()
    expect(await dealMlsNumber(dealClient(null), 'deal-1')).toBeNull()
    expect(await dealMlsNumber(dealClient({}), null)).toBeNull()
  })
})
