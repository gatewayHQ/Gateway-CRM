import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { unzip } from '../_lib/zip.js'

// ─────────────────────────────────────────────────────────────────────────────
// The MLS packager, exercised end to end against stubbed auth and storage.
//
// The thing being proved is the spec's own claim: an MLS pack is assembled from
// PDFs already on the deal and NEVER goes back through BoldSign. Every test here
// asserts that with a fetch stub that fails loudly if the handler calls out.
// ─────────────────────────────────────────────────────────────────────────────

const AGENT = { id: 'agent-1', name: 'Dana', email: 'dana@x.com' }
const DEAL  = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

let authState
vi.mock('../_lib/auth.js', () => ({
  requireAgent: async () => authState.actor,
  errorResponse: (res, err) => res.status(err?.status || 500).json({ error: err?.message || 'Server error' }),
  getServiceClient: () => authState.svc,
  // The caller's own client — this is what decides whether they may see the
  // deal at all, and the handler must use it rather than the service key.
  getUserClient: () => authState.userClient,
}))

const { default: mlsPackHandler } = await import('../_handlers/mls-pack.js')

// Returns an ArrayBuffer sized to the PDF, which is what Supabase's download
// gives back. `Buffer.prototype.buffer` will not do: Node pools small buffers,
// so it hands back the whole pool and the %PDF- check reads somebody else's
// bytes at offset 0.
async function pdf(marker, pages = 1) {
  const doc  = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < pages; i++) {
    doc.addPage([612, 792]).drawText(`${marker} ${i + 1}`, { x: 50, y: 700, size: 14, font })
  }
  const buf = Buffer.from(await doc.save())
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)
}

function fakeRes() {
  const out = { statusCode: 200, body: null }
  out.status = (c) => { out.statusCode = c; return out }
  out.json = (b) => { out.body = b; return out }
  return out
}

// A Supabase-shaped stub: the packet rows, the storage objects, and a record of
// everything written.
function setup({ rows = [], objects = {}, visible = true, isAdmin = false } = {}) {
  const uploads = new Map()
  const updates = []
  const inserts = []

  const svc = {
    from: (table) => {
      if (table === 'boldsign_documents') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => Promise.resolve({ data: rows, error: null }),
          update: (patch) => ({ eq: (_c, v) => { updates.push({ patch, id: v }); return Promise.resolve({ error: null }) } }),
        }
        return chain
      }
      return { insert: (r) => { inserts.push(r); return Promise.resolve({ error: null }) } }
    },
    storage: {
      from: () => ({
        download: (path) => Promise.resolve(objects[path]
          ? { data: { arrayBuffer: async () => objects[path] }, error: null }
          : { data: null, error: { message: 'Object not found' } }),
        upload: (path, bytes) => { uploads.set(path, bytes); return Promise.resolve({ error: null }) },
        createSignedUrl: (path) => Promise.resolve({ data: { signedUrl: `https://storage.test/${path}?sig=1` }, error: null }),
      }),
    },
  }

  authState = {
    actor: { agent: AGENT, isAdmin },
    svc,
    userClient: {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: visible ? { id: DEAL } : null }) }) }) }),
    },
  }
  return { uploads, updates, inserts }
}

// If the handler ever calls BoldSign, this fails the test by name.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('the MLS packager must never call BoldSign') }))
})

const call = async (body) => {
  const res = fakeRes()
  await mlsPackHandler({ body }, res)
  return res
}

describe('access', () => {
  it('refuses a deal the caller cannot see', async () => {
    setup({ visible: false })
    const res = await call({ deal_id: DEAL, mode: 'list' })
    expect(res.statusCode).toBe(403)
    expect(res.body.error).toMatch(/do not have access/i)
  })

  it('lets an admin through even when the deal is not in their own scope', async () => {
    setup({ visible: false, isAdmin: true, rows: [] })
    expect((await call({ deal_id: DEAL, mode: 'list' })).statusCode).toBe(200)
  })

  it('refuses a request with no deal', async () => {
    setup()
    expect((await call({ mode: 'list' })).statusCode).toBe(400)
  })
})

describe('list', () => {
  const rows = [{
    id: 'r1', document_id: 'd1', document_name: 'Purchase Agreement', status: 'completed',
    completed_at: '2026-09-01T00:00:00Z',
    local_files: [
      { kind: 'signed_pdf', path: 'deal-1/signed-purchase.pdf', form_name: 'Purchase Agreement', pages: 2 },
      { kind: 'audit',      path: 'deal-1/audit-purchase.pdf',  form_name: 'Audit' },
    ],
  }]

  it('offers the signed forms and never the audit trail', async () => {
    setup({ rows })
    const res = await call({ deal_id: DEAL, mode: 'list' })
    expect(res.statusCode).toBe(200)
    expect(res.body.files.map(f => f.form_name)).toEqual(['Purchase Agreement'])
  })

  it('names a completed packet whose PDF has not been archived yet, and how to fix it', async () => {
    setup({ rows: [{ id: 'r9', document_id: 'd9', document_name: 'Lead Paint', status: 'completed', local_files: [] }] })
    const res = await call({ deal_id: DEAL, mode: 'list' })
    expect(res.body.files).toEqual([])
    expect(res.body.unarchived).toEqual([{ documentId: 'd9', documentName: 'Lead Paint' }])
  })

  it('says which migration is missing rather than showing an empty checklist', async () => {
    authState = null
    setup()
    authState.svc.from = () => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: { code: '42703', message: 'column "local_files" does not exist' } }) }) }),
    })
    const res = await call({ deal_id: DEAL, mode: 'list' })
    expect(res.statusCode).toBe(501)
    expect(res.body.error).toMatch(/0046_signature_packets\.sql/)
  })
})

describe('packing', () => {
  const objects = {}
  const rows = [
    {
      id: 'r1', document_id: 'd1', document_name: 'Purchase Agreement', status: 'completed',
      completed_at: '2026-09-01T00:00:00Z', mls_number: 'DM-99213',
      local_files: [
        { kind: 'split_part', path: 'deal-1/part-01-Purchase.pdf',    form_name: 'Purchase Agreement', pages: 2 },
        { kind: 'split_part', path: 'deal-1/part-02-Disclosures.pdf', form_name: 'Disclosures',       pages: 1 },
      ],
    },
    {
      id: 'r2', document_id: 'd2', document_name: 'Correction', status: 'completed',
      completed_at: '2026-09-05T00:00:00Z', correction_of_document_id: 'd1',
      local_files: [{ kind: 'signed_pdf', path: 'deal-1/signed-ack.pdf', form_name: 'Acknowledgement', pages: 1 }],
    },
  ]

  beforeEach(async () => {
    objects['deal-1/part-01-Purchase.pdf']    = (await pdf('purchase', 2))
    objects['deal-1/part-02-Disclosures.pdf'] = (await pdf('disclosures', 1))
    objects['deal-1/signed-ack.pdf']          = (await pdf('acknowledgement', 1))
  })

  // ── ACCEPTANCE 6 ──────────────────────────────────────────────────────────
  it('zips one file per selected form, named for the form', async () => {
    const { uploads } = setup({ rows, objects })
    const res = await call({
      deal_id: DEAL, mode: 'zip',
      fileIds: ['deal-1/part-01-Purchase.pdf', 'deal-1/part-02-Disclosures.pdf'],
    })
    expect(res.statusCode).toBe(200)
    expect(res.body.count).toBe(2)
    expect(res.body.filename).toMatch(/^MLS-DM-99213-.*-2files\.zip$/)

    const [[path, bytes]] = [...uploads.entries()]
    expect(path).toMatch(/^deal-.*\/mls\/\d+-MLS-DM-99213/)
    const entries = await unzip(bytes)
    expect(entries.map(e => e.name)).toEqual(['Purchase Agreement.pdf', 'Disclosures.pdf'])
    expect(entries.every(e => e.bytes.subarray(0, 5).toString() === '%PDF-')).toBe(true)
  })

  // ── ACCEPTANCE 5 ──────────────────────────────────────────────────────────
  it('merges two completed PDFs into one file without calling BoldSign', async () => {
    const { uploads } = setup({ rows, objects })
    const res = await call({
      deal_id: DEAL, mode: 'merge', coverSheet: false,
      fileIds: ['deal-1/part-01-Purchase.pdf', 'deal-1/signed-ack.pdf'],
    })
    expect(res.statusCode).toBe(200)
    expect(res.body.filename).toMatch(/\.pdf$/)

    const merged = await PDFDocument.load([...uploads.values()][0])
    expect(merged.getPageCount()).toBe(3)      // 2 + 1, no cover
    // The fetch stub throws if anything reaches BoldSign; getting here proves it did not.
    expect(fetch).not.toHaveBeenCalled()
  })

  it('honors the order the agent chose, because filing order is a requirement', async () => {
    setup({ rows, objects })
    const reversed = await call({
      deal_id: DEAL, mode: 'merge', coverSheet: false,
      fileIds: ['deal-1/part-01-Purchase.pdf', 'deal-1/part-02-Disclosures.pdf'],
      order:   ['deal-1/part-02-Disclosures.pdf', 'deal-1/part-01-Purchase.pdf'],
    })
    expect(reversed.body.forms).toEqual(['Disclosures', 'Purchase Agreement'])

    setup({ rows, objects })
    const natural = await call({
      deal_id: DEAL, mode: 'merge', coverSheet: false,
      fileIds: ['deal-1/part-01-Purchase.pdf', 'deal-1/part-02-Disclosures.pdf'],
    })
    expect(natural.body.forms).toEqual(['Purchase Agreement', 'Disclosures'])
  })

  it('adds a cover sheet when asked, and one page only', async () => {
    const { uploads } = setup({ rows, objects })
    await call({
      deal_id: DEAL, mode: 'merge', coverSheet: true, address: '1420 Grand Ave',
      fileIds: ['deal-1/part-01-Purchase.pdf', 'deal-1/part-02-Disclosures.pdf'],
    })
    const merged = await PDFDocument.load([...uploads.values()][0])
    expect(merged.getPageCount()).toBe(4)      // 1 cover + 2 + 1
  })

  // ── ACCEPTANCE 7 ──────────────────────────────────────────────────────────
  it('packs an original with its correction, original first', async () => {
    setup({ rows, objects })
    const res = await call({ deal_id: DEAL, mode: 'merge', coverSheet: false, correctionOf: 'd1' })
    expect(res.statusCode).toBe(200)
    // Original first, then the acknowledgement that corrects it — the order the
    // phrase "original + acknowledgement" describes, and a filing requirement.
    expect(res.body.forms).toEqual(['Purchase Agreement', 'Disclosures', 'Acknowledgement'])
  })

  it('selects by preset', async () => {
    setup({ rows, objects })
    const res = await call({ deal_id: DEAL, mode: 'zip', preset: 'listing' })
    expect(res.statusCode).toBe(200)
    expect(res.body.forms).toEqual(['Disclosures'])
  })

  it('says so when a preset matches nothing, rather than packing nothing', async () => {
    setup({ rows: [rows[1]], objects })
    const res = await call({ deal_id: DEAL, mode: 'zip', preset: 'listing' })
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toMatch(/no completed forms.*match/i)
  })

  it('records the bundle on the packet so the deal remembers what MLS was given', async () => {
    const { updates } = setup({ rows, objects })
    await call({ deal_id: DEAL, mode: 'zip', fileIds: ['deal-1/part-01-Purchase.pdf'] })
    const manifest = updates.at(-1)?.patch?.local_files || []
    expect(manifest.some(f => f.kind === 'mls_bundle')).toBe(true)
    // The forms it was built from are untouched — a bundle is added, never
    // substituted for the files it came from.
    expect(manifest.filter(f => f.kind === 'split_part')).toHaveLength(2)
  })
})

describe('refusals', () => {
  it('packs nothing at all when one selected form cannot be read', async () => {
    // Partial is the worst outcome: the agent uploads it, the board accepts it,
    // and the gap surfaces at closing.
    const objects = { 'deal-1/a.pdf': await pdf('a') }
    const { uploads } = setup({
      objects,
      rows: [{
        id: 'r1', document_id: 'd1', document_name: 'Packet', status: 'completed',
        completed_at: '2026-09-01T00:00:00Z',
        local_files: [
          { kind: 'split_part', path: 'deal-1/a.pdf',       form_name: 'A' },
          { kind: 'split_part', path: 'deal-1/missing.pdf', form_name: 'B' },
        ],
      }],
    })
    const res = await call({ deal_id: DEAL, mode: 'zip', fileIds: ['deal-1/a.pdf', 'deal-1/missing.pdf'] })
    expect(res.statusCode).toBe(502)
    expect(res.body.error).toMatch(/could not be read, so nothing was packed/i)
    expect(uploads.size).toBe(0)
  })

  it('refuses a selection that names a file no longer on the deal', async () => {
    setup({ rows: [] })
    const res = await call({ deal_id: DEAL, mode: 'zip', fileIds: ['deal-1/ghost.pdf'] })
    expect(res.statusCode).toBe(409)
    expect(res.body.missing).toEqual(['deal-1/ghost.pdf'])
  })

  it('refuses a merge of one form and says to download it instead', async () => {
    const objects = { 'deal-1/a.pdf': await pdf('a') }
    setup({
      objects,
      rows: [{
        id: 'r1', document_id: 'd1', document_name: 'P', status: 'completed', completed_at: '2026-09-01T00:00:00Z',
        local_files: [{ kind: 'signed_pdf', path: 'deal-1/a.pdf', form_name: 'A' }],
      }],
    })
    const res = await call({ deal_id: DEAL, mode: 'merge', fileIds: ['deal-1/a.pdf'] })
    expect(res.statusCode).toBe(400)
    expect(res.body.error).toMatch(/on its own/i)
  })

  it('refuses an unknown mode', async () => {
    setup()
    expect((await call({ deal_id: DEAL, mode: 'email-it' })).statusCode).toBe(400)
  })
})
