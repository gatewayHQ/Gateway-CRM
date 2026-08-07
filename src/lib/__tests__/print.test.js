import { describe, it, expect, vi } from 'vitest'
import { printPdfFromUrl } from '../print.js'

// A minimal stand-in for the pieces of the DOM this helper touches. Hand-rolled
// rather than jsdom because this repo's suite runs in plain Node — and because the
// interesting behavior here is the ORDER of operations (load → print → revoke),
// which a fake makes explicit.
function fakeDom({ printThrows = null } = {}) {
  const events = []
  const frame = {
    style: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v },
    remove() { events.push('remove') },
    contentWindow: {
      focus: () => events.push('focus'),
      print: () => {
        events.push('print')
        if (printThrows) throw new Error(printThrows)
      },
    },
    set src(v) {
      events.push(`src:${v}`)
      // The browser fires load asynchronously once the blob is attached.
      setTimeout(() => this.onload?.(), 0)
    },
  }
  return {
    events,
    frame,
    doc: {
      createElement: () => frame,
      body: { appendChild: () => events.push('append') },
    },
  }
}

const okFetch  = () => Promise.resolve({ ok: true, blob: () => Promise.resolve({ size: 1234, type: 'application/pdf' }) })
const badFetch = (status) => () => Promise.resolve({ ok: false, status })

describe('printPdfFromUrl', () => {
  it('loads the bytes, then prints from the frame', async () => {
    const { doc, events } = fakeDom()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:abc', revokeObjectURL: () => events.push('revoke') })

    const res = await printPdfFromUrl('https://storage/x.pdf?token=1', { fetchImpl: okFetch, doc })
    expect(res).toEqual({ printed: true })
    // Focus before print: without it some browsers print the wrong frame.
    expect(events).toEqual(['append', 'src:blob:abc', 'focus', 'print'])
  })

  it('surfaces a fetch failure with its status instead of printing a blank page', async () => {
    const { doc } = fakeDom()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:abc', revokeObjectURL: () => {} })
    await expect(printPdfFromUrl('https://storage/x.pdf', { fetchImpl: badFetch(403), doc }))
      .rejects.toThrow(/HTTP 403/)
  })

  it('rejects AND cleans up when the browser blocks print()', async () => {
    // The caller relies on this rejection to fall back to a download — if it
    // resolved, a blocked print would look like a successful one and the agent
    // would be left holding nothing.
    const { doc, events } = fakeDom({ printThrows: 'blocked by user setting' })
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:abc', revokeObjectURL: () => events.push('revoke') })

    await expect(printPdfFromUrl('https://storage/x.pdf', { fetchImpl: okFetch, doc }))
      .rejects.toThrow(/blocked by user setting/)
    // No leaked blob URL and no orphaned iframe.
    expect(events).toContain('revoke')
    expect(events).toContain('remove')
  })

  it('ignores the frame\'s initial about:blank load — that was the blank print dialog', async () => {
    // An iframe appended to the document fires `load` for about:blank before the
    // blob arrives. Printing on it put an empty sheet in front of the agent, who
    // cancelled it and only then saw the real document. One load, one print.
    const { doc, frame, events } = fakeDom()
    let href = 'about:blank'
    frame.contentWindow.location = { get href() { return href } }
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:abc', revokeObjectURL: () => {} })

    const done = printPdfFromUrl('https://storage/x.pdf', { fetchImpl: okFetch, doc })
    await new Promise(r => setTimeout(r, 0))   // the fake fires its load here — about:blank
    expect(events).not.toContain('print')
    href = 'blob:abc'
    frame.onload()                       // the blob is now showing
    await done
    expect(events.filter(e => e === 'print')).toHaveLength(1)
  })

  it('prints once even if the frame fires load again', async () => {
    const { doc, frame, events } = fakeDom()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:abc', revokeObjectURL: () => {} })
    await printPdfFromUrl('https://storage/x.pdf', { fetchImpl: okFetch, doc })
    frame.onload()
    expect(events.filter(e => e === 'print')).toHaveLength(1)
  })

  it('marks the frame hidden from assistive tech — it holds bytes, not content', async () => {
    const { doc, frame } = fakeDom()
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:abc', revokeObjectURL: () => {} })
    await printPdfFromUrl('https://storage/x.pdf', { fetchImpl: okFetch, doc })
    expect(frame.attrs['aria-hidden']).toBe('true')
    expect(frame.attrs.title).toBeTruthy()
  })
})
