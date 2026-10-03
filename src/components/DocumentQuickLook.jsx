// Quick Look — see a deal document before choosing what to do with it.
//
// Agents were picking documents by filename alone ("scan_0042.pdf") to split,
// merge, mark up or send for signature, and only finding out it was the wrong
// one after the fact. This opens the document right where they are: PDFs are
// drawn page by page with pdf.js (the browser's own PDF viewer doesn't work
// inside a page on most phones), images are shown as they are, and anything
// else offers a download. Optional `actions` let the viewer end in the choice
// it was opened for — "Use this document", "Split", "Merge with…".

import React, { useEffect, useRef, useState } from 'react'
import { Dialog, Button, IconButton, EmptyState, Spinner } from './ui/index.js'
import { openPdf, renderPage } from '../lib/pdfjs.js'
import { IMAGE_MIME, PAGE_BATCH, fileExt, neighbours, previewKind } from '../lib/quickLook.js'

// Pages are drawn to fit the viewer's width, never wider than this, so a
// letter-size page stays readable on a big screen instead of becoming a poster.
const MAX_PAGE_WIDTH = 820

function PdfPage({ pdf, pageNumber, width }) {
  const canvasRef = useRef(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const page = await pdf.getPage(pageNumber)
        if (cancelled || !canvasRef.current) return
        const natural = page.getViewport({ scale: 1 }).width
        await renderPage(pdf, pageNumber, canvasRef.current, Math.min(width, MAX_PAGE_WIDTH) / natural)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => { cancelled = true }
  }, [pdf, pageNumber, width])

  return (
    <figure className="qlook__page">
      {failed
        ? <div className="qlook__page-error">Page {pageNumber} couldn’t be drawn.</div>
        : <canvas ref={canvasRef} aria-label={`Page ${pageNumber}`} role="img" />}
      <figcaption className="qlook__page-no">Page {pageNumber}</figcaption>
    </figure>
  )
}

/**
 * <DocumentQuickLook
 *   doc={{ name, label }}            the file (null = closed)
 *   loadBytes={(name) => Promise<Uint8Array>}
 *   onClose
 *   onDownload={(doc) => …}          optional
 *   actions={[{ label, onClick(doc), variant, icon, show(doc) }]}   optional — the last is primary
 *   list={[docs…]} onNavigate={(doc) => …}   optional — Previous / Next and ← →
 * />
 */
export default function DocumentQuickLook({ doc, loadBytes, onClose, onDownload, actions = [], list = null, onNavigate }) {
  const [state, setState] = useState({ status: 'loading' })   // loading | ready | none | error
  const [shown, setShown] = useState(PAGE_BATCH)
  const [width, setWidth] = useState(MAX_PAGE_WIDTH)
  const [attempt, setAttempt] = useState(0)
  const stageRef = useRef(null)

  const kind = doc ? previewKind(doc.name) : 'none'
  const nav = list && doc ? neighbours(list, doc.name, d => d.name) : null

  // Load whenever the document changes. Everything a previous document opened
  // (pdf.js document, image object URL) is released when it does.
  useEffect(() => {
    if (!doc) return
    if (kind === 'none') { setState({ status: 'none' }); return }
    let cancelled = false
    let release = () => {}
    setState({ status: 'loading' })
    setShown(PAGE_BATCH)
    ;(async () => {
      try {
        const bytes = await loadBytes(doc.name)
        if (cancelled) return
        if (kind === 'image') {
          const url = URL.createObjectURL(new Blob([bytes], { type: IMAGE_MIME[fileExt(doc.name)] || 'image/*' }))
          release = () => URL.revokeObjectURL(url)
          setState({ status: 'ready', imageUrl: url })
        } else {
          const pdf = await openPdf(bytes)
          if (cancelled) { pdf.destroy?.(); return }
          release = () => pdf.destroy?.()
          setState({ status: 'ready', pdf, pageCount: pdf.numPages })
        }
      } catch (err) {
        if (!cancelled) setState({ status: 'error', message: err?.message || 'This document could not be opened.' })
      }
    })()
    return () => { cancelled = true; release() }
  }, [doc?.name, kind, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fit pages to the viewer, and refit when it changes size (rotating a phone).
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => { if (el.clientWidth) setWidth(el.clientWidth - 32) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [state.status])

  // ← / → step through the documents, like flipping through a folder.
  useEffect(() => {
    if (!doc || !nav || !onNavigate) return
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return
      if (e.key === 'ArrowLeft' && nav.prev) { e.preventDefault(); onNavigate(nav.prev) }
      if (e.key === 'ArrowRight' && nav.next) { e.preventDefault(); onNavigate(nav.next) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doc?.name, nav?.prev, nav?.next, onNavigate]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) return null

  const visibleActions = actions.filter(a => !a.show || a.show(doc))
  const pages = state.status === 'ready' && state.pdf ? Math.min(shown, state.pageCount) : 0
  const meta = [
    nav && nav.index >= 0 ? `${nav.index + 1} of ${nav.total}` : null,
    state.status === 'ready' && state.pageCount ? `${state.pageCount} page${state.pageCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      eyebrow="Quick look"
      title={doc.label}
      description={meta || undefined}
      className="qlook"
      bodyClassName="qlook__body"
      footer={(
        <>
          {nav && onNavigate && (
            <div className="qlook__nav">
              <IconButton icon="chevronLeft" label="Previous document" disabled={!nav.prev} onClick={() => onNavigate(nav.prev)} />
              <IconButton icon="chevronRight" label="Next document" disabled={!nav.next} onClick={() => onNavigate(nav.next)} />
            </div>
          )}
          {onDownload && <Button icon="download" onClick={() => onDownload(doc)}>Download</Button>}
          {visibleActions.map((a, i) => (
            <Button
              key={a.label} icon={a.icon}
              variant={a.variant || (i === visibleActions.length - 1 ? 'primary' : 'secondary')}
              onClick={() => a.onClick(doc)}
            >
              {a.label}
            </Button>
          ))}
        </>
      )}
    >
      <div ref={stageRef} className="qlook__stage" aria-busy={state.status === 'loading' || undefined}>
        {state.status === 'loading' && (
          <div className="qlook__loading"><Spinner label={`Opening ${doc.label}…`} /> Opening {doc.label}…</div>
        )}
        {state.status === 'error' && (
          <EmptyState
            variant="error" size="sm" title="Couldn’t open this document"
            description={state.message}
            action={<Button icon="refresh" onClick={() => setAttempt(n => n + 1)}>Try again</Button>}
            secondaryAction={onDownload && <Button onClick={() => onDownload(doc)}>Download instead</Button>}
          />
        )}
        {state.status === 'none' && (
          <EmptyState
            size="sm" icon="document"
            title={`No preview for ${fileExt(doc.name).toUpperCase() || 'this'} files`}
            description="Word, Excel and other files open in their own app. Download it to take a look."
            action={onDownload && <Button icon="download" onClick={() => onDownload(doc)}>Download</Button>}
          />
        )}
        {state.status === 'ready' && state.imageUrl && (
          <img className="qlook__image" src={state.imageUrl} alt={doc.label} />
        )}
        {pages > 0 && Array.from({ length: pages }, (_, i) => (
          <PdfPage key={`${doc.name}:${i + 1}`} pdf={state.pdf} pageNumber={i + 1} width={width} />
        ))}
        {state.status === 'ready' && state.pageCount > pages && (
          <Button className="qlook__more" onClick={() => setShown(n => n + PAGE_BATCH)}>
            Show {Math.min(PAGE_BATCH, state.pageCount - pages)} more page{state.pageCount - pages === 1 ? '' : 's'} ({state.pageCount - pages} left)
          </Button>
        )}
      </div>
    </Dialog>
  )
}
