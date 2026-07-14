// ─────────────────────────────────────────────────────────────────────────────
// Data-access helpers shared by every write path.
//
// Before this, each component re-implemented the same three things inline:
//   1. detecting a transient network failure,
//   2. retrying it with backoff, and
//   3. turning the resulting error into a user-facing message.
// Drift between those copies meant some saves retried and some didn't, and some
// showed raw Postgres text while others showed friendly messages. Centralizing
// them here keeps every mutation consistent and reduces spurious failures.
// ─────────────────────────────────────────────────────────────────────────────
import { friendlyDbError } from '../dbErrors.js'

// A transport-level failure (status 0 / "Failed to fetch") means the request
// never reached the server — transient network, offline, or a blocking browser
// extension. Worth retrying; PostgREST/validation errors (4xx/5xx) are not.
export const isTransportError = (error, status) =>
  status === 0 ||
  /failed to fetch|fetcherror|networkerror|network request failed|load failed/i.test(error?.message || '')

// Retry a Supabase write on transient transport errors, with exponential
// backoff. `run` returns a PostgREST result ({ data, error, status }); the last
// result is returned whether it ultimately succeeded or failed.
export async function withRetry(run, attempts = 3) {
  let res
  for (let i = 0; i < attempts; i++) {
    res = await run()
    if (!res.error || !isTransportError(res.error, res.status)) return res
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 400 * 2 ** i))
  }
  return res
}

// The user-facing message for a failed write: network guidance for transport
// errors, then the friendly constraint/duplicate/etc. mapping, then the raw
// message, then a generic fallback.
export function mutationErrorMessage(error, status, fallback = 'Something went wrong — please try again.') {
  if (isTransportError(error, status)) {
    return "Couldn't reach the server — check your connection and try again. If you use an ad or privacy blocker, allow this site."
  }
  return friendlyDbError(error) || error?.message || fallback
}

// Replace the additional-contact link rows for one deal/property (tables
// deal_contacts / property_contacts, migration 0018). The link set is small and
// fully derived from the form's selection, so delete-then-insert is simpler and
// safer than diffing. Returns the fresh rows so callers can patch local state.
export async function replaceLinkedContacts(client, table, fkColumn, ownerId, contactIds = []) {
  const { error: delError } = await client.from(table).delete().eq(fkColumn, ownerId)
  if (delError) return { rows: [], error: delError }
  const unique = [...new Set(contactIds.filter(Boolean))]
  if (!unique.length) return { rows: [], error: null }
  const { data, error } = await client
    .from(table)
    .insert(unique.map(contact_id => ({ [fkColumn]: ownerId, contact_id })))
    .select()
  return { rows: data || [], error }
}
