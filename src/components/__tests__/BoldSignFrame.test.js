import { describe, it, expect } from 'vitest'
import { classifyBoldSignMessage, frameTookFocus } from '../BoldSignFrame.jsx'

const BOLDSIGN = 'https://app.boldsign.com'
const SELF     = 'https://crm.example.com'
const from = (origin, status) => classifyBoldSignMessage({ origin, data: { status }, selfOrigin: SELF })

describe('classifyBoldSignMessage — embedded template editor completion (the "template didn\'t save" bug)', () => {
  it('treats the template editor FINISH events as done', () => {
    // These are what the embedded TEMPLATE editor emits — previously unmatched,
    // so template saves silently never wrote back to the Form Library.
    expect(from(BOLDSIGN, 'onCreateClick')).toBe('done')
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

describe('classifyBoldSignMessage — saved-but-not-sent is NOT a send', () => {
  // A draft save used to be classified 'done', so the agent was told "Sent for
  // signature" while the CRM row stayed 'draft' and the client had nothing.
  it('classifies a document draft save as draft, not done', () => {
    expect(from(BOLDSIGN, 'onDraftSuccess')).toBe('draft')
  })

  // 'onDraftSuccess' CONTAINS the substring 'success'. If DRAFT were checked
  // after SUCCESS, this would fall through to 'done' — which is exactly the bug.
  it('is not fooled by "success" appearing inside the draft event name', () => {
    expect(from(BOLDSIGN, 'onDraftSuccess')).not.toBe('done')
  })

  // An intermediate Save in the template editor must not tear the iframe down —
  // the admin is still placing fields.
  it('classifies an intermediate template editor save as draft', () => {
    expect(from(BOLDSIGN, 'onSaveClick')).toBe('draft')
  })

  // The DOCUMENT editor's save CONFIRMATION. onSaveClick is the click;
  // onDraftSavedSuccess is BoldSign saying the values are committed. It was
  // absent from DRAFT, and because the name ends in 'success' it fell through to
  // SUCCESS — reporting a saved draft as a completed send and tearing the editor
  // down mid-prep.
  it('classifies the document editor save confirmation as draft', () => {
    expect(from(BOLDSIGN, 'onDraftSavedSuccess')).toBe('draft')
    expect(from(BOLDSIGN, 'onDraftSavedSuccess')).not.toBe('done')
    expect(from(BOLDSIGN, 'onSaveSuccess')).toBe('draft')
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

describe('frameTookFocus — the only honest "the agent is working in there" signal', () => {
  const frame = { tagName: 'IFRAME' }

  it('is true when the iframe itself holds focus', () => {
    // A cross-origin iframe cannot report a click, a drag or a half-placed field.
    // When focus crosses into it, our window blurs and the iframe becomes the active
    // element — that is the whole basis of the unsaved-work warning.
    expect(frameTookFocus(frame, frame)).toBe(true)
  })

  it('is false when focus went somewhere else on our side of the boundary', () => {
    // Clicking Print, or tabbing to the header, must NOT mark work as unsaved —
    // otherwise the leave prompt fires on a session where nothing was touched, and a
    // prompt that cries wolf is one agents dismiss without reading.
    expect(frameTookFocus({ tagName: 'BUTTON' }, frame)).toBe(false)
    expect(frameTookFocus(null, frame)).toBe(false)
  })

  it('is false before the frame exists', () => {
    expect(frameTookFocus(frame, null)).toBe(false)
    expect(frameTookFocus(null, null)).toBe(false)
  })
})
