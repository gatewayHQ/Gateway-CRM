import { describe, it, expect, beforeEach } from 'vitest'
import {
  rectToFraction, rectBelongsTo, onSameLine, gapBetween, joinRuns,
  makeMark, groupMarks, resetMarkIds, markToLine, describeMark,
  unsupportedPages, validateMarks, drawStrikes, pdfPageBoxes,
  STRIKE_DEPTH, MIN_THICKNESS, MAX_THICKNESS,
} from '../pdfStrike.js'

// ─────────────────────────────────────────────────────────────────────────────
// The geometry behind striking a clause out of a form.
//
// This is the half that has to be right. A line in the wrong place is not a
// cosmetic bug — it is a signed document that says something nobody agreed to,
// so every conversion between the three frames a mark passes through (the
// browser's pixels, the page's fractions, pdf-lib's points) is pinned here.
// ─────────────────────────────────────────────────────────────────────────────

const host = { left: 100, top: 50, width: 400, height: 600 }
const rect = (left, top, width, height) => ({ left, top, width, height })
const frac = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 })

beforeEach(() => resetMarkIds())

describe('rectToFraction — the browser\'s pixels become the page\'s own measure', () => {
  it('measures a rectangle against the page it sits on', () => {
    expect(rectToFraction(rect(100, 50, 40, 12), host)).toEqual({ x0: 0, y0: 0, x1: 0.1, y1: 0.02 })
  })

  it('is unaffected by zoom, because both sides scale together', () => {
    const at1x = rectToFraction(rect(100, 50, 40, 12), host)
    const at3x = rectToFraction(rect(300, 150, 120, 36), { left: 300, top: 150, width: 1200, height: 1800 })
    expect(at3x).toEqual(at1x)
  })

  it('clamps a selection that runs past the edge of the page', () => {
    const f = rectToFraction(rect(80, 40, 600, 700), host)
    expect(f).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 })
  })

  it('refuses what would be a line of length zero', () => {
    // A caret, a stray click, a collapsed range — none of these is a mark.
    expect(rectToFraction(rect(100, 50, 0, 12), host)).toBeNull()
    expect(rectToFraction(rect(100, 50, 40, 0), host)).toBeNull()
    expect(rectToFraction(rect(100, 50, 0.4, 12), host)).toBeNull()
    expect(rectToFraction(null, host)).toBeNull()
  })

  it('refuses a host that has not been laid out yet', () => {
    expect(rectToFraction(rect(100, 50, 40, 12), { left: 0, top: 0, width: 0, height: 0 })).toBeNull()
    expect(rectToFraction(rect(100, 50, 40, 12), undefined)).toBeNull()
  })
})

describe('rectBelongsTo — which page a selection landed on', () => {
  it('takes a rectangle whose centre is on the page', () => {
    expect(rectBelongsTo(rect(120, 80, 40, 12), host)).toBe(true)
  })

  it('leaves one that belongs to the page above', () => {
    expect(rectBelongsTo(rect(120, -40, 40, 12), host)).toBe(false)
  })

  it('does not treat missing numbers as the origin', () => {
    // A null coerced to 0 would put a phantom rectangle at the page's corner.
    expect(rectBelongsTo({ left: null, top: null, width: null, height: null }, host)).toBe(false)
    expect(rectBelongsTo(undefined, host)).toBe(false)
  })
})

describe('onSameLine / gapBetween', () => {
  it('reads two runs of the same printed line as one line', () => {
    expect(onSameLine(frac(0.1, 0.40, 0.2, 0.415), frac(0.21, 0.40, 0.3, 0.415))).toBe(true)
  })

  it('keeps consecutive lines apart', () => {
    expect(onSameLine(frac(0.1, 0.40, 0.2, 0.415), frac(0.1, 0.42, 0.2, 0.435))).toBe(false)
  })

  it('tolerates the point or two a superscript shifts a run', () => {
    expect(onSameLine(frac(0.1, 0.400, 0.2, 0.415), frac(0.21, 0.402, 0.3, 0.414))).toBe(true)
  })

  it('measures the gap between runs, and calls an overlap zero', () => {
    expect(gapBetween(frac(0.1, 0, 0.2, 1), frac(0.25, 0, 0.3, 1))).toBeCloseTo(0.05, 6)
    expect(gapBetween(frac(0.1, 0, 0.25, 1), frac(0.2, 0, 0.3, 1))).toBe(0)
  })
})

describe('joinRuns — one stroke per line, not one per text run', () => {
  it('closes the space between two runs of the same word group', () => {
    // "twelve" and "(12)" come back as separate runs; the space between them
    // belongs to neither, and drawn as-is the strike has a hole in it.
    const joined = joinRuns([
      frac(0.20, 0.40, 0.28, 0.415),
      frac(0.285, 0.40, 0.34, 0.415),
    ])
    expect(joined).toHaveLength(1)
    expect(joined[0]).toMatchObject({ x0: 0.20, x1: 0.34 })
  })

  it('joins a chain of runs even though its ends are far apart', () => {
    const joined = joinRuns([
      frac(0.10, 0.40, 0.20, 0.415),
      frac(0.205, 0.40, 0.30, 0.415),
      frac(0.305, 0.40, 0.40, 0.415),
    ])
    expect(joined).toHaveLength(1)
    expect(joined[0]).toMatchObject({ x0: 0.10, x1: 0.40 })
  })

  it('leaves a real gap alone — two struck phrases are two strokes', () => {
    const joined = joinRuns([
      frac(0.10, 0.40, 0.20, 0.415),
      frac(0.60, 0.40, 0.70, 0.415),
    ])
    expect(joined).toHaveLength(2)
  })

  it('keeps a selection that wraps as one stroke per line', () => {
    const joined = joinRuns([
      frac(0.55, 0.40, 0.90, 0.415),
      frac(0.10, 0.42, 0.35, 0.435),
    ])
    expect(joined).toHaveLength(2)
    expect(joined[0].y0).toBeLessThan(joined[1].y0)
  })

  it('has nothing to say about nothing', () => {
    expect(joinRuns([])).toEqual([])
    expect(joinRuns([null, undefined])).toEqual([])
  })
})

describe('marks and their grouping', () => {
  it('ties the strokes of one selection together', () => {
    const group = 'sel-1'
    const marks = [
      makeMark({ page: 2, rect: frac(0.55, 0.40, 0.90, 0.415), text: 'shall not exceed twelve (12)', group }),
      makeMark({ page: 2, rect: frac(0.10, 0.42, 0.35, 0.435), text: 'shall not exceed twelve (12)', group }),
    ]
    const grouped = groupMarks(marks)
    expect(grouped).toHaveLength(1)
    expect(grouped[0]).toMatchObject({ page: 2, lines: 2, text: 'shall not exceed twelve (12)' })
  })

  it('stands a lone mark on its own without a caller supplying a group', () => {
    const m = makeMark({ page: 1, rect: frac(0.1, 0.1, 0.2, 0.12), text: 'twelve (12)' })
    expect(m.group).toBe(m.id)
    expect(groupMarks([m])).toHaveLength(1)
  })

  it('tidies the text it carries, and never lets it grow unbounded in the panel', () => {
    const m = makeMark({ page: 1, rect: frac(0.1, 0.1, 0.2, 0.12), text: '  twelve\n  (12)  ' })
    expect(m.text).toBe('twelve (12)')
    expect(describeMark(m)).toBe('Page 1 · twelve (12)')

    // A struck paragraph must not push the panel open. The page prefix stays,
    // the passage is cut to 48 and says that it was.
    const long = makeMark({ page: 3, rect: frac(0.1, 0.1, 0.9, 0.12), text: 'x'.repeat(200) })
    const described = describeMark(long)
    expect(described.startsWith('Page 3 · ')).toBe(true)
    expect(described.slice('Page 3 · '.length)).toHaveLength(48)
    expect(described.endsWith('…')).toBe(true)
  })
})

describe('markToLine — the flip into pdf-lib\'s frame', () => {
  const letter = { width: 612, height: 792 }

  it('puts the line through the text, measured from the page bottom', () => {
    // The mark's y is measured from the page TOP; pdf-lib draws from the bottom.
    const mark = makeMark({ page: 1, rect: frac(0.25, 0.1, 0.75, 0.2) })
    const line = markToLine(mark, letter)

    const expectedDepth = 0.1 * 792 + (0.1 * 792) * STRIKE_DEPTH
    expect(line.start.y).toBeCloseTo(792 - expectedDepth, 6)
    expect(line.end.y).toBeCloseTo(line.start.y, 6)
    expect(line.start.x).toBeCloseTo(153, 6)
    expect(line.end.x).toBeCloseTo(459, 6)
  })

  it('crosses the body of the text, not the middle of the line box', () => {
    // A selection rectangle includes ascender and descender space, so its exact
    // half sits low. The line has to land where a pen would cross the letters.
    expect(STRIKE_DEPTH).toBeGreaterThan(0.5)
    expect(STRIKE_DEPTH).toBeLessThan(0.7)
  })

  it('weights the line against the text it strikes, within bounds', () => {
    const body = markToLine(makeMark({ page: 1, rect: frac(0.1, 0.5, 0.4, 0.5 + 11 / 792) }), letter)
    expect(body.thickness).toBeCloseTo(11 * 0.09, 5)

    // Nothing hairline on tiny print, nothing heavy on a headline.
    const tiny = markToLine(makeMark({ page: 1, rect: frac(0.1, 0.5, 0.4, 0.5 + 4 / 792) }), letter)
    expect(tiny.thickness).toBe(MIN_THICKNESS)
    const huge = markToLine(makeMark({ page: 1, rect: frac(0.1, 0.2, 0.4, 0.4) }), letter)
    expect(huge.thickness).toBe(MAX_THICKNESS)
  })

  it('reports nothing rather than guessing at a page with no size', () => {
    expect(markToLine(makeMark({ page: 1, rect: frac(0.1, 0.1, 0.2, 0.2) }), null)).toBeNull()
  })
})

describe('validateMarks — refused on the screen, never as a failed download', () => {
  const pages = [{ width: 612, height: 792, rotation: 0 }, { width: 612, height: 792, rotation: 0 }]

  it('passes a mark on a page that exists', () => {
    const marks = [makeMark({ page: 2, rect: frac(0.1, 0.1, 0.2, 0.12) })]
    expect(validateMarks(marks, pages).ok).toBe(true)
  })

  it('says so when nothing has been struck', () => {
    const v = validateMarks([], pages)
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/nothing is marked/i)
  })

  it('refuses a mark past the end of the document, and names the page', () => {
    const v = validateMarks([makeMark({ page: 9, rect: frac(0.1, 0.1, 0.2, 0.12) })], pages)
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/page 9/i)
    expect(v.error).toMatch(/2 pages/)
  })

  it('refuses a rotated page rather than placing a line by guesswork', () => {
    const rotated = [{ width: 612, height: 792, rotation: 90 }]
    const v = validateMarks([makeMark({ page: 1, rect: frac(0.1, 0.1, 0.2, 0.12) })], rotated)
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/rotated/i)
  })

  it('treats a full turn as no turn at all', () => {
    expect(unsupportedPages([makeMark({ page: 1, rect: frac(0, 0, 1, 1) })], [{ rotation: 360 }])).toEqual([])
    expect(unsupportedPages([makeMark({ page: 1, rect: frac(0, 0, 1, 1) })], [{ rotation: 270 }])).toEqual([1])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The pdf-lib half, against real PDFs. The rules above decide WHERE the line
// goes; these confirm that a real file goes in, a real file comes out, and that
// the one that went in is still intact afterwards.
// ─────────────────────────────────────────────────────────────────────────────
async function formPdf({ pages = 1, rotate = 0 } = {}) {
  const { PDFDocument, StandardFonts, degrees } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792])
    if (rotate) page.setRotation(degrees(rotate))
    page.drawText('shall not exceed twelve (12) months unless a pending closing', {
      x: 72, y: 600, size: 11, font,
    })
  }
  return doc.save()
}

describe('drawStrikes — ink in the page, not an annotation on it', () => {
  it('writes a document that still opens, with its pages untouched', async () => {
    const original = await formPdf({ pages: 3 })
    const marks = [makeMark({ page: 2, rect: frac(0.28, 0.235, 0.46, 0.249), text: 'twelve (12)' })]

    const out = await drawStrikes(original, marks)
    const boxes = await pdfPageBoxes(out)

    expect(boxes).toHaveLength(3)
    expect(boxes[0]).toMatchObject({ width: 612, height: 792, rotation: 0 })
    expect(out.length).toBeGreaterThan(0)
  })

  it('leaves the bytes it was handed alone', async () => {
    const original = await formPdf()
    const before = original.slice()
    await drawStrikes(original, [makeMark({ page: 1, rect: frac(0.28, 0.235, 0.46, 0.249) })])
    expect(Array.from(original)).toEqual(Array.from(before))
  })

  it('adds no annotation to the page — the line is content', async () => {
    // An annotation is a separate object a viewer may hide, delete or skip when
    // printing. A struck clause that can come back is the failure this avoids.
    const { PDFDocument } = await import('pdf-lib')
    const out = await drawStrikes(
      await formPdf(),
      [makeMark({ page: 1, rect: frac(0.28, 0.235, 0.46, 0.249) })],
    )
    const doc = await PDFDocument.load(out)
    const annots = doc.getPages()[0].node.Annots()
    expect(annots === undefined || annots.size() === 0).toBe(true)
  })

  it('refuses a rotated page instead of drawing in the wrong place', async () => {
    const rotated = await formPdf({ rotate: 90 })
    await expect(
      drawStrikes(rotated, [makeMark({ page: 1, rect: frac(0.28, 0.235, 0.46, 0.249) })]),
    ).rejects.toThrow(/rotated/i)
  })

  it('refuses an empty set of marks rather than writing a pointless copy', async () => {
    await expect(drawStrikes(await formPdf(), [])).rejects.toThrow(/nothing is marked/i)
  })

  it('carries every stroke of a wrapped selection', async () => {
    const group = 'sel-wrap'
    const marks = [
      makeMark({ page: 1, rect: frac(0.55, 0.235, 0.90, 0.249), group }),
      makeMark({ page: 1, rect: frac(0.10, 0.253, 0.35, 0.267), group }),
    ]
    const out = await drawStrikes(await formPdf(), marks)
    expect((await pdfPageBoxes(out))).toHaveLength(1)
  })
})
