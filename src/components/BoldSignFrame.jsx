// ─────────────────────────────────────────────────────────────────────────────
// BoldSignFrame — renders a BoldSign embedded URL (prepare/send, signing, or the
// template editor) in an iframe and relays completion back via onDone / onError.
//
// REQUIREMENT: the host domain must be added to BoldSign → Settings → Embedded →
// Approved domains, or BoldSign refuses to load in the iframe.
//
// Completion is detected THREE ways because BoldSign's signal differs by flow:
//   1. postMessage from https://app.boldsign.com. Event names vary by flow:
//        • document send/sign → onCreateSuccess | onSendSuccess |
//          onSuccessfullySigned | onSigningComplete | onDocumentSigned
//          ("saved but not sent" events go to onDraft instead — see DRAFT below)
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

// Terminal success — the document was SENT, or the template was finished.
const SUCCESS = new Set([
  // Document send / sign flows.
  'oncreatesuccess', 'onsuccessfullysigned', 'onsigningcomplete',
  'ondocumentsigned', 'onsendsuccess', 'success', 'documentsigned',
  // Embedded template editor "finished" actions.
  'oncreateclick', 'onsaveandcloseclick',
])
// Saved, NOT sent. These were previously lumped in with SUCCESS, so an agent who
// saved a draft in BoldSign was told "Sent for signature" while the CRM row
// stayed 'draft' and the client had nothing — and an admin who clicked Save
// mid-edit was ejected from the template editor. Kept separate so callers can
// persist without claiming delivery, and without tearing the iframe down.
const DRAFT = new Set([
  'ondraftsuccess',   // document flow: saved as a draft
  'onsaveclick',      // template editor: intermediate save, editor stays open
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

// Pure classifier for an inbound window message → 'done' | 'draft' | 'error' | null.
// Exported so the origin/event-name rules can be unit-tested without a DOM.
// Trusts only BoldSign's app origin (for flow events) or our own origin (for
// the explicit return marker a same-origin page posts — an iframe on another
// origin can't forge that).
//
// DRAFT is checked before SUCCESS: 'ondraftsuccess' contains the substring
// 'success', so an ordering mistake here would report a saved draft as a
// completed send.
export function classifyBoldSignMessage({ origin, data, selfOrigin }) {
  const sameOrigin = origin === selfOrigin
  if (origin !== BOLDSIGN_ORIGIN && !sameOrigin) return null
  const name = eventName(data)
  if (!name) return null
  if (sameOrigin && origin !== BOLDSIGN_ORIGIN) {
    return name.includes(RETURN_MARKER) ? 'done' : null
  }
  if ([...DRAFT].some(s => name.includes(s)))   return 'draft'
  if ([...SUCCESS].some(s => name.includes(s))) return 'done'
  if ([...FAILURE].some(s => name.includes(s))) return 'error'
  return null
}

export default function BoldSignFrame({ url, onDone, onDraft, onError, height = 640, returnUrlMarker }) {
  useEffect(() => {
    function handler(e) {
      const verdict = classifyBoldSignMessage({ origin: e.origin, data: e.data, selfOrigin: window.location.origin })
      if (verdict === 'done') onDone?.(e.data)
      // A draft save leaves the iframe mounted — the agent/admin is still working.
      else if (verdict === 'draft') onDraft?.(e.data)
      else if (verdict === 'error') onError?.(e.data)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onDone, onDraft, onError])

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
