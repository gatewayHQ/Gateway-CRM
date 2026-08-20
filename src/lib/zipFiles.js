// ─────────────────────────────────────────────────────────────────────────────
// zipFiles — bundle several files into one .zip in the browser.
//
// Written here rather than pulled in as a dependency because the need is narrow:
// a form packet is a handful of PDFs that must arrive as ONE download. Entries are
// STORED (no deflate) — a PDF's bytes are already compressed, so deflating them
// would buy a percent or two for a compressor's worth of code.
//
// Why one archive at all: the Form Library used to click a hidden <a> per file with
// a stagger between them. Chrome treats every download after the first as an
// "automatic download" once the awaits have broken out of the click's user-gesture
// context, and blocks it silently — no error, no prompt, so a six-form packet
// delivered exactly one PDF. A single archive is one download from one gesture,
// which no browser blocks.
// ─────────────────────────────────────────────────────────────────────────────

let CRC_TABLE
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE
  CRC_TABLE = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    CRC_TABLE[i] = c >>> 0
  }
  return CRC_TABLE
}

/** CRC-32 of a byte array, as the zip format defines it. */
export function crc32(bytes) {
  const t = crcTable()
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** Strip anything that cannot live in a zip entry name (no paths, no control chars). */
export function safeEntryName(name, fallback = 'file') {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return clean || fallback
}

/**
 * Make every entry name unique — a packet can legitimately hold two files called
 * "Disclosure.pdf", and duplicate names inside an archive unzip unpredictably
 * (on most tools one silently overwrites the other).
 */
export function uniqueEntryNames(names) {
  const seen = new Map()
  return (names || []).map(raw => {
    const name = safeEntryName(raw)
    const key = name.toLowerCase()
    const n = seen.get(key) || 0
    seen.set(key, n + 1)
    if (!n) return name
    const dot = name.lastIndexOf('.')
    return dot > 0 ? `${name.slice(0, dot)} (${n + 1})${name.slice(dot)}` : `${name} (${n + 1})`
  })
}

// MS-DOS date/time, the only timestamp the base zip format carries.
function dosStamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date(0)
  const year = Math.max(1980, d.getFullYear())
  return {
    time: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F),
    date: (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F),
  }
}

/**
 * Build a zip archive from `[{ name, data: Uint8Array }]`.
 * Returns a Blob (`application/zip`) ready for a download anchor.
 */
export function zipFiles(files, { date = new Date(), Blob: BlobImpl = (typeof Blob !== 'undefined' ? Blob : undefined) } = {}) {
  const list = (files || []).filter(f => f && f.data)
  if (!list.length) throw new Error('Nothing to zip')
  if (!BlobImpl) throw new Error('Blob is not available in this environment')
  const names = uniqueEntryNames(list.map(f => f.name))
  const stamp = dosStamp(date)
  const encoder = new TextEncoder()

  const parts = []        // pieces of the archive body, in order
  const central = []      // central-directory records, built as we go
  let offset = 0

  list.forEach((file, i) => {
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data)
    const nameBytes = encoder.encode(names[i])
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034B50, true)   // local file header signature
    lv.setUint16(4, 20, true)            // version needed: 2.0
    lv.setUint16(6, 0x0800, true)        // flags: UTF-8 names
    lv.setUint16(8, 0, true)             // method: stored
    lv.setUint16(10, stamp.time, true)
    lv.setUint16(12, stamp.date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)  // compressed size
    lv.setUint32(22, data.length, true)  // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)            // extra field length
    local.set(nameBytes, 30)

    parts.push(local, data)

    const dir = new Uint8Array(46 + nameBytes.length)
    const dv = new DataView(dir.buffer)
    dv.setUint32(0, 0x02014B50, true)   // central directory header signature
    dv.setUint16(4, 20, true)            // version made by
    dv.setUint16(6, 20, true)            // version needed
    dv.setUint16(8, 0x0800, true)
    dv.setUint16(10, 0, true)
    dv.setUint16(12, stamp.time, true)
    dv.setUint16(14, stamp.date, true)
    dv.setUint32(16, crc, true)
    dv.setUint32(20, data.length, true)
    dv.setUint32(24, data.length, true)
    dv.setUint16(28, nameBytes.length, true)
    dv.setUint32(42, offset, true)       // offset of this entry's local header
    dir.set(nameBytes, 46)
    central.push(dir)

    offset += local.length + data.length
  })

  const centralSize = central.reduce((t, c) => t + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054B50, true)      // end of central directory signature
  ev.setUint16(8, central.length, true)  // entries on this disk
  ev.setUint16(10, central.length, true) // entries total
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)         // where the central directory starts

  return new BlobImpl([...parts, ...central, end], { type: 'application/zip' })
}
