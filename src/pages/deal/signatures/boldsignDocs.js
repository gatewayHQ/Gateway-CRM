// BoldSign document helpers shared by the signature screens.

import { documentPdfUrl } from '../../../lib/services/boldsign.js'
import { savePdfFromUrl, showPdfInPrintTab, closePrintTab } from '../../../lib/savePdf.js'

// Where BoldSign should redirect an embedded iframe on exit — a same-origin
// STATIC page (public/boldsign-return.html), never the CRM's own live URL.
// BoldSign can redirect the IFRAME ITSELF to RedirectUrl (see BoldSignFrame's
// handleLoad), and `window.location.href` names the very page the iframe sits
// inside — so on that path the whole running CRM (header, sidebar, board and
// all) loaded a second time, recursively, inside its own small BoldSign
// iframe. The static return page just posts a marker back and stops; see
// FormLibrary.jsx's template editor for the same pattern already in place.
export const boldSignReturnUrl = () => `${window.location.origin}/boldsign-return.html`

// Save the document as it stands to a PDF file. Shared by the editor header and the
// Signatures tab rows so both behave identically — the same copy, the same messages.
//
// This REPLACED a Print button that opened the browser's print dialog on the same
// copy. Chrome renders a PDF in an iframe through a plugin the page cannot drive, so
// print() succeeded and produced BLANK paper — silently, with nothing to catch. The
// file is downloaded instead: the agent gets a complete document they can read, keep
// and print from their own PDF viewer, which is the workflow anyway (fill it in the
// preview, take it to the client in person).
//
// The PDF itself is composed server-side (api/boldsign.js → buildPrintablePdf): every
// value the fields carry is drawn onto the pages, the source form is flattened, and a
// signing summary is appended. The browser never re-renders it — the document lives in
// BoldSign's cross-origin iframe, where the CRM has no access to its pixels.
export async function saveBoldSignDocumentPdf(documentId) {
  const { url, filename, fieldCount } = await documentPdfUrl(documentId)
  if (!url) throw new Error('No PDF copy was returned')
  const res = await savePdfFromUrl(url, filename || 'document (filled).pdf')
  return { ...res, fieldCount }
}

// The same composed copy, as LINKS rather than a download — what the review
// step needs. Deliberately separate from saveBoldSignDocumentPdf(): that
// function's whole job is to put a file on the agent's disk, and calling it to
// show a preview would download a PDF nobody asked for every time the review
// opened. `previewUrl` is signed without Content-Disposition so it renders in
// the frame instead of downloading; `url` is the attachment link for the
// Download button beside it.
export async function fetchDraftPreview(documentId) {
  const { previewUrl, url, filename, fieldCount } = await documentPdfUrl(documentId)
  return { previewUrl: previewUrl || null, url: url || null, filename, fieldCount: fieldCount || 0 }
}

// PRINT — the same composed copy, shown in the browser's own PDF viewer so the
// agent can print it from there.
//
// The CRM does not print. It cannot: a PDF in an iframe is rendered by a plugin
// the page has no access to, so calling print() on it succeeded and produced blank
// paper (the whole reason Print became Save PDF — see src/lib/savePdf.js). Handing
// the document to a real viewer sidesteps that entirely; the print button the agent
// ends up using is Chrome's, wired to the document's actual pages.
//
// `previewUrl` and not `url`: the two are the same object, but `url` is signed with
// Content-Disposition: attachment and a tab pointed at it downloads a file instead
// of showing one. Only the inline signature renders.
//
// `tab` must already be open — see openPrintTab. Opening it here, after the await
// below, is too late for the browser to count it as user-initiated.
export async function printBoldSignDocument(documentId, tab) {
  const { previewUrl } = await documentPdfUrl(documentId)
  if (!previewUrl) {
    closePrintTab(tab)
    throw new Error('the on-screen copy could not be built. Use Save PDF and print from your PDF viewer')
  }
  return showPdfInPrintTab(tab, previewUrl)
}
