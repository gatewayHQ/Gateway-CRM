import React from 'react'
import { Icon, pushToast } from '../components/UI.jsx'
import PdfMarkup, { MarksList } from '../components/PdfMarkup.jsx'
import { drawStrikes, groupMarks, validateMarks, pdfPageBoxes } from '../lib/services/pdfStrike.js'
import { baseName } from '../lib/services/pdfEdit.js'

// ─────────────────────────────────────────────────────────────────────────────
// MARKUP PREVIEW — a bench for the strike-through tool, wired to nothing.
//
// WHY THIS EXISTS SEPARATELY. The question the tool has to answer is not "does
// the UI feel right" — that was a mockup — but "does the line land on the words,
// in the real file, at every zoom, and does it survive being downloaded and
// opened somewhere else". None of that can be judged from a screen. It needs a
// real form, a real selection and a real PDF at the end of it that opens in
// Acrobat with the line still in it.
//
// So: open any PDF from disk, strike it, download the result. No deal, no
// packet, no BoldSign, no upload. The send path at api/boldsign.js is untouched,
// which means this can be shipped, poked at and thrown away without any risk to
// documents that are actually out for signature.
//
// WHAT TO CHECK WHILE TESTING, in rough order of what would sink the feature:
//   1. The line sits ON the words, not above or below them, at Fit width AND
//      after zooming in and out. (Marks are stored as fractions of the page for
//      exactly this reason — see pdfStrike.js.)
//   2. A strike across a line break becomes two strokes, one per line.
//   3. The downloaded PDF still shows the line in Acrobat, Preview and Chrome —
//      and that no viewer offers to hide it, because it is page content rather
//      than an annotation.
//   4. A scanned page says so instead of accepting a mark it cannot place.
//
// WHEN IT GRADUATES. The markup step slots in front of the existing upload:
// PdfMarkup on the bytes, drawStrikes() on the way out, and the result goes to
// the `Files` blob at api/boldsign.js:3152 exactly as the clean file does today.
// ─────────────────────────────────────────────────────────────────────────────
export default function MarkupPreview() {
  const [file, setFile] = React.useState(null)       // { name, bytes }
  const [marks, setMarks] = React.useState([])
  const [pages, setPages] = React.useState([])
  const [lit, setLit] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)

  const inputRef = React.useRef(null)

  const take = React.useCallback(async (picked) => {
    if (!picked) return
    if (!/\.pdf$/i.test(picked.name)) { pushToast('That is not a PDF.', 'error'); return }
    try {
      const bytes = new Uint8Array(await picked.arrayBuffer())
      setFile({ name: picked.name, bytes })
      setMarks([])
      setLit(null)
      setPages(await pdfPageBoxes(bytes))
    } catch (err) {
      pushToast(err.message || 'That PDF could not be opened.', 'error')
    }
  }, [])

  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    take(e.dataTransfer?.files?.[0])
  }

  const addMarks = React.useCallback((added) => {
    setMarks(prev => [...prev, ...added])
  }, [])

  const removeGroup = (group) => {
    setMarks(prev => prev.filter(m => m.group !== group))
    setLit(l => (l === group ? null : l))
  }

  // The download. drawStrikes() re-validates before it touches a byte, so a
  // rotated page or a mark off the end of the document is refused here with the
  // reason, rather than producing a file with a line in the wrong place.
  const save = async () => {
    if (!file) return
    const verdict = validateMarks(marks, pages)
    if (!verdict.ok) { pushToast(verdict.error, 'error'); return }

    setBusy(true)
    try {
      const out = await drawStrikes(file.bytes, marks)
      const blob = new Blob([out], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${baseName(file.name)} (marked).pdf`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoking immediately cancels the download in Safari — see savePdf.js.
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
      pushToast(`${marks.length} mark${marks.length === 1 ? '' : 's'} written into the PDF`)
    } catch (err) {
      pushToast(err.message || 'The marked-up PDF could not be written.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const groups = groupMarks(marks)

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="eyebrow-label">Preview · not wired to any deal</div>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 600 }}>
            Document markup
          </h2>
        </div>
        {file && (
          <button className="btn btn--secondary btn--sm" onClick={() => { setFile(null); setMarks([]); setPages([]) }}>
            <Icon name="x" size={13} /> Close document
          </button>
        )}
      </div>

      {!file ? (
        <div
          className="card"
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          style={{
            borderStyle: 'dashed', borderWidth: 2,
            borderColor: dragging ? 'var(--gw-azure)' : 'var(--gw-border)',
            background: dragging ? 'var(--gw-sky)' : 'var(--gw-chalk)',
          }}
        >
          <div className="empty-state" style={{ padding: '48px 20px' }}>
            <div className="empty-state__icon"><Icon name="document" size={24} /></div>
            <div className="empty-state__title">Open a form to mark up</div>
            <p className="empty-state__msg">
              Any PDF with real text in it — a buyer agency agreement, a purchase agreement, an addendum.
              Drop it here or pick one below.
            </p>
            <button className="btn btn--primary" onClick={() => inputRef.current?.click()}>
              <Icon name="upload" size={14} /> Choose a PDF
            </button>
            <input
              ref={inputRef}
              id="markup-preview-file"
              type="file"
              accept="application/pdf,.pdf"
              style={{ display: 'none' }}
              onChange={e => take(e.target.files?.[0])}
            />
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
            borderBottom: '1px solid var(--gw-border)', background: 'var(--gw-bone)',
          }}>
            <Icon name="document" size={15} style={{ color: 'var(--gw-mist)' }} />
            <strong style={{ fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {baseName(file.name)}
            </strong>
            <span style={{ fontSize: 11, color: 'var(--gw-mist)' }}>
              {pages.length} page{pages.length === 1 ? '' : 's'}
            </span>
          </div>

          {/* The height of this row is what makes the document scrollable —
              see .markup-workspace in app.css. */}
          <div className="markup-workspace">

            {/* ── The form ───────────────────────────────────────────────── */}
            <div className="markup-workspace__doc">
              <PdfMarkup bytes={file.bytes} marks={marks} onAddMarks={addMarks} highlightGroup={lit} />
            </div>

            {/* ── What has been struck ───────────────────────────────────── */}
            <aside className="markup-workspace__rail">
              <div>
                <div className="eyebrow-label">Struck passages ({groups.length})</div>
                <MarksList groups={groups} onRemove={removeGroup} onHover={setLit} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <button className="btn btn--primary" disabled={!marks.length || busy} onClick={save}>
                  <Icon name="download" size={14} /> {busy ? 'Writing…' : 'Download marked-up PDF'}
                </button>
                <button className="btn btn--secondary" disabled={!marks.length || busy} onClick={() => { setMarks([]); setLit(null) }}>
                  Clear all
                </button>
              </div>

              <div style={{
                marginTop: 'auto', fontSize: 11, lineHeight: 1.55, color: 'var(--gw-mist)',
                borderTop: '1px solid var(--gw-border)', paddingTop: 12,
              }}>
                <strong style={{ display: 'block', color: 'var(--gw-slate)', marginBottom: 3 }}>
                  Drafts only
                </strong>
                A packet already out for signature keeps the acknowledgement-plus-initials path.
                A line over text somebody has signed says nothing about who agreed to it, or when.
              </div>
            </aside>
          </div>
        </div>
      )}
    </div>
  )
}
