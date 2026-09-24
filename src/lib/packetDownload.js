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
 * A file with no recorded name is named from its path, less the upload prefix.
 */
export function packetFiles(packet) {
  const many = Array.isArray(packet?.storage_paths) ? packet.storage_paths.filter(f => f?.path) : []
  if (many.length) return many.map(f => ({ path: f.path, name: f.name || nameFromPath(f.path) }))
  if (packet?.storage_path) return [{ path: packet.storage_path, name: nameFromPath(packet.storage_path) }]
  return []
}

// ---------------------------------------------------------------------------
// A packet whose record names ONE file may be lying.
//
// Until migration 0022 reached production the `storage_paths` column did not
// exist, and FormLibrary's save() answered the missing column by retrying
// without it: every PDF of a five-file packet was uploaded, the row kept only
// `storage_path` -- file 1 -- and the admin was told "Form packet added". When
// 0022 landed those rows got its default `[]`, and any later edit wrote the
// one surviving file back as `storage_paths: [file 1]`. Either way packetFiles()
// honestly reports one file, and Get Forms hands down file 1 as if it were the
// packet.
//
// The rest of the packet was never lost: it is in the bucket, next to file 1,
// under the name FormLibrary gives every upload -- `<Date.now()>-<i>-<name>`,
// one index per file, uploaded one after another. So a single recorded file at
// index 0 is checked against its folder, and the upload it came from is
// delivered whole. Migration 0056 writes the same answer back into the rows;
// this is what keeps agents from being handed file 1 until someone runs it.
// ---------------------------------------------------------------------------

const BATCH_NAME_RE = /^(\d+)-(\d+)-(.+)$/

// Consecutive files of one save are uploaded back to back, so the gap between
// their timestamps is one file's upload time -- seconds, or a few minutes for a
// 25 MB scan on a slow uplink. A file further away than this is not the next
// file of the same save, whatever its index says.
export const MAX_BATCH_GAP_MS = 15 * 60 * 1000

// Folder listings come back in pages; a folder is one state + transaction type.
const LIST_PAGE = 1000
const LIST_PAGE_LIMIT = 20

function parseBatchName(name) {
  const m = BATCH_NAME_RE.exec(String(name || ''))
  return m ? { ts: Number(m[1]), idx: Number(m[2]), name: m[3] } : null
}

// "IA/buyer/1723…-0-Purchase Agreement.pdf" → "Purchase Agreement.pdf": the name
// the admin uploaded, which is what an agent should find in their Downloads.
function nameFromPath(path) {
  const base = String(path || '').split('/').pop()
  return parseBatchName(base)?.name || base
}

/**
 * The upload `path` was saved in, reconstructed from `names` (the object names
 * in its folder), as `[{ path, name }]` in upload order. Null when `path` is not
 * the first file of a Form Library upload, so there is no batch to rebuild.
 *
 * File k belongs to the batch when it is index k, uploaded at or after file
 * k-1, within MAX_BATCH_GAP_MS of it, and before the NEXT upload's first file.
 * Two candidates for one index is not a guess this makes: it throws.
 */
export function uploadBatch(path, names) {
  const slash = String(path || '').lastIndexOf('/')
  const folder = slash >= 0 ? path.slice(0, slash) : ''
  const anchor = parseBatchName(slash >= 0 ? path.slice(slash + 1) : path)
  if (!anchor || anchor.idx !== 0) return null

  const entries = (names || []).map(n => ({ file: n, ...parseBatchName(n) })).filter(e => e.name)
  const nextUpload = entries.reduce((t, e) => (e.idx === 0 && e.ts > anchor.ts && e.ts < t ? e.ts : t), Infinity)
  const join = (file) => (folder ? `${folder}/${file}` : file)

  const batch = [{ path, name: anchor.name }]
  let prev = anchor
  for (let k = 1; ; k++) {
    const next = entries.filter(e => e.idx === k && e.ts >= prev.ts && e.ts < nextUpload && e.ts - prev.ts <= MAX_BATCH_GAP_MS)
    if (!next.length) return batch
    if (next.length > 1) {
      throw new Error(`Found ${next.length} candidates for file ${k + 1} of this packet in storage (${next.map(e => e.name).join(', ')}), so nothing was saved — an admin needs to re-upload this packet's PDFs in the Form Library`)
    }
    batch.push({ path: join(next[0].file), name: next[0].name })
    prev = next[0]
  }
}

// Every object name directly inside `folder`.
async function listFolder(storage, folder) {
  const names = []
  for (let page = 0; page < LIST_PAGE_LIMIT; page++) {
    const { data, error } = await storage.list(folder, { limit: LIST_PAGE, offset: page * LIST_PAGE })
    if (error) throw new Error(`Couldn't check this packet's files: ${error.message}`)
    // Sub-folders come back as entries with no id.
    for (const o of data || []) if (o?.name && o.id !== null) names.push(o.name)
    if ((data || []).length < LIST_PAGE) return names
  }
  // A listing cut short could drop a file from the middle of the packet.
  throw new Error(`Couldn't check this packet's files: ${folder} holds more than ${LIST_PAGE * LIST_PAGE_LIMIT} files`)
}

/**
 * The files to deliver for `packet`: what its record lists, or -- when the record
 * lists one file that began a multi-file upload -- that whole upload.
 * `recovered` is how many files the record was missing.
 */
export async function resolvePacketFiles(packet, { storage } = {}) {
  const recorded = packetFiles(packet)
  if (recorded.length !== 1) return { items: recorded, recovered: 0 }
  const [only] = recorded
  if (!uploadBatch(only.path, [])) return { items: recorded, recovered: 0 }   // not a Form Library upload

  const slash = only.path.lastIndexOf('/')
  const batch = uploadBatch(only.path, await listFolder(storage, slash >= 0 ? only.path.slice(0, slash) : ''))
  if (batch.length === 1) return { items: recorded, recovered: 0 }
  batch[0] = only   // keep the name the record gave file 1
  return { items: batch, recovered: batch.length - 1 }
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
 * Resolves `{ files, zipped, recovered }` -- `recovered` counts files the
 * packet's record was missing and the bucket supplied (see resolvePacketFiles).
 * Throws with a message worth showing an agent.
 */
export async function deliverPacket(packet, { storage, expiresIn = 300, doc, win, fetchImpl } = {}) {
  if (!packetFiles(packet).length) throw new Error('No file uploaded for this packet')
  const { items, recovered } = await resolvePacketFiles(packet, { storage })
  if (recovered) {
    console.warn(`[packetDownload] packet ${packet?.id} lists 1 file but its upload holds ${items.length} — delivering all of them; migration 0056 repairs the row`)
  }

  if (items.length === 1) {
    const it = items[0]
    const { data, error } = await storage.createSignedUrl(it.path, expiresIn, { download: it.name || true })
    if (error || !data?.signedUrl) {
      throw new Error(`Couldn't fetch ${it.name || 'the file'}: ${error?.message || 'storage returned no link'}`)
    }
    downloadUrl(data.signedUrl, it.name, { doc })
    return { files: 1, zipped: false, recovered: 0 }
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
  return { files: items.length, zipped: true, recovered }
}
