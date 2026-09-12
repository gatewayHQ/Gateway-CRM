import React from 'react'
import { Icon, Modal, pushToast } from './UI.jsx'
import { openPdf, renderPage } from '../lib/pdfjs.js'
import {
  initialSplitRows, blankSplitRow, validateSplit, unclaimedPages, describePages, baseName,
} from '../lib/services/pdfEdit.js'

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT DOCUMENT — one scan in, the forms it actually contains out.
//
// The shape is deliberate and is the one agents already know from Form
// Simplicity: the document on the left at readable size, and on the right a
// short table of "from page / to page / call it this", one line per piece.
// The document has to be VISIBLE while the ranges are typed — page 7 is only
// "the start of the lead-based paint disclosure" if you can see page 7 — so
// the preview is not a thumbnail strip and not a separate step.
//
// Nothing is destructive. The pieces are written as new documents on the deal
// and the original stays exactly where it was; deleting it is a separate,
// deliberate act on the row it came from.
// ─────────────────────────────────────────────────────────────────────────────
export default function SplitDocumentModal({ fileName, bytes, onClose, onSubmit }) {
  const [pdf,   setPdf]   = React.useState(null)
  const [pages, setPages] = React.useState(0)
  const [page,  setPage]  = React.useState(1)
  const [zoom,  setZoom]  = React.useState(1.25)
  const [fit,   setFit]   = React.useState(true)   // "Automatic Zoom" — track the pane's width
  const [error, setError] = React.useState('')
  const [rows,  setRows]  = React.useState(() => initialSplitRows())
  const [busy,  setBusy]  = React.useState(false)

  const [paneWidth, setPaneWidth] = React.useState(0)
  const canvasRef = React.useRef(null)
  const paneRef   = React.useRef(null)

  // Open the document once. Page count is the authority for every range typed
  // below, so a document that will not open has to say so rather than letting
  // an agent fill in six lines against a number nobody knows.
  React.useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const doc = await openPdf(bytes)
        if (!live) return
        setPdf(doc)
        setPages(doc.numPages)
      } catch (err) {
        if (live) setError(err.message || 'This file could not be opened as a PDF.')
      }
    })()
    return () => { live = false }
  }, [bytes])

  // Draw whenever the page or the zoom changes. Renders are serialised by the
  // guard below: pdf.js will happily start a second render onto a canvas it is
  // still painting, and the result is a half-drawn page.
  React.useEffect(() => {
    if (!pdf || !canvasRef.current) return
    let live = true
    ;(async () => {
      try {
        let scale = zoom
        if (fit && paneRef.current) {
          const first = await pdf.getPage(page)
          const natural = first.getViewport({ scale: 1 }).width
          scale = Math.max(0.25, (paneRef.current.clientWidth - 48) / natural)
        }
        if (!live) return
        await renderPage(pdf, page, canvasRef.current, scale)
      } catch { /* a cancelled render during teardown is not an error */ }
    })()
    return () => { live = false }
  }, [pdf, page, zoom, fit, paneWidth])

  // Automatic Zoom means automatic: a window resize (or the modal reflowing to
  // one column on a narrow screen) re-fits the page instead of leaving it at
  // the width the pane happened to have when it opened.
  React.useEffect(() => {
    if (!fit) return
    const onResize = () => setPaneWidth(paneRef.current?.clientWidth || 0)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [fit])

  const setRow = (id, key, value) => setRows(prev => prev.map(r => (r.id === id ? { ...r, [key]: value } : r)))
  const addLine = () => setRows(prev => [...prev, blankSplitRow()])
  const dropLine = (id) => setRows(prev => (prev.length > 1 ? prev.filter(r => r.id !== id) : prev))

  const verdict   = validateSplit({ rows, pageCount: pages, sourceName: fileName })
  const leftovers = verdict.ok ? unclaimedPages(verdict.pieces, pages) : []

  // The page showing is the page an agent means, so the buttons on each row
  // fill it in — typing "14" while looking at page 14 is the one step this
  // screen can take off their hands.
  const useCurrent = (id, key) => setRow(id, key, String(page))

  const submit = async () => {
    if (!verdict.ok) { pushToast(verdict.error, 'error'); return }
    setBusy(true)
    try {
      await onSubmit(verdict.pieces)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={true} onClose={busy ? () => {} : onClose} width={1180}>
      <div className="modal__head">
        <div style={{ minWidth: 0 }}>
          <div className="eyebrow-label">Split document</div>
          <h3 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--font-display)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {baseName(fileName)}
          </h3>
        </div>
        <button className="drawer__close" onClick={onClose} disabled={busy}><Icon name="x" size={18} /></button>
      </div>

      <div className="modal__body" style={{ padding: 0 }}>
        <div style={{ display: 'flex', alignItems: 'stretch', minHeight: 460, flexWrap: 'wrap' }}>

          {/* ── The document ──────────────────────────────────────────── */}
          <div style={{ flex: '1 1 520px', minWidth: 300, borderRight: '1px solid var(--gw-border)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--gw-border)', background: 'var(--gw-bone)', flexWrap: 'wrap' }}>
              <button className="btn btn--ghost btn--icon btn--sm" title="Previous page" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
                <Icon name="chevronLeft" size={13} />
              </button>
              <input
                className="form-control"
                style={{ width: 54, fontSize: 12, textAlign: 'center', padding: '3px 4px' }}
                value={page}
                onChange={e => {
                  const n = Number(String(e.target.value).replace(/\D/g, ''))
                  if (n >= 1 && n <= pages) setPage(n)
                }}
                aria-label="Page number"
              />
              <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>of {pages || '—'}</span>
              <button className="btn btn--ghost btn--icon btn--sm" title="Next page" disabled={page >= pages} onClick={() => setPage(p => Math.min(pages, p + 1))}>
                <Icon name="chevronRight" size={13} />
              </button>
              <span style={{ flex: 1 }} />
              <button className="btn btn--ghost btn--icon btn--sm" title="Zoom out" onClick={() => { setFit(false); setZoom(z => Math.max(0.25, z - 0.25)) }}>−</button>
              <select
                className="form-control"
                style={{ fontSize: 12, padding: '3px 6px', width: 130 }}
                value={fit ? 'auto' : String(zoom)}
                onChange={e => {
                  if (e.target.value === 'auto') { setFit(true); return }
                  setFit(false); setZoom(Number(e.target.value))
                }}
                aria-label="Zoom"
              >
                <option value="auto">Automatic Zoom</option>
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map(z => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
              </select>
              <button className="btn btn--ghost btn--icon btn--sm" title="Zoom in" onClick={() => { setFit(false); setZoom(z => Math.min(3, z + 0.25)) }}>+</button>
            </div>

            <div ref={paneRef} style={{ flex: 1, overflow: 'auto', background: 'var(--gw-bone)', padding: 16, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', maxHeight: '62vh' }}>
              {error
                ? <div style={{ fontSize: 13, color: 'var(--gw-red)', lineHeight: 1.7, padding: 20 }}>{error}</div>
                : <canvas ref={canvasRef} style={{ boxShadow: '0 1px 6px rgba(0,0,0,0.18)', background: '#fff', maxWidth: '100%' }} />}
              {!pdf && !error && <div style={{ fontSize: 13, color: 'var(--gw-mist)', padding: 20 }}>Opening the document…</div>}
            </div>
          </div>

          {/* ── The ranges ────────────────────────────────────────────── */}
          <div style={{ flex: '1 1 380px', minWidth: 300, padding: 16, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '70vh', overflowY: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '68px 68px 1fr 28px', gap: 8, alignItems: 'center' }}>
              <div style={{ fontSize: 11, color: 'var(--gw-mist)', fontWeight: 600 }}>From</div>
              <div style={{ fontSize: 11, color: 'var(--gw-mist)', fontWeight: 600 }}>To</div>
              <div style={{ fontSize: 11, color: 'var(--gw-mist)', fontWeight: 600 }}>Document name</div>
              <div />

              {rows.map((row, i) => {
                const bad = verdict.rowErrors[row.id]
                const edge = bad ? 'var(--gw-red)' : 'var(--gw-border)'
                return (
                  <React.Fragment key={row.id}>
                    <input
                      className="form-control" style={{ fontSize: 13, padding: '6px 8px', borderColor: edge }}
                      inputMode="numeric" value={row.from}
                      onChange={e => setRow(row.id, 'from', e.target.value.replace(/\D/g, ''))}
                      onDoubleClick={() => useCurrent(row.id, 'from')}
                      title="First page of this piece — double-click to use the page showing"
                      aria-label={`Line ${i + 1} first page`}
                    />
                    <input
                      className="form-control" style={{ fontSize: 13, padding: '6px 8px', borderColor: edge }}
                      inputMode="numeric" value={row.to}
                      onChange={e => setRow(row.id, 'to', e.target.value.replace(/\D/g, ''))}
                      onDoubleClick={() => useCurrent(row.id, 'to')}
                      title="Last page of this piece — double-click to use the page showing"
                      aria-label={`Line ${i + 1} last page`}
                    />
                    <input
                      className="form-control" style={{ fontSize: 13, padding: '6px 8px', borderColor: edge }}
                      value={row.name}
                      placeholder={row.from && row.to ? 'Optional — named by page range' : ''}
                      onChange={e => setRow(row.id, 'name', e.target.value)}
                      aria-label={`Line ${i + 1} document name`}
                    />
                    <button
                      className="btn btn--ghost btn--icon btn--sm" title="Clear this line"
                      disabled={rows.length === 1} onClick={() => dropLine(row.id)}
                      aria-label={`Remove line ${i + 1}`}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  </React.Fragment>
                )
              })}
            </div>

            <div style={{ textAlign: 'right' }}>
              <button className="btn btn--ghost btn--sm" style={{ fontSize: 12, color: 'var(--gw-azure)' }} onClick={addLine}>add line</button>
            </div>

            {verdict.error && (
              <div style={{ fontSize: 12, color: 'var(--gw-red)', lineHeight: 1.6 }}>{verdict.error}</div>
            )}

            {verdict.ok && (
              <div style={{ background: 'var(--gw-bone)', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', padding: '10px 12px', fontSize: 12, lineHeight: 1.7 }}>
                <strong>{verdict.pieces.length} document{verdict.pieces.length === 1 ? '' : 's'}</strong> will be added to this deal:
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {verdict.pieces.map(p => (
                    <li key={p.id}>
                      {p.filename.replace(/\.pdf$/i, '')} — page{p.pages === 1 ? '' : 's'} {p.from === p.to ? p.from : `${p.from}–${p.to}`}
                    </li>
                  ))}
                </ul>
                {leftovers.length > 0 && (
                  <div style={{ marginTop: 8, color: 'var(--gw-mist)' }}>
                    Page{leftovers.length === 1 ? '' : 's'} {describePages(leftovers)} {leftovers.length === 1 ? 'is' : 'are'} not in any piece.
                    They stay in the original, which is not changed.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn--primary" onClick={submit} disabled={!verdict.ok || busy}>
          {busy ? 'Splitting…' : 'Split'}
        </button>
      </div>
    </Modal>
  )
}
