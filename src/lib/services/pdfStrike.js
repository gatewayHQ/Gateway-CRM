// ─────────────────────────────────────────────────────────────────────────────
// STRIKE-THROUGH MARKUP — striking a clause out of a form before it is sent.
//
// WHAT AN AGENT IS DOING. Negotiating a form means removing parts of it. A
// retainer period that reads "shall not exceed twelve (12) months" becomes
// "shall not exceed ~~twelve (12)~~ months" because the parties agreed on
// something else, and the buyer then signs the form as marked. That is ordinary
// practice, and until now it has been the reason agents leave the CRM: they mark
// the form up somewhere else and bring a flattened copy back.
//
// THIS IS NOT THE IN-FLIGHT CORRECTION TOOL. A packet that is already out for
// signature keeps the acknowledgement-plus-initials path (see api/boldsign.js,
// "packet-add-initials"), for the reason recorded there: a line drawn over text
// somebody has already signed says nothing about who agreed to the change or
// when. Striking happens BEFORE anyone signs, on a form nobody has agreed to
// yet, and the signature that follows covers the page as marked. Everything in
// this file is for that window and the caller is expected to enforce it.
//
// WHERE THE WORK HAPPENS. In the browser, with pdf-lib, exactly as split and
// merge do (see pdfEdit.js). The marked-up bytes are what gets uploaded, so
// nothing about the send path, the field placement or the packet flow changes —
// BoldSign receives a PDF that simply has a line in it.
//
// IT IS INK, NOT AN ANNOTATION. The line is drawn into the page's content
// stream, not added to the page's /Annots array. An annotation is a separate
// object that a viewer can hide, delete or fail to print, which would mean the
// struck clause quietly coming back on the copy somebody opens later. Content
// cannot be switched off. For a document that will be signed, that difference is
// the whole point.
//
// COORDINATES. Marks are stored as FRACTIONS of the page (0..1, origin at the
// page's TOP-left, y growing downward) rather than points or pixels. Three
// different frames touch a mark — the browser's CSS pixels at whatever zoom the
// page was rendered at, pdf.js's viewport, and pdf-lib's bottom-left user space
// — and a fraction is the only one of those that survives all three. It also
// means a mark placed on a page rendered at 1.3× lands identically when the same
// document is later drawn at any other scale.
//
// ROTATION IS REFUSED, NOT GUESSED. pdf.js applies a page's /Rotate when it
// renders; pdf-lib draws in unrotated user space. On a rotated page those two
// disagree and a line would land somewhere the agent did not put it. Rather than
// approximate the transform, a rotated page is refused by name — see
// unsupportedPages(). No brokerage form in the library is rotated; a scan can
// be, and a scan is exactly where a silently misplaced line would do damage.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far down the selected box the line crosses, as a fraction of its height.
 * A browser's selection rectangle spans the whole line box — ascender space above
 * the capitals, descender space below the baseline — so its exact middle sits
 * slightly low through the body of the text. 0.58 puts the line where a pen
 * would cross a word rather than where the box happens to halve.
 */
export const STRIKE_DEPTH = 0.58

/** Line weight, as a fraction of the struck text's height, and its bounds in points. */
export const THICKNESS_RATIO = 0.09
export const MIN_THICKNESS = 0.7
export const MAX_THICKNESS = 1.6

/**
 * The ink. The same blue drawFilledValues() uses for values typed into a form
 * (api/boldsign.js) and for the same reason it gives there: it reads as
 * something a person did to the document, not as something the form was printed
 * with. A black line on a black-on-white form is indistinguishable from a
 * printing artifact, which is the last thing a struck clause should look like.
 */
export const STRIKE_INK = { r: 0.05, g: 0.08, b: 0.45 }

/** A selection thinner or shorter than this (in fractions of the page) is a stray click, not a mark. */
const MIN_SPAN = 0.002

/**
 * How far apart two pieces of one selection may sit and still be drawn as a
 * single stroke, as a fraction of page width. pdf.js lays text out in runs, so
 * selecting "twelve (12)" routinely returns two rectangles with the space
 * between them missing. ~0.9% of a US Letter page is about 5.5pt — wider than
 * any inter-word gap at form sizes, narrower than a column gutter.
 */
const JOIN_GAP = 0.009

/** Two rectangles are on the same printed line when their vertical spans overlap by most of the shorter one. */
const LINE_OVERLAP = 0.6

let seq = 0

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
const clamp01 = (v) => Math.min(1, Math.max(0, v))

// ─── Pure geometry ───────────────────────────────────────────────────────────

/**
 * A rectangle from the browser (viewport coordinates, as getClientRects gives
 * them) expressed as fractions of the page element it sits on.
 *
 * Returns null for anything degenerate — a zero-width rect, a rect outside the
 * page, a host element that has not been laid out yet. The caller drops those
 * rather than drawing a line of length zero.
 */
export function rectToFraction(rect, host) {
  const hw = num(host?.width)
  const hh = num(host?.height)
  if (!hw || !hh || hw <= 0 || hh <= 0) return null

  const left = num(rect?.left)
  const top = num(rect?.top)
  const width = num(rect?.width)
  const height = num(rect?.height)
  if (left == null || top == null || width == null || height == null) return null
  if (width <= 0 || height <= 0) return null

  const x0 = clamp01((left - host.left) / hw)
  const x1 = clamp01((left + width - host.left) / hw)
  const y0 = clamp01((top - host.top) / hh)
  const y1 = clamp01((top + height - host.top) / hh)

  if (x1 - x0 < MIN_SPAN || y1 - y0 < MIN_SPAN) return null
  return { x0, y0, x1, y1 }
}

/** Does this rectangle's centre fall inside that host rectangle? Used to assign a selection to a page. */
export function rectBelongsTo(rect, host) {
  const left = num(rect?.left)
  const top = num(rect?.top)
  const width = num(rect?.width)
  const height = num(rect?.height)
  if (left == null || top == null || width == null || height == null) return false
  if (num(host?.width) == null || num(host?.height) == null) return false

  const cx = left + width / 2
  const cy = top + height / 2
  return cx >= host.left && cx <= host.left + host.width
      && cy >= host.top && cy <= host.top + host.height
}

/** Are these two fraction-rects sitting on the same printed line? */
export function onSameLine(a, b) {
  const top = Math.max(a.y0, b.y0)
  const bottom = Math.min(a.y1, b.y1)
  const overlap = bottom - top
  if (overlap <= 0) return false
  const shorter = Math.min(a.y1 - a.y0, b.y1 - b.y0)
  return shorter > 0 && overlap / shorter >= LINE_OVERLAP
}

/**
 * Join the pieces of one selection into one stroke per printed line.
 *
 * A selection across "twelve (12)" comes back from the browser as one rectangle
 * per text run, with the spaces between runs missing. Drawn as-is that is a
 * dashed line with gaps where the spaces were. Runs that share a line and sit
 * within JOIN_GAP of each other are unioned into a single rectangle, so the
 * result is one continuous stroke — what a pen does.
 *
 * A selection that spans several lines stays several rectangles, one per line,
 * which is also what a pen does.
 */
export function joinRuns(rects) {
  const list = (rects || []).filter(Boolean).slice().sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0))
  const out = []

  for (const r of list) {
    const target = out.find(o => onSameLine(o, r) && gapBetween(o, r) <= JOIN_GAP)
    if (!target) { out.push({ ...r }); continue }
    target.x0 = Math.min(target.x0, r.x0)
    target.x1 = Math.max(target.x1, r.x1)
    target.y0 = Math.min(target.y0, r.y0)
    target.y1 = Math.max(target.y1, r.y1)
  }

  // One pass leaves neighbours that only became adjacent after an earlier union,
  // so settle before returning. Bounded by the list length; it always converges
  // because every pass either merges (shrinking the list) or stops.
  return out.length === list.length ? out : joinRuns(out)
}

/** Horizontal gap between two rects — 0 when they touch or overlap. */
export function gapBetween(a, b) {
  if (a.x1 >= b.x0 && b.x1 >= a.x0) return 0
  return a.x1 < b.x0 ? b.x0 - a.x1 : a.x0 - b.x1
}

/**
 * A mark, from one joined rectangle. `text` is what the agent struck, carried
 * only so the panel can name it — nothing is ever drawn from it.
 *
 * `group` ties together the marks that came from a single selection. Striking a
 * sentence that wraps across three lines is ONE thing the agent did and three
 * lines on the page; the group is what lets the panel say so, and what makes
 * removing it remove all three rather than leaving two orphaned strokes.
 */
export function makeMark({ page, rect, text = '', group = null }) {
  const id = `strike-${++seq}`
  return {
    id,
    group: group || id,
    type: 'strike',
    page: Math.max(1, Math.trunc(num(page) || 1)),
    x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1,
    text: String(text || '').replace(/\s+/g, ' ').trim(),
  }
}

/** The marks of one selection, newest group first, for the panel. */
export function groupMarks(marks) {
  const order = []
  const byGroup = new Map()
  for (const m of (marks || [])) {
    if (!byGroup.has(m.group)) { byGroup.set(m.group, []); order.push(m.group) }
    byGroup.get(m.group).push(m)
  }
  return order.map(group => {
    const items = byGroup.get(group)
    return { group, marks: items, page: items[0].page, text: items[0].text, lines: items.length }
  })
}

/** Reset the id counter. Tests only — ids are React keys, never persisted. */
export function resetMarkIds() { seq = 0 }

/**
 * Where the line goes on a real page, in pdf-lib's frame: origin bottom-left,
 * y growing upward, measured in points.
 *
 * This is the one conversion that has to be right, and it is the same flip
 * drawFilledValues() performs in api/boldsign.js — a mark's y is measured from
 * the page top, so the line's height above the page's bottom edge is
 * (page height − y).
 */
export function markToLine(mark, page) {
  const w = num(page?.width)
  const h = num(page?.height)
  if (!w || !h) return null

  const top = mark.y0 * h
  const boxHeight = (mark.y1 - mark.y0) * h
  const depth = top + boxHeight * STRIKE_DEPTH

  const thickness = Math.min(MAX_THICKNESS, Math.max(MIN_THICKNESS, boxHeight * THICKNESS_RATIO))

  return {
    start: { x: mark.x0 * w, y: h - depth },
    end: { x: mark.x1 * w, y: h - depth },
    thickness,
  }
}

/** A one-line description for the marks panel: "Page 2 · twelve (12)". */
export function describeMark(mark) {
  const where = `Page ${mark.page}`
  const what = mark.text ? mark.text : 'marked passage'
  return `${where} · ${what.length > 48 ? `${what.slice(0, 47)}…` : what}`
}

/**
 * Every page a mark sits on that pdf-lib and pdf.js would disagree about.
 * Returns page numbers, so the caller can say which page rather than failing
 * the whole document. See the ROTATION note at the top of this file.
 */
export function unsupportedPages(marks, pages) {
  const bad = new Set()
  for (const m of (marks || [])) {
    const page = pages?.[m.page - 1]
    if (!page) { bad.add(m.page); continue }
    if ((Number(page.rotation) || 0) % 360 !== 0) bad.add(m.page)
  }
  return [...bad].sort((a, b) => a - b)
}

/**
 * Everything that must be true before bytes are touched. Mirrors validateSplit()
 * in pdfEdit.js: the agent hears about a problem while it is still a screen they
 * can fix, never as a failed download.
 */
export function validateMarks(marks, pages) {
  const list = (marks || []).filter(Boolean)
  if (!list.length) return { ok: false, error: 'Nothing is marked yet. Select some text on the form first.' }

  const count = pages?.length || 0
  const offPage = list.filter(m => m.page < 1 || m.page > count).map(m => m.page)
  if (offPage.length) {
    return { ok: false, error: `A mark points at page ${offPage[0]}, but this document has ${count} page${count === 1 ? '' : 's'}.` }
  }

  const rotated = unsupportedPages(list, pages)
  if (rotated.length) {
    return {
      ok: false,
      error: `Page ${rotated.join(', ')} ${rotated.length === 1 ? 'is' : 'are'} rotated, and a line cannot be placed accurately on a rotated page. Straighten the page first — Split & Merge can rewrite it — then mark it.`,
    }
  }

  return { ok: true, marks: list }
}

// ─── The pdf-lib half ────────────────────────────────────────────────────────
// Below here nothing decides anything. Every rule the agent can get wrong has
// already been answered above, and these functions do only what their names say.

/** The size and rotation of every page, in the shape the pure functions expect. */
export async function pdfPageBoxes(bytes) {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  return doc.getPages().map(p => ({
    width: p.getWidth(),
    height: p.getHeight(),
    rotation: p.getRotation().angle || 0,
  }))
}

/**
 * Draw the marks into the document and return the new bytes. The original is
 * never modified: pdf-lib parses the bytes it is given and serialises a fresh
 * copy, so the caller still holds the clean file afterwards.
 */
export async function drawStrikes(bytes, marks, { ink = STRIKE_INK } = {}) {
  const { PDFDocument, rgb } = await import('pdf-lib')
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pages = doc.getPages()

  const boxes = pages.map(p => ({
    width: p.getWidth(),
    height: p.getHeight(),
    rotation: p.getRotation().angle || 0,
  }))

  const verdict = validateMarks(marks, boxes)
  if (!verdict.ok) throw new Error(verdict.error)

  const color = rgb(ink.r, ink.g, ink.b)
  for (const mark of verdict.marks) {
    const page = pages[mark.page - 1]
    const line = markToLine(mark, boxes[mark.page - 1])
    if (!page || !line) continue
    page.drawLine({ start: line.start, end: line.end, thickness: line.thickness, color })
  }

  return doc.save()
}
