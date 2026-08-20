import { describe, it, expect } from 'vitest'
import { buildPacketZip, packetZipName, downloadBlob } from '../packetDownload.js'
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
