/**
 * QR code generation — local, offline, no third party.
 *
 * Every QR code in the app used to be an <img> pointing at api.qrserver.com,
 * which meant the codes an agent printed on a postcard run depended on a free
 * external service being up at the moment they hit "download". If it was down
 * or slow, the download silently produced nothing; if it disappeared, every QR
 * preview in the CRM broke at once. It also handed the full destination URL of
 * every campaign to a third party on every page render.
 *
 * These are generated in-process instead, so they work offline and are
 * byte-identical every time.
 *
 * Error correction defaults to 'Q' (~25% recoverable). Print gets scuffed,
 * folded and photographed at an angle — the extra redundancy is worth the
 * slightly denser code, and it leaves room for a logo punch-out later.
 */
import QRCode from 'qrcode'

// Branded short-link domain. Set VITE_PUBLIC_LINK_DOMAIN (e.g. https://gatewayre.link)
// in Vercel to make QR codes point at a clean, professional domain instead of the
// CRM's own URL. Falls back to the current origin when unset.
export function linkBase() {
  const custom = import.meta.env.VITE_PUBLIC_LINK_DOMAIN
  return (custom && custom.trim() ? custom.trim().replace(/\/+$/, '') : window.location.origin)
}

export function shortUrl(token) {
  return `${linkBase()}/m/${token}`
}

const DEFAULTS = {
  errorCorrectionLevel: 'Q',
  margin: 2,          // quiet zone in modules — printers need it to scan reliably
  color: { dark: '#000000', light: '#ffffff' },
}

/** Scalable vector QR — this is what should go to a printer. */
export function qrSvg(text, opts = {}) {
  return QRCode.toString(text, { ...DEFAULTS, ...opts, type: 'svg' })
}

/** Raster QR as a data: URL — for on-screen preview and <img> tags. */
export function qrPngDataUrl(text, opts = {}) {
  return QRCode.toDataURL(text, { ...DEFAULTS, width: 400, ...opts, type: 'image/png' })
}

/**
 * Download a campaign's QR code.
 *
 * SVG is generated as a Blob rather than linking out, so the file lands even
 * when offline. PNG is rendered at the requested pixel size — 2000px is roughly
 * 6.7 inches at 300dpi, which covers any postcard or flyer placement.
 */
export async function downloadQr(token, { format = 'svg', size = 2000, filename } = {}) {
  const url  = shortUrl(token)
  const name = filename || `qr-${token}.${format}`

  const data = format === 'svg'
    ? new Blob([await qrSvg(url, { width: size })], { type: 'image/svg+xml' })
    : await (await fetch(await qrPngDataUrl(url, { width: size }))).blob()

  const href = URL.createObjectURL(data)
  const a = document.createElement('a')
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick — revoking synchronously can cancel the download
  // in Safari before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
}
