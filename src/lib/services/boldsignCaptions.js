// ─────────────────────────────────────────────────────────────────────────────
// boldsignCaptions — name a template's fields from the words printed next to
// them on the page.
//
// THE PROBLEM. BoldSign auto-names a placed field by type plus a counter, so a
// packet nobody hand-labelled arrives at the send screen as `Checkbox1`,
// `Checkbox2`, `CheckBox11`, `CheckBox4` … in placement order, which is neither
// document order nor anything an agent can read. On one live Iowa buyer-agency
// packet that is 14 tick boxes with no captions at all, several of which are
// terms of the agreement (exclusive vs non-exclusive representation, which party
// the client is, which of two term lengths applies). The agent is asked to set
// them before sending and given nothing to set them BY.
//
// Hand-mapping the ids solves it for exactly one template until somebody moves a
// field, and a mis-mapped id silently locks the WRONG term onto an agreement a
// client then signs. The document itself already carries the answer: the words
// printed beside the box. A box with `exclusive)` to its right is the exclusive
// box, on every template, forever, with nobody maintaining a table.
//
// So: given the printed text of the page (with coordinates) and the field's own
// bounds, read the caption off the page.
//
// COORDINATES. Everything here is in PDF points with the origin at the page's
// TOP-left, y growing downward — BoldSign's own convention for `bounds` (see
// drawFilledValues in api/boldsign.js, which converts the other way for
// pdf-lib). Callers convert extracted text to that frame before calling in;
// api/_lib/pdfText.js does it.
//
// This module is pure and dependency-free on purpose: the geometry is the part
// that has to be right, and it is unit-tested against real generated PDFs
// without touching BoldSign.
// ─────────────────────────────────────────────────────────────────────────────

// How far to the right of a box its caption may start, and how wide a gap may
// sit between two words of the same caption, in points. A checkbox on these
// forms sits 2–6pt from its label. 24pt is about four characters at 9pt — wide
// enough to survive a form that pads its boxes, tight enough that the caption
// does not jump the column gutter into unrelated text.
const GAP_LIMIT = 24

// Captions are for a one-line list row, not a paragraph. Long enough to carry
// "1. SINGLE SELLER AGENCY" or "A. This Agreement begins this", short enough
// that fourteen of them still read as a list.
const MAX_CAPTION = 56

// A caption must be at least this long before a sentence break is allowed to end
// it, so the "1." in "1. SINGLE SELLER AGENCY. Single Seller Agency exists…"
// cannot become the whole caption.
const MIN_SENTENCE_CUT = 8

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)

// Does this word sit on the same printed line as the box? Compared by vertical
// CENTRES rather than overlapping spans: a 10pt checkbox and its 9pt label are
// routinely offset by a point or two (the box is drawn to straddle the
// baseline), and a span test rejected exactly the labels it needed to find.
export function onSameLine(box, word) {
  const boxMid  = box.y + (box.height || 0) / 2
  const wordMid = word.y + (word.height || 0) / 2
  const tol = Math.max((box.height || 0) * 0.75, (word.height || 0) * 0.75, 3)
  return Math.abs(boxMid - wordMid) <= tol
}

// Trim the punctuation a form's typography leaves on a caption, without
// destroying the parts that carry meaning.
//
// The enumerator stays: "1.", "A.", "B." are how the document refers to these
// choices ("check either A or B"), so a caption that drops them is a caption the
// agent cannot match to the page. What goes is the debris — the unbalanced
// bracket from "(exclusive)" where the "(" sits on the far side of the box, a
// trailing comma or colon, and the dangling conjunction from "BUYER or".
export function cleanCaption(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim()
  // Unbalanced brackets, either end. "exclusive)" → "exclusive".
  if (/^[)\]]/.test(s) && !/[([]/.test(s)) s = s.replace(/^[)\]]+\s*/, '')
  if (/[)\]]$/.test(s) && !/[([]/.test(s)) s = s.replace(/\s*[)\]]+$/, '')
  if (/^[([]/.test(s) && !/[)\]]/.test(s)) s = s.replace(/^[([]+\s*/, '')
  s = s.replace(/\s*[,;:]+$/, '')
  s = s.replace(/\s+(or|and)$/i, '')
  s = s.replace(/\s*[,;:]+$/, '')
  return s.trim()
}

// End a caption at the first sentence break, then hard-truncate what is left.
// The sentence break is what turns a policy clause's whole opening paragraph
// into the heading an agent recognizes: "3. APPOINTED AGENCY." ends there and
// the definition that follows is not part of the choice being made.
export function shortenCaption(raw) {
  let s = cleanCaption(raw)
  if (!s) return ''

  // A closing bracket with no opener in front of it means the box sits INSIDE
  // the brackets — "an (|x| exclusive) agency agreement" — so the choice being
  // offered ends at that bracket and the sentence carrying on afterwards is not
  // part of it. Without this, a template whose text extracts as one long run
  // captions the second box "non-exclusive) agency agreement and is entered
  // into by…" instead of "non-exclusive".
  const close = s.search(/[)\]]/)
  if (close >= 2 && !/[([]/.test(s.slice(0, close))) s = cleanCaption(s.slice(0, close))
  if (!s) return ''

  // First ". " (or terminal ".") that leaves something substantial behind.
  const m = /\.(\s|$)/g
  let cut = ''
  let hit
  while ((hit = m.exec(s))) {
    if (hit.index >= MIN_SENTENCE_CUT) { cut = s.slice(0, hit.index); break }
  }
  let out = cleanCaption(cut || s)
  if (out.length <= MAX_CAPTION) return out

  // Truncate on a word boundary rather than mid-word.
  out = out.slice(0, MAX_CAPTION + 1)
  const sp = out.lastIndexOf(' ')
  out = (sp > MAX_CAPTION * 0.5 ? out.slice(0, sp) : out.slice(0, MAX_CAPTION)).trim()
  return `${cleanCaption(out)}…`
}

// Walk words outward from the box along its line, accepting them while each one
// stays within GAP_LIMIT of the last, and stop once there is enough for a
// caption. `dir` is 1 for rightward (the normal case on these forms: box then
// label) and -1 for leftward (a box whose label precedes it).
function runFrom(box, words, dir, siblings = []) {
  const boxLeft  = box.x
  const boxRight = box.x + (box.width || 0)
  const tol = 2

  // The caption stops at the NEXT field box on the line. A row reading
  // "|x| BUYER or |x| SELLER" has two boxes sharing one line, and without this
  // the first box captions itself "BUYER or SELLER" — a label that names the
  // wrong choice as readily as the right one, on a box the sender is about to
  // lock. Where the words run out before the next box, this changes nothing.
  const bounded = (siblings || [])
    .filter(o => o && o.id !== box.id && (o.page || 1) === (box.page || 1) && onSameLine(box, o))
    .map(o => (dir > 0 ? o.x : o.x + (o.width || 0)))
    .filter(v => Number.isFinite(v) && (dir > 0 ? v >= boxRight - tol : v <= boxLeft + tol))
  const stop = bounded.length
    ? (dir > 0 ? Math.min(...bounded) : Math.max(...bounded))
    : null

  const line = words
    .filter(w => onSameLine(box, w))
    .filter(w => (dir > 0
      // Rightward: the word must START at or after the box's right edge, so a
      // run that began to the LEFT of the box and merely extends past it is not
      // mistaken for the box's own label.
      ? w.x >= boxRight - tol
      // Leftward: the word must END at or before the box's left edge.
      : w.x + (w.width || 0) <= boxLeft + tol))
    .filter(w => stop == null || (dir > 0
      ? w.x < stop - tol
      : w.x + (w.width || 0) > stop + tol))
    .sort((a, b) => dir > 0 ? a.x - b.x : (b.x + (b.width || 0)) - (a.x + (a.width || 0)))

  const parts = []
  let edge = dir > 0 ? boxRight : boxLeft
  for (const w of line) {
    const gap = dir > 0 ? w.x - edge : edge - (w.x + (w.width || 0))
    if (gap > GAP_LIMIT) break
    const text = String(w.text || '').trim()
    if (text) {
      parts.push(text)
      // Enough words in hand to fill a caption — anything further would be
      // truncated away anyway, and every extra word is another chance to run
      // into the next column.
      if (parts.join(' ').length > MAX_CAPTION * 2) break
    }
    edge = dir > 0 ? w.x + (w.width || 0) : w.x
  }

  if (dir < 0) parts.reverse()
  return parts.join(' ').trim()
}

// The caption for one field, or '' when the page says nothing beside it.
//
// Right wins over left. On every agency form seen, the box precedes its label;
// leftward is the fallback for a box that trails its text, and a leftward
// caption is reported with lower confidence because it is the rarer shape and
// more easily picks up the tail of an unrelated sentence.
export function captionForBox({ box, words = [], siblings = [] } = {}) {
  if (!box || num(box.x) == null || num(box.y) == null) return { caption: '', side: null, confidence: 'none' }
  const page = num(box.page) || 1
  const onPage = (words || []).filter(w => (num(w.page) || 1) === page && String(w.text || '').trim())

  const right = shortenCaption(runFrom(box, onPage, 1, siblings))
  if (right) return { caption: right, side: 'right', confidence: 'high' }

  const left = shortenCaption(runFrom(box, onPage, -1, siblings))
  if (left) return { caption: left, side: 'left', confidence: 'low' }

  return { caption: '', side: null, confidence: 'none' }
}

// Printed instructions that say how a group of boxes relates. These are read off
// the page and reported as they are — never turned into an enforced rule here.
//
// The distinction matters and is the whole reason this returns a hint rather
// than a verdict: one live packet prints "CHECK ALL BOXES THAT APPLY" above a
// pair of boxes (exclusive / non-exclusive) that a buyer packet must nonetheless
// treat as one-or-the-other. The page is evidence about the page; the business
// rule for a given packet lives with the packet, not here. Reporting the cue
// lets the send screen say "the form says check either A or B" without the
// engine inventing a constraint the document does not state.
const CUE_PATTERNS = [
  { kind: 'either',     re: /check\s+either\s+([A-Z0-9]{1,2})\s+or\s+([A-Z0-9]{1,2})/i },
  { kind: 'one',        re: /check\s+(?:only\s+)?one|select\s+(?:only\s+)?one|choose\s+one|mark\s+one\s+/i },
  { kind: 'all-apply',  re: /check\s+all\s+(?:boxes\s+)?that\s+apply/i },
]

// Scan a page's words for those cues. Returns [{ kind, text, page, y, options }]
// in reading order, so a caller can associate a cue with the boxes below it.
export function detectSelectionCues(words = []) {
  // Reassemble lines: a cue is a phrase, and pdf text arrives in runs that may
  // split it ("(check either A" / "or B):").
  const byLine = new Map()
  for (const w of words) {
    const text = String(w?.text || '').trim()
    if (!text) continue
    const page = num(w.page) || 1
    // Bucket by page and rounded line position. 3pt buckets keep a line
    // together without merging two adjacent ones.
    const key = `${page}:${Math.round((num(w.y) || 0) / 3)}`
    const bucket = byLine.get(key) || { page, y: num(w.y) || 0, items: [] }
    bucket.items.push(w)
    byLine.set(key, bucket)
  }

  const out = []
  for (const b of byLine.values()) {
    const text = b.items
      .sort((p, q) => (num(p.x) || 0) - (num(q.x) || 0))
      .map(w => String(w.text || '').trim())
      .join(' ')
      .replace(/\s+/g, ' ')
    for (const { kind, re } of CUE_PATTERNS) {
      const m = re.exec(text)
      if (!m) continue
      out.push({
        kind,
        text: text.trim().slice(0, 120),
        page: b.page,
        y: b.y,
        ...(kind === 'either' ? { options: [m[1], m[2]].map(s => s.toUpperCase()) } : {}),
      })
      break
    }
  }
  return out.sort((a, b) => a.page - b.page || a.y - b.y)
}

// Caption every field that has geometry. Returns { [fieldId]: { caption, side,
// confidence } } for the ones the page could name — fields with no bounds, and
// fields the page says nothing about, are simply absent, so a caller can fall
// back to whatever it showed before.
export function captionFields({ fields = [], words = [] } = {}) {
  // Every field with geometry is a potential stop for every other field's
  // caption — including the text fields, since a date box sitting between a
  // tick box and the next words ends the caption just as a sibling tick box
  // does ("A. This Agreement begins this |date| day of |label|").
  const boxes = []
  for (const f of fields || []) {
    if (!f?.id) continue
    const b = f.bounds || f
    const box = { id: f.id, page: num(f.page ?? f.pageNumber) || 1, x: num(b.x), y: num(b.y), width: num(b.width) || 0, height: num(b.height) || 0 }
    if (box.x == null || box.y == null) continue
    boxes.push(box)
  }

  const out = {}
  for (const box of boxes) {
    const got = captionForBox({ box, words, siblings: boxes })
    if (got.caption) out[box.id] = got
  }
  return out
}
