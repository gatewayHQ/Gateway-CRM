// ─────────────────────────────────────────────────────────────────────────────
// Templates service — saved email templates and the sends that use them.
//
// The Templates and Mass Email pages used to query the templates table inline.
// Each function here is one of those queries, unchanged, and returns the
// Supabase result as-is so the pages keep their own error handling and toasts.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

// ── templates ────────────────────────────────────────────────────────────────

/** Every template, newest first. */
export const fetchTemplates = () =>
  supabase.from('templates').select('*').order('created_at', { ascending: false })

export const createTemplate = (row) =>
  supabase.from('templates').insert([row])

export const updateTemplate = (templateId, patch) =>
  supabase.from('templates').update(patch).eq('id', templateId)

export const deleteTemplate = (templateId) =>
  supabase.from('templates').delete().eq('id', templateId)

/** Record a use of a template; the caller passes the already-incremented count. */
export const updateTemplateUsageCount = (templateId, usageCount) =>
  supabase.from('templates').update({ usage_count: usageCount }).eq('id', templateId)

// ── activities ───────────────────────────────────────────────────────────────

/** Log an email sent from a template on the contact's timeline. */
export const insertEmailActivity = (row) =>
  supabase.from('activities').insert([row])
