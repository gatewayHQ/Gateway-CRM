// Quick Look — the rules behind previewing a deal document before acting on
// it. Pure: no React, no DOM.

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** "contract.PDF" → "pdf". Empty for a name with no extension. */
export const fileExt = (name) => {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

/**
 * How a file can be previewed in the app: 'pdf' (drawn page by page),
 * 'image', or 'none' — Word, Excel and the rest have to be downloaded,
 * because a browser can't draw them without an online converter, and deal
 * documents don't leave the CRM's own storage for a preview.
 */
export function previewKind(name) {
  const ext = fileExt(name)
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_EXTS.has(ext)) return 'image'
  return 'none'
}

export const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

/**
 * Where `current` sits in `list` (compared by `key`), and its neighbours —
 * for stepping through a deal's documents without closing the preview.
 * No wrap-around: at either end the button is simply unavailable.
 */
export function neighbours(list, current, key = (x) => x) {
  const keys = list.map(key)
  const index = keys.indexOf(current)
  if (index < 0) return { index: -1, total: list.length, prev: null, next: null }
  return {
    index,
    total: list.length,
    prev: index > 0 ? list[index - 1] : null,
    next: index < list.length - 1 ? list[index + 1] : null,
  }
}

/**
 * How many pages to draw at once. A 200-page closing packet would otherwise
 * render every page up front; the rest load when the agent asks for them.
 */
export const PAGE_BATCH = 12
