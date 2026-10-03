// ─────────────────────────────────────────────────────────────────────────────
// Lead rotation (round-robin) tables — `lead_rotation_members` and
// `lead_rotations` (migration 0037).
//
// The ordering / next-up logic lives in lib/leadRotation.js; this module is only
// the data access the Round Robin admin panel needs. Results are returned raw so
// the panel can detect a missing table from `error`.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

export const fetchLeadRotationMembers = () =>
  supabase.from('lead_rotation_members').select('*')

export const fetchLeadRotations = () =>
  supabase.from('lead_rotations').select('*')

export const setLeadRotationMemberActive = (lane, agentId, active) =>
  supabase.from('lead_rotation_members').update({ active }).eq('lane', lane).eq('agent_id', agentId)

export const deleteLeadRotationMember = (lane, agentId) =>
  supabase.from('lead_rotation_members').delete().eq('lane', lane).eq('agent_id', agentId)

// Add or reorder members; (lane, agent_id) is the natural key.
export const upsertLeadRotationMembers = (rows) =>
  supabase.from('lead_rotation_members').upsert(rows, { onConflict: 'lane,agent_id' })
