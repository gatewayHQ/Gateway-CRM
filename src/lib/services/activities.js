// ─────────────────────────────────────────────────────────────────────────────
// Activities service — the contact timeline (notes, calls, emails, meetings,
// showings) logged from the contact drawer.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

/** Log one activity and read the saved row back. */
export const createActivity = (activity) =>
  supabase.from('activities').insert([activity]).select().single()
