// ─────────────────────────────────────────────────────────────────────────────
// Sequences service — drip sequences, their steps, and who is enrolled.
//
// The Sequences page used to query sequences / sequence_steps /
// contact_sequences inline. Each function here is one of those queries,
// unchanged, and returns the Supabase result as-is so the page keeps its own
// error handling and toasts.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

// ── sequences ────────────────────────────────────────────────────────────────

/** Every sequence the caller can see, with its steps, newest first. */
export const fetchSequencesWithSteps = () =>
  supabase.from('sequences')
    .select('*, sequence_steps(*)').order('created_at', { ascending: false })

/** Create a sequence and read the new row back. */
export const insertSequence = (row) =>
  supabase.from('sequences')
    .insert([row]).select().single()

/** One auto-start sequence per lane per agent: free the lane on the agent's other sequences. */
export const clearAutoEnrollLane = (agentId, lane, exceptSequenceId) =>
  supabase.from('sequences').update({ auto_enroll_lane: null })
    .eq('agent_id', agentId).eq('auto_enroll_lane', lane).neq('id', exceptSequenceId)

export const updateSequence = (sequenceId, patch) =>
  supabase.from('sequences').update(patch).eq('id', sequenceId)

export const deleteSequenceById = (sequenceId) =>
  supabase.from('sequences').delete().eq('id', sequenceId)

/** Take ownership of an unowned (pre-migration) sequence. */
export const claimSequence = (sequenceId, agentId) =>
  supabase.from('sequences').update({ agent_id: agentId }).eq('id', sequenceId)

// ── sequence_steps ───────────────────────────────────────────────────────────

export const insertSequenceSteps = (rows) =>
  supabase.from('sequence_steps').insert(rows)

export const deleteSequenceSteps = (sequenceId) =>
  supabase.from('sequence_steps').delete().eq('sequence_id', sequenceId)

// ── contact_sequences (enrollments) ──────────────────────────────────────────

/** Enrollments in one sequence with the contact's name/email, newest first. */
export const fetchSequenceEnrollments = (sequenceId) =>
  supabase.from('contact_sequences')
    .select('*, contacts(first_name,last_name,email)')
    .eq('sequence_id', sequenceId)
    .order('started_at', { ascending: false })

/** Enroll contacts; returns the new enrollment ids. */
export const insertEnrollments = (rows) =>
  supabase.from('contact_sequences').insert(rows).select('id')

export const updateEnrollment = (enrollmentId, patch) =>
  supabase.from('contact_sequences').update(patch).eq('id', enrollmentId)
