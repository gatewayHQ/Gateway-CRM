// ─────────────────────────────────────────────────────────────────────────────
// Mass-email send history (email_blasts) and each send's recipients, for the
// report under Mass Email.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

/** The most recent sends the caller can see, newest first. */
export const fetchRecentEmailBlasts = (limit) =>
  supabase
    .from('email_blasts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)

/** One send's recipients with the given columns, grouped by status. */
export const fetchBlastRecipients = (blastId, columns) =>
  supabase
    .from('email_blast_recipients')
    .select(columns)
    .eq('blast_id', blastId)
    .order('status', { ascending: true })
