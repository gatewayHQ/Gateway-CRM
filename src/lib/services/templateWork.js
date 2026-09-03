// ─────────────────────────────────────────────────────────────────────────────
// Template work-in-progress — the prepare screen, saved.
//
// WHAT THIS FIXES. "Prepare from Template" is a real piece of work: an agent
// picks the signers, ticks the boxes that make up the terms of the agreement,
// corrects the buyer's name, opens Send options and adds the lender. All of it
// lived in React state and nowhere else. Close the modal — the X, Escape, the
// backdrop, Cancel, a reload — and every one of those decisions was gone, with
// no warning that anything was being thrown away. The next time the same
// template was opened on the same deal it re-seeded from the deal and the agent
// started again.
//
// That is the complaint this module answers: an agent must be able to work on a
// packet that is not needed yet, leave, and come back to exactly what they had.
//
// TWO THINGS ARE SAVED, and they are not the same thing:
//
//   1. The BoldSign DRAFT — a real document on the Signatures tab, with every
//      value already written into it. That is api/boldsign.js `template-draft`
//      and it already existed; what was missing is that it only happened when
//      the agent pressed one of the two buttons at the bottom of the screen.
//
//   2. This — the SCREEN's own state. The draft is a snapshot BoldSign holds;
//      the prepare screen is where the choices are made, and reopening it has
//      to bring back the radio buttons and the tri-state tick boxes, not just
//      the document they produced. Without this half, "reopen the draft" means
//      going back into BoldSign's editor, where (as the modal itself says)
//      anything typed is a preview that never reaches the signers.
//
// SCOPED TO (deal, template), exactly like deal_field_layouts and for the same
// reason: the arrangement of one deal's packet must never rewrite the
// brokerage-wide form every other deal sends from.
//
// A TEMPLATE CAN CHANGE UNDER A SAVE. Fields get renamed, boxes get deleted,
// roles get added. So a restore is a MERGE onto a freshly seeded screen and
// never a replacement of it: anything the current template no longer has is
// dropped rather than resurrected, and anything it has gained arrives seeded
// from the deal. See applySavedTemplateWork.
//
// Pure except for readTemplateWork / saveTemplateWork / clearTemplateWork /
// isUnsentDraft, which are the only functions here that touch Supabase — and
// each takes the client as an argument (defaulting to the app's), so the query
// each one builds is testable without a database. Same pattern as deals.js.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from '../supabase.js'

/** Bumped only for a change no merge can absorb; older rows are still read. */
export const TEMPLATE_WORK_VERSION = 1

const TABLE = 'deal_template_drafts'

// Send options travel with the rest because BoldSign fixes them when the
// document is CREATED — an agent who set a 7-day expiry and a CC to the lender
// before leaving must not come back to a screen that has forgotten both and
// then create the draft without them.
const OPTION_KEYS = ['inOrder', 'subject', 'message', 'cc', 'expiryDays']

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

// Key order must not decide whether two states count as equal — `values` is
// rebuilt by every keystroke and its insertion order follows the typing.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (isObj(value)) {
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = stable(value[k])
    return out
  }
  // null and '' are the same answer on this screen ("nothing here"), and the
  // seed writes one where a restore may write the other. Treated as equal so a
  // reopened screen is not reported as edited before it has been touched.
  if (value === null || value === undefined) return ''
  return value
}

const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b))

/**
 * The prepare screen as a plain, storable object.
 * Everything the two buttons at the bottom read, and nothing else.
 */
export function serializeTemplateWork({
  signers = {}, values = {}, selections = {}, panelState = {},
  inOrder = true, subject = '', message = '', cc = [], expiryDays = '',
} = {}) {
  return {
    version: TEMPLATE_WORK_VERSION,
    signers: Object.fromEntries(Object.entries(signers).map(([idx, s]) => [String(idx), {
      name:  String(s?.name  ?? ''),
      email: String(s?.email ?? ''),
    }])),
    // A tick box the panel does not own is TRI-STATE — true, false, or null for
    // "as the form is set up" — and null is a real answer, not a missing one, so
    // it is stored rather than stripped.
    values:     { ...values },
    selections: { ...selections },
    panelState: { ...panelState },
    inOrder:    Boolean(inOrder),
    subject:    String(subject ?? ''),
    message:    String(message ?? ''),
    cc:         Array.isArray(cc) ? cc.filter(Boolean).map(String) : [],
    expiryDays: String(expiryDays ?? ''),
  }
}

/**
 * WHAT THE AGENT CHANGED, compared with what seeding put on the screen.
 *
 * This is what decides whether closing is allowed to be silent. Opening the
 * screen and closing it again has to close, with no dialog — a confirm on every
 * close is a confirm nobody reads, and the seeded values are not the agent's
 * work. Anything they actually touched is.
 *
 * Returns the field ids / role indices that differ, so the prompt can say how
 * much is at stake rather than "unsaved changes".
 */
export function templateWorkEdits({ current, seeded } = {}) {
  const a = serializeTemplateWork(current || {})
  const b = serializeTemplateWork(seeded  || {})
  const changedKeys = (x = {}, y = {}) =>
    [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(k => !same(x[k], y[k])).sort()

  const values     = changedKeys(a.values,     b.values)
  const selections = changedKeys(a.selections, b.selections)
  const panel      = changedKeys(a.panelState, b.panelState)
  const signers    = changedKeys(a.signers,    b.signers)
  const options    = OPTION_KEYS.filter(k => !same(a[k], b[k]))
  return {
    values, selections, panel, signers, options,
    count: values.length + selections.length + panel.length + signers.length + options.length,
  }
}

/** Has the agent typed, ticked or chosen anything the seed did not put there? */
export function hasTemplateWorkEdits(args) {
  return templateWorkEdits(args).count > 0
}

/**
 * Restore a save onto a freshly seeded screen.
 *
 * A MERGE, never a replacement — see the header. `fields` and `roles` are the
 * template AS IT IS NOW, and they are the filter: a saved value for a field
 * that has since been deleted is dropped, because writing it back would send a
 * payload addressing a field BoldSign no longer has (which the API rejects
 * outright — see assertPayloadFieldsExist).
 *
 * `selections` and `panelState` are filtered against the SEEDED state rather
 * than the field list: both are keyed by things the screen derives (a tick-box
 * row the panel doesn't own, a panel group), so "is this key still on the
 * screen" is the only question that matters and the seed is the answer.
 *
 * Returns the merged state plus a count of what actually came back, so the
 * screen can say so instead of silently differing from the template.
 */
export function applySavedTemplateWork({ saved, seeded, fields = [], roles = [] } = {}) {
  const base = {
    signers:    { ...(seeded?.signers    || {}) },
    values:     { ...(seeded?.values     || {}) },
    selections: { ...(seeded?.selections || {}) },
    panelState: { ...(seeded?.panelState || {}) },
    inOrder:    seeded?.inOrder === undefined ? true : Boolean(seeded.inOrder),
    subject:    seeded?.subject ?? '',
    message:    seeded?.message ?? '',
    cc:         Array.isArray(seeded?.cc) ? [...seeded.cc] : [],
    expiryDays: seeded?.expiryDays ?? '',
  }
  const empty = { state: base, restored: { values: 0, selections: 0, panel: 0, signers: 0, options: 0, count: 0 }, dropped: [] }
  if (!isObj(saved)) return empty

  const work        = serializeTemplateWork(saved)
  const fieldIds    = new Set((fields || []).map(f => String(f?.id ?? '')).filter(Boolean))
  const roleIndices = new Set((roles || []).map(r => String(r?.index ?? '')).filter(Boolean))
  const restored    = { values: 0, selections: 0, panel: 0, signers: 0, options: 0, count: 0 }
  const dropped     = []

  const overlay = (into, from, allowed, bucket) => {
    for (const [k, v] of Object.entries(from)) {
      if (!allowed(k)) { dropped.push(k); continue }
      if (same(into[k], v)) continue
      into[k] = v
      restored[bucket] += 1
    }
  }

  overlay(base.values,     work.values,     k => fieldIds.has(k),                     'values')
  overlay(base.selections, work.selections, k => k in base.selections || fieldIds.has(k), 'selections')
  overlay(base.panelState, work.panelState, k => k in base.panelState,                'panel')

  for (const [idx, signer] of Object.entries(work.signers)) {
    // A role the template has since removed cannot be restored: buildTemplateRoles
    // keys on the live role list and would send a signer for a role that is gone.
    if (roleIndices.size && !roleIndices.has(idx)) { dropped.push(`role:${idx}`); continue }
    const merged = { ...(base.signers[idx] || {}), ...signer }
    if (same(base.signers[idx], merged)) continue
    base.signers[idx] = merged
    restored.signers += 1
  }

  for (const k of OPTION_KEYS) {
    if (work[k] === undefined || same(base[k], work[k])) continue
    base[k] = work[k]
    restored.options += 1
  }

  restored.count = restored.values + restored.selections + restored.panel + restored.signers + restored.options
  return { state: base, restored, dropped }
}

/**
 * How many of the packet's own blanks carry a value. Shown on the save, so the
 * row on the Signatures tab and the banner on this screen agree about how much
 * of the form is filled in.
 */
export function countFilledWork(work) {
  const w = serializeTemplateWork(work || {})
  const filled = Object.values(w.values).filter(v => String(v ?? '').trim() !== '').length
  const ticked = Object.values(w.selections).filter(v => v !== null && v !== undefined).length
  return filled + ticked
}

/** "3 boxes and the buyer's name" is beyond us; a plain count is not. */
export function describeTemplateWorkEdits(edits) {
  if (!edits || !edits.count) return ''
  const parts = []
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  if (edits.values.length)     parts.push(plural(edits.values.length, 'filled-in value', 'filled-in values'))
  if (edits.selections.length + edits.panel.length) {
    parts.push(plural(edits.selections.length + edits.panel.length, 'box or term', 'boxes and terms'))
  }
  if (edits.signers.length)    parts.push(plural(edits.signers.length, 'signer', 'signers'))
  if (edits.options.length)    parts.push('your send options')
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

// ── Supabase ────────────────────────────────────────────────────────────────
// Read directly from the client, RLS-scoped, exactly as the Signatures tab
// already reads deal_field_layouts: this is the agent's own in-progress work on
// a deal they can see, and routing it through /api/boldsign would add a hop
// without adding a check.

/** The saved work for (deal, template), or null. Never throws. */
export async function readTemplateWork({ dealId, templateId, client = supabase }) {
  if (!dealId) return null
  const { data, error } = await client
    .from(TABLE)
    .select('id, deal_id, template_id, template_name, work, field_count, document_id, updated_at')
    .eq('deal_id', dealId)
    .eq('template_id', templateId || '')
    .maybeSingle()
  if (error) {
    // A database that has not run migration 0044 yet must not break the send
    // screen — the packet is still perfectly preparable, it just won't remember
    // anything. Same reasoning as the field-layout restore.
    console.warn(`[boldsign] could not read saved template work: ${error.message}`)
    return null
  }
  return data || null
}

/**
 * Write the work for (deal, template). One row per pair, upserted, so an agent
 * who saves five times has one save and not five.
 *
 * `documentId` is the BoldSign draft this work last produced, when it produced
 * one. It is what lets the next save supersede that draft instead of leaving a
 * second half-finished row on the Signatures tab.
 */
export async function saveTemplateWork({ dealId, templateId, templateName, work, documentId = null, agentId = null, client = supabase }) {
  if (!dealId) throw new Error('A deal is needed to save work on a template')
  const payload = {
    deal_id:       dealId,
    template_id:   templateId || '',
    template_name: templateName || null,
    work:          serializeTemplateWork(work),
    field_count:   countFilledWork(work),
    document_id:   documentId,
    saved_by:      agentId || null,
    updated_at:    new Date().toISOString(),
  }
  const { data, error } = await client
    .from(TABLE)
    .upsert([payload], { onConflict: 'deal_id,template_id' })
    .select('id, document_id, field_count, updated_at')
    .single()
  if (error) throw new Error(error.message)
  return data
}

/** Forget the save — "start fresh from the deal", and after a send. */
export async function clearTemplateWork({ dealId, templateId, client = supabase }) {
  if (!dealId) return
  const { error } = await client
    .from(TABLE)
    .delete()
    .eq('deal_id', dealId)
    .eq('template_id', templateId || '')
  if (error) console.warn(`[boldsign] could not clear saved template work: ${error.message}`)
}

/**
 * Is `documentId` still an unsent draft on this deal?
 *
 * Asked before superseding the draft a previous save left behind. The CRM row is
 * the right source here: it is what the Signatures tab lists, and a document it
 * calls anything other than 'draft' is one a signer has already been told
 * about — never ours to remove on the way to saving a newer copy.
 */
export async function isUnsentDraft({ dealId, documentId, client = supabase }) {
  if (!dealId || !documentId) return false
  const { data, error } = await client
    .from('boldsign_documents')
    .select('id, status')
    .eq('deal_id', dealId)
    .eq('document_id', documentId)
    .maybeSingle()
  if (error || !data) return false
  return data.status === 'draft'
}
