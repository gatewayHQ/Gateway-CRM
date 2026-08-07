// ─────────────────────────────────────────────────────────────────────────────
// savePdfFromUrl — hand the agent the finished PDF as a file on their disk.
//
// REPLACES the old print-through-a-hidden-iframe helper. That approach called
// print() on an iframe holding a blob: URL, and in Chrome the PDF is rendered by a
// plugin the parent frame cannot drive — print() returned without error and the
// job came out BLANK. Nothing in the page could detect that, so the agent got
// empty paper with no message. Downloading the bytes has no such failure mode: the
// file either arrives or the fetch fails loudly.
//
// The bytes come from the server-composed copy (api/boldsign.js → buildPrintablePdf),
// which has every filled value drawn onto the pages and any interactive form
// flattened, so what downloads is already the complete, printable document. Nothing
// is re-rendered from the DOM here — the CRM never has the document's pixels, they
// live in BoldSign's cross-origin iframe.
//
// The blob is fetched rather than linking straight at the signed URL so the
// download carries OUR filename, and so a failure (expired signature, network) is
// reported instead of opening a tab showing an error page.
// ─────────────────────────────────────────────────────────────────────────────

// Long enough for the browser to have started reading the blob before it is
// revoked. Revoking immediately after click() cancels the download in Safari.
const REVOKE_MS = 60_000

export function safePdfFilename(name, fallback = 'document.pdf') {
  const base = String(name || '').trim()
  if (!base) return fallback
  // Characters no common filesystem accepts, plus path separators — a document
  // named "Listing 3/4 duplex" must not try to write into a directory.
  const clean = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim()
  if (!clean) return fallback
  return /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`
}

/**
 * Download `url` as `filename`. Resolves { saved: true, bytes } once the download
 * has been handed to the browser; rejects with a message worth showing an agent.
 */
export async function savePdfFromUrl(url, filename, { fetchImpl = fetch, doc = document, win = (typeof window !== 'undefined' ? window : undefined) } = {}) {
  if (!url) throw new Error('No document was returned to save')

  let res
  try {
    res = await fetchImpl(url)
  } catch (err) {
    throw new Error(`Could not download the PDF: ${err.message}`)
  }
  if (!res.ok) throw new Error(`Could not download the PDF (HTTP ${res.status})`)
  const blob = await res.blob()
  if (!blob?.size) throw new Error('The generated PDF came back empty')

  const name    = safePdfFilename(filename)
  const objUrl  = (win?.URL || URL).createObjectURL(blob)
  const anchor  = doc.createElement('a')
  anchor.href     = objUrl
  anchor.download = name
  // rel/target only matter if a browser ignores `download` (older iOS Safari) and
  // navigates instead — then at least it opens away from the CRM rather than
  // replacing the page the agent is working in.
  anchor.rel      = 'noopener'
  anchor.style.display = 'none'
  doc.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => { try { (win?.URL || URL).revokeObjectURL(objUrl) } catch { /* already gone */ } }, REVOKE_MS)

  return { saved: true, bytes: blob.size, filename: name }
}
