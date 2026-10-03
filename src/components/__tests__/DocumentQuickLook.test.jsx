// @vitest-environment jsdom
import React, { useState } from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'

// jsdom can't draw a PDF; stand in for pdf.js with a document of N pages.
const destroy = vi.fn()
const renderPage = vi.fn(() => Promise.resolve())
let numPages = 3
vi.mock('../../lib/pdfjs.js', () => ({
  openPdf: () => Promise.resolve({
    numPages, destroy,
    getPage: () => Promise.resolve({ getViewport: () => ({ width: 612, height: 792 }) }),
  }),
  renderPage: (...a) => renderPage(...a),
}))

const { default: DocumentQuickLook } = await import('../DocumentQuickLook.jsx')
const { _resetLayers } = await import('../ui/layers.js')

const DOCS = [
  { name: '1-Purchase Agreement.pdf', label: 'Purchase Agreement.pdf' },
  { name: '2-Site photo.png', label: 'Site photo.png' },
  { name: '3-Lease.docx', label: 'Lease.docx' },
]

function Harness({ start = DOCS[0].name, loadBytes, actions = [], onDownload }) {
  const [name, setName] = useState(start)
  const doc = DOCS.find(d => d.name === name) || null
  return (
    <DocumentQuickLook
      doc={doc} list={DOCS} onNavigate={d => setName(d.name)}
      loadBytes={loadBytes} onClose={() => setName(null)} onDownload={onDownload} actions={actions}
    />
  )
}

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

beforeEach(() => {
  _resetLayers(); destroy.mockReset(); renderPage.mockClear(); numPages = 3
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview')
  globalThis.URL.revokeObjectURL = vi.fn()
})
afterEach(cleanup)

describe('DocumentQuickLook', () => {
  it('draws every page of a PDF, with its place in the list and page count', async () => {
    const loadBytes = vi.fn(() => Promise.resolve(new Uint8Array([1])))
    render(<Harness loadBytes={loadBytes} />)
    expect(screen.getByRole('dialog', { name: 'Purchase Agreement.pdf' })).toBeTruthy()
    await flush(); await flush()
    expect(screen.getByText('1 of 3 · 3 pages')).toBeTruthy()
    expect(screen.getAllByRole('img', { name: /^Page \d$/ })).toHaveLength(3)
    expect(loadBytes).toHaveBeenCalledWith('1-Purchase Agreement.pdf')
  })

  it('draws long documents in batches', async () => {
    numPages = 30
    render(<Harness loadBytes={() => Promise.resolve(new Uint8Array([1]))} />)
    await flush(); await flush()
    expect(screen.getAllByRole('img', { name: /^Page \d+$/ })).toHaveLength(12)
    fireEvent.click(screen.getByRole('button', { name: /Show 12 more pages \(18 left\)/ }))
    expect(screen.getAllByRole('img', { name: /^Page \d+$/ })).toHaveLength(24)
  })

  it('steps through documents with Next/Previous and the arrow keys, releasing the last one', async () => {
    render(<Harness loadBytes={() => Promise.resolve(new Uint8Array([1]))} />)
    await flush(); await flush()
    expect(screen.getByRole('button', { name: 'Previous document' }).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Next document' }))
    expect(screen.getByRole('dialog', { name: 'Site photo.png' })).toBeTruthy()
    expect(destroy).toHaveBeenCalled()           // the PDF was let go
    await flush()
    expect(screen.getByRole('img', { name: 'Site photo.png' }).getAttribute('src')).toBe('blob:preview')

    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByRole('dialog', { name: 'Lease.docx' })).toBeTruthy()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
    expect(screen.getByRole('button', { name: 'Next document' }).disabled).toBe(true)

    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByRole('dialog', { name: 'Site photo.png' })).toBeTruthy()
  })

  it('offers a download for files it can’t preview, without fetching them', async () => {
    const loadBytes = vi.fn()
    const onDownload = vi.fn()
    render(<Harness start={DOCS[2].name} loadBytes={loadBytes} onDownload={onDownload} />)
    expect(screen.getByText('No preview for DOCX files')).toBeTruthy()
    expect(loadBytes).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Download' })[0])
    expect(onDownload).toHaveBeenCalledWith(DOCS[2])
  })

  it('shows a failure with Try again, which loads it again', async () => {
    const loadBytes = vi.fn()
      .mockRejectedValueOnce(new Error('Could not read Purchase Agreement.pdf (HTTP 403).'))
      .mockResolvedValue(new Uint8Array([1]))
    render(<Harness loadBytes={loadBytes} />)
    await flush()
    expect(screen.getByRole('alert').textContent).toMatch(/HTTP 403/)
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
    await flush(); await flush()
    expect(loadBytes).toHaveBeenCalledTimes(2)
    expect(screen.getAllByRole('img', { name: /^Page \d$/ })).toHaveLength(3)
  })

  it('ends in the action it was opened for; the last action is the primary one', async () => {
    const use = vi.fn()
    const split = vi.fn()
    render(<Harness loadBytes={() => Promise.resolve(new Uint8Array([1]))} actions={[
      { label: 'Split', onClick: split, show: d => d.name.endsWith('.pdf') },
      { label: 'Use this document', onClick: use },
    ]} />)
    const primary = screen.getByRole('button', { name: 'Use this document' })
    expect(primary.className).toContain('btn--primary')
    fireEvent.click(primary)
    expect(use).toHaveBeenCalledWith(DOCS[0])
    fireEvent.click(screen.getByRole('button', { name: 'Next document' }))
    expect(screen.queryByRole('button', { name: 'Split' })).toBeNull()   // not a PDF
  })
})
