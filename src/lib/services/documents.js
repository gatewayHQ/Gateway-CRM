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
