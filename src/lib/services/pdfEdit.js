// ─────────────────────────────────────────────────────────────────────────────
// SPLIT & MERGE — the two paper operations every transaction file needs.
//
// A brokerage's documents never arrive shaped the way they have to be filed. A
// board sends one 40-page scan holding six forms; a lender wants the disclosure
// and its acknowledgement as one document. Agents have been doing this in Form
// Simplicity and mailing the result back into the CRM, which means the deal's
// own filing cabinet is a copy of somebody's downloads folder.
//
// WHERE THE WORK HAPPENS. In the browser, with pdf-lib, on bytes the agent can
// already read. Nothing here needs a server: the source file is downloaded with
// the agent's own signed URL and the result is uploaded under their own session,
// so Supabase's row rules answer "may they touch this deal?" exactly as they do
// for a plain upload. A serverless endpoint would add a function to a capped
// plan and a service key to a path that does not need one.
//
// WHAT IS PURE AND WHY. Every rule an agent can get wrong — a page number
// outside the document, a range that runs backwards, two pieces that would land
// on the same filename — is decided by the pure functions in the first half of
// this file, which take values and return verdicts. They are tested directly.
// The pdf-lib calls at the bottom do only what their names say.
//
// NOTHING IS DESTRUCTIVE. A split writes new documents and leaves the original
// on the deal; a merge does the same. The agent deletes the source themselves,
// after they have seen what came out — because "it split wrong AND the original
// is gone" is not a state this feature is allowed to create.
// ─────────────────────────────────────────────────────────────────────────────

/** The most pages one operation will touch. A guard against a runaway paste, not a policy. */
export const MAX_PAGES = 2000

/** How many rows the split panel starts with, matching the six an agent sees in Form Simplicity. */
export const SPLIT_ROWS = 6

let rowSeq = 0
/** A blank row for the split panel. `id` is a React key, never persisted. */
export function blankSplitRow() {
  return { id: `row-${++rowSeq}`, from: '', to: '', name: '' }
}

/** SPLIT_ROWS blank rows — what the panel opens with. */
export function initialSplitRows(count = SPLIT_ROWS) {
  return Array.from({ length: count }, () => blankSplitRow())
}

/**
 * A page number as the agent typed it. Returns null for anything that is not a
 * positive whole number, INCLUDING "1.5" and "2x" — a silent Math.floor would
 * split a document somewhere the agent did not ask for.
 */
export function parsePageNumber(value) {
  const raw = String(value ?? '').trim()
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 ? n : null
}

/** A row the agent has not touched. Blank rows are ignored, never an error. */
export function isBlankSplitRow(row) {
  return !String(row?.from ?? '').trim() && !String(row?.to ?? '').trim() && !String(row?.name ?? '').trim()
}

/** The document's own name, minus the upload timestamp and the extension. */
export function baseName(fileName) {
  return String(fileName || 'Document')
    .replace(/^\d{10,}-/, '')          // the `Date.now()-` prefix the uploader adds
    .replace(/\.[a-z0-9]{1,6}$/i, '')  // the extension
    .trim() || 'Document'
}

/**
 * The name a piece is actually stored under: safe as a storage key, and still
 * the name the agent typed. This is the ONE authority on that — what the screen
 * promises ("saved as …") is what lands on the deal, so nothing downstream
 * sanitizes it a second time into something else.
 *
 * Spaces and brackets are kept (both are ordinary in a form's name and legal in
 * a storage key); a slash, a quote or a control character is not — those are
 * what a filename must never carry.
 */
export function safeFileName(name) {
  const cleaned = String(name || '')
    .replace(/\.pdf$/i, '')
    .replace(/[^a-zA-Z0-9._()&+ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')          // a leading dot would hide the file
    .trim()
  return `${cleaned || 'Document'}.pdf`
}

/**
 * What a piece is called when the agent left the name box empty. Names it after
 * the page range rather than "Document 1", so a stack of pieces stays sortable
 * and an agent can tell at a glance which part of the scan each one came from.
 */
export function defaultPieceName(sourceName, from, to) {
  const base = baseName(sourceName)
  return from === to ? `${base} p${from}` : `${base} p${from}-${to}`
}

/**
 * Decide a split. Returns { ok, error, pieces, rowErrors } — `rowErrors` is
 * keyed by row id so the panel can mark the row that is wrong instead of
 * printing one message about a form with six rows in it.
 *
 * Every refusal names the row and the number, because "invalid range" sends an
 * agent back to guess which of six lines it meant.
 */
export function validateSplit({ rows = [], pageCount = 0, sourceName = '' } = {}) {
  const rowErrors = {}
  const pieces = []
  const used = new Map()   // filename → how many pieces have claimed it

  if (!pageCount) return { ok: false, error: 'This document has no pages to split.', pieces: [], rowErrors }

  rows.forEach((row, i) => {
    if (isBlankSplitRow(row)) return
    const label = `Line ${i + 1}`
    const from = parsePageNumber(row.from)
    const to   = parsePageNumber(row.to)

    if (from == null || to == null) {
      rowErrors[row.id] = `${label}: enter a first and last page (whole numbers).`
      return
    }
    if (from > pageCount || to > pageCount) {
      rowErrors[row.id] = `${label}: this document only has ${pageCount} page${pageCount === 1 ? '' : 's'}.`
      return
    }
    if (from > to) {
      rowErrors[row.id] = `${label}: page ${from} comes after page ${to} — swap them.`
      return
    }

    // A name collision would overwrite the piece written a moment ago, so the
    // second one is numbered rather than refused: the agent meant two pieces.
    const wanted = safeFileName(String(row.name || '').trim() || defaultPieceName(sourceName, from, to))
    const seen = used.get(wanted) || 0
    used.set(wanted, seen + 1)
    const filename = seen ? safeFileName(`${wanted.replace(/\.pdf$/i, '')} (${seen + 1})`) : wanted

    pieces.push({ id: row.id, from, to, filename, pages: to - from + 1 })
  })

  const firstRowError = Object.values(rowErrors)[0]
  if (firstRowError) return { ok: false, error: firstRowError, pieces: [], rowErrors }
  if (!pieces.length) {
    return { ok: false, error: 'Fill in at least one line — the first page, the last page, and what to call it.', pieces: [], rowErrors }
  }
  const total = pieces.reduce((n, p) => n + p.pages, 0)
  if (total > MAX_PAGES) {
    return { ok: false, error: `That is ${total} pages in one go. Split it in smaller batches (limit ${MAX_PAGES}).`, pieces: [], rowErrors }
  }

  return { ok: true, error: '', pieces, rowErrors }
}

/**
 * Pages the split would leave behind. Not an error — an agent pulling two forms
 * out of a six-form scan means to leave the rest — but worth saying out loud,
 * because "I thought I got all of it" is how a disclosure goes missing.
 */
export function unclaimedPages(pieces = [], pageCount = 0) {
  const claimed = new Set()
  for (const p of pieces) for (let n = p.from; n <= p.to; n++) claimed.add(n)
  const out = []
  for (let n = 1; n <= pageCount; n++) if (!claimed.has(n)) out.push(n)
  return out
}

/** "1, 2 and 7-9" — a page list a person can read back to themselves. */
export function describePages(pages = []) {
  if (!pages.length) return ''
  const runs = []
  let start = pages[0], prev = pages[0]
  for (const n of pages.slice(1)) {
    if (n === prev + 1) { prev = n; continue }
    runs.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = prev = n
  }
  runs.push(start === prev ? `${start}` : `${start}-${prev}`)
  return runs.length === 1 ? runs[0] : `${runs.slice(0, -1).join(', ')} and ${runs[runs.length - 1]}`
}

/**
 * Decide a merge. Order is the caller's and is never re-sorted here: "the
 * amendment after the agreement it amends" is a filing requirement, not a
 * display preference.
 */
export function validateMerge({ items = [], name = '' } = {}) {
  if (items.length < 2) {
    return { ok: false, error: 'Add a second document — a merge needs at least two.', filename: '' }
  }
  const nonPdf = items.filter(i => i.pages === 0 || i.notPdf)
  if (nonPdf.length) {
    return {
      ok: false,
      error: `${nonPdf.map(i => i.label || i.name).join(', ')} ${nonPdf.length === 1 ? 'is not a PDF' : 'are not PDFs'}, so ${nonPdf.length === 1 ? 'it' : 'they'} cannot be merged. Remove ${nonPdf.length === 1 ? 'it' : 'them'} and try again.`,
      filename: '',
    }
  }
  const typed = String(name || '').trim()
  return { ok: true, error: '', filename: safeFileName(typed || `${baseName(items[0].label || items[0].name)} (merged)`) }
}

/**
 * Move one entry of an ordered list to a new position. Returns a new array;
 * an out-of-range index is a no-op. A MOVE, not a swap: dragging the last
 * document to the top should put it on top and push the rest down, which is
 * what the agent watched their cursor do.
 */
export function moveItem(list = [], from, to) {
  if (from === to) return list
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

// ─── pdf-lib, and nothing else ───────────────────────────────────────────────
// Imported dynamically so the library lands in its own chunk: the Documents tab
// loads for every deal, and splitting a scan is something an agent does a few
// times a month.

/** How many pages a PDF has. Throws with a readable message if it is not a PDF. */
export async function pdfPageCount(bytes) {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  return doc.getPageCount()
}

/**
 * Cut `pieces` out of one PDF. Returns [{ ...piece, bytes }] in the order given.
 * Pages are COPIED, never moved — the source bytes are untouched, and a piece
 * that overlaps another is simply both agents' pages.
 */
export async function splitPdfBytes(bytes, pieces = []) {
  const { PDFDocument } = await import('pdf-lib')
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const total = src.getPageCount()

  const out = []
  for (const piece of pieces) {
    if (piece.to > total) throw new Error(`${piece.filename} asks for page ${piece.to}, but this document has ${total}.`)
    const doc = await PDFDocument.create()
    const indices = []
    for (let n = piece.from; n <= piece.to; n++) indices.push(n - 1)
    const copied = await doc.copyPages(src, indices)
    for (const page of copied) doc.addPage(page)
    out.push({ ...piece, bytes: await doc.save({ useObjectStreams: true }) })
  }
  return out
}

/**
 * Concatenate PDFs in the order given. `items` is [{ bytes, label }]; a file
 * that will not parse is named in the error rather than silently dropped — a
 * merged packet quietly missing a disclosure is worse than no packet.
 */
export async function mergePdfBytes(items = []) {
  const { PDFDocument } = await import('pdf-lib')
  const out = await PDFDocument.create()
  for (const item of items) {
    let src
    try {
      src = await PDFDocument.load(item.bytes, { ignoreEncryption: true })
    } catch (err) {
      throw new Error(`${item.label || 'A document'} could not be read as a PDF (${err.message}), so nothing was merged.`)
    }
    const pages = await out.copyPages(src, src.getPageIndices())
    for (const page of pages) out.addPage(page)
  }
  return out.save({ useObjectStreams: true })
}
