// ─────────────────────────────────────────────────────────────────────────────
// Cold calls service — call lists, their leads, and what a call produces.
//
// The Cold Calls page used to query cold_call_lists / cold_call_leads inline,
// along with the contact, property, activity and task rows a call or a
// conversion writes. Each function here is one of those queries, unchanged,
// and returns the Supabase result as-is so the page keeps its own control flow.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

// ── cold_call_lists ──────────────────────────────────────────────────────────

/** Every call list, newest first. A 42P01 error means the table isn't migrated. */
export const fetchColdCallLists = () =>
  supabase.from('cold_call_lists').select('*').order('created_at', { ascending: false })

/** Create a list and read the new row back. */
export const createColdCallList = (name, agentId) =>
  supabase
    .from('cold_call_lists').insert([{ name, agent_id: agentId }]).select().single()

export const deleteColdCallList = (listId) =>
  supabase.from('cold_call_lists').delete().eq('id', listId)

// ── cold_call_leads ──────────────────────────────────────────────────────────

/** A list's leads in import order. */
export const fetchColdCallLeads = (listId) =>
  supabase.from('cold_call_leads').select('*').eq('list_id', listId).order('created_at', { ascending: true })

export const insertColdCallLeads = (rows) =>
  supabase.from('cold_call_leads').insert(rows)

export const updateColdCallLead = (leadId, patch) =>
  supabase.from('cold_call_leads').update(patch).eq('id', leadId)

// ── rows a call or a conversion writes elsewhere ─────────────────────────────

/** Every contact's phone, for flagging imported leads as possible duplicates. */
export const fetchContactPhones = () =>
  // contacts stores a single phone (text), not a phones[] array.
  supabase.from('contacts').select('phone')

/** The property a converted lead was about; reads the new row back. */
export const insertColdCallProperty = (row) =>
  supabase.from('properties').insert([row]).select().single()

/** The call notes, logged on the new contact's timeline. */
export const insertColdCallActivity = (row) =>
  supabase.from('activities').insert([row])

/** A callback task; reads the new row back so its calendar event can sync. */
export const insertCallbackTask = (row) =>
  supabase.from('tasks').insert([row]).select().single()
