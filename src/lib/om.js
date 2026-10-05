/**
 * Offering Memorandum attachments on QR landing pages.
 *
 * The OM is the thing a prospect actually wants off a QR code — and the thing
 * worth asking for a name in exchange for. Both halves live here so the builder
 * (authenticated, uploading) and the four public landing pages (anonymous,
 * unlocking) can never disagree about the shape of `landing_config.om`:
 *
 *   om: {
 *     path,        // object key inside the PRIVATE `campaign-oms` bucket
 *     filename,    // what the visitor's download is named
 *     title,       // optional label shown on the gate ("Offering Memorandum")
 *     size,        // bytes, for the "PDF · 4.2 MB" hint
 *     uploaded_at,
 *   }
 *
 * `path` is deliberately absent from the payload the public pages receive
 * (api/campaigns.js strips it — see publicLandingConfig): the page never builds
 * a URL itself. It POSTs the visitor's details to `action=om_request` and gets
 * back a short-lived signed URL. That is what makes the gate a gate rather than
 * a suggestion — the bucket is private, so there is no link to share around.
 */

import { supabase } from './supabase.js'

export const OM_BUCKET = 'campaign-oms'

/** Matches the bucket's file_size_limit in migration 0045. */
export const OM_MAX_BYTES = 50 * 1024 * 1024

export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Normalize whatever is on `landing_config.om` into a predictable object, or
 * null when the campaign has no OM. Tolerates a bare string path (hand-edited
 * config) and the public shape, which has no `path` but carries
 * `available: true`.
 */
export function normalizeOm(om) {
  if (!om) return null
  if (typeof om === 'string') {
    return { path: om, filename: om.split('/').pop() || 'offering-memorandum.pdf', title: '', size: null, available: true }
  }
  if (typeof om !== 'object') return null
  const path = String(om.path || '').trim()
  const available = om.available === true || !!path
  if (!available) return null
  return {
    path,
    filename:    String(om.filename || 'offering-memorandum.pdf'),
    title:       String(om.title || ''),
    size:        Number.isFinite(Number(om.size)) ? Number(om.size) : null,
    uploaded_at: om.uploaded_at || null,
    available,
  }
}

/** True when a landing_config has an OM the gate should be rendered for. */
export function hasOm(cfg) {
  return !!normalizeOm(cfg?.om)
}

/**
 * Upload an OM PDF from the builder. Runs as the signed-in agent, straight into
 * the private bucket — no compression, no rewriting: a PDF an owner will read
 * page by page has to arrive byte-identical.
 *
 * Returns the descriptor to store on `landing_config.om`.
 */
export async function uploadOm(file) {
  if (!file) throw new Error('No file selected')
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
  if (!isPdf) throw new Error('The offering memorandum must be a PDF')
  if (file.size > OM_MAX_BYTES) {
    throw new Error(`That PDF is ${formatBytes(file.size)} — the limit is ${formatBytes(OM_MAX_BYTES)}`)
  }

  // Random prefix, original-ish name: the visitor's download should read
  // "Riverside-Apartments-OM.pdf", not a uuid.
  const safeName = (file.name || 'offering-memorandum.pdf')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(-120)
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}/${safeName}`

  const { error } = await supabase.storage
    .from(OM_BUCKET)
    .upload(path, file, { contentType: 'application/pdf', upsert: false })
  if (error) throw error

  return {
    path,
    filename:    safeName,
    title:       '',
    size:        file.size,
    uploaded_at: new Date().toISOString(),
  }
}

/** Remove an OM object. Best-effort: a stale object costs storage, not correctness. */
export async function deleteOm(path) {
  if (!path) return
  try { await supabase.storage.from(OM_BUCKET).remove([path]) } catch { /* orphan, not a failure */ }
}

/**
 * The public half: trade the visitor's details for a signed download URL.
 *
 * Throws with a message fit to show a visitor. On success returns
 * { url, filename, access_token, deal_room } — the caller opens the URL (when
 * there is an OM file) and keeps the token (src/lib/dealRoomAccess.js).
 */
export async function requestOm(payload) {
  const res = await fetch('/api/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'om_request', ...payload }),
  })
  const data = await res.json().catch(() => ({}))
  // A Deal Room with no OM file still answers with an access token and the
  // room's contents, just no download URL.
  if (!res.ok || data.error || (!data.url && !data.access_token)) {
    throw new Error(data.error || "We couldn't prepare the download. Please try again.")
  }
  return data
}

/**
 * Deal Room documents beyond the OM: rent rolls and T-12s arrive as Excel,
 * CSV, Word, photos or a zip as often as a PDF. Same private bucket, same
 * rules (migration 0063 widened what it accepts).
 */
export const DEAL_ROOM_ACCEPT = [
  '.pdf', '.xlsx', '.xls', '.csv', '.docx', '.doc', '.jpg', '.jpeg', '.png', '.webp', '.zip',
].join(',')

const DEAL_ROOM_EXT = /\.(pdf|xlsx|xls|csv|docx|doc|jpe?g|png|webp|zip)$/i

export const DEAL_ROOM_DOC_KINDS = [
  { value: 'rent_roll',  label: 'Rent Roll' },
  { value: 't12',        label: 'T-12 Operating Statement' },
  { value: 'financials', label: 'Financials' },
  { value: 'photos',     label: 'Photo Package' },
  { value: 'survey',     label: 'Survey / Site Plan' },
  { value: 'other',      label: 'Other' },
]

export async function uploadDealRoomDoc(file) {
  if (!file) throw new Error('No file selected')
  if (!DEAL_ROOM_EXT.test(file.name || '')) {
    throw new Error('Use a PDF, Excel, CSV, Word, image or zip file')
  }
  if (file.size > OM_MAX_BYTES) {
    throw new Error(`That file is ${formatBytes(file.size)} — the limit is ${formatBytes(OM_MAX_BYTES)}`)
  }
  const safeName = (file.name || 'document')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(-120)
  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}/${safeName}`
  const { error } = await supabase.storage
    .from(OM_BUCKET)
    .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false })
  if (error) throw error
  return {
    id:          `doc-${Math.random().toString(36).slice(2, 10)}`,
    path,
    filename:    safeName,
    title:       '',
    kind:        'other',
    size:        file.size,
    uploaded_at: new Date().toISOString(),
  }
}
