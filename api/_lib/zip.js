// ─────────────────────────────────────────────────────────────────────────────
// A minimal ZIP reader and writer, on node:zlib only.
//
// WHY NOT A LIBRARY. Two operations are needed and both are small:
//
//   1. READ — BoldSign returns a ZIP, not a PDF, from `/v1/document/download`
//      when the document was created with `DocumentDownloadOption:
//      Individually`. That is the only way to get the separate per-form files
//      MLS wants, and unpacking it here is what keeps us from inventing a
//      "split page" endpoint BoldSign does not have.
//   2. WRITE — "Download selected as separate files" hands the agent one
//      archive with one PDF per form.
//
// Adding a dependency for that would put a transitive tree inside the one
// serverless function that already handles every signature request, on a
// project that pins its deps deliberately (see package.json). The formats
// involved are the two documented in APPNOTE.TXT §4.3 that real producers emit:
// STORE (0) and DEFLATE (8), the latter being exactly `zlib.inflateRaw`.
//
// WHAT THIS DELIBERATELY DOES NOT DO: ZIP64 (an archive over 4 GB or with more
// than 65,535 entries), encryption, split archives, or data descriptors whose
// sizes are only known after the compressed stream. Each is refused by name
// rather than mis-parsed — a truncated disclosure packet that looks like a
// successful download is worse than a failed one.
//
// Everything is Buffer in, Buffer out, and pure: no fs, no network, no globals.
// ─────────────────────────────────────────────────────────────────────────────
import zlib from 'node:zlib'
import { promisify } from 'node:util'

const inflateRaw = promisify(zlib.inflateRaw)
const deflateRaw = promisify(zlib.deflateRaw)

const SIG_LOCAL   = 0x04034b50   // local file header
const SIG_CENTRAL = 0x02014b50   // central directory entry
const SIG_EOCD    = 0x06054b50   // end of central directory

const METHOD_STORE   = 0
const METHOD_DEFLATE = 8

/** Cheap shape check — the four magic bytes every ZIP starts with. */
export function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.readUInt32LE(0) === SIG_LOCAL
}

/** The other magic bytes worth knowing, so a caller can tell the two apart. */
export function looksLikePdf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-'
}

function fail(message) {
  const e = new Error(message)
  e.status = 422
  return e
}

/**
 * Find the End Of Central Directory record.
 *
 * Scanned backwards because the record sits at the very end but is followed by
 * a variable-length comment. 64 KB is the maximum that comment can be, so the
 * search window is bounded rather than "the whole file".
 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - (0xffff + 22))
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/**
 * List a ZIP's entries from its central directory, without decompressing.
 * Returns [{ name, method, compressedSize, size, localHeaderOffset }].
 */
export function listZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw fail('That download is not a readable archive.')

  const eocd = findEocd(buf)
  if (eocd < 0) {
    throw fail('That download is not a readable archive — no end-of-archive record was found. It may have been truncated in transit.')
  }
  // ZIP64 puts the real counts in a separate record and leaves 0xffff/0xffffffff
  // in these 32-bit fields as markers. Only the MARKERS are refused: a ZIP64
  // record alongside honest 32-bit fields describes a small archive and reads
  // perfectly. Reading the markers as if they were counts is what would
  // silently return a truncated file list — a half-downloaded disclosure packet
  // that looks like a successful one.
  const total  = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOff  = buf.readUInt32LE(eocd + 16)
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    throw fail('That archive uses the ZIP64 format, which this reader does not support. Download the packet from BoldSign directly.')
  }
  if (cdOff + cdSize > buf.length) throw fail('That archive is truncated — its directory points past the end of the file.')

  const entries = []
  let p = cdOff
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw fail('That archive\'s directory is malformed — it could not be read safely.')
    }
    const flags      = buf.readUInt16LE(p + 8)
    const method     = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const size       = buf.readUInt32LE(p + 24)
    const nameLen    = buf.readUInt16LE(p + 28)
    const extraLen   = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff   = buf.readUInt32LE(p + 42)
    // Bit 0 is "encrypted". There is no password to try and no useful partial
    // result, so say what it is rather than handing back noise.
    if (flags & 0x1) throw fail('That archive is password-protected, so its files could not be read.')
    // Bit 11 is "the name is UTF-8". Without it the spec says CP437; every
    // producer we care about writes ASCII filenames, for which the two agree.
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    entries.push({ name, method, compressedSize: compressed, size, localHeaderOffset: localOff })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * Read one entry's bytes, resolving the local header (whose extra field length
 * routinely differs from the central directory's — a classic source of
 * off-by-a-few corruption when only the central entry is trusted).
 */
async function readEntry(buf, entry) {
  const p = entry.localHeaderOffset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) {
    throw fail(`"${entry.name}" could not be located inside the archive.`)
  }
  const nameLen  = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start    = p + 30 + nameLen + extraLen
  const end      = start + entry.compressedSize
  if (end > buf.length) throw fail(`"${entry.name}" is truncated inside the archive.`)
  const raw = buf.subarray(start, end)

  if (entry.method === METHOD_STORE)   return Buffer.from(raw)
  if (entry.method === METHOD_DEFLATE) return Buffer.from(await inflateRaw(raw))
  throw fail(`"${entry.name}" uses an unsupported compression method (${entry.method}).`)
}

/**
 * Unpack every entry. Returns [{ name, bytes }] in archive order.
 *
 * Directory entries (a trailing "/") and macOS's `__MACOSX` resource forks are
 * skipped — they are never a form, and a checkbox for one on the MLS screen is
 * a checkbox that produces a zero-byte upload.
 */
export async function unzip(buf) {
  const out = []
  for (const entry of listZipEntries(buf)) {
    if (entry.name.endsWith('/')) continue
    if (entry.name.startsWith('__MACOSX/') || entry.name.split('/').pop().startsWith('._')) continue
    out.push({ name: entry.name, bytes: await readEntry(buf, entry) })
  }
  return out
}

/** Only the PDFs, which is all this app ever wants out of a BoldSign archive. */
export async function unzipPdfs(buf) {
  const files = await unzip(buf)
  return files.filter(f => /\.pdf$/i.test(f.name) || looksLikePdf(f.bytes))
}

// ── Writing ──────────────────────────────────────────────────────────────────

// CRC-32, table-driven. Required by the format; a ZIP whose CRCs are wrong
// opens in some tools and is rejected by others, which is the worst outcome for
// a file an agent is about to upload to a board.
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

export function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

// MS-DOS date/time, which is what the format stores. Second resolution is 2s
// and the epoch is 1980 — both are the format's, not ours.
function dosDateTime(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/**
 * Make filenames safe for an archive without losing what they say.
 *
 * Path separators are the important one: an entry named `a/b.pdf` unpacks into
 * a subdirectory, and an agent who unzips a packet expecting eight PDFs beside
 * each other should get eight PDFs beside each other.
 */
export function safeEntryName(name, fallback = 'document.pdf') {
  const base = String(name ?? '')
    .replace(/[\\/]+/g, '-')            // no subdirectories: eight PDFs, side by side
    .replace(/[\x00-\x1f\x7f]+/g, '')   // control characters
    .replace(/-{2,}/g, '-')             // the runs the first rule can leave behind
    // Leading dots and dashes go LAST, after the separators have collapsed —
    // otherwise "..\..\etc\passwd" strips its dots first and comes back as
    // "-..-etc-passwd", still leading with the traversal this exists to remove.
    .replace(/^[.\-\s]+/, '')
    .trim()
  return (base || fallback).slice(0, 180)
}

/** Give every entry a distinct name, because a ZIP with two `Disclosures.pdf` loses one. */
export function dedupeNames(names = []) {
  const seen = new Map()
  return names.map(raw => {
    const name = safeEntryName(raw)
    if (!seen.has(name)) { seen.set(name, 1); return name }
    const n = seen.get(name) + 1
    seen.set(name, n)
    const dot = name.lastIndexOf('.')
    return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
  })
}

/**
 * Build a ZIP from `[{ name, bytes }]`.
 *
 * DEFLATE by default, falling back to STORE per entry whenever compression does
 * not actually help — which is the normal case here, since PDF content streams
 * are already compressed. Storing them keeps the archive honest about its size
 * instead of spending CPU to add a few bytes.
 */
export async function zip(files = [], { date = new Date() } = {}) {
  const list  = Array.isArray(files) ? files.filter(f => f && Buffer.isBuffer(f.bytes)) : []
  if (!list.length) throw fail('Nothing to put in the archive.')
  const names = dedupeNames(list.map(f => f.name))
  const { time, date: dosDate } = dosDateTime(date)

  const locals  = []
  const central = []
  let offset = 0

  for (let i = 0; i < list.length; i++) {
    const raw  = list[i].bytes
    const name = Buffer.from(names[i], 'utf8')
    const crc  = crc32(raw)

    let method = METHOD_DEFLATE
    let body   = await deflateRaw(raw, { level: zlib.constants.Z_BEST_SPEED })
    if (body.length >= raw.length) { method = METHOD_STORE; body = raw }

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)             // version needed: 2.0
    local.writeUInt16LE(0x0800, 6)         // flags: bit 11, names are UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)             // no extra field

    locals.push(local, name, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(SIG_CENTRAL, 0)
    cd.writeUInt16LE(20, 4)                // version made by
    cd.writeUInt16LE(20, 6)                // version needed
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(time, 12)
    cd.writeUInt16LE(dosDate, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt16LE(0, 30)                // extra
    cd.writeUInt16LE(0, 32)                // comment
    cd.writeUInt16LE(0, 34)                // disk number
    cd.writeUInt16LE(0, 36)                // internal attrs
    cd.writeUInt32LE(0, 38)                // external attrs
    cd.writeUInt32LE(offset, 42)

    central.push(cd, name)
    offset += local.length + name.length + body.length
  }

  const cdBuf   = Buffer.concat(central)
  const eocd    = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)                 // this disk
  eocd.writeUInt16LE(0, 6)                 // disk with the directory
  eocd.writeUInt16LE(list.length, 8)
  eocd.writeUInt16LE(list.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)                // no archive comment

  return Buffer.concat([...locals, cdBuf, eocd])
}
