// ─────────────────────────────────────────────────────────────────────────────
// Browser image compression — shrink user uploads BEFORE they hit Supabase
// Storage. The free plan has no server-side image transforms, and public
// bucket images (landing pages served on every QR-mailer scan, property
// galleries, advisor headshots) are the dominant "cached egress" cost. A raw
// 3–8 MB phone photo becomes ~150–300 KB here — a 15–30× reduction — with no
// visible quality loss at on-screen sizes. Pure canvas, no dependencies.
// ─────────────────────────────────────────────────────────────────────────────

// Per-use-case targets. maxDim caps the longest edge; quality is the encoder
// quality (0–1). Headshots are shown small, so they cap tighter.
export const IMAGE_PRESETS = {
  landing:  { maxDim: 1600, quality: 0.82 }, // campaign/landing collage photos
  property: { maxDim: 1600, quality: 0.82 }, // property gallery
  headshot: { maxDim: 512,  quality: 0.85 }, // advisor card / profile photo
}

// Pure: the scaled dimensions for a maxDim cap, never upscaling. Exported for
// unit testing (the canvas work itself is integration-only).
export function computeTargetDimensions(w, h, maxDim) {
  if (!w || !h) return { width: w || 0, height: h || 0 }
  const longest = Math.max(w, h)
  if (longest <= maxDim) return { width: w, height: h }
  const scale = maxDim / longest
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

const loadImage = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')) }
  img.src = url
})

/**
 * Compress an image File for upload. Returns { blob, ext, type, original }.
 * On any failure (unsupported format like HEIC, decode error, or a result
 * that isn't actually smaller) it falls back to the original file so an upload
 * never breaks — worst case we're no worse off than before.
 */
export async function compressForUpload(file, preset = 'landing') {
  const cfg = IMAGE_PRESETS[preset] || IMAGE_PRESETS.landing
  const fallback = {
    blob: file,
    ext: (file.name?.split('.').pop() || 'jpg').toLowerCase(),
    type: file.type || 'image/jpeg',
    original: true,
  }
  // Only attempt raster images; skip SVG/GIF (animation) and anything exotic.
  if (!file.type?.startsWith('image/') || /svg|gif/.test(file.type)) return fallback
  if (typeof document === 'undefined' || !document.createElement('canvas').getContext) return fallback

  try {
    const img = await loadImage(file)
    const { width, height } = computeTargetDimensions(img.naturalWidth, img.naturalHeight, cfg.maxDim)
    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, width, height)

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', cfg.quality))
    if (!blob || blob.size >= file.size) return fallback   // no win → keep original
    return { blob, ext: 'webp', type: 'image/webp', original: false }
  } catch {
    return fallback
  }
}

// One year, immutable — safe because every upload path uses a unique
// timestamp+random filename, so a stored object never changes. Lets returning
// visitors and social crawlers serve from their own cache instead of
// re-hitting the CDN, which directly cuts cached egress for repeat views.
export const IMMUTABLE_CACHE = '31536000'
