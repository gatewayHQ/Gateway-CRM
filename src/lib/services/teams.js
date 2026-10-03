// ─────────────────────────────────────────────────────────────────────────────
// Teams service — the `teams` table and its `team_splits` membership rows.
//
// team_splits is the single source of truth for who is on a team (and at what
// split). Every function returns the raw PostgREST builder/result so callers
// keep their own error handling, toasts and retry wrappers (withRetry).
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

// ── teams ────────────────────────────────────────────────────────────────────

export const fetchTeams = () =>
  supabase.from('teams').select('*').order('name', { ascending: true })

export const createTeam = (team) =>
  supabase.from('teams').insert([team]).select().single()

export const updateTeam = (teamId, fields) =>
  supabase.from('teams').update(fields).eq('id', teamId).select().single()

export const deleteTeam = (teamId) =>
  supabase.from('teams').delete().eq('id', teamId)

// ── team_splits ──────────────────────────────────────────────────────────────

export const fetchTeamSplits = () =>
  supabase.from('team_splits').select('*')

export const upsertTeamSplits = (rows) =>
  supabase.from('team_splits').upsert(rows, { onConflict: 'team_id,agent_id' }).select()

export const deleteTeamSplitsForTeam = (teamId) =>
  supabase.from('team_splits').delete().eq('team_id', teamId)

export const deleteTeamSplitsForAgents = (teamId, agentIds) =>
  supabase.from('team_splits').delete().eq('team_id', teamId).in('agent_id', agentIds)
