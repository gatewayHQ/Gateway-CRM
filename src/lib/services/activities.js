// ─────────────────────────────────────────────────────────────────────────────
// Activities service — the timeline of notes, calls, emails, meetings and
// showings logged against contacts and deals.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

/** Log one activity and read the saved row back. */
export const createActivity = (activity) =>
  supabase.from('activities').insert([activity]).select().single()

/** Log one activity without reading it back (call notes, sent emails). */
export const logActivity = (activity) =>
  supabase.from('activities').insert([activity])

/** Every activity the caller can see, newest first (the boot load pages through it). */
export const fetchActivities = () =>
  supabase.from('activities').select('*').order('created_at', { ascending: false })
