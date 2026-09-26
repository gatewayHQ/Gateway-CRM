#!/usr/bin/env node
/**
 * Derive the shipped Wolf CRM seal assets from the master artwork.
 *
 *   npm i -D sharp
 *   node scripts/build-brand-assets.mjs public/brand/wolf-crm-logo.jfif
 *
 * Input: the square seal, uncropped, any format sharp can read (.jfif/.jpg/.png).
 * Output, next to it in public/brand/:
 *
 *   wolf-crm-logo-512.{png,webp}   boot screen (220px CSS @ 2x)
 *   wolf-crm-logo-128.{png,webp}   header slot (32-36px CSS @ 3x)
 *
 * and the installed-app icons in public/icons/ (see ICONS below), which the
 * web app manifest (public/manifest.webmanifest) and index.html point at.
 *
 * Two things this does beyond a plain resize:
 *
 * 1. The source is a JPEG, so the seal sits on a flat #282828 square. Left
 *    alone that reads as a grey plate around the circle on the near-black boot
 *    screen. Everything outside the seal is masked to transparent instead, so
 *    the mark drops onto any background — the dark boot field, the charcoal
 *    plate in the mobile topbar — without a halo.
 * 2. Every size is converted from the original, never from a larger output, so
 *    the brushed-gold gradients stay metallic instead of banding.
 *
 * The mask radius is measured off the artwork rather than hardcoded: the script
 * scans out from the centre for the last pixel that differs from the corner
 * colour. Re-exporting the seal with a different margin therefore needs no code
 * change here.
 */
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const OUT_DIR = 'public/brand'
const ICON_DIR = 'public/icons'
const SIZES = [512, 128]
/** The seal's own outer field (--gw-seal-field), for icons that must be opaque. */
const FIELD = { r: 0x0b, g: 0x0b, b: 0x0b, alpha: 1 }
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 }
/**
 * Installed-app icons. `seal` is the seal's diameter as a fraction of the icon.
 *
 * - `any`: the transparent seal edge to edge — Chrome/Edge/Android show it as is.
 *   The 512 `any` icon is brand/wolf-crm-logo-512.png itself, so it is not
 *   written twice.
 * - `maskable`: Android crops these to whatever shape the launcher uses (circle,
 *   squircle, teardrop). Only the centre circle of radius 40% is guaranteed to
 *   survive, so the seal sits inside it on an opaque field that bleeds to the edge.
 * - `apple-touch-icon`: iOS paints transparency black and rounds the corners
 *   itself, so it gets the opaque field and a little margin inside the corners.
 * - `favicon`: browser tab. There was none before — tabs showed a blank page.
 */
const ICONS = [
  { file: 'icon-192.png',          size: 192, seal: 1,    background: CLEAR },
  { file: 'maskable-192.png',      size: 192, seal: 0.78, background: FIELD },
  { file: 'maskable-512.png',      size: 512, seal: 0.78, background: FIELD },
  { file: 'apple-touch-icon.png',  size: 180, seal: 0.88, background: FIELD },
  { file: 'favicon-32.png',        size: 32,  seal: 1,    background: CLEAR },
]
/**
 * How much brighter than the corner colour a pixel must be to count as the
 * mark. Deliberately a brightness test rather than any-difference: the seal is
 * ringed by a soft drop shadow that differs from the field but is not part of
 * the artwork, and including it would leave a smudged dark edge once the
 * surround goes transparent. Only the gold ring clears this.
 */
const ARTWORK_LUMA_DELTA = 60
/** Grown past the measured edge so antialiasing on the ring is not clipped. */
const EDGE_PAD_FRACTION = 0.006

const src = process.argv[2] || path.join(OUT_DIR, 'wolf-crm-logo.jfif')

if (!existsSync(src)) {
  console.error(`Source artwork not found: ${src}`)
  console.error(`Drop the original seal in ${OUT_DIR}/ and pass its path.`)
  process.exit(1)
}

let sharp
try {
  ({ default: sharp } = await import('sharp'))
} catch {
  console.error('sharp is not installed. Run:  npm i -D sharp')
  process.exit(1)
}

const meta = await sharp(src).metadata()
if (meta.width !== meta.height) {
  console.warn(`Warning: source is ${meta.width}x${meta.height}, not square. ` +
    'The seal must not be cropped — re-export it square before shipping.')
}

/**
 * Radius of the seal within the source, as a fraction of half the width.
 * Walks eight rays out from the centre; the furthest-out bright pixel on any
 * of them is the outer edge of the gold ring. Eight rather than four because
 * the ring is not perfectly concentric in the source — the edge lands between
 * 93% and 96% depending on the angle, and the mask has to clear all of it.
 */
async function measureSealRadius() {
  const { data, info } = await sharp(src).raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h, channels: c } = info
  const at = (x, y) => {
    const o = (y * w + x) * c
    return [data[o], data[o + 1], data[o + 2]]
  }
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
  const fieldLuma = luma(at(1, 1))
  const isArtwork = (x, y) => luma(at(x, y)) > fieldLuma + ARTWORK_LUMA_DELTA

  const cx = (w - 1) / 2
  const cy = (h - 1) / 2
  // 0°, 90°, 180°, 270° and the four diagonals.
  const rays = [0, 45, 90, 135, 180, 225, 270, 315].map(deg => (deg * Math.PI) / 180)
  const limit = Math.min(cx, cy)

  let maxRadius = 0
  for (const angle of rays) {
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    for (let r = Math.floor(limit); r > 0; r--) {
      const x = Math.round(cx + dx * r)
      const y = Math.round(cy + dy * r)
      if (x < 0 || y < 0 || x >= w || y >= h) continue
      if (isArtwork(x, y)) { maxRadius = Math.max(maxRadius, r); break }
    }
  }
  if (!maxRadius) throw new Error('Could not find the seal — is the source a flat colour?')
  return maxRadius / limit
}

const radiusFraction = await measureSealRadius()
console.log(`seal fills ${(radiusFraction * 100).toFixed(1)}% of the source radius`)

/** The seal at `size` px, masked to a transparent circle. */
function maskedSeal(size) {
  const half = size / 2
  const r = Math.min(half, half * (radiusFraction + EDGE_PAD_FRACTION))
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<circle cx="${half}" cy="${half}" r="${r}" fill="#fff"/></svg>`
  )
  return sharp(src)
    .resize(size, size, { fit: 'contain', background: CLEAR })
    .composite([{ input: mask, blend: 'dest-in' }])
}

for (const size of SIZES) {
  const base = path.join(OUT_DIR, `wolf-crm-logo-${size}`)
  await maskedSeal(size).png({ compressionLevel: 9 }).toFile(`${base}.png`)
  await maskedSeal(size).webp({ quality: 92, alphaQuality: 100 }).toFile(`${base}.webp`)
  console.log(`wrote ${base}.png and ${base}.webp`)
}

mkdirSync(ICON_DIR, { recursive: true })
for (const icon of ICONS) {
  const out = path.join(ICON_DIR, icon.file)
  const sealPx = Math.round(icon.size * icon.seal)
  const seal = await maskedSeal(sealPx).png().toBuffer()
  await sharp({ create: { width: icon.size, height: icon.size, channels: 4, background: icon.background } })
    .composite([{ input: seal, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(out)
  console.log(`wrote ${out}`)
}
