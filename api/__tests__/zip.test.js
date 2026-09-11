import { describe, it, expect } from 'vitest'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import {
  zip, unzip, unzipPdfs, listZipEntries, looksLikeZip, looksLikePdf,
  crc32, safeEntryName, dedupeNames,
} from '../_lib/zip.js'

const bytes = (s) => Buffer.from(s)
// Text compresses; PDF-ish binary noise mostly does not. Both paths matter,
// because the writer picks STORE or DEFLATE per entry on which is smaller.
const compressible   = bytes('the quick brown fox '.repeat(200))
// Genuinely random, not a repeating pattern: deflate happily compresses
// `(i * 97 + 13) % 256` because it has a period, which would make this test
// assert the opposite of what it means to.
const incompressible = crypto.randomBytes(2048)

describe('shape checks', () => {
  it('tells a zip from a pdf from neither', async () => {
    const archive = await zip([{ name: 'a.txt', bytes: compressible }])
    expect(looksLikeZip(archive)).toBe(true)
    expect(looksLikePdf(archive)).toBe(false)
    expect(looksLikePdf(bytes('%PDF-1.7 hello'))).toBe(true)
    expect(looksLikeZip(bytes('%PDF-1.7 hello'))).toBe(false)
    expect(looksLikeZip(bytes('hi'))).toBe(false)
    expect(looksLikeZip(null)).toBe(false)
  })
})

describe('round trip', () => {
  it('writes and reads back every entry byte for byte', async () => {
    const archive = await zip([
      { name: 'Purchase Agreement.pdf', bytes: compressible },
      { name: 'Disclosures.pdf',        bytes: incompressible },
    ])
    const out = await unzip(archive)
    expect(out.map(f => f.name)).toEqual(['Purchase Agreement.pdf', 'Disclosures.pdf'])
    expect(out[0].bytes.equals(compressible)).toBe(true)
    expect(out[1].bytes.equals(incompressible)).toBe(true)
  })

  it('deflates what compresses and stores what does not', async () => {
    const archive = await zip([
      { name: 'text.txt', bytes: compressible },
      { name: 'noise.bin', bytes: incompressible },
    ])
    const [text, noise] = listZipEntries(archive)
    expect(text.method).toBe(8)          // DEFLATE
    expect(text.compressedSize).toBeLessThan(text.size)
    expect(noise.method).toBe(0)         // STORE — spending CPU to grow a file is worse than not
    expect(noise.compressedSize).toBe(noise.size)
  })

  it('records a correct CRC for every entry', async () => {
    const archive = await zip([{ name: 'a.bin', bytes: incompressible }])
    // Read the CRC straight out of the local header rather than trusting our own
    // reader: a wrong CRC opens in some tools and is rejected by others, which
    // is the worst outcome for a file an agent uploads to a board.
    expect(archive.readUInt32LE(14)).toBe(crc32(incompressible))
  })

  it('refuses to build an empty archive', async () => {
    await expect(zip([])).rejects.toThrow(/Nothing to put/i)
    await expect(zip([{ name: 'x', bytes: 'not a buffer' }])).rejects.toThrow(/Nothing to put/i)
  })
})

describe('entry names', () => {
  it('flattens path separators so a packet unzips as files side by side', () => {
    expect(safeEntryName('a/b/Purchase.pdf')).toBe('a-b-Purchase.pdf')
    expect(safeEntryName('..\\..\\etc\\passwd')).toBe('etc-passwd')
    expect(safeEntryName('')).toBe('document.pdf')
  })

  it('gives duplicates distinct names, because a zip with two of one loses one', () => {
    expect(dedupeNames(['Disclosures.pdf', 'Disclosures.pdf', 'Disclosures.pdf']))
      .toEqual(['Disclosures.pdf', 'Disclosures (2).pdf', 'Disclosures (3).pdf'])
    expect(dedupeNames(['readme', 'readme'])).toEqual(['readme', 'readme (2)'])
  })

  it('actually writes the deduped names', async () => {
    const archive = await zip([
      { name: 'Disclosures.pdf', bytes: compressible },
      { name: 'Disclosures.pdf', bytes: incompressible },
    ])
    expect((await unzip(archive)).map(f => f.name)).toEqual(['Disclosures.pdf', 'Disclosures (2).pdf'])
  })
})

// A STORE-only ZIP writer that writes names verbatim — no sanitizing, no
// deduping. Our own writer deliberately does both, so it cannot produce the
// archives this reader actually has to cope with (BoldSign's, and anything that
// has been through macOS).
function rawZip(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const crc  = crc32(e.bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.bytes.length, 18); local.writeUInt32LE(e.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, e.bytes)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(e.bytes.length, 20); cd.writeUInt32LE(e.bytes.length, 24)
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += local.length + name.length + e.bytes.length
  }
  const dir  = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(dir.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, eocd])
}

describe('reading archives from elsewhere', () => {
  it('skips directory entries and macOS resource forks', async () => {
    // Built by hand, because our own writer flattens path separators and would
    // never produce these names — but the archives this reader is pointed at
    // come from OTHER producers, which do.
    const archive = rawZip([
      { name: 'forms/',                  bytes: Buffer.alloc(0) },
      { name: 'forms/Purchase.pdf',      bytes: bytes('%PDF-1.4 real') },
      { name: '__MACOSX/._Purchase.pdf', bytes: bytes('resource fork') },
    ])
    expect((await unzip(archive)).map(f => f.name)).toEqual(['forms/Purchase.pdf'])
  })

  it('keeps only the PDFs when asked', async () => {
    const archive = await zip([
      { name: 'Purchase.pdf', bytes: bytes('%PDF-1.4 real') },
      { name: 'manifest.txt', bytes: bytes('nothing to see') },
      // No extension, but the bytes say PDF — a producer that names files by id.
      { name: 'anonymous',    bytes: bytes('%PDF-1.4 also real') },
    ])
    expect((await unzipPdfs(archive)).map(f => f.name)).toEqual(['Purchase.pdf', 'anonymous'])
  })

  it('refuses something that is not an archive at all', () => {
    expect(() => listZipEntries(bytes('%PDF-1.4 this is a pdf'))).toThrow(/not a readable archive/i)
    expect(() => listZipEntries(Buffer.alloc(4))).toThrow(/not a readable archive/i)
  })

  it('refuses a truncated archive rather than returning half a packet', async () => {
    const archive = await zip([{ name: 'a.pdf', bytes: compressible }])
    expect(() => listZipEntries(archive.subarray(0, archive.length - 30))).toThrow(/not a readable archive|truncated/i)
  })

  it('refuses ZIP64 by name instead of silently reading the marker as a count', async () => {
    const archive = await zip([{ name: 'a.pdf', bytes: compressible }])
    const forged = Buffer.from(archive)
    // Stamp the "the real count is in the ZIP64 record" marker into the EOCD.
    forged.writeUInt16LE(0xffff, forged.length - 22 + 10)
    expect(() => listZipEntries(forged)).toThrow(/ZIP64/i)
  })

  it('refuses an encrypted archive with a sentence rather than returning noise', async () => {
    const archive = await zip([{ name: 'a.pdf', bytes: compressible }])
    const forged = Buffer.from(archive)
    // Set the "encrypted" flag on the central-directory entry.
    const cdOff = forged.readUInt32LE(forged.length - 22 + 16)
    forged.writeUInt16LE(0x1, cdOff + 8)
    expect(() => listZipEntries(forged)).toThrow(/password-protected/i)
  })

  it('reads an archive whose local header carries an extra field the directory does not', async () => {
    // The classic corruption: trusting the CENTRAL entry's extra-field length
    // when resolving the local header. Built by hand so the two genuinely differ.
    const name = Buffer.from('a.pdf')
    const data = Buffer.from('%PDF-1.4 body')
    const extra = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd])   // local only
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10); cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28); cd.writeUInt16LE(0, 30)   // NO extra here
    cd.writeUInt32LE(0, 42)

    const front = Buffer.concat([local, name, extra, data])
    const dir   = Buffer.concat([cd, name])
    const eocd  = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(dir.length, 12); eocd.writeUInt32LE(front.length, 16)

    const out = await unzip(Buffer.concat([front, dir, eocd]))
    expect(out[0].bytes.equals(data)).toBe(true)
  })

  it('names the compression method it cannot handle', async () => {
    const archive = await zip([{ name: 'a.pdf', bytes: compressible }])
    const forged = Buffer.from(archive)
    const cdOff = forged.readUInt32LE(forged.length - 22 + 16)
    forged.writeUInt16LE(14, cdOff + 10)   // LZMA, in the central directory
    forged.writeUInt16LE(14, 8)            // and in the local header
    await expect(unzip(forged)).rejects.toThrow(/unsupported compression method \(14\)/i)
  })
})

describe('crc32', () => {
  it('matches node\'s own implementation', () => {
    // zlib.crc32 exists on modern Node; where it does not, the round-trip tests
    // above already prove the value we write is the one a reader expects.
    if (typeof zlib.crc32 !== 'function') return
    expect(crc32(compressible)).toBe(zlib.crc32(compressible))
    expect(crc32(Buffer.alloc(0))).toBe(zlib.crc32(Buffer.alloc(0)))
  })
})
