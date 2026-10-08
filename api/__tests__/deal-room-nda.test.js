/**
 * NDA before the Deal Room.
 *
 * What must hold:
 *
 *   1. NOTHING IS RELEASED UNSIGNED. With an NDA attached, registering records
 *      the lead but returns no OM URL and no room contents; deal_room and
 *      deal_room_doc refuse with 403 until the signature is on file.
 *   2. THE SIGNATURE IS EVIDENCE. Signing records the typed name, time, IP,
 *      browser and the SHA-256 of the exact NDA file, and stores a signed copy.
 *      If the record can't be written, the room stays shut.
 *   3. THE PUBLIC PAGE CAN'T SEE AROUND IT. The NDA's storage path never
 *      reaches a browser, and teaser mode can't be switched off under an NDA.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'

process.env.SCAN_SIGNING_SECRET = 'test-secret-for-scan-signing'
process.env.SUPABASE_SERVICE_KEY = 'test-service-key'

import {
  publicTeaserConfig, isTeaser, ndaRequired, cleanNdaSignature, mintAccess,
} from '../_lib/dealRoom.js'
import { buildSignedNda, sha256Hex } from '../_lib/ndaCertificate.js'

const MAILING_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
const LEAD_ID    = 'cccccccc-0000-0000-0000-000000000003'
const REG_ID     = 'eeeeeeee-0000-0000-0000-000000000005'
const NDA_PATH   = '1720000000000-nda/Riverside-CA.pdf'

const CFG = {
  headline: '24 Units in Riverside',
  cap_rate: '6.1', noi: '195000',
  images: ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'],
  om:  { path: 'x/Riverside-OM.pdf', filename: 'Riverside-OM.pdf', title: 'Riverside · OM' },
  nda: { path: NDA_PATH, filename: 'Riverside-CA.pdf', title: 'Confidentiality Agreement', size: 120_000 },
  deal_room: { documents: [{ id: 'doc-rr', path: 'y/rent-roll.xlsx', filename: 'rent-roll.xlsx', kind: 'rent_roll' }] },
}

let NDA_BYTES
beforeEach(async () => {
  if (!NDA_BYTES) {
    const d = await PDFDocument.create()
    d.addPage([612, 792]).drawText('The Recipient shall keep all Evaluation Material confidential.', { x: 50, y: 700, size: 11 })
    NDA_BYTES = await d.save()
  }
})

describe('pure rules', () => {
  it('strips the NDA path from the public page and says one is required', () => {
    const pub = publicTeaserConfig(CFG)
    expect(pub.nda).toBeUndefined()
    expect(JSON.stringify(pub)).not.toContain(NDA_PATH)
    expect(pub.deal_room.nda_required).toBe(true)
  })

  it('keeps teaser mode on under an NDA even if the agent turned it off', () => {
    const cfg = { ...CFG, teaser_mode: false }
    expect(isTeaser(cfg)).toBe(true)
    const pub = publicTeaserConfig(cfg)
    expect(pub.cap_rate).toBeUndefined()
    expect(pub.images).toHaveLength(3)
  })

  it('an NDA with no Deal Room behind it gates nothing', () => {
    expect(ndaRequired({ nda: CFG.nda })).toBe(false)
    expect(ndaRequired(CFG)).toBe(true)
  })

  it('a signature needs a name and an explicit agreement', () => {
    expect(cleanNdaSignature({ signer_name: 'J', agree: true }).error).toBeTruthy()
    expect(cleanNdaSignature({ signer_name: '1234', agree: true }).error).toBeTruthy()
    expect(cleanNdaSignature({ signer_name: 'Jane Investor', agree: 'yes' }).error).toBeTruthy()
    expect(cleanNdaSignature({ signer_name: '  Jane   Investor ', company: '', agree: true }))
      .toEqual({ name: 'Jane Investor', company: null })
  })

  it('the signed copy is the NDA plus a certificate page', async () => {
    const out = await buildSignedNda({
      ndaBytes: NDA_BYTES, ndaSha256: sha256Hex(NDA_BYTES), ndaFilename: 'Riverside-CA.pdf', propertyName: 'Riverside',
      signer: { name: 'Jane Ńvestor', company: 'Fund LLC', email: 'jane@fund.com', phone: '515', ip: '1.2.3.4', userAgent: 'UA', signedAt: '2026-10-08T15:00:00Z' },
    })
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(2)
  })

  it('still produces a certificate when the NDA PDF cannot be parsed', async () => {
    const out = await buildSignedNda({
      ndaBytes: new Uint8Array([1, 2, 3]), ndaSha256: 'abc', ndaFilename: 'x.pdf', propertyName: '',
      signer: { name: 'Jane', email: 'j@x.com', signedAt: '2026-10-08T15:00:00Z' },
    })
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1)
  })
})

// ─── Handler ────────────────────────────────────────────────────────────────

function mockRes() {
  return {
    headers: {}, statusCode: null, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this },
    status(c) { this.statusCode = c; return this },
    send(b) { this.body = b; return this },
    json(b) { this.body = b; return this },
    end() { return this },
  }
}

let inserts, upserts, updates, signCalls, uploads
let regRow        // the mailing_om_requests row for this visitor (null = none)
let updateError   // error returned from mailing_om_requests updates

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    rpc: async () => ({ data: [], error: null }),
    storage: {
      from: () => ({
        createSignedUrl: (path, ttl, opts) => {
          signCalls.push({ path, opts })
          return Promise.resolve({ data: { signedUrl: `https://storage.test/${path}` }, error: null })
        },
        download: async () => ({ data: new Blob([NDA_BYTES]), error: null }),
        upload: async (path, body, opts) => { uploads.push({ path, body, opts }); return { data: { path }, error: null } },
      }),
    },
    from: (table) => {
      let op = null
      const chain = {
        select: () => chain,
        insert: (rows) => { inserts.push({ table, rows }); return chain },
        upsert: (row, opts) => { upserts.push({ table, row, opts }); return chain },
        update: (patch) => { op = 'update'; updates.push({ table, patch }); return chain },
        delete: () => chain,
        eq: () => chain, in: () => chain, limit: () => chain, order: () => chain,
        single:      () => Promise.resolve(rowFor(table)),
        maybeSingle: () => Promise.resolve(rowFor(table)),
        then: (resolve) => resolve(op === 'update' && table === 'mailing_om_requests' && updateError
          ? { data: null, error: updateError }
          : { data: table === 'mailing_om_requests' && regRow ? [regRow] : [], error: null, count: 1 }),
      }
      return chain
    },
  }),
}))

function rowFor(table) {
  if (table === 'mailings')            return { data: { id: MAILING_ID, name: 'Riverside', agent_id: null, landing_config: CFG }, error: null }
  if (table === 'mailing_leads')       return { data: { id: LEAD_ID }, error: null }
  if (table === 'contacts')            return { data: { id: 'dddddddd-0000-0000-0000-000000000004' }, error: null }
  if (table === 'mailing_om_requests') return { data: regRow, error: null }
  return { data: null, error: null }
}

let handler
beforeEach(async () => {
  vi.resetModules()
  inserts = []; upserts = []; updates = []; signCalls = []; uploads = []
  regRow = null; updateError = null
  handler = (await import('../campaigns.js')).default
})

const call = async (body) => {
  const res = mockRes()
  await handler({
    method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (iPhone)', 'x-forwarded-for': '9.8.7.6' }, query: {},
    body: { mailing_id: MAILING_ID, ...body }, socket: { remoteAddress: '1.2.3.4' },
  }, res)
  return res
}

const GOOD = { name: 'Jane Investor', phone: '(515) 555-0134', email: 'jane@fund.com' }
const token = () => mintAccess({ mailingId: MAILING_ID, email: 'jane@fund.com' })

describe('om_request under an NDA', () => {
  it('records the lead but releases nothing until the NDA is signed', async () => {
    const res = await call({ action: 'om_request', ...GOOD })
    expect(res.statusCode).toBe(200)
    expect(res.body.nda_required).toBe(true)
    expect(res.body.url).toBeFalsy()
    expect(res.body.deal_room).toBeUndefined()
    expect(res.body.access_token).toBeTruthy()
    expect(res.body.nda).toEqual({ filename: 'Riverside-CA.pdf', title: 'Confidentiality Agreement', size: 120_000 })
    expect(signCalls).toHaveLength(0)
    expect(inserts.some(i => i.table === 'mailing_leads')).toBe(true)
  })

  it('lets someone who already signed straight in', async () => {
    regRow = { id: REG_ID, name: 'Jane Investor', nda_signed_at: '2026-10-01T00:00:00Z' }
    const res = await call({ action: 'om_request', ...GOOD })
    expect(res.body.nda_required).toBeUndefined()
    expect(res.body.url).toContain('Riverside-OM.pdf')
    expect(res.body.deal_room.financials.cap_rate).toBe('6.1')
  })
})

describe('deal_room / deal_room_doc refuse an unsigned visitor', () => {
  it('deal_room → 403 nda_required, no contents', async () => {
    regRow = { id: REG_ID, name: 'Jane Investor', nda_signed_at: null }
    const res = await call({ action: 'deal_room', access_token: token() })
    expect(res.statusCode).toBe(403)
    expect(res.body.nda_required).toBe(true)
    expect(res.body.deal_room).toBeUndefined()
    expect(res.body.visitor.first_name).toBe('Jane')
  })

  it('deal_room_doc → 403 and nothing signed', async () => {
    regRow = { id: REG_ID, name: 'Jane Investor', nda_signed_at: null }
    const res = await call({ action: 'deal_room_doc', access_token: token(), doc_id: 'doc-rr' })
    expect(res.statusCode).toBe(403)
    expect(signCalls).toHaveLength(0)
  })

  it('opens for a signer', async () => {
    regRow = { id: REG_ID, name: 'Jane Investor', nda_signed_at: '2026-10-01T00:00:00Z', visit_count: 1 }
    const res = await call({ action: 'deal_room_doc', access_token: token(), doc_id: 'doc-rr' })
    expect(res.statusCode).toBe(200)
    expect(signCalls[0].path).toBe('y/rent-roll.xlsx')
  })
})

describe('nda_view / nda_sign', () => {
  it('nda_view hands a registered visitor the agreement — and no one else', async () => {
    const ok = await call({ action: 'nda_view', access_token: token() })
    expect(ok.statusCode).toBe(200)
    expect(signCalls[0].path).toBe(NDA_PATH)
    const no = await call({ action: 'nda_view', access_token: 'forged.token' })
    expect(no.statusCode).toBe(401)
  })

  it('records the signature with the file hash, stores a signed copy, and opens the room', async () => {
    regRow = { id: REG_ID, name: 'Jane Investor', email: 'jane@fund.com', phone: '515-555-0134', nda_signed_at: null }
    const res = await call({ action: 'nda_sign', access_token: token(), signer_name: 'Jane Investor', company: 'Fund LLC', agree: true })

    expect(res.statusCode).toBe(200)
    const sig = updates.find(u => u.table === 'mailing_om_requests' && u.patch.nda_signed_at)
    expect(sig.patch).toMatchObject({
      nda_signer_name: 'Jane Investor', nda_signer_company: 'Fund LLC', nda_ip: '9.8.7.6',
      nda_path: NDA_PATH, nda_sha256: sha256Hex(NDA_BYTES),
    })
    expect(uploads).toHaveLength(1)
    expect(uploads[0].path).toMatch(new RegExp(`^nda-signed/${MAILING_ID}/${REG_ID}-`))
    expect(updates.some(u => u.patch.nda_signed_copy_path === uploads[0].path)).toBe(true)
    expect(inserts.some(i => i.table === 'deal_room_events' && i.rows.kind === 'nda_signed')).toBe(true)
    expect(res.body.url).toContain('Riverside-OM.pdf')
    expect(res.body.nda_copy_url).toContain('nda-signed/')
    expect(res.body.deal_room.documents.map(d => d.id)).toEqual(['om', 'doc-rr'])
  })

  it('refuses without the agreement box', async () => {
    regRow = { id: REG_ID, name: 'Jane Investor', nda_signed_at: null }
    const res = await call({ action: 'nda_sign', access_token: token(), signer_name: 'Jane Investor' })
    expect(res.statusCode).toBe(400)
    expect(updates).toHaveLength(0)
  })

  it('stays shut when the signature cannot be recorded', async () => {
    regRow = { id: REG_ID, name: 'Jane Investor', nda_signed_at: null }
    updateError = { message: 'column "nda_signed_at" does not exist' }
    const res = await call({ action: 'nda_sign', access_token: token(), signer_name: 'Jane Investor', agree: true })
    expect(res.statusCode).toBe(503)
    expect(res.body.deal_room).toBeUndefined()
    expect(res.body.url).toBeUndefined()
  })

  it('refuses someone who never registered', async () => {
    regRow = null
    const res = await call({ action: 'nda_sign', access_token: token(), signer_name: 'Jane Investor', agree: true })
    expect(res.statusCode).toBe(401)
  })
})
