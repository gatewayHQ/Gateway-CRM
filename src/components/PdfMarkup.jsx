import React from 'react'
import { Icon } from './UI.jsx'
import { loadPdfJs, renderPage } from '../lib/pdfjs.js'
import { rectToFraction, rectBelongsTo, joinRuns, makeMark, STRIKE_DEPTH } from '../lib/services/pdfStrike.js'

// ─────────────────────────────────────────────────────────────────────────────
// PDF MARKUP — striking text out of a form by selecting it.
//
// THE GESTURE IS THE BROWSER'S. An agent selects the words they are removing the
// same way they select words anywhere else, and lets go. There is no bar to drag
// into place and no handles to nudge, because pdf.js can lay a transparent text
// layer over the rendered page — the same thing that makes a PDF selectable in
// any browser viewer — and the browser will then report exactly where the
// selected glyphs are. A line drawn to those rectangles is on the text by
// construction, not by aim.
//
// That is the whole reason this does not look like the field placer next door.
// Placing a signature box is putting something in blank space, where a click is
// the right gesture. Striking a clause is about text that is already there, and
// the gesture for text is selection.
//
// WHAT COMES BACK FROM A SELECTION. One rectangle per text RUN, not per line:
// pdf.js lays out "twelve (12)" as separate runs and the space between them
// belongs to neither, so a naive drawing is a dashed line with holes in it.
// joinRuns() in pdfStrike.js unions the pieces that share a printed line, which
// turns a selection into one stroke per line — which is what a pen does.
//
// MARKS DO NOT INTERCEPT CLICKS. The strokes drawn over the page are
// pointer-events:none. A mark sits exactly on top of the words it struck, so
// anything clickable there would make that text impossible to select again, and
// "I can't re-select the line I just struck" is a worse problem than "I remove
// it from the list on the right".
//
// A SCAN HAS NO TEXT LAYER. A page that came from a fax or a flatbed carries an
// image and nothing else — there is no text to select and this screen says so
// rather than letting an agent drag across a picture and wonder why nothing
// happened.
// ─────────────────────────────────────────────────────────────────────────────

const MIN_SCALE = 0.4
const PANE_PADDING = 48

export default function PdfMarkup({ bytes, marks = [], onAddMarks, highlightGroup = null }) {
  const [pdf, setPdf] = React.useState(null)
  const [pageCount, setPageCount] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [zoom, setZoom] = React.useState(1.3)
  const [fit, setFit] = React.useState(true)
  const [natural, setNatural] = React.useState(0)
  const [paneWidth, setPaneWidth] = React.useState(0)
  const [hasText, setHasText] = React.useState(true)
  const [error, setError] = React.useState('')

  const paneRef = React.useRef(null)
  const pageRef = React.useRef(null)
  const canvasRef = React.useRef(null)
  const textRef = React.useRef(null)

  // Open once. Everything below is measured against this document, so a file
  // that will not open has to say so rather than rendering an empty frame.
  React.useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const pdfjsLib = await loadPdfJs()
        const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise
        if (!live) return
        setPdf(doc)
        setPageCount(doc.numPages)
        setPage(1)
      } catch (err) {
        if (live) setError(err.message || 'This file could not be opened as a PDF.')
      }
    })()
    return () => { live = false }
  }, [bytes])

  // The page's own width at 1×, which is what "fit to pane" is a fraction of.
  React.useEffect(() => {
    if (!pdf) return
    let live = true
    pdf.getPage(page)
      .then(p => { if (live) setNatural(p.getViewport({ scale: 1 }).width) })
      .catch(() => {})
    return () => { live = false }
  }, [pdf, page])

  React.useEffect(() => {
    const measure = () => setPaneWidth(paneRef.current?.clientWidth || 0)
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // ONE scale for both layers. The canvas and the text layer have to agree to
  // the pixel — they are the picture and the thing that says where the words in
  // it are — so the number is computed here and handed to both.
  const scale = fit && natural && paneWidth
    ? Math.max(MIN_SCALE, (paneWidth - PANE_PADDING) / natural)
    : zoom

  // Draw the page. Serialised by the `live` guard: pdf.js will start a second
  // render onto a canvas it is still painting, and that leaves half a page.
  React.useEffect(() => {
    if (!pdf || !canvasRef.current || !scale) return
    let live = true
    ;(async () => {
      try {
        await renderPage(pdf, page, canvasRef.current, scale)
      } catch { /* a cancelled render during teardown is not an error */ }
    })()
    return () => { live = false }
  }, [pdf, page, scale])

  // Lay the selectable text over it. Rebuilt on every page and zoom change,
  // because each span carries its own position and font size in CSS pixels.
  React.useEffect(() => {
    if (!pdf || !textRef.current || !scale) return
    let live = true
    let task = null
    ;(async () => {
      try {
        const pdfjsLib = await loadPdfJs()
        const p = await pdf.getPage(page)
        const viewport = p.getViewport({ scale })
        const content = await p.getTextContent()
        if (!live || !textRef.current) return

        setHasText((content?.items || []).some(i => String(i?.str || '').trim()))

        const container = textRef.current
        container.replaceChildren()
        container.style.width = `${viewport.width}px`
        container.style.height = `${viewport.height}px`

        // pdf.js 3.x lays its spans out as PERCENTAGES of this container and
        // sizes their type with calc(var(--scale-factor) * Npx). Without the
        // variable the font-size declaration is invalid and every span falls
        // back to the inherited size, so the transparent text stops lining up
        // with the glyphs on the canvas — which means selecting a word selects
        // the wrong one, or nothing. It has to be set on the container itself.
        container.style.setProperty('--scale-factor', String(scale))

        // pdf.js 3.8 renamed `textContent` to `textContentSource`; the version
        // pinned in lib/pdfjs.js takes the new name without a deprecation warning.
        task = pdfjsLib.renderTextLayer({ textContentSource: content, container, viewport, textDivs: [] })
        await task.promise
      } catch { /* a cancelled text layer during teardown is not an error */ }
    })()
    return () => { live = false; try { task?.cancel?.() } catch { /* already done */ } }
  }, [pdf, page, scale])

  // ── Turning a selection into marks ─────────────────────────────────────────
  const captureSelection = React.useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return

    const host = pageRef.current?.getBoundingClientRect()
    const layer = textRef.current
    if (!host || !layer) return

    // Only selections made in this page's text layer. A selection that started
    // in the panel beside the document is not a mark.
    const range = sel.getRangeAt(0)
    if (!layer.contains(range.startContainer) && !layer.contains(range.commonAncestorContainer)) return

    const text = sel.toString()
    const pieces = Array.from(range.getClientRects())
      .filter(r => rectBelongsTo(r, host))
      .map(r => rectToFraction(r, host))
      .filter(Boolean)

    const strokes = joinRuns(pieces)
    if (!strokes.length) return

    const group = `sel-${Date.now()}-${Math.round(Math.random() * 1e6)}`
    onAddMarks?.(strokes.map(rect => makeMark({ page, rect, text, group })))
    sel.removeAllRanges()
  }, [page, onAddMarks])

  // mouseup fires once the selection has settled; the timeout covers the
  // double-click-to-select-a-word case, where the selection lands fractionally
  // after the event on some browsers.
  const onPointerFinish = React.useCallback(() => {
    window.setTimeout(captureSelection, 0)
  }, [captureSelection])

  if (error) {
    return (
      <div style={{ padding: 32, textAlign: 'center', color: 'var(--gw-red)', fontSize: 13 }}>
        <Icon name="alert" size={18} /> <div style={{ marginTop: 8 }}>{error}</div>
      </div>
    )
  }

  const pageMarks = marks.filter(m => m.page === page)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>

      {/* ── Page and zoom controls ──────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px',
        borderBottom: '1px solid var(--gw-border)', background: 'var(--gw-bone)', flexWrap: 'wrap',
      }}>
        <button className="btn btn--ghost btn--icon btn--sm" title="Previous page"
          disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
          <Icon name="chevronLeft" size={13} />
        </button>
        <span style={{ fontSize: 12, color: 'var(--gw-mist)', fontVariantNumeric: 'tabular-nums' }}>
          Page {page} of {pageCount || '—'}
        </span>
        <button className="btn btn--ghost btn--icon btn--sm" title="Next page"
          disabled={!pageCount || page >= pageCount} onClick={() => setPage(p => Math.min(pageCount, p + 1))}>
          <Icon name="chevronRight" size={13} />
        </button>

        <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--gw-border)', margin: '0 4px' }} />

        <button className={`btn btn--sm ${fit ? 'btn--primary' : 'btn--secondary'}`} onClick={() => setFit(true)}>
          Fit width
        </button>
        <button className="btn btn--secondary btn--sm" title="Zoom out"
          onClick={() => { setFit(false); setZoom(z => Math.max(MIN_SCALE, z - 0.2)) }}>−</button>
        <button className="btn btn--secondary btn--sm" title="Zoom in"
          onClick={() => { setFit(false); setZoom(z => Math.min(4, z + 0.2)) }}>+</button>

        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--gw-mist)' }}>
          {hasText
            ? 'Select the text you’re striking out'
            : 'This page is a scan — no text to select'}
        </span>
      </div>

      {/* ── The document ────────────────────────────────────────────────── */}
      {/* The scroll container. Its height comes from .markup-workspace, which is
          what makes `overflow: auto` mean anything here. Centred with text-align
          rather than flex: a flex-centred item wider than its container is
          clipped on the left and cannot be scrolled back to. */}
      <div
        ref={paneRef}
        style={{
          flex: 1, minHeight: 0, overflow: 'auto',
          background: '#e5e7eb', padding: 24, textAlign: 'center',
        }}
      >
        {!hasText && (
          <div style={{
            maxWidth: 520, margin: '0 auto 16px', padding: '10px 14px', fontSize: 12, lineHeight: 1.5,
            background: 'var(--gw-amber-light)', color: '#8a5406', borderRadius: 'var(--radius)',
          }}>
            <strong>No text layer on this page.</strong> It was scanned rather than generated, so there is
            nothing to select. Striking it would mean drawing a line by hand at a guessed position, which
            this screen deliberately does not do.
          </div>
        )}

        <div
          ref={pageRef}
          className="pdf-markup__page"
          onMouseUp={onPointerFinish}
          onTouchEnd={onPointerFinish}
        >
          <canvas ref={canvasRef} style={{ display: 'block' }} />
          <div ref={textRef} className="pdf-textlayer" />

          {/* The strokes. Drawn exactly where drawStrikes() will put them, in the
              same ink, so what the agent approves is what the client receives. */}
          {pageMarks.map(m => {
            const lit = highlightGroup && m.group === highlightGroup
            return (
              <div
                key={m.id}
                className={`pdf-markup__strike${lit ? ' is-lit' : ''}`}
                style={{
                  left: `${m.x0 * 100}%`,
                  width: `${(m.x1 - m.x0) * 100}%`,
                  // STRIKE_DEPTH, not a number of its own: the screen has to
                  // put the line where drawStrikes() will, or the agent approves
                  // one document and the client receives another.
                  top: `${(m.y0 + (m.y1 - m.y0) * STRIKE_DEPTH) * 100}%`,
                }}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
