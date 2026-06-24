// Storage upload with real progress events.
//
// supabase-js v2's standard upload() doesn't expose progress for non-resumable
// transfers, so we POST directly to Supabase's storage REST API with XHR —
// XHR's upload.onprogress is the only widely-supported way to read bytes-sent
// inside a browser without bringing in a tus client.
//
// Returns the same { data, error } shape as supabase.storage.from(b).upload()
// so callers can swap it in with no other changes.

import { supabase } from './supabase.js'

const SUPABASE_URL =
  (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_SUPABASE_URL) ||
  'https://twgwemkihpwlgliftagg.supabase.co'

const ANON_KEY =
  (typeof import.meta !== 'undefined' && import.meta?.env?.VITE_SUPABASE_ANON_KEY) || ''

/**
 * @param {string} bucket      e.g. 'form-packets'
 * @param {string} path        object path inside the bucket
 * @param {File|Blob} file
 * @param {object} [opts]
 * @param {(pct: number) => void} [opts.onProgress]  0–100, monotonic
 * @param {boolean} [opts.upsert]                    default false
 * @param {string}  [opts.contentType]               defaults to file.type
 * @param {string}  [opts.cacheControl]              defaults to '3600'
 * @returns {Promise<{data: {path: string} | null, error: Error | null}>}
 */
export async function uploadWithProgress(bucket, path, file, opts = {}) {
  const { onProgress, upsert = false, contentType, cacheControl = '3600' } = opts

  // Pull the active session for the bearer token. Falls back to the anon key
  // for unauthenticated callers (which RLS will then reject — same behavior
  // as supabase.storage.upload would have produced).
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token || ANON_KEY
  if (!token) return { data: null, error: new Error('Not authenticated') }

  return new Promise(resolve => {
    const xhr = new XMLHttpRequest()
    const url = `${SUPABASE_URL}/storage/v1/object/${bucket}/${encodeURI(path)}`
    xhr.open('POST', url)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.setRequestHeader('apikey', ANON_KEY)
    xhr.setRequestHeader('Content-Type', contentType || file.type || 'application/octet-stream')
    xhr.setRequestHeader('x-upsert', upsert ? 'true' : 'false')
    xhr.setRequestHeader('cache-control', `max-age=${cacheControl}`)

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.min(100, Math.round((e.loaded / e.total) * 100))
          onProgress(pct)
        }
      }
    }

    xhr.onload = () => {
      // Storage returns 200 on success with a JSON body { Key, Id }, and
      // 4xx/5xx with { statusCode, error, message } on failure.
      let body = null
      try { body = JSON.parse(xhr.responseText) } catch { /* keep null */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onProgress) onProgress(100)
        resolve({ data: { path }, error: null })
      } else {
        const message = body?.message || body?.error || `Upload failed (${xhr.status})`
        const err = new Error(message)
        err.status = xhr.status
        err.statusCode = body?.statusCode
        resolve({ data: null, error: err })
      }
    }

    xhr.onerror = () => resolve({ data: null, error: new Error('Network error during upload') })
    xhr.onabort = () => resolve({ data: null, error: new Error('Upload cancelled') })

    xhr.send(file)
  })
}
