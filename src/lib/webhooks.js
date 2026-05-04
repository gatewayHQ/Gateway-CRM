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

    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      source: 'gateway-crm',
      data,
    })

    await Promise.allSettled(
      configs.map(cfg =>
        fetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).catch(err => console.warn(`[webhook] "${cfg.name}" failed:`, err.message))
      )
    )
  } catch (err) {
    // Never let webhook errors bubble up to the calling CRM action
    console.warn('[fireWebhooks] error:', err.message)
  }
}
