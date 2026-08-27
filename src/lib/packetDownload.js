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

// ---------------------------------------------------------------------------
// A packet's files, and delivering them.
//
// These two live here rather than in a page because there are TWO "Get Forms"
// buttons — the Form Library and the pipeline's Required Forms panel — and when
// only the Form Library learned about multi-file packets, the pipeline's copy
// went on handing out `storage_path` alone. That is the FIRST file of the
// packet: an agent asking for the Iowa purchase agreement got whichever single
// PDF happened to be first and no indication the rest existed. One
// implementation, both buttons.
// ---------------------------------------------------------------------------

/**
 * Every file in `packet`, as `[{ path, name }]`, newest scheme first.
 * `storage_paths` holds the whole package; `storage_path` is the pre-0022
 * single-file column, kept as the fallback for packets uploaded before it.
 */
export function packetFiles(packet) {
  const many = Array.isArray(packet?.storage_paths) ? packet.storage_paths.filter(f => f?.path) : []
  if (many.length) return many.map(f => ({ path: f.path, name: f.name || f.path.split('/').pop() }))
  if (packet?.storage_path) return [{ path: packet.storage_path, name: packet.storage_path.split('/').pop() }]
  return []
}

/** Point the browser at `url` as a download named `filename`. */
function downloadUrl(url, filename, { doc = document } = {}) {
  const anchor = doc.createElement('a')
  anchor.href = url
  anchor.download = filename || ''
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  doc.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/**
 * Deliver every file in `packet` from `storage` (a supabase storage bucket
 * client). One file goes straight down as itself; several arrive as one zip,
 * because after the first await the clicks are outside the button's user
 * gesture and browsers block every download but the first.
 *
 * Resolves `{ files, zipped }`; throws with a message worth showing an agent.
 */
export async function deliverPacket(packet, { storage, expiresIn = 300, doc, win, fetchImpl } = {}) {
  const items = packetFiles(packet)
  if (!items.length) throw new Error('No file uploaded for this packet')

  if (items.length === 1) {
    const it = items[0]
    const { data, error } = await storage.createSignedUrl(it.path, expiresIn, { download: it.name || true })
    if (error || !data?.signedUrl) {
      throw new Error(`Couldn't fetch ${it.name || 'the file'}: ${error?.message || 'storage returned no link'}`)
    }
    downloadUrl(data.signedUrl, it.name, { doc })
    return { files: 1, zipped: false }
  }

  const { data: signed, error: signErr } = await storage.createSignedUrls(items.map(it => it.path), expiresIn)
  if (signErr) throw new Error(`Couldn't prepare this packet: ${signErr.message}`)
  // Keyed by path, not by index: the batch endpoint reports a per-file error and
  // there is nothing promising it answers in the order it was asked.
  const byPath = new Map((signed || []).filter(r => r?.path).map(r => [r.path, r.signedUrl]))
  const urls = items.map((it, i) => ({
    name: it.name,
    url: byPath.get(it.path) || (byPath.size ? '' : (signed || [])[i]?.signedUrl || ''),
  }))
  const unsigned = urls.filter(u => !u.url)
  if (unsigned.length) {
    throw new Error(
      `Couldn't prepare ${unsigned.length} of ${items.length} forms, so nothing was saved: ${unsigned.map(u => u.name).join(', ')}`,
    )
  }
  const blob = await buildPacketZip(urls, fetchImpl ? { fetchImpl } : {})
  downloadBlob(blob, packetZipName(packet), { ...(doc ? { doc } : {}), ...(win ? { win } : {}) })
  return { files: items.length, zipped: true }
}
