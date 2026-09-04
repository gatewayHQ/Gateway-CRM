import { describe, it, expect, vi } from 'vitest'
import { savePdfFromUrl, safePdfFilename, openPrintTab, showPdfInPrintTab, closePrintTab } from '../savePdf.js'

// Hand-rolled DOM stand-in rather than jsdom because this repo's suite runs in
// plain Node — and because what matters here is the ORDER of operations
// (fetch → objectURL → click → remove) plus the filename that reaches the disk.
function fakeDom() {
  const events = []
  const anchor = {
    style: {},
    remove() { events.push('remove') },
    click() { events.push(`click:${this.download}`) },
  }
  return {
    events,
    anchor,
    doc: {
      createElement: () => anchor,
      body: { appendChild: () => events.push('append') },
    },
    win: {
      URL: {
        createObjectURL: () => { events.push('objectUrl'); return 'blob:abc' },
        revokeObjectURL: () => events.push('revoke'),
      },
    },
  }
}

const pdfFetch = (size = 4321) => () => Promise.resolve({ ok: true, blob: () => Promise.resolve({ size, type: 'application/pdf' }) })
const badFetch = (status) => () => Promise.resolve({ ok: false, status })

describe('safePdfFilename', () => {
  it('keeps a readable name and adds the extension', () => {
    expect(safePdfFilename('Iowa Listing — 123 Main (review)')).toBe('Iowa Listing — 123 Main (review).pdf')
    expect(safePdfFilename('already.pdf')).toBe('already.pdf')
  })
  it('never lets a document name become a path', () => {
    expect(safePdfFilename('a/b:c*d')).toBe('a-b-c-d.pdf')
  })
  it('falls back when there is no usable name', () => {
    expect(safePdfFilename('')).toBe('document.pdf')
    expect(safePdfFilename(null)).toBe('document.pdf')
  })
})

describe('savePdfFromUrl', () => {
  it('downloads the bytes under our filename', async () => {
    const { doc, win, events, anchor } = fakeDom()
    const res = await savePdfFromUrl('https://storage/x.pdf?token=1', 'Listing (filled)', { fetchImpl: pdfFetch(), doc, win })

    expect(res).toEqual({ saved: true, bytes: 4321, filename: 'Listing (filled).pdf' })
    expect(anchor.href).toBe('blob:abc')
    expect(events).toEqual(['objectUrl', 'append', 'click:Listing (filled).pdf', 'remove'])
  })

  it('reports a refused download instead of saving nothing quietly', async () => {
    const { doc, win } = fakeDom()
    await expect(savePdfFromUrl('https://storage/x.pdf', 'x', { fetchImpl: badFetch(403), doc, win }))
      .rejects.toThrow(/HTTP 403/)
  })

  it('refuses an empty PDF — a zero-byte file is the blank page this replaced', async () => {
    const { doc, win } = fakeDom()
    await expect(savePdfFromUrl('https://storage/x.pdf', 'x', { fetchImpl: pdfFetch(0), doc, win }))
      .rejects.toThrow(/empty/)
  })

  it('surfaces a network failure with its message', async () => {
    const { doc, win } = fakeDom()
    const boom = () => Promise.reject(new Error('offline'))
    await expect(savePdfFromUrl('https://storage/x.pdf', 'x', { fetchImpl: boom, doc, win }))
      .rejects.toThrow(/offline/)
  })

  it('rejects a missing url rather than clicking an empty anchor', async () => {
    const { doc, win } = fakeDom()
    await expect(savePdfFromUrl('', 'x', { fetchImpl: pdfFetch(), doc, win })).rejects.toThrow(/No document/)
  })

  it('revokes the blob url on a timer, not before the browser has read it', async () => {
    vi.useFakeTimers()
    try {
      const { doc, win, events } = fakeDom()
      await savePdfFromUrl('https://storage/x.pdf', 'x', { fetchImpl: pdfFetch(), doc, win })
      expect(events).not.toContain('revoke')
      vi.advanceTimersByTime(60_000)
      expect(events).toContain('revoke')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── Printing ────────────────────────────────────────────────────────────────
// The rule these hold to: the tab is opened on the click and navigated later, and
// a blocked tab produces a MESSAGE rather than a button that silently does nothing.

function fakeTab() {
  const calls = []
  return {
    calls,
    opener: {},
    location: { replace: (u) => calls.push(`replace:${u}`) },
    document: { write: () => calls.push('write'), close: () => calls.push('close') },
    close: () => calls.push('close-tab'),
  }
}

describe('openPrintTab', () => {
  it('opens a blank tab, not a URL — the document is not composed yet', () => {
    const tab = fakeTab()
    const opened = []
    openPrintTab({ open: (url, target) => { opened.push([url, target]); return tab } })
    expect(opened).toEqual([['', '_blank']])
  })

  it('detaches the opener and shows a placeholder rather than a blank white tab', () => {
    const tab = fakeTab()
    openPrintTab({ open: () => tab })
    expect(tab.opener).toBeNull()
    expect(tab.calls).toEqual(['write', 'close'])
  })

  it('reports a blocked pop-up as null instead of throwing', () => {
    expect(openPrintTab({ open: () => null })).toBeNull()
    expect(openPrintTab({ open: () => { throw new Error('blocked') } })).toBeNull()
    expect(openPrintTab(undefined)).toBeNull()
  })

  it('survives an unwritable about:blank', () => {
    const tab = fakeTab()
    tab.document.write = () => { throw new Error('denied') }
    expect(openPrintTab({ open: () => tab })).toBe(tab)
  })
})

describe('showPdfInPrintTab', () => {
  it('replaces rather than assigns, so the placeholder is not a back-button stop', () => {
    const tab = fakeTab()
    expect(showPdfInPrintTab(tab, 'https://x/doc.pdf')).toEqual({ opened: true })
    expect(tab.calls).toContain('replace:https://x/doc.pdf')
  })

  it('tells the agent what to do when the tab was blocked', () => {
    expect(() => showPdfInPrintTab(null, 'https://x/doc.pdf')).toThrow(/pop-ups/i)
  })

  it('closes the tab it cannot fill, instead of leaving a placeholder up forever', () => {
    const tab = fakeTab()
    expect(() => showPdfInPrintTab(tab, '')).toThrow(/no printable copy/i)
    expect(tab.calls).toContain('close-tab')
  })
})

describe('closePrintTab', () => {
  it('is safe on a tab that was never opened', () => {
    expect(() => closePrintTab(null)).not.toThrow()
    expect(() => closePrintTab({ close: () => { throw new Error('gone') } })).not.toThrow()
  })
})
