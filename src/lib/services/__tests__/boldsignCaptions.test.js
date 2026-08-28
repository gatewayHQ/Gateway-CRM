// Captions read off a PDF page. The end-to-end cases below build a real PDF with
// pdf-lib, laid out the way the live Iowa buyer-agency packet is, and run the
// actual text extractor over it — because the failure mode this whole mechanism
// exists to prevent is a caption that is confidently wrong, and only real
// extracted geometry can prove it isn't.
import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { extractPdfWords } from '../../../../api/_lib/pdfText.js'
import {
  captionFields, captionForBox, detectSelectionCues,
  cleanCaption, shortenCaption, onSameLine,
} from '../boldsignCaptions.js'

const PAGE_H = 792

// Build a one-page PDF from a script of text runs and record where the tick
// boxes sit. Coordinates are given TOP-origin (BoldSign's frame) and converted
// for pdf-lib on the way in, so the fixtures read like the printed page.
async function buildPage(draw) {
  const doc  = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([612, PAGE_H])
  const boxes = []
  const api = {
    text: (s, x, yTop, size = 9) => page.drawText(s, { x, y: PAGE_H - yTop - size, size, font }),
    box:  (id, x, yTop, w = 10, h = 10) => { boxes.push({ id, page: 1, bounds: { x, y: yTop, width: w, height: h } }); },
  }
  draw(api)
  const { words } = await extractPdfWords(await doc.save())
  return { words, boxes, captions: captionFields({ fields: boxes, words }) }
}

const caption = (caps, id) => caps[id]?.caption ?? null

describe('captions from a real PDF — the Appointed Agency Agreement row', () => {
  it('names each box from the words printed beside it', async () => {
    const { captions } = await buildPage(({ text, box }) => {
      text('CHECK ALL BOXES THAT APPLY.', 60, 100, 10)
      text('THIS AGREEMENT is an', 60, 130, 10)
      box('Checkbox1', 172, 129)
      text('exclusive)', 185, 130)
      box('CheckBox2', 240, 129)
      text('non-exclusive) agency agreement and is entered into by and between', 253, 130)
    })
    expect(caption(captions, 'Checkbox1')).toBe('exclusive')
    // Cut at the unbalanced bracket: the box sits inside "(non-exclusive)", so
    // the sentence continuing afterwards is not part of the choice.
    expect(caption(captions, 'CheckBox2')).toBe('non-exclusive')
  })

  // The bug that makes hand-mapping dangerous, in miniature. Two boxes share the
  // line, so the first one's caption must stop at the second box — otherwise the
  // BUYER box is captioned "BUYER or SELLER" and reads as either choice on a box
  // the sender is about to lock on.
  it('stops a caption at the next box on the line', async () => {
    const { captions } = await buildPage(({ text, box }) => {
      text('prospective', 60, 145)
      box('CheckBox11', 110, 144)
      text('BUYER or', 123, 145)
      box('CheckBox4', 175, 144)
      text('SELLER', 188, 145)
    })
    expect(caption(captions, 'CheckBox11')).toBe('BUYER')
    expect(caption(captions, 'CheckBox4')).toBe('SELLER')
  })
})

describe('captions from a real PDF — the policy list and the term choice', () => {
  it('ends a policy caption at its heading, not the clause that defines it', async () => {
    const { captions } = await buildPage(({ text, box }) => {
      box('CheckBox8', 58, 199)
      text('1.  SINGLE SELLER AGENCY.  Single Seller Agency exists when Brokerage and Seller enter into a', 74, 200)
      box('CheckBox3', 58, 269)
      text('3.  APPOINTED AGENCY.', 74, 270)
    })
    expect(caption(captions, 'CheckBox8')).toBe('1. SINGLE SELLER AGENCY')
    expect(caption(captions, 'CheckBox3')).toBe('3. APPOINTED AGENCY')
  })

  it('keeps the A/B enumerator the document refers to the choice by', async () => {
    const { captions } = await buildPage(({ text, box }) => {
      text('6. TERM OF AGREEMENT  (check either A or B):', 60, 360, 10)
      box('CheckBox6', 74, 379)
      text('A.  This Agreement begins this', 88, 380)
      box('CheckBox7', 74, 409)
      text('B. This Agreement begins this', 88, 410)
    })
    expect(caption(captions, 'CheckBox6')).toMatch(/^A\. This Agreement begins/)
    expect(caption(captions, 'CheckBox7')).toMatch(/^B\. This Agreement begins/)
  })

  it('reads the printed instruction off the page', async () => {
    const { words } = await buildPage(({ text }) => {
      text('CHECK ALL BOXES THAT APPLY.', 60, 100, 10)
      text('6. TERM OF AGREEMENT  (check either A or B):', 60, 360, 10)
    })
    const cues = detectSelectionCues(words)
    expect(cues.map(c => c.kind)).toEqual(['all-apply', 'either'])
    expect(cues[1].options).toEqual(['A', 'B'])
  })
})

describe('captions never guess', () => {
  it('gives no caption to a box with nothing printed beside it', async () => {
    const { captions } = await buildPage(({ text, box }) => {
      box('Checkbox9', 300, 500)
      // Far away on the page, and on another line.
      text('Signature of Buyer', 60, 700)
    })
    expect(captions.Checkbox9).toBeUndefined()
  })

  it('ignores text on a different page', () => {
    const box = { page: 2, x: 100, y: 100, width: 10, height: 10 }
    const words = [{ text: 'exclusive', x: 113, y: 100, width: 40, height: 9, page: 1 }]
    expect(captionForBox({ box, words }).caption).toBe('')
  })

  it('will not jump a wide gap to reach the next column', () => {
    const box = { page: 1, x: 100, y: 100, width: 10, height: 10 }
    const words = [{ text: 'Initials', x: 300, y: 100, width: 30, height: 9, page: 1 }]
    expect(captionForBox({ box, words }).caption).toBe('')
  })

  // A box whose label precedes it is the rarer shape and more easily picks up
  // the tail of an unrelated sentence, so it is reported as low confidence —
  // the caller can show it and still know it is the weaker read.
  it('falls back to the left, flagged as the weaker read', () => {
    const box = { page: 1, x: 200, y: 100, width: 10, height: 10 }
    const words = [{ text: 'Buyer initials here', x: 120, y: 100, width: 75, height: 9, page: 1 }]
    const got = captionForBox({ box, words })
    expect(got.caption).toBe('Buyer initials here')
    expect(got.side).toBe('left')
    expect(got.confidence).toBe('low')
  })
})

describe('caption text handling', () => {
  it('strips the debris a form leaves behind', () => {
    expect(cleanCaption('  exclusive)  ')).toBe('exclusive')
    expect(cleanCaption('BUYER or')).toBe('BUYER')
    expect(cleanCaption('Earnest money,')).toBe('Earnest money')
    // A balanced pair is the author's own punctuation and stays.
    expect(cleanCaption('(exclusive)')).toBe('(exclusive)')
  })

  it('will not let an enumerator become the whole caption', () => {
    expect(shortenCaption('1. SINGLE SELLER AGENCY. Single Seller Agency exists when'))
      .toBe('1. SINGLE SELLER AGENCY')
    expect(shortenCaption('A. This')).toBe('A. This')
  })

  it('truncates long text on a word boundary', () => {
    const out = shortenCaption('This Agreement begins on the date written below and continues without interruption')
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out).not.toMatch(/\s…$/)
  })

  it('matches a box to its label by line, not by exact overlap', () => {
    const box = { y: 100, height: 10 }
    expect(onSameLine(box, { y: 101, height: 9 })).toBe(true)
    expect(onSameLine(box, { y: 118, height: 9 })).toBe(false)
  })
})
