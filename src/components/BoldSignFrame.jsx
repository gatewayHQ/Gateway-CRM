// ─────────────────────────────────────────────────────────────────────────────
// BoldSignFrame — renders a BoldSign embedded URL (prepare/send, signing, or the
// template editor) in an iframe and relays completion back via onDone / onError.
//
// REQUIREMENT: the host domain must be added to BoldSign → Settings → Embedded →
// Approved domains, or BoldSign refuses to load in the iframe.
//
// Completion is detected THREE ways because BoldSign's signal differs by flow:
//   1. postMessage from https://app.boldsign.com. Event names vary by flow:
//        • document send/sign → onCreateSuccess | onDraftSuccess | onSendSuccess |
//          onSuccessfullySigned | onSigningComplete | onDocumentSigned
//        • TEMPLATE editor    → onCreateClick | onSaveClick | onSaveAndCloseClick
//          (these are what the embedded *template* editor emits — NOT the
//          *Success events above; missing them was why template saves looked
//          like they "didn't save".)
//   2. A same-origin return page (see returnUrlMarker) that posts
//      { status: 'gwTemplateEditorDone' } to us — used when BoldSign only
//      redirects to RedirectUrl instead of posting a flow event.
//   3. The iframe's load event: once BoldSign redirects to our same-origin
//      RedirectUrl, we can read its location and match returnUrlMarker. This is
//      the reliable fallback that doesn't depend on BoldSign's event names.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect } from 'react'

const BOLDSIGN_ORIGIN = 'https://app.boldsign.com'

// ── Event groups ─────────────────────────────────────────────────────────────
// SAVE events mean "BoldSign persisted the current state" — which is COMPLETION
// for the template editor but only an intermediate step in the document send
// wizard. In the send flow, clicking "Save and proceed" on Step 1/2 (Prepare
// document for signing) emits one of these; treating it as completion tore our
// modal down mid-wizard, before the agent ever reached Step 2/2's Send button,
// and left the document parked as a Draft. See the `flow` argument below.
const SAVE = ['onsaveandcloseclick', 'onsaveclick', 'oncreateclick', 'ondraftsuccess', 'ondraftsaved']
// A document actually went out for signature, or was signed.
const SENT = ['onsendsuccess', 'oncreatesuccess', 'onsuccessfullysigned', 'onsigningcomplete',
  'ondocumentsigned', 'documentsigned']
const FAILURE = [
  'oncreatefailed', 'onsigningfailed', 'ondeclined', 'onerror', 'failed', 'declined',
]
// Marker our own same-origin return page posts (see public/boldsign-return.html).
const RETURN_MARKER = 'gwtemplateeditordone'

function eventName(data) {
  if (typeof data === 'string') return data.toLowerCase()
  if (data && typeof data === 'object') return String(data.type || data.event || data.action || data.status || '').toLowerCase()
  return ''
}

// Pure classifier for an inbound window message → 'done' | 'draft' | 'error' | null.
// Exported so the origin/event-name rules can be unit-tested without a DOM.
// Trusts only BoldSign's app origin (for flow events) or our own origin (for
// the explicit return marker a same-origin page posts — an iframe on another
// origin can't forge that).
//
// `flow` decides what a SAVE event means:
//   'template' (default) → saving IS finishing; the Form Library writes back.
//   'document'           → saving is mid-wizard. Returns 'draft', so the caller
//                          can record the draft WITHOUT closing the frame or
//                          claiming the document was sent.
export function classifyBoldSignMessage({ origin, data, selfOrigin, flow = 'template' }) {
  const sameOrigin = origin === selfOrigin
  if (origin !== BOLDSIGN_ORIGIN && !sameOrigin) return null
  const name = eventName(data)
  if (!name) return null
  if (sameOrigin && origin !== BOLDSIGN_ORIGIN) {
    return name.includes(RETURN_MARKER) ? 'done' : null
  }
  if (FAILURE.some(s => name.includes(s))) return 'error'
  // Order matters: SAVE is checked before SENT because 'onDraftSuccess' also
  // contains the substring 'success'.
  if (SAVE.some(s => name.includes(s))) return flow === 'document' ? 'draft' : 'done'
  if (SENT.some(s => name.includes(s)) || name.includes('success')) return 'done'
  return null
}

export default function BoldSignFrame({ url, onDone, onError, onDraft, height = 640, returnUrlMarker, flow = 'template' }) {
  useEffect(() => {
    function handler(e) {
      const verdict = classifyBoldSignMessage({ origin: e.origin, data: e.data, selfOrigin: window.location.origin, flow })
      if (verdict === 'done') onDone?.(e.data)
      else if (verdict === 'error') onError?.(e.data)
      // 'draft' deliberately does NOT close the frame — the agent is still
      // working inside the wizard (e.g. mid "Save and proceed"). The caller just
      // records that a draft now exists so it can be resumed if they bail out.
      else if (verdict === 'draft') onDraft?.(e.data)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onDone, onError, onDraft, flow])

  // When BoldSign redirects the iframe to our same-origin RedirectUrl, its load
  // event fires and the location becomes readable (cross-origin reads throw
  // while still inside BoldSign, so those are ignored).
  const handleLoad = (e) => {
    if (!returnUrlMarker) return
    try {
      const href = e.currentTarget.contentWindow.location.href
      if (href && href.includes(returnUrlMarker)) onDone?.({ via: 'redirect' })
    } catch { /* cross-origin — still inside BoldSign, not done yet */ }
  }

  if (!url) return null
  return (
    <iframe
      title="BoldSign"
      src={url}
      onLoad={handleLoad}
      style={{ width: '100%', height, border: 'none', borderRadius: 'var(--radius)' }}
      allow="camera; microphone; geolocation"
    />
  )
}
