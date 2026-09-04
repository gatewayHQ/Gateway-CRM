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

// ─────────────────────────────────────────────────────────────────────────────
// PRINTING — hand the PDF to the browser's own viewer and let IT print.
//
// The CRM must never call print() itself. That is what the retired helper did
// (see the note at the top of this file): print() on an iframe holding a PDF is
// driven by a plugin the parent frame has no access to, so the call returned
// success and the printer produced BLANK paper, silently.
//
// A new tab has none of that. The browser renders the PDF in its built-in viewer,
// which has a working print button wired to the document's real pages. We are not
// printing — we are getting out of the way of the one thing that already works.
//
// The tab has to be opened SYNCHRONOUSLY inside the click handler, before the
// round-trip that composes the PDF: a window.open() that happens after an await
// has lost the user gesture and pop-up blockers eat it. So the flow is two steps —
// openPrintTab() on the click, showPdfInPrintTab() once the URL is known.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a blank tab to hold the printable copy. Call this FIRST, in the click
 * handler, before any await. Returns the window handle, or null if it was
 * blocked — showPdfInPrintTab() turns that into a message worth reading.
 */
export function openPrintTab(win = (typeof window !== 'undefined' ? window : undefined)) {
  if (!win?.open) return null
  let tab = null
  // NOT window.open(url, '_blank', 'noopener'): with 'noopener' Chrome returns
  // null by design, and the handle is the whole point — we navigate this tab
  // ourselves once the PDF exists. `opener` is cleared below instead, which gets
  // the same isolation without giving up the reference.
  try { tab = win.open('', '_blank') } catch { return null }
  if (!tab) return null
  try { tab.opener = null } catch { /* already detached in some browsers */ }
  // Composing a scanned packet takes a moment, and a blank white tab in the
  // meantime reads as a broken button.
  try {
    tab.document.write('<!doctype html><title>Preparing your copy…</title>'
      + '<body style="margin:0;padding:32px;font:14px/1.6 system-ui,sans-serif;color:#4a4a4a">'
      + 'Preparing your copy…</body>')
    tab.document.close()
  } catch { /* about:blank is not always writable — cosmetic only */ }
  return tab
}

/** Point an opened print tab at `url`. Throws with a message worth showing an agent. */
export function showPdfInPrintTab(tab, url) {
  if (!tab) {
    throw new Error('your browser blocked the new tab. Allow pop-ups for this site, or use Save PDF and print from your PDF viewer')
  }
  if (!url) {
    closePrintTab(tab)
    throw new Error('no printable copy was returned')
  }
  // replace() rather than assigning href: the placeholder above should not become
  // a back-button destination inside the agent's new tab.
  tab.location.replace(url)
  return { opened: true }
}

/** Close a print tab that will never receive a document. Safe on null. */
export function closePrintTab(tab) {
  try { tab?.close?.() } catch { /* already closed, or never opened */ }
}
