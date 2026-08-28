// The Selections panel's rows. The panel is the SENDER's pre-check: every row is
// a term of the agreement they lock onto the document before it goes out, so the
// two failures that matter are a row named after the wrong box and a row that
// silently changes what the packet says.
import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { extractPdfWords } from '../../../../api/_lib/pdfText.js'
import { captionFields } from '../boldsignCaptions.js'
import { shortLabelFor, selectionRows, seedSelectionValues, applySelection, isTicked } from '../boldsignSelections.js'

describe('shortLabelFor — from the printed caption, never the id', () => {
  it('reads the representation pair the right way round', () => {
    // "exclusive" is a substring of "non-exclusive": the wrong rule order labels
    // this box as the exact opposite of the term being agreed.
    expect(shortLabelFor('non-exclusive').label).toBe('Non-exclusive representation')
    expect(shortLabelFor('exclusive').label).toBe('Exclusive representation')
    expect(shortLabelFor('non-exclusive').mutex).toBe('representation')
    expect(shortLabelFor('exclusive').mutex).toBe('representation')
  })

  it('names the four policies', () => {
    expect(shortLabelFor('1. SINGLE SELLER AGENCY').label).toBe('Policy: Single Seller Agency')
    expect(shortLabelFor('2. SINGLE BUYER AGENCY').label).toBe('Policy: Single Buyer Agency')
    expect(shortLabelFor('3. APPOINTED AGENCY').label).toBe('Policy: Appointed Agency')
    expect(shortLabelFor('4. CONSENSUAL DUAL AGENCY').label).toBe('Policy: Consensual Dual Agency')
  })

  it('does not mistake a policy clause for the party box', () => {
    // "2. SINGLE BUYER AGENCY" contains "buyer" and is not the party checkbox.
    expect(shortLabelFor('2. SINGLE BUYER AGENCY').label).not.toMatch(/^Party/)
    expect(shortLabelFor('BUYER').label).toBe('Party: Buyer')
    expect(shortLabelFor('SELLER').label).toBe('Party: Seller')
  })

  it('tells the two terms apart by what the clause says', () => {
    const a = shortLabelFor('A. This Agreement begins this day of , 20 , and shall continue until closing of the transaction')
    const b = shortLabelFor('B. This Agreement begins this day of , and ends at 11:59 p.m. the')
    expect(a.label).toBe('Term A: Until close / completion')
    expect(b.label).toBe('Term B: Fixed end date')
    expect(a.mutex).toBe('term')
    expect(b.mutex).toBe('term')
  })

  it('recognizes nothing in wording it does not know', () => {
    expect(shortLabelFor('Initial here if you have received the pamphlet')).toBeNull()
    expect(shortLabelFor('')).toBeNull()
  })
})

describe('rows', () => {
  const fields = [
    { id: 'CheckBox4', page: 3, caption: '1. SINGLE SELLER AGENCY', bounds: { y: 200 } },
    { id: 'CheckBox1', page: 2, caption: 'exclusive',              bounds: { y: 130 } },
    { id: 'CheckBox3', page: 2, caption: 'BUYER', value: 'true',   bounds: { y: 145 } },
    { id: 'CheckBox2', page: 2, caption: 'non-exclusive',          bounds: { y: 130 } },
  ]

  it('orders rows as they appear on the paper, not in placement order', () => {
    expect(selectionRows({ fields }).map(r => r.id)).toEqual(['CheckBox1', 'CheckBox2', 'CheckBox3', 'CheckBox4'])
  })

  it('titles every row from its printed meaning', () => {
    const titles = selectionRows({ fields }).map(r => r.title)
    expect(titles).toEqual([
      'Exclusive representation', 'Non-exclusive representation', 'Party: Buyer', 'Policy: Single Seller Agency',
    ])
    expect(titles.some(t => /checkbox/i.test(t))).toBe(false)
  })

  // A box with nothing printed beside it cannot be named. Showing its id is the
  // only honest option left — inventing a name for a box that locks a term is
  // the one thing this must never do.
  it('keeps the id only for a box the page could not caption', () => {
    const rows = selectionRows({ fields: [{ id: 'CheckBox9', page: 3 }] })
    expect(rows[0].title).toBe('CheckBox9')
    expect(rows[0].named).toBe(false)
  })

  it('defaults each row to the state the template already carries', () => {
    const rows = selectionRows({ fields })
    expect(seedSelectionValues(rows)).toEqual({
      CheckBox1: false, CheckBox2: false, CheckBox3: true, CheckBox4: false,
    })
  })

  it('reads every spelling BoldSign uses for a ticked box', () => {
    for (const v of [true, 'true', 'True', 'on', 'YES', 'checked', '1', 'X']) expect(isTicked(v)).toBe(true)
    for (const v of [false, 'false', '', null, undefined, '0', 'no']) expect(isTicked(v)).toBe(false)
  })
})

describe('mutex', () => {
  const rows = selectionRows({ fields: [
    { id: 'ex',    page: 2, caption: 'exclusive' },
    { id: 'nonex', page: 2, caption: 'non-exclusive' },
    { id: 'termA', page: 3, caption: 'A. This Agreement begins this day of and shall continue until closing of the transaction' },
    { id: 'termB', page: 3, caption: 'B. This Agreement begins this day of and ends at 11:59 p.m. the' },
  ] })

  it('checking one representation unchecks the other', () => {
    const after = applySelection({ ex: false, nonex: true }, rows, 'ex', true)
    expect(after).toMatchObject({ ex: true, nonex: false })
  })

  it('checking one term unchecks the other, and leaves the other group alone', () => {
    const after = applySelection({ ex: true, nonex: false, termA: true, termB: false }, rows, 'termB', true)
    expect(after).toMatchObject({ termA: false, termB: true, ex: true })
  })

  // Clearing both is a valid intermediate state. Ticking the other one for the
  // sender would be this panel deciding a term of the agreement on their behalf.
  it('unchecking one never checks the other', () => {
    const after = applySelection({ ex: true, nonex: false }, rows, 'ex', false)
    expect(after).toMatchObject({ ex: false, nonex: false })
  })
})

// End to end: a PDF laid out like the buyer packet, through the real extractor
// and captioner, into the rows the panel renders. This is the table the panel
// shows — derived from printed text, with no id anywhere in it.
describe('end to end, from a generated PDF', () => {
  it('names every box on both pages', async () => {
    const doc  = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const H = 792
    const fields = []
    const mk = (page, n) => {
      const p = doc.addPage([612, H])
      return {
        T: (s, x, yTop, size = 9) => p.drawText(s, { x, y: H - yTop - size, size, font }),
        B: (id, x, yTop, value) => fields.push({ id, page: n, value, bounds: { x, y: yTop, width: 10, height: 10 } }),
      }
    }
    doc.addPage([612, H])                       // page 1, not part of the panel
    const p2 = mk(2, 2)
    p2.T('THIS AGREEMENT is an', 60, 130, 10)
    p2.B('CheckBox1', 172, 129);  p2.T('exclusive)', 185, 130)
    p2.B('CheckBox2', 240, 129);  p2.T('non-exclusive) agency agreement', 253, 130)
    p2.T('prospective', 60, 145)
    p2.B('CheckBox3', 110, 144, 'true'); p2.T('BUYER or', 123, 145)

    const p3 = mk(3, 3)
    p3.B('CheckBox4', 58, 199); p3.T('1.  SINGLE SELLER AGENCY.  Single Seller Agency exists when', 74, 200)
    p3.B('CheckBox5', 58, 229); p3.T('2.  SINGLE BUYER AGENCY.  Single Buyer Agency exists when', 74, 230)
    p3.B('CheckBox6', 58, 259, 'true'); p3.T('3.  APPOINTED AGENCY.', 74, 260)
    p3.B('CheckBox7', 58, 289, 'true'); p3.T('4.  CONSENSUAL DUAL AGENCY.', 74, 290)
    p3.B('CheckBox8', 74, 379); p3.T('A.  This Agreement begins this day of , 20 , and shall continue until closing of the transaction', 88, 380)
    p3.B('CheckBox9', 74, 409); p3.T('B. This Agreement begins this day of , and ends at 11:59 p.m. the', 88, 410)

    const { words } = await extractPdfWords(await doc.save())
    const caps = captionFields({ fields, words })
    const rows = selectionRows({ fields: fields.map(f => ({ ...f, caption: caps[f.id]?.caption })) })

    expect(rows.map(r => [r.id, r.page, r.title, r.defaultChecked])).toEqual([
      ['CheckBox1', 2, 'Exclusive representation',          false],
      ['CheckBox2', 2, 'Non-exclusive representation',      false],
      ['CheckBox3', 2, 'Party: Buyer',                      true],
      ['CheckBox4', 3, 'Policy: Single Seller Agency',      false],
      ['CheckBox5', 3, 'Policy: Single Buyer Agency',       false],
      ['CheckBox6', 3, 'Policy: Appointed Agency',          true],
      ['CheckBox7', 3, 'Policy: Consensual Dual Agency',    true],
      ['CheckBox8', 3, 'Term A: Until close / completion',  false],
      ['CheckBox9', 3, 'Term B: Fixed end date',            false],
    ])
    // The panel's own acceptance test: no row is named after a field id.
    expect(rows.every(r => !/^Check\s?Box\d+$/i.test(r.title))).toBe(true)
  })
})
