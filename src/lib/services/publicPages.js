// ─────────────────────────────────────────────────────────────────────────────
// Public (signed-out) page reads — the anon-key queries behind /lp/*, the
// advisor profile and the lead-capture page.
//
// These run WITHOUT a session, so they may only touch what anon can read:
// `agents_public` (the column-limited view granted to anon in 0027 §4), never
// `agents` or any table 0027 closed to anon. Mailings and properties come from
// the service-key helpers in lib/publicMailing.js / lib/publicProperty.js.
// src/lib/__tests__/publicPageDataAccess.test.js scans this module along with
// the pages that import it.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

// ── Landing-page advisor cards (/lp/*) ───────────────────────────────────────

// Include bio; callers fall back to fetchPublicAgentsLegacy if that migration
// (0004) hasn't run yet (selecting a missing column would otherwise error).
export const fetchPublicAgents = (ids) =>
  supabase.from('agents_public')
    .select('id, name, phone, email, photo_url, color, role, bio')
    .in('id', ids)

// The pre-0004 column set.
export const fetchPublicAgentsLegacy = (ids) =>
  supabase.from('agents_public')
    .select('id, name, phone, email, photo_url, color, role')
    .in('id', ids)

// ── Advisor profile (/advisor/:id) ───────────────────────────────────────────

// The full column set; callers fall back to fetchPublicAdvisorLegacy if
// migrations 0004/0006 haven't run.
export const fetchPublicAdvisor = (agentId) =>
  supabase.from('agents_public')
    .select('id, name, role, tagline, bio, photo_url, color, phone, email, stats')
    .eq('id', agentId).maybeSingle()

export const fetchPublicAdvisorLegacy = (agentId) =>
  supabase.from('agents_public')
    .select('id, name, role, photo_url, color, phone, email')
    .eq('id', agentId).maybeSingle()

// ── Lead capture page ────────────────────────────────────────────────────────

export const fetchLeadCaptureAgent = (agentId) =>
  supabase.from('agents_public').select('id, name, role, tagline, bio, photo_url, color, phone, email, stats').eq('id', agentId).single()
