// ─────────────────────────────────────────────────────────────────────────────
// pdf.js loader — one copy, loaded once, shared by everything that draws a PDF.
//
// pdf.js renders pages to a canvas; pdf-lib (the other half of this story) edits
// bytes and cannot draw. Both are needed and they are not interchangeable.
//
// From the CDN rather than the bundle on purpose: it is ~1MB of renderer that
// only the screens which SHOW a document need, and the same build is already
// being pulled in by the signature field placer. The version is pinned — a
// floating version would change how every existing document renders without a
// deploy.
// ─────────────────────────────────────────────────────────────────────────────
const PDFJS_VERSION = '3.11.174'
const CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`

let pending = null

/** Resolve with window.pdfjsLib, loading it the first time. Concurrent callers share one load. */
export function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib)
  if (pending) return pending
  pending = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `${CDN}/pdf.min.js`
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${CDN}/pdf.worker.min.js`
      resolve(window.pdfjsLib)
    }
    s.onerror = () => {
      pending = null   // a failed load must not poison the next attempt
      reject(new Error('Could not load the PDF viewer. Check your connection and try again.'))
    }
    document.head.appendChild(s)
  })
  return pending
}

/**
 * Open a document for rendering. Takes a COPY of the bytes: pdf.js transfers the
 * buffer it is given to its worker, which detaches it — and the caller usually
 * still needs those bytes to do the actual split.
 */
export async function openPdf(bytes) {
  const pdfjsLib = await loadPdfJs()
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return pdfjsLib.getDocument({ data: view.slice() }).promise
}

/** Draw one page (1-indexed) onto a canvas at the given scale. */
export async function renderPage(pdf, pageNumber, canvas, scale = 1) {
  const page = await pdf.getPage(pageNumber)
  const viewport = page.getViewport({ scale })
  const ratio = window.devicePixelRatio || 1
  canvas.width  = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  canvas.style.width  = `${Math.floor(viewport.width)}px`
  canvas.style.height = `${Math.floor(viewport.height)}px`
  const ctx = canvas.getContext('2d')
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  await page.render({ canvasContext: ctx, viewport }).promise
}
