import { supabase } from './supabase.js'

// ─── Event registry ───────────────────────────────────────────────────────────
// Single source of truth for all outbound webhook event IDs + labels.

export const WEBHOOK_EVENTS = [
  { id: 'contact.created',    label: 'Contact Created' },
  { id: 'contact.updated',    label: 'Contact Updated' },
  { id: 'deal.created',       label: 'Deal Created' },
  { id: 'deal.stage_changed', label: 'Deal Stage Changed' },
  { id: 'deal.closed',        label: 'Deal Closed' },
  { id: 'task.completed',     label: 'Task Completed' },
  { id: 'property.added',     label: 'Property Added' },
  { id: 'lead.captured',      label: 'Website Lead Captured' },
  { id: 'radius_sync',        label: 'Radius Mailing Synced to Mailchimp' },
]

// ─── Fire webhooks ────────────────────────────────────────────────────────────
// Fetches all active webhook configs that subscribe to `event`, then POSTs
// the payload to each URL in parallel. Errors per webhook are swallowed so one
// bad URL never breaks a CRM action.

export async function fireWebhooks(event, data = {}) {
  try {
    const { data: configs, error } = await supabase
      .from('webhook_configs')
      .select('id, name, url')
      .eq('active', true)
      .contains('events', [event])

    if (error || !configs?.length) return

    const payload = { event, timestamp: new Date().toISOString(), source: 'gateway-crm', data }
    const body    = JSON.stringify(payload)

    // Fire all subscribers in parallel; record each result. The delivery log
    // (migration 0019) lets admins see at a glance which subscribers are
    // failing — previously a 500 from the destination was a console.warn that
    // disappeared into the ether.
    await Promise.allSettled(configs.map(async cfg => {
      const startedAt = Date.now()
      let result
      try {
        const r = await fetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })
        result = { ok: r.ok, status_code: r.status, error: r.ok ? null : `HTTP ${r.status} ${r.statusText || ''}`.trim() }
      } catch (err) {
        result = { ok: false, status_code: null, error: err?.message || 'Network error' }
        console.warn(`[webhook] "${cfg.name}" failed:`, err.message)
      }
      // Best-effort log write. A logging failure shouldn't crash the firer.
      supabase.from('webhook_deliveries').insert({
        webhook_id:  cfg.id,
        event,
        payload,
        status_code: result.status_code,
        ok:          result.ok,
        error:       result.error,
        duration_ms: Date.now() - startedAt,
      }).then(() => {}).catch(() => {})
    }))
  } catch (err) {
    // Never let webhook errors bubble up to the calling CRM action
    console.warn('[fireWebhooks] error:', err.message)
  }
}
