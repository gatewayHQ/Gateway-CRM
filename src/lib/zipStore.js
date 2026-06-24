// Minimal STORE-only ZIP builder. No compression — PDFs don't shrink and we
// avoid an external dependency. Each entry is a {path, bytes} pair. Returns
// a single Uint8Array that browsers will treat as a valid .zip file.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function writeU32(view, off, val) { view.setUint32(off, val, true) }
function writeU16(view, off, val) { view.setUint16(off, val, true) }

const encoder = new TextEncoder()

export function buildZip(entries) {
  // First pass: encode names + compute sizes for offset math.
  const prepared = entries.map(e => {
    const nameBytes = encoder.encode(e.path)
    const data      = e.bytes instanceof Uint8Array ? e.bytes : new Uint8Array(e.bytes)
    return { nameBytes, data, crc: crc32(data) }
  })

  // Sum local-file-header sizes (30 + name + data) and central-dir sizes (46 + name).
  let localTotal = 0
  for (const p of prepared) localTotal += 30 + p.nameBytes.length + p.data.length
  let centralTotal = 0
  for (const p of prepared) centralTotal += 46 + p.nameBytes.length

  const total = localTotal + centralTotal + 22  // 22 = end-of-central-dir record
  const buf   = new Uint8Array(total)
  const view  = new DataView(buf.buffer)
  let offset  = 0
  const localOffsets = []

  // Local file headers + data.
  for (const p of prepared) {
    localOffsets.push(offset)
    writeU32(view, offset, 0x04034b50); offset += 4   // signature
    writeU16(view, offset, 20);         offset += 2   // version needed
    writeU16(view, offset, 0);          offset += 2   // flags
    writeU16(view, offset, 0);          offset += 2   // method (0 = store)
    writeU16(view, offset, 0);          offset += 2   // mod time
    writeU16(view, offset, 0x21);       offset += 2   // mod date (epoch-ish, fine)
    writeU32(view, offset, p.crc);      offset += 4
    writeU32(view, offset, p.data.length); offset += 4
    writeU32(view, offset, p.data.length); offset += 4
    writeU16(view, offset, p.nameBytes.length); offset += 2
    writeU16(view, offset, 0);          offset += 2   // extra length
    buf.set(p.nameBytes, offset);       offset += p.nameBytes.length
    buf.set(p.data, offset);            offset += p.data.length
  }

  // Central directory.
  const centralStart = offset
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i]
    writeU32(view, offset, 0x02014b50); offset += 4   // signature
    writeU16(view, offset, 20);         offset += 2   // version made by
    writeU16(view, offset, 20);         offset += 2   // version needed
    writeU16(view, offset, 0);          offset += 2   // flags
    writeU16(view, offset, 0);          offset += 2   // method
    writeU16(view, offset, 0);          offset += 2   // mod time
    writeU16(view, offset, 0x21);       offset += 2   // mod date
    writeU32(view, offset, p.crc);      offset += 4
    writeU32(view, offset, p.data.length); offset += 4
    writeU32(view, offset, p.data.length); offset += 4
    writeU16(view, offset, p.nameBytes.length); offset += 2
    writeU16(view, offset, 0);          offset += 2   // extra length
    writeU16(view, offset, 0);          offset += 2   // comment length
    writeU16(view, offset, 0);          offset += 2   // disk #
    writeU16(view, offset, 0);          offset += 2   // internal attrs
    writeU32(view, offset, 0);          offset += 4   // external attrs
    writeU32(view, offset, localOffsets[i]); offset += 4
    buf.set(p.nameBytes, offset);       offset += p.nameBytes.length
  }

  // End of central directory.
  writeU32(view, offset, 0x06054b50); offset += 4
  writeU16(view, offset, 0);          offset += 2   // disk #
  writeU16(view, offset, 0);          offset += 2   // start disk
  writeU16(view, offset, prepared.length); offset += 2
  writeU16(view, offset, prepared.length); offset += 2
  writeU32(view, offset, centralTotal); offset += 4
  writeU32(view, offset, centralStart); offset += 4
  writeU16(view, offset, 0);          offset += 2   // comment length

  return buf
}

// Strip characters that would break a file path on Windows/macOS/Linux.
export function safePathSegment(s) {
  return (s || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'unknown'
}
