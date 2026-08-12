/**
 * Renders a campaign's QR code locally (see src/lib/qr.js — no external image
 * service). Generation is async, so a same-size placeholder holds the space to
 * keep the surrounding layout from jumping when the code resolves.
 */
import React, { useEffect, useState } from 'react'
import { qrPngDataUrl, shortUrl } from '../lib/qr.js'

export default function QrCode({ token, size = 400, style, alt = 'QR code', className }) {
  const [src, setSrc] = useState(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setSrc(null); setFailed(false)
    if (!token) return
    // Render at 2x for crisp display on retina screens.
    qrPngDataUrl(shortUrl(token), { width: Math.max(120, size * 2) })
      .then(url => { if (live) setSrc(url) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [token, size])

  if (failed) {
    return (
      <div className={className} title="QR code could not be generated"
           style={{ width: size, height: size, display: 'grid', placeItems: 'center',
                    background: 'var(--gw-bone)', border: '1px solid var(--gw-border)',
                    borderRadius: 6, fontSize: 11, color: 'var(--gw-mist)', ...style }}>
        QR unavailable
      </div>
    )
  }

  if (!src) {
    return (
      <div className={className} aria-hidden="true"
           style={{ width: size, height: size, background: 'var(--gw-bone)',
                    border: '1px solid var(--gw-border)', borderRadius: 6, ...style }} />
    )
  }

  return <img className={className} src={src} alt={alt} width={size} height={size} style={style} />
}
