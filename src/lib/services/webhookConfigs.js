// ─────────────────────────────────────────────────────────────────────────────
// Outbound webhook configs (`webhook_configs`) — managed on Integrations →
// Webhooks. Results are returned raw so the page keeps its own toasts.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

export const fetchWebhookConfigs = () =>
  supabase.from('webhook_configs').select('*').order('created_at', { ascending: true })

export const createWebhookConfig = (config) =>
  supabase
    .from('webhook_configs')
    .insert([config])
    .select()
    .single()

export const setWebhookConfigActive = (id, active) =>
  supabase.from('webhook_configs').update({ active }).eq('id', id)

export const deleteWebhookConfig = (id) =>
  supabase.from('webhook_configs').delete().eq('id', id)
