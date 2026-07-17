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

const SUCCESS = new Set([
  // Document send / sign flows.
  'oncreatesuccess', 'ondraftsuccess', 'onsuccessfullysigned', 'onsigningcomplete',
  'ondocumentsigned', 'onsendsuccess', 'success', 'documentsigned',
  // Embedded template editor "finished" actions.
  'oncreateclick', 'onsaveclick', 'onsaveandcloseclick',
])
const FAILURE = new Set([
  'oncreatefailed', 'onsigningfailed', 'ondeclined', 'onerror', 'failed', 'declined',
])
// Marker our own same-origin return page posts (see public/boldsign-return.html).
const RETURN_MARKER = 'gwtemplateeditordone'

function eventName(data) {
  if (typeof data === 'string') return data.toLowerCase()
  if (data && typeof data === 'object') return String(data.type || data.event || data.action || data.status || '').toLowerCase()
  return ''
}

// Pure classifier for an inbound window message → 'done' | 'error' | null.
// Exported so the origin/event-name rules can be unit-tested without a DOM.
// Trusts only BoldSign's app origin (for flow events) or our own origin (for
// the explicit return marker a same-origin page posts — an iframe on another
// origin can't forge that).
export function classifyBoldSignMessage({ origin, data, selfOrigin }) {
  const sameOrigin = origin === selfOrigin
  if (origin !== BOLDSIGN_ORIGIN && !sameOrigin) return null
  const name = eventName(data)
  if (!name) return null
  if (sameOrigin && origin !== BOLDSIGN_ORIGIN) {
    return name.includes(RETURN_MARKER) ? 'done' : null
  }
  if ([...SUCCESS].some(s => name.includes(s))) return 'done'
  if ([...FAILURE].some(s => name.includes(s))) return 'error'
  return null
}

export default function BoldSignFrame({ url, onDone, onError, height = 640, returnUrlMarker }) {
  useEffect(() => {
    function handler(e) {
      const verdict = classifyBoldSignMessage({ origin: e.origin, data: e.data, selfOrigin: window.location.origin })
      if (verdict === 'done') onDone?.(e.data)
      else if (verdict === 'error') onError?.(e.data)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onDone, onError])

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
