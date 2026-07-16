// ─────────────────────────────────────────────────────────────────────────────
// BoldSignFrame — renders a BoldSign embedded URL (prepare/send or signing) in
// an iframe and relays BoldSign's postMessage events to onDone / onError.
//
// REQUIREMENT: the host domain must be added to BoldSign → Settings → Embedded →
// Approved domains, or BoldSign refuses to load in the iframe.
//
// BoldSign posts window messages from https://app.boldsign.com. Event names vary
// by flow (sending vs signing) and version, so we match defensively:
//   success  → onCreateSuccess | onDraftSuccess | onSuccessfullySigned |
//              onSigningComplete | onDocumentSigned | onSendSuccess
//   failure  → onCreateFailed | onSigningFailed | onDeclined | onError
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect } from 'react'

const BOLDSIGN_ORIGIN = 'https://app.boldsign.com'

const SUCCESS = new Set([
  'oncreatesuccess', 'ondraftsuccess', 'onsuccessfullysigned', 'onsigningcomplete',
  'ondocumentsigned', 'onsendsuccess', 'success', 'documentsigned',
])
const FAILURE = new Set([
  'oncreatefailed', 'onsigningfailed', 'ondeclined', 'onerror', 'failed', 'declined',
])

function eventName(data) {
  if (typeof data === 'string') return data.toLowerCase()
  if (data && typeof data === 'object') return String(data.type || data.event || data.action || data.status || '').toLowerCase()
  return ''
}

export default function BoldSignFrame({ url, onDone, onError, height = 640 }) {
  useEffect(() => {
    function handler(e) {
      // Only trust messages from BoldSign's app origin.
      if (e.origin !== BOLDSIGN_ORIGIN) return
      const name = eventName(e.data)
      if (!name) return
      if ([...SUCCESS].some(s => name.includes(s))) onDone?.(e.data)
      else if ([...FAILURE].some(s => name.includes(s))) onError?.(e.data)
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [onDone, onError])

  if (!url) return null
  return (
    <iframe
      title="BoldSign"
      src={url}
      style={{ width: '100%', height, border: 'none', borderRadius: 'var(--radius)' }}
      allow="camera; microphone; geolocation"
    />
  )
}
