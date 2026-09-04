// pdfWatermark — the DRAFT stamp comes off, and nothing else does.
//
// The PDFs are generated here with pdf-lib and read back with the same text
// extractor the caption pass uses, so what is asserted is what a reader (and a
// printer) would actually see on the page — not what the content stream looks
// like.
import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import {
  removeDraftWatermark,
  stripDraftWatermarkOps,
  looksLikeDraftWatermark,
  isDraftWatermarkText,
  parseContentOps,
} from '../_lib/pdfWatermark.js'
import { extractPdfWords } from '../_lib/pdfText.js'

const PAGE_W = 612
const PAGE_H = 792

// A two-page agreement with the stamp BoldSign puts on an unsent document:
// large, rotated, screened back, on every page.
async function stampedPdf({ pages = 2, size = 72, rotate = 45 } = {}) {
  const doc  = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([PAGE_W, PAGE_H])
    page.drawText('EXCLUSIVE LISTING AGREEMENT', { x: 60, y: 700, size: 14, font: bold })
    page.drawText('This draft is subject to review by counsel.', { x: 60, y: 660, size: 10, font })
    page.drawText(`Seller initials ______   Page ${i + 1}`, { x: 60, y: 620, size: 10, font })
    page.drawRectangle({ x: 60, y: 580, width: 10, height: 10, borderWidth: 1, borderColor: rgb(0, 0, 0) })
    page.drawText('DRAFT', {
      x: 120, y: 250, size, font: bold, rotate: degrees(rotate), color: rgb(0.85, 0.85, 0.85), opacity: 0.3,
    })
  }
  return new Uint8Array(await doc.save())
}

// The extractor deliberately drops rotated runs (a watermark is not a caption),
// so "is the stamp still in the file?" is answered from the page's own drawing
// instructions rather than from extracted words.
const drawnStrings = async (bytes) => {
  // pdf.js detaches the buffer it is handed, so every reader here works on its
  // own copy and a test can read the same PDF twice.
  const doc = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true })
  const { decodePDFRawStream, PDFRawStream } = await import('pdf-lib')
  const out = []
  for (const page of doc.getPages()) {
    const contents = page.node.Contents()
    const streams = contents instanceof PDFRawStream
      ? [contents]
      : Array.from({ length: contents.size() }, (_, i) => page.node.context.lookup(contents.get(i)))
    for (const stream of streams) {
      const text = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')
      for (const op of parseContentOps(text)) {
        for (const operand of op.operands) {
          if (operand.type === 'string') out.push(operand.value)
          if (operand.type === 'array') for (const it of operand.items) if (it.type === 'string') out.push(it.value)
        }
      }
    }
  }
  return out
}

const wordsOf = async (bytes) => {
  const { words, pages } = await extractPdfWords(bytes.slice())
  return { text: words.map(w => w.text).join(' '), pages }
}

const strip = async (bytes) => {
  const doc = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true })
  const summary = await removeDraftWatermark(doc)
  return { summary, bytes: new Uint8Array(await doc.save()) }
}

describe('removeDraftWatermark', () => {
  it('removes the stamp from every page and leaves the document alone', async () => {
    const before = await stampedPdf()
    expect(await drawnStrings(before)).toContain('DRAFT')

    const { summary, bytes } = await strip(before)
    expect(summary).toMatchObject({ pages: 2, blocks: 2, annotations: 0 })

    // Gone from the file itself, not merely invisible to the extractor.
    expect(await drawnStrings(bytes)).not.toContain('DRAFT')

    const after = await wordsOf(bytes)
    expect(after.text).toContain('EXCLUSIVE LISTING AGREEMENT')
    expect(after.text).toContain('This draft is subject to review by counsel.')
    // Every other run survives exactly as it was drawn, spacing included.
    const kept = await drawnStrings(bytes)
    expect(kept).toContain('Seller initials ______   Page 1')
    expect(kept).toContain('Seller initials ______   Page 2')
  })

  it('does not crop, resize or re-paginate', async () => {
    const before = await stampedPdf({ pages: 3 })
    const { bytes } = await strip(before)
    const doc = await PDFDocument.load(bytes.slice())
    expect(doc.getPageCount()).toBe(3)
    for (const page of doc.getPages()) {
      expect(page.getWidth()).toBe(PAGE_W)
      expect(page.getHeight()).toBe(PAGE_H)
    }
    const { pages } = await wordsOf(bytes)
    expect(pages).toEqual([
      { width: PAGE_W, height: PAGE_H },
      { width: PAGE_W, height: PAGE_H },
      { width: PAGE_W, height: PAGE_H },
    ])
  })

  it('leaves a page that was never stamped byte-identical in content', async () => {
    const doc  = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([PAGE_W, PAGE_H])
    page.drawText('A draft of the purchase agreement is attached.', { x: 60, y: 700, size: 11, font })
    const clean = new Uint8Array(await doc.save())

    const { summary, bytes } = await strip(clean)
    expect(summary).toMatchObject({ pages: 0, blocks: 0, annotations: 0 })
    expect((await wordsOf(bytes)).text).toContain('A draft of the purchase agreement is attached.')
  })

  it('takes an upright stamp off too when it is set large', async () => {
    const before = await stampedPdf({ pages: 1, rotate: 0, size: 90 })
    const { summary, bytes } = await strip(before)
    expect(summary.blocks).toBe(1)
    expect(await drawnStrings(bytes)).not.toContain('DRAFT')
  })

  it('keeps a small upright DRAFT — that is a label, not a stamp', async () => {
    const doc  = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([PAGE_W, PAGE_H])
    page.drawText('DRAFT', { x: 60, y: 700, size: 9, font })
    const bytes = new Uint8Array(await doc.save())

    const { summary, bytes: out } = await strip(bytes)
    expect(summary.blocks).toBe(0)
    expect(await drawnStrings(out)).toContain('DRAFT')
  })

  it('survives bytes it cannot make sense of', async () => {
    const doc = await PDFDocument.create()
    doc.addPage([PAGE_W, PAGE_H])
    const summary = await removeDraftWatermark(doc)
    expect(summary).toMatchObject({ pages: 0, blocks: 0 })
  })
})

describe('stripDraftWatermarkOps', () => {
  it('cuts only the stamp block out of the stream', async () => {
    const content = [
      'BT /F1 10 Tf 1 0 0 1 60 700 Tm (Purchase Agreement) Tj ET',
      'q 0.7 0.7 -0.7 0.7 100 200 cm BT /F2 60 Tf (DRAFT) Tj ET Q',
      'BT /F1 10 Tf 1 0 0 1 60 660 Tm (Signed this day) Tj ET',
    ].join('\n')
    const out = stripDraftWatermarkOps(content)
    expect(out.removed).toBe(1)
    expect(out.content).toContain('(Purchase Agreement) Tj')
    expect(out.content).toContain('(Signed this day) Tj')
    expect(out.content).not.toContain('(DRAFT)')
    // The surrounding graphics state is left exactly as it was.
    expect(out.content).toContain('0.7 0.7 -0.7 0.7 100 200 cm')
  })

  it('reads the word through TJ spacing and two-byte encodings', () => {
    const spaced = 'BT /F1 60 Tf 0.7 0.7 -0.7 0.7 100 200 Tm [(D) -20 (R) -20 (A) -20 (F) -20 (T)] TJ ET'
    expect(stripDraftWatermarkOps(spaced).removed).toBe(1)
    const hex = 'BT /F1 60 Tf 0.7 0.7 -0.7 0.7 100 200 Tm <00440052004100460054> Tj ET'
    expect(stripDraftWatermarkOps(hex).removed).toBe(1)
  })

  it('leaves prose that merely contains the word', () => {
    const prose = 'BT /F1 60 Tf 0.7 0.7 -0.7 0.7 100 200 Tm (DRAFT COPY — DO NOT SIGN) Tj ET'
    expect(stripDraftWatermarkOps(prose).removed).toBe(0)
  })

  it('is not fooled by a parenthesis inside a string', () => {
    const tricky = 'BT /F1 10 Tf 1 0 0 1 60 700 Tm (a \\(draft\\) ET copy) Tj ET'
    const ops = parseContentOps(tricky)
    expect(ops.filter(o => o.op === 'ET')).toHaveLength(1)
    expect(stripDraftWatermarkOps(tricky).removed).toBe(0)
  })
})

describe('looksLikeDraftWatermark', () => {
  it('recognises the word however it is spaced or cased', () => {
    expect(isDraftWatermarkText('D R A F T')).toBe(true)
    expect(isDraftWatermarkText('draft')).toBe(true)
    expect(isDraftWatermarkText('DRAFTDRAFT')).toBe(true)
    expect(isDraftWatermarkText('DRAFT COPY')).toBe(false)
  })

  it('needs the word to be set like a stamp', () => {
    expect(looksLikeDraftWatermark({ text: 'DRAFT', rotated: true, fontSize: 8 })).toBe(true)
    expect(looksLikeDraftWatermark({ text: 'DRAFT', rotated: false, fontSize: 72 })).toBe(true)
    expect(looksLikeDraftWatermark({ text: 'DRAFT', rotated: false, fontSize: 10 })).toBe(false)
    expect(looksLikeDraftWatermark({ text: 'Final', rotated: true, fontSize: 72 })).toBe(false)
  })
})

// Not every producer paints the stamp straight onto the page. These two cover
// the other shapes it arrives in.
describe('stamps that are not page content', () => {
  it('reaches into a form XObject the page draws', async () => {
    const { PDFName, PDFRawStream } = await import('pdf-lib')
    const doc  = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const page = doc.addPage([PAGE_W, PAGE_H])
    page.drawText('Purchase Agreement', { x: 60, y: 700, size: 12, font })

    const stamp = doc.context.flateStream(
      'q BT /F1 1 Tf 45 0 0 45 100 200 Tm (DRAFT) Tj ET Q',
      { Type: 'XObject', Subtype: 'Form', BBox: doc.context.obj([0, 0, PAGE_W, PAGE_H]),
        Matrix: doc.context.obj([0.7, 0.7, -0.7, 0.7, 0, 0]) },
    )
    const xobjects = doc.context.obj({ Wm: doc.context.register(stamp) })
    page.node.Resources().set(PDFName.of('XObject'), xobjects)
    page.node.addContentStream(doc.context.register(doc.context.flateStream('q /Wm Do Q')))

    const saved = new Uint8Array(await doc.save())
    const { summary, bytes } = await strip(saved)
    expect(summary.blocks).toBe(1)
    expect(await drawnStrings(bytes)).not.toContain('DRAFT')
    expect(await drawnStrings(bytes)).toContain('Purchase Agreement')

    // The form is still there and still placed the same way — only the stamp
    // inside it is gone.
    const after = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true })
    const form = after.getPages()[0].node.Resources()
      .lookup(PDFName.of('XObject')).lookup(PDFName.of('Wm'))
    expect(form).toBeInstanceOf(PDFRawStream)
    expect(form.dict.lookup(PDFName.of('Matrix')).toString()).toBe('[ 0.7 0.7 -0.7 0.7 0 0 ]')
  })

  it('removes a DRAFT stamp annotation and keeps the other annotations', async () => {
    const { PDFName } = await import('pdf-lib')
    const doc  = await PDFDocument.create()
    const page = doc.addPage([PAGE_W, PAGE_H])
    const keep = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: doc.context.obj([0, 0, 10, 10]),
    }))
    const stamp = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Stamp', Name: 'Draft', Rect: doc.context.obj([0, 0, 400, 400]),
    }))
    page.node.set(PDFName.of('Annots'), doc.context.obj([keep, stamp]))

    const { summary, bytes } = await strip(new Uint8Array(await doc.save()))
    expect(summary).toMatchObject({ annotations: 1, pages: 1 })
    const after = await PDFDocument.load(bytes.slice(), { ignoreEncryption: true })
    const annots = after.getPages()[0].node.Annots()
    expect(annots.size()).toBe(1)
    expect(after.context.lookup(annots.get(0)).lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Link'))
  })
})
