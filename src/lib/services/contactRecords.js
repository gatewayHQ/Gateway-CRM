// ─────────────────────────────────────────────────────────────────────────────
// Contact records — reads and writes on the `contacts` table for the Contacts
// page, its drawer and the CSV import.
//
// Each function returns the Supabase builder/result exactly as the screen used
// to build it, so callers keep their own error handling, toasts and retries.
// The dedupe-aware create path for conversions is upsertContact in contacts.js.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'
import { upsertContact } from './contacts.js'

/** One contact by id, or null when this agent can't see it. */
export const fetchContactById = (id) =>
  supabase.from('contacts').select('*').eq('id', id).maybeSingle()

/**
 * The live (not soft-deleted) contact book, newest first. Admins get the firm;
 * everyone else only the owners in `agentIds`.
 */
export function fetchLiveContacts({ isAdmin, agentIds }) {
  let q = supabase.from('contacts').select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
  if (!isAdmin) q = q.in('assigned_agent_id', agentIds)
  return q
}

/** Soft-delete: stamp deleted_at on every id. */
export const markContactsDeleted = (ids) =>
  supabase.from('contacts')
    .update({ deleted_at: new Date().toISOString() })
    .in('id', ids)

// Fallback for a database that has not been migrated to have `deleted_at`.
export const hardDeleteContacts = (ids) =>
  supabase.from('contacts').delete().in('id', ids)

/** Undo a soft-delete by clearing deleted_at. */
export const restoreContacts = (ids) =>
  supabase.from('contacts')
    .update({ deleted_at: null })
    .in('id', ids)

/** Set one column on one contact (inline table edits). */
export const updateContactField = (id, field, value) =>
  supabase.from('contacts').update({ [field]: value }).eq('id', id)

export const reassignContacts = (ids, agentId) =>
  supabase.from('contacts').update({ assigned_agent_id: agentId }).in('id', ids)

export const setContactsStatus = (ids, status) =>
  supabase.from('contacts').update({ status }).in('id', ids)

/** Bulk insert (CSV import chunks) — no read-back. */
export const insertContacts = (rows) =>
  supabase.from('contacts').insert(rows)

// Drawer saves. The plain variants don't read the row back — used for a handoff
// to another agent, whom RLS may then hide from this one. The readBack variants
// use maybeSingle() so a write whose RETURNING yields 0 rows isn't an error.
export const updateContact = (id, patch) =>
  supabase.from('contacts').update(patch).eq('id', id)

export const insertContact = (row) =>
  supabase.from('contacts').insert([row])

export const updateContactReadBack = (id, patch) =>
  supabase.from('contacts').update(patch).eq('id', id).select().maybeSingle()

export const insertContactReadBack = (row) =>
  supabase.from('contacts').insert([row]).select().maybeSingle()

/**
 * upsertContact (contacts.js) bound to the app's client — the dedupe-aware
 * create-or-fill path for quick-add and lead conversion. Same arguments and
 * result as upsertContact, minus the client.
 */
export const upsertContactRecord = (payload, existingRows, opts) =>
  upsertContact(supabase, payload, existingRows, opts)

/** Every contact's phone, for flagging imported cold-call leads as possible duplicates. */
export const fetchContactPhones = () =>
  // contacts stores a single phone (text), not a phones[] array.
  supabase.from('contacts').select('phone')

/** Contacts with the owner mailing address, for picking mailing recipients. */
export const fetchMailingContacts = () =>
  supabase.from('contacts').select('id, first_name, last_name, email, phone, owner_address, owner_city, owner_state, owner_zip').order('last_name')

/** Create a contact for a new signer and read back just enough to name them. */
export const createSignerContact = (row) =>
  supabase.from('contacts').insert([row]).select('id, first_name, last_name, email').single()
