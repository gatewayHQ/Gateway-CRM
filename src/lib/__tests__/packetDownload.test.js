import { describe, it, expect } from 'vitest'
import {
  buildPacketZip, packetZipName, downloadBlob, packetFiles, deliverPacket,
  uploadBatch, resolvePacketFiles, MAX_BATCH_GAP_MS,
} from '../packetDownload.js'
import { crc32, uniqueEntryNames, zipFiles } from '../zipFiles.js'

// Minimal zip reader — enough to prove every file made it into the archive, which
// is the whole point of the fix: a six-form packet used to deliver one PDF.
async function readZip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const entries = []
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (view.getUint32(i, true) !== 0x04034B50) continue
    const size = view.getUint32(i + 18, true)
    const nameLen = view.getUint16(i + 26, true)
    const start = i + 30 + nameLen + view.getUint16(i + 28, true)
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLen)),
      crc: view.getUint32(i + 14, true),
      data: bytes.subarray(start, start + size),
    })
  }
  // Trailing central directory must agree about how many entries there are.
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i--) if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break }
  return { entries, declared: eocd >= 0 ? view.getUint16(eocd + 10, true) : -1 }
}

const bytesFetch = (bodies) => {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const body = bodies[url]
    if (body === undefined) return { ok: false, status: 404 }
    if (body instanceof Error) throw body
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode(body).buffer }
  }
  return { impl, calls }
}

const PACKET_URLS = [
  { name: 'Exclusive Listing Agreement.pdf', url: 'https://s/1' },
  { name: 'Dual Agency Potential Consent.pdf', url: 'https://s/2' },
  { name: 'Appointed Agency Agreement.pdf', url: 'https://s/3' },
  { name: 'Agency Disclosure & Acknowledge.pdf', url: 'https://s/4' },
  { name: 'Ground Water Hazard.pdf', url: 'https://s/5' },
  { name: 'Mortgage Authorization.pdf', url: 'https://s/6' },
]

describe('buildPacketZip', () => {
  it('puts EVERY file in the packet into the archive, not just the first', async () => {
    const bodies = Object.fromEntries(PACKET_URLS.map((it, i) => [it.url, `pdf-${i}`]))
    const { impl, calls } = bytesFetch(bodies)

    const blob = await buildPacketZip(PACKET_URLS, { fetchImpl: impl })
    const { entries, declared } = await readZip(blob)

    expect(calls).toHaveLength(6)
    expect(entries.map(e => e.name)).toEqual(PACKET_URLS.map(it => it.name))
    expect(declared).toBe(6)
    expect(new TextDecoder().decode(entries[5].data)).toBe('pdf-5')
    expect(blob.type).toBe('application/zip')
  })

  it('preserves packet order even though the fetches run concurrently', async () => {
    const bodies = Object.fromEntries(PACKET_URLS.map((it, i) => [it.url, `pdf-${i}`]))
    const slowFirst = async (url) => {
      if (url === 'https://s/1') await new Promise(r => setTimeout(r, 20))
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode(bodies[url]).buffer }
    }
    const { entries } = await readZip(await buildPacketZip(PACKET_URLS, { fetchImpl: slowFirst }))
    expect(entries.map(e => e.name)).toEqual(PACKET_URLS.map(it => it.name))
  })

  it('records a CRC the entries can be verified against', async () => {
    const { impl } = bytesFetch({ 'https://s/1': 'hello' })
    const { entries } = await readZip(await buildPacketZip([{ name: 'a.pdf', url: 'https://s/1' }], { fetchImpl: impl }))
    expect(entries[0].crc).toBe(crc32(new TextEncoder().encode('hello')))
  })

  it('refuses a partial packet and names the files that failed', async () => {
    const bodies = { 'https://s/1': 'ok', 'https://s/3': 'ok' }   // 2 and 4-6 missing
    const { impl } = bytesFetch(bodies)
    await expect(buildPacketZip(PACKET_URLS, { fetchImpl: impl }))
      .rejects.toThrow(/4 of 6 forms could not be downloaded, so nothing was saved/)
  })

  it('treats a network error and an empty body as failures too', async () => {
    const boom = { impl: async () => { throw new Error('offline') } }
    await expect(buildPacketZip([{ name: 'a.pdf', url: 'https://s/1' }], { fetchImpl: boom.impl }))
      .rejects.toThrow(/a\.pdf \(offline\)/)
    const empty = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })
    await expect(buildPacketZip([{ name: 'a.pdf', url: 'https://s/1' }], { fetchImpl: empty }))
      .rejects.toThrow(/came back empty/)
  })

  it('complains rather than producing an empty archive when there is nothing to fetch', async () => {
    await expect(buildPacketZip([], { fetchImpl: async () => ({ ok: true }) })).rejects.toThrow(/No files/)
  })
})

describe('packetZipName', () => {
  it('names the archive after the packet', () => {
    expect(packetZipName({ state: 'IA', name: 'Iowa Agency Packet' })).toBe('IA - Iowa Agency Packet.zip')
  })
  it('never lets a packet name become a path', () => {
    expect(packetZipName({ state: 'IA', name: 'Listing 3/4 duplex' })).toBe('IA - Listing 3-4 duplex.zip')
  })
  it('falls back when the packet has no usable name', () => {
    expect(packetZipName({})).toBe('form packet.zip')
  })
})

describe('zipFiles entry names', () => {
  it('keeps two identically named forms apart', () => {
    expect(uniqueEntryNames(['Disclosure.pdf', 'Disclosure.pdf', 'Other.pdf']))
      .toEqual(['Disclosure.pdf', 'Disclosure (2).pdf', 'Other.pdf'])
  })
  it('refuses to build an archive with no entries', () => {
    expect(() => zipFiles([])).toThrow(/Nothing to zip/)
  })
})

describe('downloadBlob', () => {
  it('hands the archive over as a single click', () => {
    const events = []
    const anchor = { style: {}, click() { events.push(`click:${this.download}`) }, remove() { events.push('remove') } }
    const doc = { createElement: () => anchor, body: { appendChild: () => events.push('append') } }
    const win = { URL: { createObjectURL: () => { events.push('objectUrl'); return 'blob:z' }, revokeObjectURL: () => {} } }
    const res = downloadBlob({ size: 123 }, 'IA - Packet.zip', { doc, win })
    expect(events).toEqual(['objectUrl', 'append', 'click:IA - Packet.zip', 'remove'])
    expect(anchor.href).toBe('blob:z')
    expect(res).toEqual({ saved: true, bytes: 123, filename: 'IA - Packet.zip' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Regression: the two real packets that came down truncated.
//
// The Iowa Purchase Agreement is stored as five PDFs; the pipeline's Required
// Forms panel signed `storage_path` — the FIRST of them — so the agent got one
// section and nothing said the other four existed. The Buyer Agency Agreement
// is stored as its cover pages plus its addenda, and delivered the cover pages
// alone. Both buttons now run deliverPacket, so both packets arrive whole.
// ─────────────────────────────────────────────────────────────────────────────
const IOWA_PURCHASE = {
  id: 'ia-purchase',
  state: 'IA',
  name: 'Iowa Purchase Agreement',
  storage_path: 'IA/buyer/1-0-Bill of Sale.pdf',   // primary/first — all the old code looked at
  storage_paths: [
    { path: 'IA/buyer/1-0-Bill of Sale.pdf',            name: 'Bill of Sale.pdf' },
    { path: 'IA/buyer/1-1-Purchase Agreement.pdf',      name: 'Purchase Agreement.pdf' },
    { path: 'IA/buyer/1-2-Groundwater Hazard.pdf',      name: 'Groundwater Hazard.pdf' },
    { path: 'IA/buyer/1-3-Radon Disclosure.pdf',        name: 'Radon Disclosure.pdf' },
    { path: 'IA/buyer/1-4-Lead Paint Addendum.pdf',     name: 'Lead Paint Addendum.pdf' },
  ],
}

const BUYER_AGENCY = {
  id: 'ia-buyer-agency',
  state: 'IA',
  name: 'Buyer Agency Agreement',
  storage_path: 'IA/buyer/2-0-Buyer Agency pp1-3.pdf',
  storage_paths: [
    { path: 'IA/buyer/2-0-Buyer Agency pp1-3.pdf',   name: 'Buyer Agency pp1-3.pdf' },
    { path: 'IA/buyer/2-1-Buyer Agency pp4-8.pdf',   name: 'Buyer Agency pp4-8.pdf' },
    { path: 'IA/buyer/2-2-Agency Disclosure.pdf',    name: 'Agency Disclosure.pdf' },
  ],
}

// A stand-in for supabase.storage.from(bucket) that signs whatever it is asked for.
// `objects` is the bucket's contents; list() answers like Supabase's: the direct
// children of a folder, sub-folders as { name, id: null }, a page at a time.
function fakeStorage(objects = []) {
  const signed = []
  const listed = []
  return {
    signed,
    listed,
    list: async (folder, { limit = 100, offset = 0 } = {}) => {
      listed.push(folder)
      const kids = new Map()
      for (const path of objects) {
        if (!path.startsWith(`${folder}/`)) continue
        const rest = path.slice(folder.length + 1)
        const cut = rest.indexOf('/')
        kids.set(cut < 0 ? rest : rest.slice(0, cut), { name: cut < 0 ? rest : rest.slice(0, cut), id: cut < 0 ? rest : null })
      }
      return { data: [...kids.values()].slice(offset, offset + limit), error: null }
    },
    createSignedUrl: async (path, _exp, opts) => {
      signed.push(path)
      return { data: { signedUrl: `https://s/${encodeURIComponent(path)}` }, error: null, opts }
    },
    createSignedUrls: async (paths) => {
      signed.push(...paths)
      return { data: paths.map(path => ({ path, signedUrl: `https://s/${encodeURIComponent(path)}` })), error: null }
    },
  }
}

const fakeDom = () => {
  const clicks = []
  const anchor = { style: {}, click() { clicks.push(this.download) }, remove() {} }
  return {
    clicks,
    doc: { createElement: () => anchor, body: { appendChild: () => {} } },
    win: { URL: { createObjectURL: () => 'blob:z', revokeObjectURL: () => {} } },
  }
}

describe('packetFiles', () => {
  it('lists every file of a multi-file packet, not the primary one', () => {
    expect(packetFiles(IOWA_PURCHASE).map(f => f.name)).toEqual([
      'Bill of Sale.pdf', 'Purchase Agreement.pdf', 'Groundwater Hazard.pdf',
      'Radon Disclosure.pdf', 'Lead Paint Addendum.pdf',
    ])
    expect(packetFiles(BUYER_AGENCY)).toHaveLength(3)
  })

  it('falls back to the pre-0022 single-file column', () => {
    expect(packetFiles({ storage_path: 'IA/seller/9-0-Listing.pdf' }))
      .toEqual([{ path: 'IA/seller/9-0-Listing.pdf', name: 'Listing.pdf' }])
    expect(packetFiles({ storage_paths: [] , storage_path: 'IA/seller/9-0-Listing.pdf' })).toHaveLength(1)
  })

  it('names a file from its path when the row carries no name — the uploaded name, not the storage key', () => {
    expect(packetFiles({ storage_paths: [{ path: 'IA/buyer/1-0-Addendum.pdf' }] })[0].name).toBe('Addendum.pdf')
    expect(packetFiles({ storage_path: 'IA/buyer/1723000000000-0-2024 Addendum 3-1.pdf' })[0].name).toBe('2024 Addendum 3-1.pdf')
    expect(packetFiles({ storage_path: 'SD/seller/Listing Agreement.pdf' })[0].name).toBe('Listing Agreement.pdf')
  })

  it('is empty for a packet with nothing uploaded', () => {
    expect(packetFiles({})).toEqual([])
    expect(packetFiles(null)).toEqual([])
  })
})

describe('deliverPacket', () => {
  it('delivers the WHOLE Iowa Purchase Agreement, not just the Bill of Sale', async () => {
    const storage = fakeStorage()
    const dom = fakeDom()
    const bodies = Object.fromEntries(
      IOWA_PURCHASE.storage_paths.map((f, i) => [`https://s/${encodeURIComponent(f.path)}`, `section-${i}`]),
    )
    const { impl } = bytesFetch(bodies)

    const res = await deliverPacket(IOWA_PURCHASE, { storage, fetchImpl: impl, ...dom })

    expect(res).toEqual({ files: 5, zipped: true, recovered: 0 })
    expect(storage.signed).toEqual(IOWA_PURCHASE.storage_paths.map(f => f.path))
    expect(dom.clicks).toEqual(['IA - Iowa Purchase Agreement.zip'])
  })

  it('delivers every page-range file of the Buyer Agency Agreement', async () => {
    const storage = fakeStorage()
    const dom = fakeDom()
    const bodies = Object.fromEntries(
      BUYER_AGENCY.storage_paths.map((f, i) => [`https://s/${encodeURIComponent(f.path)}`, `pages-${i}`]),
    )
    const { impl } = bytesFetch(bodies)

    const res = await deliverPacket(BUYER_AGENCY, { storage, fetchImpl: impl, ...dom })

    expect(res).toEqual({ files: 3, zipped: true, recovered: 0 })
    expect(storage.signed).toEqual(BUYER_AGENCY.storage_paths.map(f => f.path))
  })

  it('still hands a genuinely single-file packet down as the PDF itself', async () => {
    const storage = fakeStorage()
    const dom = fakeDom()
    const res = await deliverPacket(
      { id: 'x', state: 'IA', name: 'Lead Paint', storage_paths: [{ path: 'IA/buyer/3-0-Lead.pdf', name: 'Lead Paint.pdf' }] },
      { storage, ...dom },
    )
    expect(res).toEqual({ files: 1, zipped: false, recovered: 0 })
    expect(dom.clicks).toEqual(['Lead Paint.pdf'])
  })

  it('refuses to hand over a partial packet when a file cannot be fetched', async () => {
    const storage = fakeStorage()
    const dom = fakeDom()
    // Only the first two of the five sections are readable.
    const bodies = Object.fromEntries(
      IOWA_PURCHASE.storage_paths.slice(0, 2).map((f, i) => [`https://s/${encodeURIComponent(f.path)}`, `section-${i}`]),
    )
    const { impl } = bytesFetch(bodies)

    await expect(deliverPacket(IOWA_PURCHASE, { storage, fetchImpl: impl, ...dom }))
      .rejects.toThrow(/3 of 5 forms could not be downloaded, so nothing was saved/)
    expect(dom.clicks).toEqual([])
  })

  it('names the forms it could not sign rather than zipping what it got', async () => {
    const storage = fakeStorage()
    storage.createSignedUrls = async (paths) => ({
      data: paths.map((path, i) => (i ? { path, signedUrl: `https://s/${i}` } : { path, error: 'not found' })),
      error: null,
    })
    await expect(deliverPacket(BUYER_AGENCY, { storage, ...fakeDom() }))
      .rejects.toThrow(/Couldn't prepare 1 of 3 forms.*Buyer Agency pp1-3\.pdf/)
  })

  it('complains instead of downloading nothing when the packet has no files', async () => {
    await expect(deliverPacket({ id: 'empty' }, { storage: fakeStorage() }))
      .rejects.toThrow(/No file uploaded/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Regression: the record that lists one file of a five-file upload.
//
// Until migration 0022 reached production, FormLibrary's save() answered the
// missing `storage_paths` column by retrying without it: every PDF went into the
// bucket and the row kept `storage_path` — file 1. 0022 then defaulted those
// rows to `[]`, and a later edit re-saved them as `storage_paths: [file 1]`.
// Both shapes read as a one-file packet, so Get Forms handed out file 1 and
// looked like it had worked. The rest of the upload is still in the bucket,
// under the `<Date.now()>-<i>-<name>` scheme, and that is what is delivered now.
// ─────────────────────────────────────────────────────────────────────────────
const T = 1_723_000_000_000
const IOWA_UPLOAD = [
  `IA/buyer/${T}-0-Purchase Agreement.pdf`,
  `IA/buyer/${T + 4_000}-1-Bill of Sale.pdf`,
  `IA/buyer/${T + 9_000}-2-Groundwater Hazard.pdf`,
  `IA/buyer/${T + 15_000}-3-Radon Disclosure.pdf`,
  `IA/buyer/${T + 20_000}-4-Lead Paint Addendum.pdf`,
]
const IOWA_NAMES = ['Purchase Agreement.pdf', 'Bill of Sale.pdf', 'Groundwater Hazard.pdf', 'Radon Disclosure.pdf', 'Lead Paint Addendum.pdf']
const TRUNCATED_BEFORE_0022 = { id: 'ia-buyer', state: 'IA', name: 'Iowa Buyer Contract Package', storage_path: IOWA_UPLOAD[0], storage_paths: [] }
const TRUNCATED_THEN_RESAVED = {
  ...TRUNCATED_BEFORE_0022,
  storage_paths: [{ path: IOWA_UPLOAD[0], name: 'Purchase Agreement.pdf' }],
}
const folderNames = (paths, folder = 'IA/buyer') => paths.filter(p => p.startsWith(`${folder}/`)).map(p => p.slice(folder.length + 1))

describe('uploadBatch', () => {
  it('rebuilds a five-file upload, in upload order, from its first file', () => {
    expect(uploadBatch(IOWA_UPLOAD[0], folderNames(IOWA_UPLOAD)))
      .toEqual(IOWA_UPLOAD.map((path, i) => ({ path, name: IOWA_NAMES[i] })))
  })

  it('stops where the next upload into the folder begins', () => {
    const single = `IA/buyer/${T}-0-Lead Paint.pdf`
    const nextUpload = [`IA/buyer/${T + 100}-0-A.pdf`, `IA/buyer/${T + 200}-1-B.pdf`]
    expect(uploadBatch(single, folderNames([single, ...nextUpload]))).toEqual([{ path: single, name: 'Lead Paint.pdf' }])
  })

  it('does not reach back to an earlier upload', () => {
    const earlier = [`IA/buyer/${T - 5_000}-0-Old.pdf`, `IA/buyer/${T - 4_000}-1-Old addendum.pdf`]
    const single = `IA/buyer/${T}-0-New.pdf`
    expect(uploadBatch(single, folderNames([...earlier, single]))).toHaveLength(1)
  })

  it('will not join a file uploaded long after the one before it', () => {
    const single = `IA/seller/${T}-0-X.pdf`
    const orphan = `IA/seller/${T + MAX_BATCH_GAP_MS + 1}-1-Y.pdf`
    expect(uploadBatch(single, folderNames([single, orphan], 'IA/seller'))).toHaveLength(1)
  })

  it('refuses to guess between two files claiming the same place', () => {
    const files = [`IA/seller/${T}-0-Listing.pdf`, `IA/seller/${T + 100}-1-A.pdf`, `IA/seller/${T + 200}-1-B.pdf`]
    expect(() => uploadBatch(files[0], folderNames(files, 'IA/seller'))).toThrow(/2 candidates for file 2.*nothing was saved/)
  })

  it('has nothing to rebuild for a file that did not start a Form Library upload', () => {
    expect(uploadBatch('SD/seller/Listing Agreement.pdf', ['Listing Agreement.pdf', 'Disclosure.pdf'])).toBeNull()
    expect(uploadBatch(IOWA_UPLOAD[1], folderNames(IOWA_UPLOAD))).toBeNull()
  })
})

describe('resolvePacketFiles', () => {
  it('trusts a record that already lists several files, without listing the bucket', async () => {
    const storage = fakeStorage([...IOWA_UPLOAD, `IA/buyer/${T + 21_000}-5-Stray.pdf`])
    const { items, recovered } = await resolvePacketFiles(IOWA_PURCHASE, { storage })
    expect(items).toHaveLength(5)
    expect(recovered).toBe(0)
    expect(storage.listed).toEqual([])
  })

  it('ignores sub-folders when it lists', async () => {
    const storage = fakeStorage([...IOWA_UPLOAD, `IA/buyer/archive/${T + 1_000}-1-Nested.pdf`])
    const { items } = await resolvePacketFiles(TRUNCATED_BEFORE_0022, { storage })
    expect(items.map(f => f.name)).toEqual(IOWA_NAMES)
  })

  it('reads a folder that runs past one page of listing', async () => {
    const filler = Array.from({ length: 1500 }, (_, i) => `IA/buyer/${T - 10_000_000 + i}-0-Old ${i}.pdf`)
    const { items } = await resolvePacketFiles(TRUNCATED_BEFORE_0022, { storage: fakeStorage([...filler, ...IOWA_UPLOAD]) })
    expect(items).toHaveLength(5)
  })

  it('refuses rather than guessing when the folder cannot be read', async () => {
    const storage = fakeStorage(IOWA_UPLOAD)
    storage.list = async () => ({ data: null, error: { message: 'permission denied' } })
    await expect(resolvePacketFiles(TRUNCATED_BEFORE_0022, { storage })).rejects.toThrow(/Couldn't check this packet's files: permission denied/)
  })
})

describe('deliverPacket — a record that lists only file 1', () => {
  const bodiesFor = (paths) => Object.fromEntries(paths.map((p, i) => [`https://s/${encodeURIComponent(p)}`, `form-${i}`]))

  for (const [label, packet] of [['storage_paths = []', TRUNCATED_BEFORE_0022], ['storage_paths = [file 1]', TRUNCATED_THEN_RESAVED]]) {
    it(`zips the whole upload when the row has ${label}`, async () => {
      const storage = fakeStorage(IOWA_UPLOAD)
      const dom = fakeDom()
      const { impl } = bytesFetch(bodiesFor(IOWA_UPLOAD))

      const res = await deliverPacket(packet, { storage, fetchImpl: impl, ...dom })

      expect(res).toEqual({ files: 5, zipped: true, recovered: 4 })
      expect(storage.listed).toEqual(['IA/buyer'])
      expect(storage.signed).toEqual(IOWA_UPLOAD)
      expect(dom.clicks).toEqual(['IA - Iowa Buyer Contract Package.zip'])
    })
  }

  it('puts every form in the archive under its uploaded name, in upload order', async () => {
    const blobs = []
    const dom = fakeDom()
    dom.win.URL.createObjectURL = (b) => { blobs.push(b); return 'blob:z' }
    const { impl } = bytesFetch(bodiesFor(IOWA_UPLOAD))

    await deliverPacket(TRUNCATED_BEFORE_0022, { storage: fakeStorage(IOWA_UPLOAD), fetchImpl: impl, ...dom })

    const { entries, declared } = await readZip(blobs[0])
    expect(declared).toBe(5)
    expect(entries.map(e => e.name)).toEqual(IOWA_NAMES)
    expect(entries.map(e => new TextDecoder().decode(e.data))).toEqual(['form-0', 'form-1', 'form-2', 'form-3', 'form-4'])
  })

  it('still refuses the whole packet when one recovered file cannot be fetched', async () => {
    const dom = fakeDom()
    const { impl } = bytesFetch(bodiesFor(IOWA_UPLOAD.slice(0, 4)))   // Lead Paint Addendum is gone
    await expect(deliverPacket(TRUNCATED_BEFORE_0022, { storage: fakeStorage(IOWA_UPLOAD), fetchImpl: impl, ...dom }))
      .rejects.toThrow(/1 of 5 forms could not be downloaded, so nothing was saved: Lead Paint Addendum\.pdf/)
    expect(dom.clicks).toEqual([])
  })

  it('hands a genuine one-file packet down as the PDF itself, under its real name', async () => {
    const single = `IA/buyer/${T}-0-Lead Paint.pdf`
    const storage = fakeStorage([single, `IA/buyer/${T + 100}-0-A.pdf`, `IA/buyer/${T + 200}-1-B.pdf`])
    const dom = fakeDom()

    const res = await deliverPacket({ id: 'lp', state: 'IA', name: 'Lead Paint', storage_path: single }, { storage, ...dom })

    expect(res).toEqual({ files: 1, zipped: false, recovered: 0 })
    expect(storage.signed).toEqual([single])
    expect(dom.clicks).toEqual(['Lead Paint.pdf'])
  })

  it('downloads nothing when it cannot tell which file is the packet', async () => {
    const files = [`IA/seller/${T}-0-Listing.pdf`, `IA/seller/${T + 100}-1-A.pdf`, `IA/seller/${T + 200}-1-B.pdf`]
    const storage = fakeStorage(files)
    const dom = fakeDom()
    await expect(deliverPacket({ id: 'amb', state: 'IA', name: 'Listing', storage_path: files[0] }, { storage, ...dom }))
      .rejects.toThrow(/nothing was saved/)
    expect(storage.signed).toEqual([])
    expect(dom.clicks).toEqual([])
  })
})
