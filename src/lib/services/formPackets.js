/**
 * Form packet ↔ BoldSign template-id helpers.
 *
 * `form_packets.boldsign_template_id` is protected by a partial unique index
 * (`uq_form_packets_boldsign_tid`, migration 0019) — one CRM packet per BoldSign
 * template, nulls unconstrained. That index is correct and stays; what was
 * missing was everything around it:
 *
 *   • a pre-flight lookup, so a collision is reported as "already linked to
 *     <packet>" instead of a raw Postgres constraint string;
 *   • normalization, so a template id pasted with stray whitespace (or in a
 *     different case — BoldSign ids are hex GUIDs, so case carries no meaning)
 *     can't slip past an exact-match index and create a second row pointing at
 *     the same BoldSign template;
 *   • a conflict classifier both the UI and the nightly drift-sync cron can
 *     share, so an expected race (cron drafting an id an admin just linked)
 *     is skipped rather than swallowed.
 *
 * Deliberately client-agnostic — callers pass their own Supabase client, so this
 * module is importable from both the browser bundle and `api/` (Node).
 */

export const TID_CONSTRAINT = 'uq_form_packets_boldsign_tid'

/**
 * Canonical form of a pasted BoldSign template id: whitespace stripped (paste
 * from the BoldSign UI often carries a trailing newline/NBSP), empty → null so
 * the column stays NULL rather than '' (an empty string is a *value* and would
 * collide with every other blank packet under the unique index).
 */
export function normalizeTemplateId(raw) {
  if (raw == null) return null
  const cleaned = String(raw).replace(/[\s ]+/g, '')
  return cleaned || null
}

/** True when a Postgres/PostgREST error is the template-id uniqueness violation. */
export function isTemplateIdConflictError(error) {
  if (!error) return false
  const haystack = `${error.message || ''} ${error.details || ''} ${error.constraint || ''}`
  return error.code === '23505' && haystack.includes(TID_CONSTRAINT)
}

/**
 * Human, actionable message for a collision — names the packet that already
 * owns the id, and whether it's one of the nightly sync's auto-discovered
 * drafts (the usual culprit: a template built in BoldSign whose packet save
 * never completed, then auto-registered as an inactive row at 3am).
 */
export function describeTemplateIdConflict(templateId, row) {
  if (!row) {
    return `BoldSign template ${templateId} is already linked to another form packet. Find it in the Form Library and edit that packet instead of creating a second one.`
  }
  const where = [row.state, row.transaction_type].filter(Boolean).join(' · ')
  const bits = [where, row.active === false ? 'disabled' : null].filter(Boolean).join(', ')
  return `BoldSign template ${templateId} is already linked to the packet "${row.name}"${bits ? ` (${bits})` : ''}. Edit that packet instead — or clear the Template ID here to save this one as a plain form.`
}

/** Escape LIKE/ILIKE metacharacters (PostgREST also treats `*` as `%`). */
export function escapeLikePattern(value) {
  return String(value).replace(/[\\%_*]/g, m => `\\${m}`)
}

/**
 * Find the packet holding a template id, if any.
 *
 * Case-insensitive on purpose: the unique index is exact-match, so a re-paste
 * with different casing would otherwise sail through and leave two CRM packets
 * pointing at one BoldSign template — a silent duplicate that's worse than the
 * loud constraint error. `excludeId` skips the row being edited.
 *
 * Returns `{ row, error }`; a lookup error is non-fatal (the index is still the
 * backstop) and the caller decides whether to proceed.
 */
export async function findPacketByTemplateId(supabase, templateId, { excludeId } = {}) {
  const tid = normalizeTemplateId(templateId)
  if (!tid) return { row: null, error: null }
  let q = supabase
    .from('form_packets')
    .select('id, name, state, transaction_type, active, boldsign_template_id')
    // ilike takes a *pattern* — neutralize wildcards so an id can only ever
    // match itself (BoldSign ids are GUIDs, but never trust the paste buffer).
    .ilike('boldsign_template_id', escapeLikePattern(tid))
    .limit(2)
  if (excludeId) q = q.neq('id', excludeId)
  const { data, error } = await q
  if (error) return { row: null, error }
  return { row: (data && data[0]) || null, error: null }
}
