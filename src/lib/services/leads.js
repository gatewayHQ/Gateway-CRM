// ─────────────────────────────────────────────────────────────────────────────
// Leads service — what the public website feeds the Leads page: visitor
// events, lead-capture form submissions, and round-robin inquiries
// (migration 0037), plus linking a capture to the contact it became.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

export const fetchVisitorEvents = () =>
  supabase.from('visitor_events').select('*').order('created_at', { ascending: false })

export const fetchLeadCaptures = () =>
  supabase.from('lead_captures').select('*').order('created_at', { ascending: false })

/** The 300 newest round-robin inquiries with the listings each one viewed. */
export const fetchRecentLeadInquiries = () =>
  supabase.from('leads')
    .select('*, lead_property_views(title, url, position)')
    .order('created_at', { ascending: false }).limit(300)

/** Record which contact a website capture was converted into. */
export const linkLeadCaptureToContact = (captureId, contactId) =>
  supabase.from('lead_captures').update({ converted_contact_id: contactId }).eq('id', captureId)
