// ---------------------------------------------------------------------------
// packetDownload -- "Get Forms" for a multi-file form packet.
//
// A packet's files are fetched as bytes and handed over as ONE zip. Two reasons
// this is not a loop of download links: browsers block every automatic download
// after the first (see src/lib/zipFiles.js), and fetching the bytes ourselves is
// the only way a failure is visible -- a link that 403s opens an error page (or
// nothing at all), while a fetch reports which file failed.
//
// Partial packets are refused outright. An agent who takes six forms to a listing
// appointment and finds four cannot tell that two are missing, so if any file in
// the packet cannot be fetched, nothing downloads and the failure names the files.
// ---------------------------------------------------------------------------
import { zipFiles } from './zipFiles.js'

// Enough to keep the download quick, low enough that a large packet does not
// open a dozen simultaneous connections to storage.
const CONCURRENCY = 3

// Long enough for the browser to have started reading the blob before it is
// revoked -- revoking straight after click() cancels the download in Safari.
const REVOKE_MS = 60_000

/** Filename for a packet's archive: "IA - Iowa Agency Packet.zip". */
export function packetZipName(packet) {
  const parts = [packet?.state, packet?.name].map(s => String(s || '').trim()).filter(Boolean)
  const base = (parts.join(' - ') || 'form packet')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return `${base}.zip`
}

// Run `worker` over `items` a few at a time, preserving input order in the result.
async function mapPooled(items, limit, worker) {
  const out = new Array(items.length)
  let next = 0
  const runner = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner))
  return out
}

/**
 * Fetch every `{ name, url }` in `items` and return a single zip Blob.
 * Throws (naming the files that failed) rather than returning a partial archive.
 */
export async function buildPacketZip(items, { fetchImpl = fetch, concurrency = CONCURRENCY, date, Blob: BlobImpl } = {}) {
  const list = (items || []).filter(it => it && it.url)
  if (!list.length) throw new Error('No files to download for this packet')

  const results = await mapPooled(list, concurrency, async (it) => {
    try {
      const res = await fetchImpl(it.url)
      if (!res.ok) return { it, error: `HTTP ${res.status}` }
      const buf = await res.arrayBuffer()
      if (!buf?.byteLength) return { it, error: 'the file came back empty' }
      return { it, data: new Uint8Array(buf) }
    } catch (err) {
      return { it, error: err.message || 'network error' }
    }
  })

  const failed = results.filter(r => r.error)
  if (failed.length) {
    const named = failed.map(r => `${r.it.name || 'a file'} (${r.error})`).join('; ')
    throw new Error(
      `${failed.length} of ${list.length} form${list.length === 1 ? '' : 's'} could not be downloaded, so nothing was saved: ${named}`,
    )
  }

  const zipOpts = { date }
  if (BlobImpl) zipOpts.Blob = BlobImpl
  return zipFiles(results.map(r => ({ name: r.it.name, data: r.data })), zipOpts)
}

/** Hand a blob to the browser as a download named `filename`. */
export function downloadBlob(blob, filename, { doc = document, win = (typeof window !== 'undefined' ? window : undefined) } = {}) {
  const objUrl = (win?.URL || URL).createObjectURL(blob)
  const anchor = doc.createElement('a')
  anchor.href = objUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  doc.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => { try { (win?.URL || URL).revokeObjectURL(objUrl) } catch { /* already gone */ } }, REVOKE_MS)
  return { saved: true, bytes: blob.size, filename }
}
