// ─────────────────────────────────────────────────────────────────────────────
// Documents service — upload, version, pin, audit.
//
// Lives between pages and Supabase: the page asks "upload this file for this
// deal" and gets back the new version row. The service handles storage,
// document_versions bookkeeping, and audit-log writes. Pages don't touch
// supabase.storage / document_versions directly.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { BUCKETS, TABLES, DOC_SOURCE } from '../constants.js'
import { audit } from '../audit.js'

/**
 * Upload a file to a deal. Creates the storage object, records a
 * document_versions row (auto-incremented per document_name), and writes
 * an audit entry. Returns { ok, version, error }.
 *
 * @param {object} deal — the deal row (needs id)
 * @param {File}   file — browser File object
 * @param {object} opts — { actorId, source }
 */
export async function uploadDealDocument(deal, file, { actorId = null, source = DOC_SOURCE.UPLOAD } = {}) {
  if (!deal?.id) return { ok: false, error: 'Deal missing' }
  if (!file)     return { ok: false, error: 'File missing' }

  const storagePath = `deal-${deal.id}/${file.name}`
  const { error: upErr } = await supabase.storage
    .from(BUCKETS.DEAL_DOCS)
    .upload(storagePath, file, { upsert: false })
  if (upErr) return { ok: false, error: upErr.message }

  // Version number = max existing + 1 for this (deal, document_name).
  const { data: existing } = await supabase
    .from(TABLES.DOCUMENT_VERSIONS)
    .select('version_num')
    .eq('deal_id', deal.id)
    .eq('document_name', file.name)
    .order('version_num', { ascending: false })
    .limit(1)
  const nextVersion = ((existing?.[0]?.version_num) || 0) + 1

  const { data: version, error: rowErr } = await supabase
    .from(TABLES.DOCUMENT_VERSIONS)
    .insert([{
      deal_id:       deal.id,
      document_name: file.name,
      storage_path:  storagePath,
      size:          file.size,
      mime_type:     file.type || null,
      version_num:   nextVersion,
      source,
      uploaded_by:   actorId,
    }])
    .select()
    .single()
  if (rowErr) return { ok: false, error: rowErr.message }

  // Best-effort audit — never blocks the upload.
  audit.documentUploaded(deal, file.name, actorId, source)

  return { ok: true, version }
}

/**
 * Sign a deal-document storage path for download. Default 60s lifetime
 * matches the UI pattern of "click → window.open immediately".
 */
export async function signDealDocumentUrl(storagePath, expiresInSeconds = 60) {
  const { data, error } = await supabase.storage
    .from(BUCKETS.DEAL_DOCS)
    .createSignedUrl(storagePath, expiresInSeconds)
  return { url: data?.signedUrl || null, error: error?.message || null }
}

export async function signClosingPacketUrl(storagePath, expiresInSeconds = 120) {
  const { data, error } = await supabase.storage
    .from(BUCKETS.CLOSING_PACKETS)
    .createSignedUrl(storagePath, expiresInSeconds)
  return { url: data?.signedUrl || null, error: error?.message || null }
}

/**
 * Pin (or unpin) a document version. Pinning 'final' replaces any prior
 * 'final' pin on the same document_name so there's always exactly one.
 */
export async function pinDocumentVersion(version, pinAs /* 'final'|'signed'|null */, { deal, actorId } = {}) {
  if (!version?.id) return { ok: false, error: 'version missing' }
  // Clear any conflicting final/signed pin for the same logical document.
  if (pinAs) {
    await supabase.from(TABLES.DOCUMENT_VERSIONS)
      .update({ pinned_as: null })
      .eq('deal_id', version.deal_id)
      .eq('document_name', version.document_name)
      .eq('pinned_as', pinAs)
  }
  const { data, error } = await supabase.from(TABLES.DOCUMENT_VERSIONS)
    .update({ pinned_as: pinAs })
    .eq('id', version.id)
    .select()
    .single()
  if (error) return { ok: false, error: error.message }
  if (deal && pinAs) audit.documentPinned(deal, version.document_name, pinAs, actorId)
  return { ok: true, version: data }
}

/**
 * List versions for a deal. Returned newest-first; the caller can group by
 * document_name client-side to render a tree.
 */
export async function listDealVersions(dealId) {
  const { data, error } = await supabase
    .from(TABLES.DOCUMENT_VERSIONS)
    .select('*')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: false })
  return { versions: data || [], error: error?.message || null }
}

// ─────────────────────────────────────────────────────────────────────────────
// LISTING A DEAL'S FILES
//
// The deal's Documents tab does not read the `documents` / `document_versions`
// tables — it lists the `deal-documents` bucket under the `deal-<uuid>/` prefix
// that every writer in the app and the API agrees on. Two screens do this (the
// pipeline drawer's DocumentsTab and the deal page's summary card), and they
// used to do it with two copies of the same inline call, which is how they
// drifted apart on the one thing that matters here: what to do when the list
// comes back empty.
//
// It can come back empty for three quite different reasons, and an agent
// deserves to be told which:
//
//   • the deal genuinely has no files             → empty state, no alarm
//   • the bucket does not exist yet               → setup instructions
//   • RLS denied the rows                         → say so
//
// The third is the one that caused real trouble. Supabase storage does not
// ERROR on rows a policy hides, it FILTERS them, so before migration 0049
// scoped the bucket to the deal, a co-agent on a colleague's deal got `[]` and
// both screens rendered "No documents yet" — the same words they use for an
// empty deal. Two agents looked at one deal, saw contradictory answers, and
// nothing anywhere said "you were not allowed to see those". `denied` below is
// a heuristic for the residual case (a database where 0049 has not been applied
// yet, or a leftover hand-made policy): a storage error that talks about
// permission, rather than a missing bucket. It is advisory only — the fix is
// the policy, not the message.
// ─────────────────────────────────────────────────────────────────────────────

/** The storage prefix holding a deal's files. The one place this is spelled. */
export function dealFolder(dealId) {
  return `deal-${dealId}`
}

const isMissingBucket = (message = '') =>
  /not found|does not exist|bucket not found/i.test(message)

const isDenied = (message = '') =>
  /permission|denied|unauthor|not authorized|violates row-level security|rls/i.test(message)

/**
 * Every file filed against a deal, newest first.
 *
 * Sub-folder entries (storage lists `print/` as an entry with no `id`) are
 * dropped: the `print/` prefix holds throwaway BoldSign review copies, and
 * showing it would put a fake "print" document in the deal's filing list.
 *
 * @returns {{ files: object[], error: string|null, bucketMissing: boolean, denied: boolean }}
 */
export async function listDealFiles(dealId) {
  const empty = { files: [], error: null, bucketMissing: false, denied: false }
  if (!dealId) return empty

  const { data, error } = await supabase.storage
    .from(BUCKETS.DEAL_DOCS)
    .list(dealFolder(dealId), { sortBy: { column: 'created_at', order: 'desc' } })

  if (error) {
    const message = error.message || 'Could not load this deal’s documents.'
    if (isMissingBucket(message)) return { ...empty, bucketMissing: true }
    return { ...empty, error: message, denied: isDenied(message) }
  }

  return {
    ...empty,
    files: (data || []).filter(f => f.id && f.name !== '.emptyFolderPlaceholder'),
  }
}
