// @vitest-environment jsdom
// The deal's Documents tab: look at a file before acting on it, and go from
// the look straight into the tool — without downloading it twice.
import React from 'react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react'

const fetchDealFileBytes = vi.fn(() => Promise.resolve(new Uint8Array([37, 80, 68, 70])))
vi.mock('../../../lib/services/documents.js', () => ({
  listDealFiles: () => Promise.resolve({
    files: [
      { name: '1700000000-Purchase Agreement.pdf', metadata: { size: 2048 }, created_at: '2026-09-01' },
      { name: '1700000001-Inspection Report.pdf', metadata: { size: 4096 }, created_at: '2026-09-02' },
    ],
    error: '', denied: false,
  }),
  uploadDealFile: vi.fn(), removeDealFile: vi.fn(),
  createDealFileSignedUrl: () => Promise.resolve({ data: { signedUrl: 'https://x' }, error: null }),
  fetchDealFileBytes: (...a) => fetchDealFileBytes(...a),
}))
vi.mock('../../../lib/services/dealRecords.js', () => ({
  fetchDealCompData: () => Promise.resolve({ data: { comp_data: {} } }),
  updateDealCompData: () => Promise.resolve({ error: null }),
}))
vi.mock('../RequiredFormsPanel.jsx', () => ({ RequiredFormsPanel: () => null }))
vi.mock('../../../lib/pdfjs.js', () => ({
  openPdf: () => Promise.resolve({
    numPages: 2, destroy: vi.fn(),
    getPage: () => Promise.resolve({ getViewport: () => ({ width: 612, height: 792 }) }),
  }),
  renderPage: () => Promise.resolve(),
}))

const { DocumentsTab } = await import('../DocumentsTab.jsx')
const { _resetLayers } = await import('../../../components/ui/layers.js')

const settle = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })

beforeEach(() => { _resetLayers(); fetchDealFileBytes.mockClear() })
afterEach(cleanup)

describe('Documents tab — Quick Look', () => {
  it('opens from the file name, steps to the next document, and closes', async () => {
    render(<DocumentsTab deal={{ id: 'd1' }} />)
    await settle()
    const agreement = screen.getByRole('button', { name: 'Purchase Agreement' })
    fireEvent.click(agreement)
    const dialog = screen.getByRole('dialog', { name: 'Purchase Agreement' })
    expect(within(dialog).getByText('Quick look')).toBeTruthy()
    await settle()
    expect(within(dialog).getAllByRole('img', { name: /^Page \d$/ })).toHaveLength(2)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Next document' }))
    expect(screen.getByRole('dialog', { name: 'Inspection Report' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('every row has a labelled Quick Look button', async () => {
    render(<DocumentsTab deal={{ id: 'd1' }} />)
    await settle()
    expect(screen.getByRole('button', { name: 'Quick look at Inspection Report' })).toBeTruthy()
  })

  it('goes from the preview straight into Split, reusing the bytes it already has', async () => {
    render(<DocumentsTab deal={{ id: 'd1' }} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Purchase Agreement' }))
    await settle()
    expect(fetchDealFileBytes).toHaveBeenCalledTimes(1)

    const look = screen.getByRole('dialog', { name: 'Purchase Agreement' })
    await act(async () => { fireEvent.click(within(look).getByRole('button', { name: 'Split' })) })
    await settle()
    expect(screen.queryByText('Quick look')).toBeNull()                                // the preview closed
    expect(screen.getByText('Split document')).toBeTruthy()                            // the tool opened
    expect(fetchDealFileBytes).toHaveBeenCalledTimes(1)                                // no second download
  })
})
