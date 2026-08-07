// Translates Supabase/Postgres errors into plain-English, agent-friendly messages.
//
// Why this exists: when a form offers a value the live database doesn't allow
// yet (typically because a migration hasn't been applied), PostgREST surfaces a
// raw message like:
//   new row for relation "contacts" violates check constraint "contacts_status_check"
// That's meaningless to an agent. This maps the common Postgres error codes to a
// clear sentence that names the field and tells them what to do next.
//
// Postgres error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html

// Constraint name → the human-facing field it guards. Lets a check-constraint
// violation name the offending field instead of leaking the SQL constraint name.
const CONSTRAINT_FIELDS = {
  contacts_status_check:   'Status',
  contacts_source_check:   'Source',
  contacts_type_check:     'Type',
  properties_status_check: 'Status',
  properties_type_check:   'Type',
}

// Returns a friendly message string, or null if we have nothing better than the
// caller's own default (so callers can do `friendlyDbError(error) || error.message`).
export function friendlyDbError(error) {
  if (!error) return null
  const code = error.code
  const msg  = error.message || ''

  // 23514 = check_violation — almost always a form value the DB doesn't allow yet
  // (e.g. a new Status option whose migration hasn't reached this database).
  if (code === '23514' || /violates check constraint/i.test(msg)) {
    const m = msg.match(/check constraint "([^"]+)"/i)
    const field = m && CONSTRAINT_FIELDS[m[1]]
    if (field) {
      return `That ${field} value isn't accepted by the database yet. Pick a different ${field.toLowerCase()}, or ask an admin to apply the latest database migration.`
    }
    return "One of the values you entered isn't accepted by the database yet. Try a different option, or ask an admin to apply the latest database migration."
  }

  // 23505 = unique_violation
  if (code === '23505' || /duplicate key value/i.test(msg)) {
    if (/email/i.test(msg)) return 'A contact with this email already exists.'
    return 'This record already exists.'
  }

  // 23503 = foreign_key_violation
  if (code === '23503') {
    // A DELETE that trips this is the other direction from the usual case: rows
    // elsewhere still point AT the record being removed. That happens when a
    // referencing table's foreign key predates its `on delete` action — the
    // classic one being another agent's tasks on a shared deal, which RLS keeps
    // the deleting agent from clearing themselves. Name the blocking table so
    // the fix is one migration away rather than a mystery.
    // Postgres names two tables here — "update or delete on table "deals"
    // violates ... on table "tasks"". The BLOCKING one is the last, and it is
    // the only one the agent doesn't already know about.
    const named = [...msg.matchAll(/on table "([^"]+)"/gi)].map(m => m[1])
    const blocking = named.length > 1 ? named[named.length - 1] : null
    if (/still referenced|update or delete/i.test(msg)) {
      return `This can't be deleted yet — ${blocking ? `records in "${blocking}"` : 'other records'} still link to it, `
        + 'and some of them belong to another agent. Ask an admin to apply the latest database migration '
        + '(it makes those links clear themselves).'
    }
    return 'A linked record (such as the assigned agent) no longer exists. Refresh the page and try again.'
  }

  // 23502 = not_null_violation
  if (code === '23502') {
    const m = msg.match(/column "([^"]+)"/i)
    const col = m ? m[1].replace(/_/g, ' ') : null
    return col ? `"${col}" is required.` : 'A required field is missing.'
  }

  return null
}
