#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// One-time storage re-compression — shrink the images ALREADY in the public
// buckets (the ones live QR mailers are serving right now), which is what
// fixes a current "cached egress" overage. New uploads are already compressed
// in-app (src/lib/imageCompress.js); this catches everything uploaded before.
//
// It re-encodes each image IN PLACE at the same object key (same extension,
// same public URL), so every URL stored in the DB keeps working — only the
// bytes get smaller, plus a 1-year immutable cache header.
//
// Run locally (NOT committed to run on a server — it needs the service key):
//   npm i -D sharp
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/recompress-storage.mjs
//   # add --dry-run first to see what it would do without uploading
//
// Safe to re-run: objects already small / already optimized are skipped.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js'

const DRY = process.argv.includes('--dry-run')
const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY'); process.exit(1) }

let sharp
try { sharp = (await import('sharp')).default }
catch { console.error('Missing dependency. Run:  npm i -D sharp'); process.exit(1) }

const supabase = createClient(URL, KEY, { auth: { persistSession: false } })

const BUCKETS = ['campaign-images', 'property-photos']
const SKIP_UNDER = 350 * 1024          // already-small files aren't worth touching
const ONE_YEAR   = '31536000'

// Recursively list every object key in a bucket (Supabase list is per-prefix).
async function listAll(bucket, prefix = '') {
  const out = []
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 })
  if (error) { console.error(`  list ${bucket}/${prefix}:`, error.message); return out }
  for (const item of data || []) {
    const key = prefix ? `${prefix}/${item.name}` : item.name
    if (item.id === null || item.metadata == null) out.push(...await listAll(bucket, key)) // folder
    else out.push({ key, size: item.metadata?.size || 0, mime: item.metadata?.mimetype || '' })
  }
  return out
}

const maxDimFor = (key) => key.startsWith('agents/') ? 512 : 1600

async function reencode(buf, key) {
  const img = sharp(buf, { failOn: 'none' })
  const meta = await img.metadata()
  const maxDim = maxDimFor(key)
  let pipe = img.rotate() // honor EXIF orientation
  if (Math.max(meta.width || 0, meta.height || 0) > maxDim) {
    pipe = pipe.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
  }
  // Keep the original format so the object key/extension and stored URL are unchanged.
  const fmt = (meta.format || '').toLowerCase()
  if (fmt === 'png')  return { buf: await pipe.png({ compressionLevel: 9, palette: true }).toBuffer(), mime: 'image/png' }
  if (fmt === 'webp') return { buf: await pipe.webp({ quality: 82 }).toBuffer(), mime: 'image/webp' }
  return { buf: await pipe.jpeg({ quality: 82, mozjpeg: true }).toBuffer(), mime: 'image/jpeg' }
}

let scanned = 0, shrunk = 0, savedBytes = 0
for (const bucket of BUCKETS) {
  console.log(`\n▶ ${bucket}`)
  const objects = await listAll(bucket)
  for (const obj of objects) {
    scanned++
    if (!/^image\//.test(obj.mime) && !/\.(jpe?g|png|webp)$/i.test(obj.key)) continue
    if (obj.size && obj.size < SKIP_UNDER) continue
    const { data, error } = await supabase.storage.from(bucket).download(obj.key)
    if (error || !data) { console.log(`  ! download failed: ${obj.key}`); continue }
    const original = Buffer.from(await data.arrayBuffer())
    let result
    try { result = await reencode(original, obj.key) }
    catch { console.log(`  ~ skip (decode): ${obj.key}`); continue }
    if (result.buf.length >= original.length) continue // no win
    const save = original.length - result.buf.length
    console.log(`  ${DRY ? '[dry] ' : ''}${obj.key}  ${(original.length/1024|0)}KB → ${(result.buf.length/1024|0)}KB`)
    shrunk++; savedBytes += save
    if (DRY) continue
    const { error: upErr } = await supabase.storage.from(bucket)
      .upload(obj.key, result.buf, { upsert: true, contentType: result.mime, cacheControl: ONE_YEAR })
    if (upErr) console.log(`  ! upload failed: ${obj.key} — ${upErr.message}`)
  }
}
console.log(`\nScanned ${scanned}, ${DRY ? 'would shrink' : 'shrank'} ${shrunk}, ` +
  `saving ${(savedBytes/1024/1024).toFixed(1)} MB per full serve.${DRY ? '  (dry run — nothing uploaded)' : ''}`)
