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

describe('classifyBoldSignMessage — document send wizard must not close on a mid-flow save', () => {
  const doc = (status) => classifyBoldSignMessage({ origin: BOLDSIGN, data: { status }, selfOrigin: SELF, flow: 'document' })

  // The reported bug: in the send wizard the agent clicks Back to add a
  // recipient, then "Save and proceed" on Step 1/2. That emits a save event.
  // Treating it as 'done' tore the modal down before they reached Step 2/2's
  // Send button and stranded the document as an uneditable Draft.
  it('classifies a mid-wizard save as draft, NOT done', () => {
    expect(doc('onSaveClick')).toBe('draft')
    expect(doc('onSaveAndCloseClick')).toBe('draft')
    expect(doc('onCreateClick')).toBe('draft')
  })

  it("classifies BoldSign's explicit draft-saved event as draft", () => {
    // Must not be swallowed by the generic 'success' token it contains.
    expect(doc('onDraftSuccess')).toBe('draft')
  })

  it('only a real send or signature counts as done', () => {
    expect(doc('onSendSuccess')).toBe('done')
    expect(doc('onCreateSuccess')).toBe('done')
    expect(doc('onSuccessfullySigned')).toBe('done')
    expect(doc('onDocumentSigned')).toBe('done')
  })

  it('still surfaces failures', () => {
    expect(doc('onCreateFailed')).toBe('error')
    expect(doc('onDeclined')).toBe('error')
  })

  it('leaves the template flow behavior unchanged (save IS finish there)', () => {
    const tpl = (status) => classifyBoldSignMessage({ origin: BOLDSIGN, data: { status }, selfOrigin: SELF, flow: 'template' })
    expect(tpl('onSaveClick')).toBe('done')
    expect(tpl('onSaveAndCloseClick')).toBe('done')
    expect(tpl('onDraftSuccess')).toBe('done')
  })

  it('the same-origin return marker still completes either flow', () => {
    expect(classifyBoldSignMessage({ origin: SELF, data: { status: 'gwTemplateEditorDone' }, selfOrigin: SELF, flow: 'document' })).toBe('done')
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
