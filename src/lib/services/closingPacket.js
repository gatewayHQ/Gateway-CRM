// ─────────────────────────────────────────────────────────────────────────────
// Closing packet client — thin wrapper around POST /api/boldsign
//   { action: 'closing-packet', deal_id }
//
// Centralizes the auth-header dance and the signed-URL fetch so DealPage
// (and any future admin tool that wants to regenerate a packet) doesn't
// duplicate that plumbing.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { signClosingPacketUrl } from './documents.js'
import { TABLES } from '../constants.js'

/**
 * Generate a closing packet for the given deal. Admin-only — the server
 * verifies. Returns { ok, doc_count, storage_path, packet_id } on success.
 */
export async function generateClosingPacket(dealId) {
  if (!dealId) return { ok: false, error: 'deal_id required' }
  const { data: { session } } = await supabase.auth.getSession()
  if (!session?.access_token) return { ok: false, error: 'Sign in required' }

  const res = await fetch('/api/boldsign', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body:    JSON.stringify({ action: 'closing-packet', deal_id: dealId }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, error: body?.error || `HTTP ${res.status}` }
  return { ok: true, ...body }
}

/** Recent packets for a deal. Newest first. */
export async function listClosingPackets(dealId, { limit = 5 } = {}) {
  const { data, error } = await supabase
    .from(TABLES.CLOSING_PACKETS)
    .select('*')
    .eq('deal_id', dealId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return { packets: data || [], error: error?.message || null }
}

/** Open a packet in a new tab via a signed storage URL. */
export async function openClosingPacket(storagePath) {
  const { url, error } = await signClosingPacketUrl(storagePath, 120)
  if (!url) return { ok: false, error: error || 'Could not open packet' }
  window.open(url, '_blank', 'noopener')
  return { ok: true }
}
