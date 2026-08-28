// ─────────────────────────────────────────────────────────────────────────────
// pdfText — the printed words of a PDF, with coordinates, in BoldSign's frame.
//
// Used to caption a template's unnamed fields from the text beside them (see
// src/lib/services/boldsignCaptions.js). Extraction is the only part of that job
// that needs a PDF parser, so it lives here alone and the geometry stays pure
// and testable.
//
// FRAME. pdf.js reports text in PDF user space: origin at the page's BOTTOM-left,
// y growing upward, position carried in the item's transform matrix ([a,b,c,d,e,f]
// — e,f are x and y of the baseline). BoldSign's `bounds` measure from the
// page's TOP-left with y growing downward. Everything here is converted to
// BoldSign's frame on the way out, because that is the frame the field bounds
// arrive in and converting once, here, is what keeps the comparison honest.
//
// pdf.js also reports the baseline, not the box: `f` is where the glyphs sit, and
// a run's height is its font size, so the run's top is baseline − height. Using
// the baseline as the top shifted every word down by a full line and matched
// boxes against the line BELOW their label.
// ─────────────────────────────────────────────────────────────────────────────

// Rotated or vertically-set text (a sidebar, a watermark) has no place in a
// caption and its bounds do not mean what the horizontal case means. `b` and `c`
// are the transform's skew/rotation terms; both ~0 is upright text.
const isUpright = (t) => Math.abs(Number(t?.[1]) || 0) < 0.01 && Math.abs(Number(t?.[2]) || 0) < 0.01

// Returns { words, pages }: every text run as { text, x, y, width, height, page }
// with y measured from the page top, plus each page's { width, height } in points
// (needed to resolve the scale between BoldSign's bounds and PDF points).
// Never throws — a PDF that cannot be parsed yields empty results so the caller
// falls back to showing what it showed before captions existed.
export async function extractPdfWords(bytes, { maxPages = 40 } = {}) {
  let getDocument
  try {
    ({ getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs'))
  } catch (err) {
    console.warn(`[boldsign] captions: pdf.js unavailable (${err.message})`)
    return { words: [], pages: [] }
  }

  let doc
  try {
    doc = await getDocument({
      data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      // Serverless: no worker thread, no system fonts, no eval. Text extraction
      // needs none of them, and each one left on is a cold-start cost or a
      // hard failure in a function with no DOM.
      disableWorker: true,
      useSystemFonts: false,
      isEvalSupported: false,
      standardFontDataUrl: undefined,
      verbosity: 0,
    }).promise
  } catch (err) {
    console.warn(`[boldsign] captions: could not open the PDF (${err.message})`)
    return { words: [], pages: [] }
  }

  const words = []
  const pages = []
  try {
    const pageCount = Math.min(doc.numPages || 0, maxPages)
    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p)
      const height = page.view?.[3] != null && page.view?.[1] != null
        ? Number(page.view[3]) - Number(page.view[1])
        : Number(page.getViewport({ scale: 1 }).height)
      const width = page.view?.[2] != null && page.view?.[0] != null
        ? Number(page.view[2]) - Number(page.view[0])
        : Number(page.getViewport({ scale: 1 }).width)
      pages[p - 1] = { width, height }
      const content = await page.getTextContent({ includeMarkedContent: false })
      for (const item of (content?.items || [])) {
        const text = String(item?.str ?? '')
        if (!text.trim()) continue
        const t = item.transform
        if (!Array.isArray(t) || !isUpright(t)) continue
        const x = Number(t[4])
        const baseline = Number(t[5])
        const h = Math.abs(Number(item.height)) || Math.abs(Number(t[3])) || 0
        const w = Math.abs(Number(item.width)) || 0
        if (!Number.isFinite(x) || !Number.isFinite(baseline)) continue
        words.push({ text, x, y: height - baseline - h, width: w, height: h, page: p })
      }
      page.cleanup?.()
    }
  } catch (err) {
    console.warn(`[boldsign] captions: text extraction stopped early (${err.message})`)
  } finally {
    try { await doc.destroy?.() } catch { /* nothing to do */ }
  }
  return { words, pages }
}
