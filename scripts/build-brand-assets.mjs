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
 *   wolf-crm-logo.png        1024px master, lossless
 *   wolf-crm-logo.webp       1024px master
 *   wolf-crm-logo-512.{png,webp}   boot screen (220px CSS @ 2x)
 *   wolf-crm-logo-128.{png,webp}   header slot (32-36px CSS @ 3x)
 *
 * The source is converted exactly once, from the original, at every size — the
 * small files are never upscaled from each other, so the gold stays metallic
 * instead of turning into mush.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

const OUT_DIR = 'public/brand'
const SIZES = [1024, 512, 128]

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

for (const size of SIZES) {
  const suffix = size === 1024 ? '' : `-${size}`
  const base = path.join(OUT_DIR, `wolf-crm-logo${suffix}`)
  const pipeline = () => sharp(src).resize(size, size, { fit: 'contain', background: '#0b0b0b' })
  await pipeline().png({ compressionLevel: 9 }).toFile(`${base}.png`)
  await pipeline().webp({ quality: 92 }).toFile(`${base}.webp`)
  console.log(`wrote ${base}.png and ${base}.webp`)
}
