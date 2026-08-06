// ─────────────────────────────────────────────────────────────────────────────
// printPdfFromUrl — put a PDF in front of the OS print dialog.
//
// A cross-origin URL cannot be printed directly: calling print() on an iframe whose
// document is on another origin throws, and window.print() from our page prints the
// CRM's own chrome rather than the document. So the bytes are fetched, wrapped in a
// blob URL (which IS same-origin), and printed from a hidden iframe.
//
// Blob URLs are revoked on cleanup — each print copy is a few MB and a session that
// prints a dozen packets would otherwise hold all of them in memory until reload.
// ─────────────────────────────────────────────────────────────────────────────

// How long to keep the iframe alive after print() returns. The print dialog is
// modal in some browsers and asynchronous in others; tearing the iframe down too
// early cancels the job. Generous on purpose — an orphan iframe costs nothing.
const TEARDOWN_MS = 60_000

export async function printPdfFromUrl(url, { fetchImpl = fetch, doc = document } = {}) {
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`Could not load the print copy (HTTP ${res.status})`)
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)

  return new Promise((resolve, reject) => {
    const frame = doc.createElement('iframe')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    // aria-hidden: this frame exists to hold bytes for the print driver, and a
    // screen reader announcing an unlabeled empty frame is pure noise.
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('title', 'Print document')

    let settled = false
    const cleanup = () => {
      URL.revokeObjectURL(blobUrl)
      frame.remove()
    }

    frame.onload = () => {
      try {
        const win = frame.contentWindow
        win.focus()
        win.print()
        if (!settled) { settled = true; resolve({ printed: true }) }
      } catch (err) {
        cleanup()
        if (!settled) { settled = true; reject(new Error(`The browser blocked printing: ${err.message}`)) }
        return
      }
      setTimeout(cleanup, TEARDOWN_MS)
    }
    frame.onerror = () => {
      cleanup()
      if (!settled) { settled = true; reject(new Error('The print copy could not be opened')) }
    }

    // Insert FIRST, then point it at the blob: an iframe that isn't in the document
    // yet is not guaranteed to fire `load` in every browser, and this whole helper
    // hangs off that event.
    doc.body.appendChild(frame)
    frame.src = blobUrl
  })
}
