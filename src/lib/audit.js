// ─────────────────────────────────────────────────────────────────────────────
// Audit log helper — write-once, never breaks the user's action.
//
// Every material change in the app should call logAudit() AFTER the underlying
// row was saved. The log row is best-effort: if the insert fails we swallow
// it (logged to the console). The user's primary write already succeeded; the
// audit row is observability, not a guard.
//
// Read with useDealAudit() which subscribes via supabase realtime so the
// timeline updates without polling.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase.js'

/**
 * Write an audit entry. Returns the inserted row or null.
 * - `table_name`/`record_id` identify the affected row
 * - `deal_id` is denormalized so the deal's timeline reads from one index
 * - `summary` is the human-readable line shown in the UI
 */
export async function logAudit({ table_name, record_id = null, deal_id = null, actor_id = null, action, old_values = null, new_values = null, summary = null }) {
  try {
    const { data, error } = await supabase.from('audit_log').insert([{
      table_name, record_id, deal_id, actor_id, action,
      old_values, new_values, summary,
    }]).select().single()
    if (error) {
      if (typeof console !== 'undefined') console.warn('[audit] insert failed', error.message)
      return null
    }
    return data
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[audit] insert threw', e?.message)
    return null
  }
}

// Convenience writers — opinionated summaries so callers don't reinvent them.
export const audit = {
  stageChange: (deal, fromStage, toStage, actorId) => logAudit({
    table_name: 'deals', record_id: deal.id, deal_id: deal.id, actor_id: actorId,
    action: 'stage',
    old_values: { stage: fromStage }, new_values: { stage: toStage },
    summary: `Stage moved ${fromStage} → ${toStage}`,
  }),
  documentUploaded: (deal, filename, actorId, source = 'upload') => logAudit({
    table_name: 'documents', deal_id: deal.id, actor_id: actorId,
    action: 'insert', new_values: { name: filename, source },
    summary: `Uploaded "${filename}"`,
  }),
  documentPinned: (deal, filename, pinKind, actorId) => logAudit({
    table_name: 'document_versions', deal_id: deal.id, actor_id: actorId,
    action: 'pin', new_values: { document_name: filename, pinned_as: pinKind },
    summary: `Pinned "${filename}" as ${pinKind}`,
  }),
  documentSigned: (deal, filename, signerName) => logAudit({
    table_name: 'boldsign_documents', deal_id: deal.id,
    action: 'doc_signed', new_values: { document_name: filename, signer: signerName },
    summary: `"${filename}" signed by ${signerName || 'signer'}`,
  }),
  reviewSubmitted: (deal, actorId) => logAudit({
    table_name: 'deals', record_id: deal.id, deal_id: deal.id, actor_id: actorId,
    action: 'review_submit', new_values: { review_status: 'pending' },
    summary: 'Submitted to admin for review',
  }),
  reviewApproved: (deal, actorId, notes = null) => logAudit({
    table_name: 'deals', record_id: deal.id, deal_id: deal.id, actor_id: actorId,
    action: 'review_approve', new_values: { review_status: 'approved', notes },
    summary: notes ? `Admin approved: ${notes}` : 'Admin approved for closing',
  }),
  reviewChanges: (deal, actorId, notes) => logAudit({
    table_name: 'deals', record_id: deal.id, deal_id: deal.id, actor_id: actorId,
    action: 'review_changes', new_values: { review_status: 'changes_requested', notes },
    summary: `Admin requested changes: ${notes || '(no notes)'}`,
  }),
  packetGenerated: (deal, docCount, actorId) => logAudit({
    table_name: 'closing_packets', deal_id: deal.id, actor_id: actorId,
    action: 'packet_generated', new_values: { doc_count: docCount },
    summary: `Closing packet generated (${docCount} document${docCount === 1 ? '' : 's'})`,
  }),
  commissionEdited: (deal, actorId) => logAudit({
    table_name: 'commissions', deal_id: deal.id, actor_id: actorId,
    action: 'update',
    summary: 'Commission updated',
  }),
  stepToggled: (deal, step, actorId) => logAudit({
    table_name: 'transaction_steps', record_id: step.id, deal_id: deal.id, actor_id: actorId,
    action: 'update', new_values: { title: step.title, completed: !step.completed },
    summary: `Checklist: "${step.title}" marked ${!step.completed ? 'done' : 'open'}`,
  }),
}

// React hook — load + realtime subscribe to a deal's audit log.
export function useDealAudit(dealId) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const load = useCallback(async () => {
    if (!dealId) { setRows([]); return }
    setLoading(true)
    const { data, error } = await supabase.from('audit_log')
      .select('*')
      .eq('deal_id', dealId)
      .order('created_at', { ascending: false })
      .limit(100)
    setLoading(false)
    if (!error) setRows(data || [])
  }, [dealId])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!dealId) return
    const ch = supabase.channel(`audit-${dealId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_log', filter: `deal_id=eq.${dealId}` }, payload => {
        setRows(r => [payload.new, ...r])
      }).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [dealId])
  return { rows, loading, refresh: load }
}
