// ─────────────────────────────────────────────────────────────────────────────
// pdfWatermark — take the big diagonal DRAFT stamp off a deal's PDF.
//
// WHY THIS EXISTS. BoldSign stamps a large rotated "DRAFT" across every page of
// a document that has not been sent/completed yet, and that stamp is in the
// bytes `/document/download` hands back. Save PDF and Save to Deal build the
// agent's review copy from exactly those bytes (see buildPrintablePdf in
// api/boldsign.js), so the copy an agent prints for a client — the whole point
// of printing a filled draft — came out with DRAFT slashed across every page.
//
// WHAT IT DOES. Content-stream surgery, and nothing else:
//   • the page keeps its own MediaBox/CropBox — nothing is cropped, resized or
//     re-paged, and no page is redrawn onto a new one;
//   • only the drawing block that paints the stamp is deleted, so every other
//     glyph, rule, logo, checkbox and filled-in value is left byte-for-byte as
//     it was — this never rasterises or re-renders a page, so print quality is
//     the source file's own;
//   • nothing is drawn IN — no replacement stamp, note or annotation.
//
// WHAT IT WILL NOT TOUCH. A text block only qualifies when the text it paints
// is the word DRAFT on its own AND it is either rotated or set very large —
// i.e. a watermark rather than prose. A paragraph that happens to contain the
// word ("this draft agreement…"), a small upright DRAFT in a header, and a
// field value an agent typed all stay. Deleting a caption someone needs is a
// worse failure than leaving a stamp, so the doubtful case is left alone.
//
// NEVER THROWS. A PDF this cannot parse comes back unchanged and the caller
// still gets its print copy — with the stamp, exactly as before this existed.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Content-stream scanning ──────────────────────────────────────────────────
// A PDF content stream is postfix: operands, then the operator. Everything
// below works on the stream as latin1 text, so string offsets are byte offsets
// and a span can be cut out of the original bytes without re-serialising the
// parts that are kept.

const WHITESPACE = new Set([' ', '\n', '\r', '\t', '\f', '\0'])
const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%'])

// Escapes inside a literal `(…)` string. \ddd octal is handled separately.
const ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }

function readLiteralString(src, start) {
  // `start` is the opening paren. Parens nest, and a backslash escapes the next
  // character — including a paren, which is why this cannot be a regex.
  let out = ''
  let depth = 1
  let i = start + 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      const n = src[i + 1]
      if (n >= '0' && n <= '7') {
        let oct = ''
        while (oct.length < 3 && src[i + 1] >= '0' && src[i + 1] <= '7') { oct += src[i + 1]; i++ }
        out += String.fromCharCode(parseInt(oct, 8) & 0xff)
        i++
        continue
      }
      if (n === '\n') { i += 2; continue }            // line continuation
      if (n === '\r') { i += src[i + 2] === '\n' ? 3 : 2; continue }
      out += ESCAPES[n] ?? n ?? ''
      i += 2
      continue
    }
    if (c === '(') { depth++; out += c; i++; continue }
    if (c === ')') {
      depth--
      if (depth === 0) return { value: out, end: i + 1 }
      out += c; i++; continue
    }
    out += c
    i++
  }
  return { value: out, end: src.length }
}

function readHexString(src, start) {
  // `start` is the opening angle bracket (already known not to be `<<`).
  let digits = ''
  let i = start + 1
  for (; i < src.length && src[i] !== '>'; i++) {
    if (/[0-9a-fA-F]/.test(src[i])) digits += src[i]
  }
  if (digits.length % 2) digits += '0'
  let value = ''
  for (let k = 0; k < digits.length; k += 2) value += String.fromCharCode(parseInt(digits.slice(k, k + 2), 16))
  return { value, end: i + 1 }
}

// Every operator in the stream, with its operands and the byte span it occupies
// (from the first operand through the operator itself) so a whole block can be
// located and cut. Returns [] for anything it cannot walk.
export function parseContentOps(content) {
  const ops = []
  let operands = []
  let spanStart = -1
  // `[ … ]` operand arrays (the TJ case) collect into their own list.
  let array = null

  const push = (token) => {
    if (spanStart < 0) spanStart = token.start
    if (array) array.items.push(token)
    else operands.push(token)
  }

  let i = 0
  while (i < content.length) {
    const c = content[i]
    if (WHITESPACE.has(c)) { i++; continue }

    if (c === '%') { while (i < content.length && content[i] !== '\n' && content[i] !== '\r') i++; continue }

    if (c === '(') {
      const { value, end } = readLiteralString(content, i)
      push({ type: 'string', value, start: i })
      i = end
      continue
    }

    if (c === '<') {
      if (content[i + 1] === '<') { push({ type: 'other', value: '<<', start: i }); i += 2; continue }
      const { value, end } = readHexString(content, i)
      push({ type: 'string', value, start: i })
      i = end
      continue
    }

    if (c === '>' && content[i + 1] === '>') { push({ type: 'other', value: '>>', start: i }); i += 2; continue }

    if (c === '[') {
      if (spanStart < 0) spanStart = i
      array = { type: 'array', items: [], start: i, parent: array }
      i++
      continue
    }

    if (c === ']') {
      const closed = array
      if (closed) {
        array = closed.parent
        const token = { type: 'array', items: closed.items, start: closed.start }
        if (array) array.items.push(token)
        else operands.push(token)
      }
      i++
      continue
    }

    if (c === '/') {
      let j = i + 1
      while (j < content.length && !WHITESPACE.has(content[j]) && !DELIMITERS.has(content[j])) j++
      push({ type: 'name', value: content.slice(i + 1, j), start: i })
      i = j
      continue
    }

    if (c === '{' || c === '}' || c === ')') { i++; continue }

    // A regular token: either a number (an operand) or an operator.
    let j = i
    while (j < content.length && !WHITESPACE.has(content[j]) && !DELIMITERS.has(content[j])) j++
    const token = content.slice(i, j)
    if (/^[-+.\d]/.test(token) && /^[-+]?(\d+\.?\d*|\.\d+)$/.test(token)) {
      push({ type: 'number', value: Number(token), start: i })
      i = j
      continue
    }

    if (token === 'BI') {
      // An inline image carries raw binary between ID and EI, which is not
      // tokenisable. Skip the whole thing rather than mis-read bytes as ops.
      const idAt = content.indexOf('ID', j)
      const eiAt = idAt < 0 ? -1 : content.indexOf('EI', idAt)
      ops.push({ op: 'BI', operands: [], start: spanStart < 0 ? i : spanStart, end: eiAt < 0 ? content.length : eiAt + 2 })
      operands = []
      array = null
      spanStart = -1
      i = eiAt < 0 ? content.length : eiAt + 2
      continue
    }

    ops.push({ op: token, operands, start: spanStart < 0 ? i : spanStart, end: j })
    operands = []
    array = null
    spanStart = -1
    i = j
  }
  return ops
}

// ─── Matrices ────────────────────────────────────────────────────────────────
// PDF transforms are [a b c d e f]. `b` and `c` carry rotation/skew: both ~0 is
// upright text, anything else is set at an angle — which is what a watermark is.

const IDENTITY = [1, 0, 0, 1, 0, 0]

export function multiplyMatrix(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ]
}

const isRotated = (m) => Math.abs(m[1]) > 0.01 || Math.abs(m[2]) > 0.01

// How much the matrix scales a glyph, so a font size means the same thing
// whether the size lives in `Tf` or in the matrix.
const matrixScale = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1

// ─── What counts as the stamp ────────────────────────────────────────────────

// Letters only, upper-cased: "D R A F T", "DRAFT" and a two-byte-encoded
// "\0D\0R\0A\0F\0T" all normalise to the same word, and the spacing a TJ array
// puts between glyphs stops mattering.
export const normalizeShownText = (text) => String(text ?? '').toUpperCase().replace(/[^A-Z]/g, '')

// Repeats included: some stamps tile the word across the page in one block.
export const isDraftWatermarkText = (text) => /^(DRAFT)+$/.test(normalizeShownText(text))

// A text block is the stamp when it says DRAFT and nothing else, AND it is set
// the way a stamp is set — at an angle, or very large. Upright body text at a
// normal size is left alone even when the word is DRAFT.
export const WATERMARK_MIN_FONT_SIZE = 24
export function looksLikeDraftWatermark({ text, rotated, fontSize }) {
  if (!isDraftWatermarkText(text)) return false
  return Boolean(rotated) || Number(fontSize) >= WATERMARK_MIN_FONT_SIZE
}

// ─── The surgery ─────────────────────────────────────────────────────────────

// Walk one content stream, find every BT…ET block that is the stamp, and return
// the stream with those blocks (and only those) cut out. Also reports how many
// were removed so callers can log a number instead of a guess.
export function stripDraftWatermarkOps(content) {
  const ops = parseContentOps(content)
  if (!ops.length) return { content, removed: 0 }

  const cuts = []
  const stack = []
  let ctm = IDENTITY
  let block = null

  for (const entry of ops) {
    const nums = entry.operands.filter(o => o.type === 'number').map(o => o.value)
    switch (entry.op) {
      case 'q':
        stack.push(ctm)
        break
      case 'Q':
        ctm = stack.pop() || IDENTITY
        break
      case 'cm':
        if (nums.length === 6) ctm = multiplyMatrix(nums, ctm)
        break
      case 'BT':
        block = { start: entry.start, text: '', tm: IDENTITY, fontSize: 0, ctm }
        break
      case 'Tf':
        if (block && nums.length) block.fontSize = nums[nums.length - 1]
        break
      case 'Tm':
        if (block && nums.length === 6) block.tm = nums
        break
      case 'Tj':
      case "'":
      case '"': {
        if (!block) break
        const str = entry.operands.filter(o => o.type === 'string').pop()
        if (str) block.text += str.value
        break
      }
      case 'TJ': {
        if (!block) break
        const arr = entry.operands.filter(o => o.type === 'array').pop()
        for (const item of arr?.items || []) if (item.type === 'string') block.text += item.value
        break
      }
      case 'ET': {
        if (!block) break
        const full = multiplyMatrix(block.tm, block.ctm)
        if (looksLikeDraftWatermark({
          text: block.text,
          rotated: isRotated(full),
          fontSize: block.fontSize * matrixScale(full),
        })) cuts.push([block.start, entry.end])
        block = null
        break
      }
      default:
        break
    }
  }

  if (!cuts.length) return { content, removed: 0 }
  let out = ''
  let at = 0
  for (const [from, to] of cuts) {
    out += content.slice(at, from)
    at = to
  }
  out += content.slice(at)
  return { content: out, removed: cuts.length }
}

// ─── pdf-lib plumbing ────────────────────────────────────────────────────────

const decodeStream = async (stream) => {
  const { decodePDFRawStream, PDFRawStream } = await import('pdf-lib')
  if (stream instanceof PDFRawStream) return Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')
  // Not every content stream on the page came out of the file: flattening a form
  // appends streams pdf-lib built itself this session, and those hand over their
  // own operators directly. Missing them would mean the stamp survives on any
  // document that went through the flatten first.
  if (typeof stream?.getContentsString === 'function') return stream.getContentsString()
  return null
}

// A page's content may be one stream or an array of them; the array is defined
// to be the concatenation, so it is read as one and written back as one.
async function readPageContent(page) {
  const { PDFArray, PDFRawStream } = await import('pdf-lib')
  const contents = page.node.Contents()
  if (!contents) return null
  if (contents instanceof PDFRawStream) return decodeStream(contents)
  if (contents instanceof PDFArray) {
    const parts = []
    for (let i = 0; i < contents.size(); i++) {
      const stream = page.node.context.lookup(contents.get(i))
      const text = await decodeStream(stream)
      if (text == null) return null
      parts.push(text)
    }
    return parts.join('\n')
  }
  return null
}

// A stamp is often packaged as a form XObject the page draws with `Do`, in
// which case the page's own stream holds nothing but the invocation. Same
// surgery, one level down.
async function stripFromFormXObjects(pdfDoc, page) {
  const { PDFName, PDFDict, PDFRawStream } = await import('pdf-lib')
  const context = pdfDoc.context
  const resources = page.node.Resources()
  const xobjects = resources?.lookupMaybe?.(PDFName.of('XObject'), PDFDict)
  if (!xobjects) return 0

  let removed = 0
  for (const [name, ref] of xobjects.entries()) {
    const stream = context.lookup(ref)
    if (!(stream instanceof PDFRawStream)) continue
    if (stream.dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Form')) continue
    const text = await decodeStream(stream)
    if (text == null) continue
    const result = stripDraftWatermarkOps(text)
    if (!result.removed) continue
    // Rewrite the form's own stream in place, keeping its dictionary — its
    // BBox and Matrix are what place anything else it draws.
    const replacement = context.flateStream(result.content)
    for (const [key, value] of stream.dict.entries()) {
      if (key === PDFName.of('Length') || key === PDFName.of('Filter') || key === PDFName.of('DecodeParms')) continue
      replacement.dict.set(key, value)
    }
    xobjects.set(name, context.register(replacement))
    removed += result.removed
  }
  return removed
}

// A stamp can also arrive as an annotation rather than page content: a
// /Watermark annot, or a /Stamp whose name or contents say DRAFT. Those are
// removed too — they print, which is the whole problem.
async function stripWatermarkAnnotations(page) {
  const { PDFName, PDFArray, PDFDict, PDFString, PDFHexString } = await import('pdf-lib')
  const annots = page.node.Annots()
  if (!(annots instanceof PDFArray)) return 0
  const context = page.node.context

  const keep = []
  let removed = 0
  for (let i = 0; i < annots.size(); i++) {
    const ref = annots.get(i)
    const annot = context.lookup(ref)
    let drop = false
    if (annot instanceof PDFDict) {
      const subtype = annot.lookup(PDFName.of('Subtype'))
      const isStamp = subtype === PDFName.of('Stamp')
      if (subtype === PDFName.of('Watermark')) {
        drop = true
      } else if (isStamp) {
        const label = [annot.lookup(PDFName.of('Name')), annot.lookup(PDFName.of('Contents'))]
          .map(v => (v instanceof PDFString || v instanceof PDFHexString) ? v.decodeText()
            : (v instanceof PDFName ? v.asString() : ''))
          .join(' ')
        drop = isDraftWatermarkText(label)
      }
    }
    if (drop) removed++
    else keep.push(ref)
  }
  if (!removed) return 0

  const replacement = context.obj([])
  for (const ref of keep) replacement.push(ref)
  page.node.set(PDFName.of('Annots'), replacement)
  return removed
}

// Strip the DRAFT stamp from every page of a loaded pdf-lib document, in place.
// Returns { blocks, annotations, pages } — how much came off, for the log.
// Never throws: a page that cannot be read is left exactly as it is.
export async function removeDraftWatermark(pdfDoc) {
  const { PDFName } = await import('pdf-lib')
  const context = pdfDoc.context
  const summary = { blocks: 0, annotations: 0, pages: 0 }

  for (const page of pdfDoc.getPages()) {
    let touched = false
    try {
      const content = await readPageContent(page)
      if (content != null) {
        const result = stripDraftWatermarkOps(content)
        if (result.removed) {
          // One replacement stream for the page. The page dictionary is
          // otherwise untouched — same MediaBox, same Resources, same
          // Rotate — so nothing moves, resizes or re-paginates.
          page.node.set(PDFName.of('Contents'), context.register(context.flateStream(result.content)))
          summary.blocks += result.removed
          touched = true
        }
      }
      const inForms = await stripFromFormXObjects(pdfDoc, page)
      if (inForms) { summary.blocks += inForms; touched = true }
      const annots = await stripWatermarkAnnotations(page)
      if (annots) { summary.annotations += annots; touched = true }
    } catch (err) {
      console.warn(`[pdf] watermark: leaving a page as it is (${err.message})`)
      continue
    }
    if (touched) summary.pages++
  }
  return summary
}
