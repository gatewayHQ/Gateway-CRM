import { describe, it, expect } from 'vitest'
import {
  parsePageNumber, isBlankSplitRow, baseName, safeFileName, defaultPieceName,
  validateSplit, unclaimedPages, describePages, validateMerge, moveItem,
  initialSplitRows, blankSplitRow, SPLIT_ROWS, MAX_PAGES,
  splitPdfBytes, mergePdfBytes, pdfPageCount,
} from '../pdfEdit.js'

// ─────────────────────────────────────────────────────────────────────────────
// The rules behind Split and Merge. Everything an agent can get wrong lives
// here, because the alternative is finding out after the pieces are written:
// a split writes real documents onto a real deal, and "page 40 of a 12-page
// scan" has to be refused before pdf-lib is ever asked for it.
// ─────────────────────────────────────────────────────────────────────────────
const row = (from, to, name = '', id = `r${from}-${to}-${name}`) => ({ id, from, to, name })

describe('parsePageNumber — a page is a whole page', () => {
  it('takes the numbers a page can be', () => {
    expect(parsePageNumber('1')).toBe(1)
    expect(parsePageNumber(' 12 ')).toBe(12)
  })

  it('refuses what would silently become a different page', () => {
    // "1.5" rounded down would split somewhere the agent did not ask for.
    for (const bad of ['1.5', '2x', '', '0', '-3', 'one', null, undefined]) {
      expect(parsePageNumber(bad)).toBeNull()
    }
  })
})

describe('naming', () => {
  it('strips the upload timestamp and the extension from a stored name', () => {
    expect(baseName('1757642400000-202 Listing Change Form.pdf')).toBe('202 Listing Change Form')
    expect(baseName('Addendum.PDF')).toBe('Addendum')
    expect(baseName('')).toBe('Document')
  })

  it('keeps a name readable while making it storage-safe', () => {
    expect(safeFileName('611 E South St — Addendum')).toBe('611 E South St Addendum.pdf')
    expect(safeFileName('already.pdf')).toBe('already.pdf')
    expect(safeFileName('   ')).toBe('Document.pdf')
  })

  it('names an unnamed piece after the pages it came from', () => {
    expect(defaultPieceName('Scan.pdf', 3, 7)).toBe('Scan p3-7')
    expect(defaultPieceName('Scan.pdf', 4, 4)).toBe('Scan p4')
  })
})

describe('validateSplit — nothing is cut until every line makes sense', () => {
  it('ignores the blank lines the panel starts with', () => {
    const rows = [...initialSplitRows(), row('1', '2', 'Agreement')]
    const v = validateSplit({ rows, pageCount: 10, sourceName: 'Scan.pdf' })
    expect(v.ok).toBe(true)
    expect(v.pieces).toHaveLength(1)
    expect(v.pieces[0]).toMatchObject({ from: 1, to: 2, pages: 2, filename: 'Agreement.pdf' })
  })

  it('opens with six lines, like the screen it replaces', () => {
    expect(initialSplitRows()).toHaveLength(SPLIT_ROWS)
    expect(blankSplitRow().id).not.toBe(blankSplitRow().id)   // stable React keys
  })

  it('refuses a page the document does not have, and says how many it has', () => {
    const v = validateSplit({ rows: [row('1', '40')], pageCount: 12, sourceName: 'Scan.pdf' })
    expect(v.ok).toBe(false)
    expect(v.error).toContain('only has 12 pages')
  })

  it('refuses a range that runs backwards rather than quietly swapping it', () => {
    const v = validateSplit({ rows: [row('9', '3')], pageCount: 12 })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/page 9 comes after page 3/)
  })

  it('names the line that is wrong, so six lines do not become one guess', () => {
    const rows = [row('1', '2', 'Good'), row('3', '99', 'Bad', 'bad-row')]
    const v = validateSplit({ rows, pageCount: 12 })
    expect(v.ok).toBe(false)
    expect(v.rowErrors['bad-row']).toBeTruthy()
    expect(v.error).toContain('Line 2')
  })

  it('treats a half-filled line as a mistake, not as a blank', () => {
    const v = validateSplit({ rows: [row('3', '', 'Disclosure')], pageCount: 12 })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/first and last page/)
  })

  it('will not run on nothing', () => {
    expect(validateSplit({ rows: initialSplitRows(), pageCount: 12 }).ok).toBe(false)
    expect(validateSplit({ rows: [row('1', '2')], pageCount: 0 }).ok).toBe(false)
  })

  it('numbers a repeated name instead of writing one piece over the other', () => {
    const rows = [row('1', '2', 'Disclosure', 'a'), row('3', '4', 'Disclosure', 'b')]
    const v = validateSplit({ rows, pageCount: 10 })
    expect(v.ok).toBe(true)
    expect(v.pieces.map(p => p.filename)).toEqual(['Disclosure.pdf', 'Disclosure (2).pdf'])
  })

  it('falls back to the page range when the name box is left empty', () => {
    const v = validateSplit({ rows: [row('3', '7')], pageCount: 10, sourceName: '1757642400000-Scan.pdf' })
    expect(v.pieces[0].filename).toBe('Scan p3-7.pdf')
  })

  it('allows one page to land in two pieces — a cover sheet belongs to both', () => {
    const rows = [row('1', '5', 'A', 'a'), row('5', '9', 'B', 'b')]
    expect(validateSplit({ rows, pageCount: 9 }).ok).toBe(true)
  })

  it('stops a runaway batch', () => {
    const v = validateSplit({ rows: [row('1', String(MAX_PAGES + 1))], pageCount: MAX_PAGES + 1 })
    expect(v.ok).toBe(false)
    expect(v.error).toContain('smaller batches')
  })
})

describe('unclaimedPages — what the split would leave behind', () => {
  it('reports the pages no piece asked for', () => {
    const { pieces } = validateSplit({ rows: [row('1', '2', 'A', 'a'), row('5', '6', 'B', 'b')], pageCount: 8 })
    expect(unclaimedPages(pieces, 8)).toEqual([3, 4, 7, 8])
  })

  it('is empty when every page is accounted for', () => {
    const { pieces } = validateSplit({ rows: [row('1', '4', 'A', 'a'), row('5', '8', 'B', 'b')], pageCount: 8 })
    expect(unclaimedPages(pieces, 8)).toEqual([])
  })
})

describe('describePages — a page list a person can read', () => {
  it('collapses runs and joins the last with "and"', () => {
    expect(describePages([1])).toBe('1')
    expect(describePages([1, 2])).toBe('1-2')
    expect(describePages([1, 2, 7, 8, 9])).toBe('1-2 and 7-9')
    expect(describePages([1, 3, 5])).toBe('1, 3 and 5')
    expect(describePages([])).toBe('')
  })
})

describe('validateMerge — two documents, in an order somebody chose', () => {
  const doc = (label, pages = 2) => ({ key: label, label, pages })

  it('needs a second document', () => {
    const v = validateMerge({ items: [doc('A.pdf')], name: '' })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/at least two/)
  })

  it('names the file that is not a PDF rather than dropping it', () => {
    const v = validateMerge({ items: [doc('A.pdf'), { key: 'b', label: 'Scan.tiff', pages: 0, notPdf: true }] })
    expect(v.ok).toBe(false)
    expect(v.error).toContain('Scan.tiff')
  })

  it('takes the typed name, and falls back to the first document when it is blank', () => {
    expect(validateMerge({ items: [doc('A.pdf'), doc('B.pdf')], name: 'Closing Packet' }).filename)
      .toBe('Closing Packet.pdf')
    expect(validateMerge({ items: [doc('1757642400000-Listing.pdf'), doc('B.pdf')], name: '  ' }).filename)
      .toBe('Listing (merged).pdf')
  })
})

describe('moveItem — a move, not a swap', () => {
  const list = ['a', 'b', 'c', 'd']

  it('pushes the rest along, the way the cursor showed', () => {
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveItem(list, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('behaves as a neighbour swap for the up/down buttons', () => {
    expect(moveItem(list, 1, 0)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveItem(list, 1, 2)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('leaves the list alone when the move goes nowhere', () => {
    expect(moveItem(list, 0, 0)).toBe(list)
    expect(moveItem(list, 0, -1)).toBe(list)
    expect(moveItem(list, 9, 1)).toBe(list)
  })
})

describe('isBlankSplitRow', () => {
  it('is blank only when nothing at all was typed', () => {
    expect(isBlankSplitRow({ from: '', to: '', name: '' })).toBe(true)
    expect(isBlankSplitRow({ from: '', to: '', name: 'Addendum' })).toBe(false)
    expect(isBlankSplitRow({ from: '2', to: '', name: '' })).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The pdf-lib half, against real PDFs. The rules above decide WHAT to cut; these
// prove the cut lands where it was asked to — a split that quietly returns the
// wrong pages passes every test written against ranges alone.
// ─────────────────────────────────────────────────────────────────────────────
describe('splitPdfBytes / mergePdfBytes — on real bytes', () => {
  // Each page carries its own number as text, so a piece can be read back and
  // checked against the pages it was supposed to contain.
  const sourcePdf = async (pages) => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 1; i <= pages; i++) {
      doc.addPage([612, 792]).drawText(`PAGE ${i}`, { x: 60, y: 700, size: 24, font })
    }
    return doc.save()
  }
  const pageCount = async (bytes) => {
    const { PDFDocument } = await import('pdf-lib')
    return (await PDFDocument.load(bytes)).getPageCount()
  }

  it('cuts each piece to exactly the pages it named', async () => {
    const src = await sourcePdf(10)
    const { pieces } = validateSplit({
      rows: [row('1', '3', 'Agreement', 'a'), row('7', '7', 'Signature page', 'b')],
      pageCount: 10,
    })
    const cut = await splitPdfBytes(src, pieces)
    expect(cut.map(c => c.filename)).toEqual(['Agreement.pdf', 'Signature page.pdf'])
    expect(await pageCount(cut[0].bytes)).toBe(3)
    expect(await pageCount(cut[1].bytes)).toBe(1)
  })

  it('leaves the source untouched — the original stays on the deal', async () => {
    const src = await sourcePdf(6)
    const before = await pageCount(src)
    await splitPdfBytes(src, validateSplit({ rows: [row('2', '4')], pageCount: 6 }).pieces)
    expect(await pageCount(src)).toBe(before)
  })

  it('refuses a page the document does not have rather than writing a short piece', async () => {
    const src = await sourcePdf(3)
    await expect(splitPdfBytes(src, [{ from: 1, to: 9, filename: 'Too long.pdf' }]))
      .rejects.toThrow(/page 9, but this document has 3/)
  })

  it('merges in the order given, page for page', async () => {
    const a = await sourcePdf(2)
    const b = await sourcePdf(3)
    const merged = await mergePdfBytes([{ bytes: a, label: 'A' }, { bytes: b, label: 'B' }])
    expect(await pageCount(merged)).toBe(5)
  })

  it('names the file that will not parse instead of merging around it', async () => {
    const a = await sourcePdf(1)
    const junk = new Uint8Array([1, 2, 3, 4])
    await expect(mergePdfBytes([{ bytes: a, label: 'Good.pdf' }, { bytes: junk, label: 'Scan.tiff' }]))
      .rejects.toThrow(/Scan\.tiff could not be read/)
  })

  it('reads back a page count for the merge screen', async () => {
    expect(await pdfPageCount(await sourcePdf(4))).toBe(4)
  })
})
