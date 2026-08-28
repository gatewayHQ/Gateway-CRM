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

// ── A saved layout must not carry a checkbox's tick ──────────────────────────
// A layout remembers WHERE the agent put things. The state of a checkbox is a
// term of the agreement, decided on the send screen for this packet. BoldSign
// reports an unticked box as the non-empty string "false", so capturing it put a
// stale value in the layout that the next /document/edit replayed onto the new
// draft — clearing the boxes this send had just ticked and the ones the template
// itself carried. /document/edit runs AFTER the draft is created, so it had the
// last word.
describe('layouts carry placement, not tick state', () => {
  it('does not capture a checkbox value, ticked or unticked', async () => {
    const { normalizeCapturedField } = await import('../boldsign.js')
    const box = { id: 'CheckBox3', fieldType: 'CheckBox', pageNumber: 1, bounds: { x: 10, y: 20, width: 10, height: 10 } }
    expect(normalizeCapturedField({ ...box, value: 'false' })).not.toHaveProperty('value')
    expect(normalizeCapturedField({ ...box, value: 'true'  })).not.toHaveProperty('value')
    // A text field's value is still captured — that is the hand-typed label the
    // layout exists to preserve.
    expect(normalizeCapturedField({ ...box, fieldType: 'TextBox', value: 'Story County' }))
      .toMatchObject({ value: 'Story County' })
  })

  it('drops a tick from a layout already stored with one', async () => {
    const { buildLayoutEditPayload } = await import('../boldsign.js')
    const layout = { signers: [{ signerEmail: 'buyer@example.com', formFields: [
      { id: 'CheckBox3', fieldType: 'CheckBox', pageNumber: 1, bounds: { x: 10, y: 20, width: 10, height: 10 }, value: 'false' },
    ] }] }
    const signerDetails = [{ id: 'signer-1', signerEmail: 'buyer@example.com', formFields: [{ id: 'CheckBox3', value: 'true' }] }]
    const payload = buildLayoutEditPayload({ layout, signerDetails })
    const field = payload.signers[0].formFields.find(f => f.id === 'CheckBox3')
    // The live draft's own value wins, and the layout's stale "false" is gone.
    expect(field.value).toBe('true')
  })

  it('leaves a checkbox alone when the draft reports no value for it', async () => {
    const { buildLayoutEditPayload } = await import('../boldsign.js')
    const layout = { signers: [{ signerEmail: 'buyer@example.com', formFields: [
      { id: 'CheckBox3', fieldType: 'CheckBox', pageNumber: 1, bounds: { x: 10, y: 20, width: 10, height: 10 }, value: 'false' },
    ] }] }
    const signerDetails = [{ id: 'signer-1', signerEmail: 'buyer@example.com', formFields: [{ id: 'CheckBox3' }] }]
    const payload = buildLayoutEditPayload({ layout, signerDetails })
    const field = payload.signers[0].formFields.find(f => f.id === 'CheckBox3')
    // No value at all rather than an explicit "false": BoldSign reads a false as
    // an instruction to clear the template's own tick.
    expect(field).not.toHaveProperty('value')
  })
})

// ── Ticks reconciled against the finished draft ──────────────────────────────
// The reported failure: a draft created from a template whose BUYER box was
// ticked came back with that box empty, and boxes the send screen ticked arrived
// unticked — while the Labels on the same document filled in correctly. So the
// create call is not trusted to carry a tick; the finished draft is read back and
// the difference repaired through /document/edit.
describe('tickRepairPayload', () => {
  const props = (formFields) => ({ signerDetails: [{ id: 'signer-1', formFields }] })

  it('repairs a box the draft did not tick', async () => {
    const { tickRepairPayload } = await import('../boldsign.js')
    const out = tickRepairPayload({
      props: props([{ id: 'CheckBox2', fieldType: 'CheckBox', value: 'false' }]),
      desired: { CheckBox2: true },
    })
    expect(out).toEqual({ signers: [{ editAction: 'Update', id: 'signer-1', formFields: [
      { editAction: 'Update', id: 'CheckBox2', value: 'true' },
    ] }] })
  })

  // The wipe, from the other side: the template had it ticked, the draft lost it,
  // and the CRM puts it back rather than hoping silence preserved it.
  it('restores a template tick the draft lost', async () => {
    const { tickRepairPayload } = await import('../boldsign.js')
    const out = tickRepairPayload({
      props: props([{ id: 'CheckBox3', fieldType: 'CheckBox' }]),
      desired: { CheckBox3: true },
    })
    expect(out.signers[0].formFields).toEqual([{ editAction: 'Update', id: 'CheckBox3', value: 'true' }])
  })

  it('touches nothing that already agrees', async () => {
    const { tickRepairPayload } = await import('../boldsign.js')
    expect(tickRepairPayload({
      props: props([
        { id: 'CheckBox3', fieldType: 'CheckBox', value: 'true' },
        { id: 'CheckBox1', fieldType: 'CheckBox', value: 'false' },
      ]),
      desired: { CheckBox3: true, CheckBox1: false },
    })).toBeNull()
  })

  // A box nobody decided is absent from the map. Writing any value to it is
  // exactly what would clear a tick the template put there.
  it('never writes a field the caller did not name', async () => {
    const { tickRepairPayload } = await import('../boldsign.js')
    const out = tickRepairPayload({
      props: props([
        { id: 'CheckBox2', fieldType: 'CheckBox', value: 'false' },
        { id: 'CheckBox14', fieldType: 'CheckBox', value: 'true' },
        { id: 'CheckBox15', fieldType: 'CheckBox' },
      ]),
      desired: { CheckBox2: true },
    })
    expect(out.signers[0].formFields.map(f => f.id)).toEqual(['CheckBox2'])
  })

  it('leaves non-tickable fields alone', async () => {
    const { tickRepairPayload } = await import('../boldsign.js')
    expect(tickRepairPayload({
      props: props([{ id: 'Label1', fieldType: 'Label', value: '' }]),
      desired: { Label1: true },
    })).toBeNull()
  })

  // The repair addresses the ids the DOCUMENT reports, so casing cannot be wrong
  // — which is the whole reason it runs against a read-back rather than a guess.
  it('matches the document’s own casing', async () => {
    const { tickRepairPayload } = await import('../boldsign.js')
    const out = tickRepairPayload({
      props: props([{ id: 'Checkbox2', fieldType: 'CheckBox', value: 'false' }]),
      desired: { CheckBox2: true },
    })
    expect(out.signers[0].formFields[0].id).toBe('Checkbox2')
  })

  it('reads every spelling BoldSign uses for a ticked box', async () => {
    const { tickRepairPayload } = await import('../boldsign.js')
    for (const value of ['true', 'on', 'X', '1', 'checked']) {
      expect(tickRepairPayload({
        props: props([{ id: 'CheckBox3', fieldType: 'CheckBox', value }]),
        desired: { CheckBox3: true },
      })).toBeNull()
    }
  })

  it('spans every signer that holds one of the boxes', async () => {
    const { tickRepairPayload } = await import('../boldsign.js')
    const out = tickRepairPayload({
      props: { signerDetails: [
        { id: 's1', formFields: [{ id: 'CheckBox1', fieldType: 'CheckBox', value: 'true' }] },
        { id: 's2', formFields: [{ id: 'CheckBox2', fieldType: 'CheckBox', value: 'false' }] },
      ] },
      desired: { CheckBox1: false, CheckBox2: true },
    })
    expect(out.signers.map(s => s.id)).toEqual(['s1', 's2'])
  })
})

describe('unmetTicks', () => {
  it('names the boxes that still disagree after the repair', async () => {
    const { unmetTicks } = await import('../boldsign.js')
    expect(unmetTicks({
      props: { signerDetails: [{ id: 's1', formFields: [
        { id: 'CheckBox2', fieldType: 'CheckBox', value: 'true' },
        { id: 'CheckBox3', fieldType: 'CheckBox', value: 'false' },
      ] }] },
      desired: { CheckBox2: true, CheckBox3: true },
    })).toEqual(['CheckBox3'])
  })

  it('is empty when the draft holds what was asked for', async () => {
    const { unmetTicks } = await import('../boldsign.js')
    expect(unmetTicks({
      props: { signerDetails: [{ id: 's1', formFields: [{ id: 'CheckBox2', fieldType: 'CheckBox', value: 'true' }] }] },
      desired: { CheckBox2: true },
    })).toEqual([])
  })
})
