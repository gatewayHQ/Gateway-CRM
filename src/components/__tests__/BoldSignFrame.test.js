import { describe, it, expect } from 'vitest'
import { classifyBoldSignMessage } from '../BoldSignFrame.jsx'

const BOLDSIGN = 'https://app.boldsign.com'
const SELF     = 'https://crm.example.com'
const from = (origin, status) => classifyBoldSignMessage({ origin, data: { status }, selfOrigin: SELF })

describe('classifyBoldSignMessage — embedded template editor completion (the "template didn\'t save" bug)', () => {
  it('treats the template editor finish events as done', () => {
    // These are what the embedded TEMPLATE editor emits — previously unmatched,
    // so template saves silently never wrote back to the Form Library.
    expect(from(BOLDSIGN, 'onCreateClick')).toBe('done')
    expect(from(BOLDSIGN, 'onSaveClick')).toBe('done')
    expect(from(BOLDSIGN, 'onSaveAndCloseClick')).toBe('done')
  })

  it('does NOT treat mid-flow template events as done', () => {
    expect(from(BOLDSIGN, 'onNextClick')).toBeNull()
    expect(from(BOLDSIGN, 'onPreviewClick')).toBeNull()
    expect(from(BOLDSIGN, 'onPreviewExit')).toBeNull()
  })

  it('still handles the document send/sign success + failure events', () => {
    expect(from(BOLDSIGN, 'onSendSuccess')).toBe('done')
    expect(from(BOLDSIGN, 'onSuccessfullySigned')).toBe('done')
    expect(from(BOLDSIGN, 'onCreateFailed')).toBe('error')
    expect(from(BOLDSIGN, 'onDeclined')).toBe('error')
  })
})

describe('classifyBoldSignMessage — origin trust', () => {
  it('accepts the same-origin return marker only', () => {
    expect(from(SELF, 'gwTemplateEditorDone')).toBe('done')
    // A same-origin message that isn't our explicit marker is ignored, so a
    // stray postMessage can't be mistaken for a BoldSign flow event.
    expect(from(SELF, 'onCreateClick')).toBeNull()
  })

  it('ignores messages from any other origin', () => {
    expect(from('https://evil.example.com', 'onCreateClick')).toBeNull()
    expect(from('https://evil.example.com', 'gwTemplateEditorDone')).toBeNull()
  })

  it('ignores empty / unrecognized payloads', () => {
    expect(classifyBoldSignMessage({ origin: BOLDSIGN, data: {}, selfOrigin: SELF })).toBeNull()
    expect(classifyBoldSignMessage({ origin: BOLDSIGN, data: { status: 'somethingElse' }, selfOrigin: SELF })).toBeNull()
  })
})
