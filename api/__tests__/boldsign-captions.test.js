// templateCaptions — the whole caption pass, from a template's PDF bytes to the
// captions the send screen shows. The PDF is generated here and handed in via
// `fetchPdf`, so the test exercises the real extractor and the real scale
// resolution without a BoldSign account.
import { describe, it, expect } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { templateCaptions } from '../boldsign.js'

const PAGE_H = 792
const PAGE_W = 612

// The agency-agreement row, drawn once and reused. Text positions are given
// TOP-origin, in PDF points.
async function agreementPdf() {
  const doc  = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const page = doc.addPage([PAGE_W, PAGE_H])
  const T = (s, x, yTop, size = 9) => page.drawText(s, { x, y: PAGE_H - yTop - size, size, font })
  T('THIS AGREEMENT is an', 60, 130, 10)
  T('exclusive)', 185, 130)
  T('non-exclusive) agency agreement', 253, 130)
  T('prospective', 60, 145)
  T('BUYER or', 123, 145)
  T('SELLER', 188, 145)
  return new Uint8Array(await doc.save())
}

// Field bounds as BoldSign reports them, in whatever unit `scaleFrom` implies:
// dividing point coordinates by the scale is how a document measured in pixels
// at 96 DPI (scale 0.75) reports the same physical position.
const fieldsAt = (scale) => ([
  { id: 'Checkbox1',  page: 1, bounds: { x: 172 / scale, y: 129 / scale, width: 10 / scale, height: 10 / scale } },
  { id: 'CheckBox2',  page: 1, bounds: { x: 240 / scale, y: 129 / scale, width: 10 / scale, height: 10 / scale } },
  { id: 'CheckBox11', page: 1, bounds: { x: 110 / scale, y: 144 / scale, width: 10 / scale, height: 10 / scale } },
  { id: 'CheckBox4',  page: 1, bounds: { x: 175 / scale, y: 144 / scale, width: 10 / scale, height: 10 / scale } },
])

describe('templateCaptions', () => {
  it('captions every box from the page, in points', async () => {
    const pdf = await agreementPdf()
    const { captions } = await templateCaptions('tpl-points', {
      fields: fieldsAt(1),
      props: { documentPageDetails: [{ pageNumber: 1, width: PAGE_W, height: PAGE_H }] },
      fetchPdf: async () => pdf,
    })
    expect(Object.fromEntries(Object.entries(captions).map(([k, v]) => [k, v.caption]))).toEqual({
      Checkbox1:  'exclusive',
      CheckBox2:  'non-exclusive',
      CheckBox11: 'BUYER',
      CheckBox4:  'SELLER',
    })
  })

  // The unit BoldSign reports bounds in is not fixed, and a caption matched at
  // the wrong scale would land on whatever text happens to sit at 0.75 of the
  // real position — a plausible wrong answer, the failure mode that matters.
  it('resolves a pixel-measured document from the page size BoldSign reports', async () => {
    const pdf = await agreementPdf()
    const { captions } = await templateCaptions('tpl-pixels', {
      fields: fieldsAt(0.75),
      props: { documentPageDetails: [{ pageNumber: 1, width: PAGE_W / 0.75, height: PAGE_H / 0.75 }] },
      fetchPdf: async () => pdf,
    })
    expect(captions.Checkbox1?.caption).toBe('exclusive')
    expect(captions.CheckBox11?.caption).toBe('BUYER')
  })

  it('returns nothing when the PDF cannot be fetched', async () => {
    const out = await templateCaptions('tpl-nofetch', {
      fields: fieldsAt(1),
      fetchPdf: async () => { throw new Error('HTTP 403') },
    })
    expect(out).toEqual({ captions: {}, cues: [] })
  })

  it('returns nothing when the bytes are not a PDF', async () => {
    const out = await templateCaptions('tpl-garbage', {
      fields: fieldsAt(1),
      fetchPdf: async () => new Uint8Array([1, 2, 3, 4]),
    })
    expect(out.captions).toEqual({})
  })

  it('does not download anything for a template whose fields carry no geometry', async () => {
    let called = false
    const out = await templateCaptions('tpl-nogeo', {
      fields: [{ id: 'Checkbox1', page: 1 }],
      fetchPdf: async () => { called = true; return new Uint8Array() },
    })
    expect(called).toBe(false)
    expect(out.captions).toEqual({})
  })

  it('serves a repeat call from cache instead of re-parsing', async () => {
    const pdf = await agreementPdf()
    let downloads = 0
    const args = {
      fields: fieldsAt(1),
      props: { documentPageDetails: [{ pageNumber: 1, width: PAGE_W, height: PAGE_H }] },
      fetchPdf: async () => { downloads += 1; return pdf },
    }
    const first  = await templateCaptions('tpl-cached', args)
    const second = await templateCaptions('tpl-cached', args)
    expect(downloads).toBe(1)
    expect(second).toBe(first)
  })
})
