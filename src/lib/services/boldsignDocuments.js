// ─────────────────────────────────────────────────────────────────────────────
// The e-signature rows the CRM keeps — boldsign_documents (one per packet sent),
// its per-packet timeline, the field layouts remembered per deal, and the
// Form Library templates that can be sent — read directly under RLS.
//
// Sending, voiding and status reads go through the API (boldsign.js); this
// module is only the CRM's own tables. Results come back as Supabase returns
// them so each screen keeps its own fallbacks for databases missing a migration.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { TABLES } from '../constants.js'
import { uploadSendablePdf, signSendableUrl } from './boldsign.js'

/** Every packet on a deal, newest first. */
export const fetchDealBoldsignDocuments = (dealId) =>
  supabase.from(TABLES.BOLDSIGN_DOCUMENTS).select('*').eq('deal_id', dealId).order('created_at', { ascending: false })

// boldsign_template_id is what ties a completed envelope to the state packet it
// satisfies — the closing gate needs nothing else.
export const fetchDealEnvelopesForGate = (dealId) =>
  supabase.from(TABLES.BOLDSIGN_DOCUMENTS)
    .select('id, status, document_name, boldsign_template_id').eq('deal_id', dealId)

/** The dashboard queue: packets in the given statuses, oldest send first. */
export const fetchSignatureQueueDocuments = (statuses) =>
  supabase
    .from(TABLES.BOLDSIGN_DOCUMENTS)
    .select('id, deal_id, document_id, document_name, signer_name, signers, status, sent_at, created_at, last_reminded_at, reminder_count')
    .in('status', statuses)
    .order('sent_at', { ascending: true, nullsFirst: false })
    .limit(100)

export const updateBoldsignDocument = (id, patch) =>
  supabase.from(TABLES.BOLDSIGN_DOCUMENTS).update(patch).eq('id', id)

// ── Realtime ─────────────────────────────────────────────────────────────────
// Both return an unsubscribe function for a React effect's cleanup.

/** Every insert/update/delete on one deal's packets. */
export function subscribeToDealBoldsignDocuments(dealId, onChange) {
  const channel = supabase.channel(`sig-documents-${dealId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'boldsign_documents',
      filter: `deal_id=eq.${dealId}`,
    }, onChange)
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}

/** Any change to any packet the viewer can see (the dashboard queue). */
export function subscribeToSignatureQueue(onChange) {
  const channel = supabase.channel('dash-signature-queue')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'boldsign_documents' }, onChange)
    .subscribe()
  return () => { supabase.removeChannel(channel) }
}

// ── Around the packets ───────────────────────────────────────────────────────

// deal_field_layouts is migration 0026; callers treat an error as "no layouts".
export const fetchDealFieldLayouts = (dealId) =>
  supabase
    .from('deal_field_layouts')
    .select('template_id, field_count, document_name, updated_at')
    .eq('deal_id', dealId)

// signature_packet_events is migration 0046; callers treat an error as "no timeline".
export const fetchPacketTimeline = (documentId) =>
  supabase
    .from('signature_packet_events')
    .select('id, event, status, signer_name, signer_email, occurred_at')
    .eq('document_id', documentId)
    .order('occurred_at', { ascending: false })
    .limit(50)

// ── Shared-client bindings of boldsign.js ────────────────────────────────────
// boldsign.js takes the client as an argument for these two; the send screen
// calls them through here instead of importing the client itself.

export const uploadSendableDealPdf = (args) => uploadSendablePdf(supabase, args)

export const signSendableDealUrl = (path) => signSendableUrl(supabase, path)
