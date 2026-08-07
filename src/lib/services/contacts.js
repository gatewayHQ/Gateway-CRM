// ─────────────────────────────────────────────────────────────────────────────
// Contact upsert — one door into the `contacts` table.
//
// Five tables in this schema are all "a person": contacts, cold_call_leads,
// lead_captures, mailing_leads and mailing_subscribers. Each grew its own
// hand-rolled path into `contacts`, and two of them (ColdCalls convert, Leads
// convert) blind-INSERTed with no duplicate check at all — so the same owner
// reached through a cold-call list and a website form became two contact rows,
// each with half the history.
//
// This does not merge the tables (that needs a migration and a backfill — see
// the TODO at the bottom). It does make every client-side path agree on what
// counts as "the same person", so converting twice updates rather than doubles.
// ─────────────────────────────────────────────────────────────────────────────
import { normalizePhone } from '../phone.js'

/** Lower-cased, trimmed, or null. Emails are compared case-insensitively. */
export function normalizeEmail(input) {
  const e = String(input || '').trim().toLowerCase()
  return e || null
}

/**
 * Identity key for a person. Email wins when present because it is the field
 * people type consistently; phone is the fallback, compared in E.164 so
 * "(515) 555-0123" and "5155550123" are one person, not two.
 */
export function contactIdentity({ email, phone } = {}) {
  const e = normalizeEmail(email)
  if (e) return `email:${e}`
  const p = normalizePhone(phone)
  if (p) return `phone:${p}`
  return null
}

/**
 * Find an already-known contact in `rows` matching the incoming person.
 * Returns null when there is no identity to match on — a person with neither
 * email nor phone is always treated as new, because matching them on name
 * alone would merge unrelated people.
 */
export function findExistingContact(rows = [], incoming = {}) {
  const key = contactIdentity(incoming)
  if (!key) return null
  return rows.find(r => contactIdentity(r) === key) || null
}

/**
 * Create the contact, or return the existing one when this person is already
 * known. Never silently overwrites: fields already set on the existing row win,
 * and only blank ones are filled in from the incoming payload.
 *
 *   const { contact, created, error } = await upsertContact(supabase, payload, db.contacts)
 *
 * `existingRows` is the caller's already-loaded contact list. Passing it keeps
 * this a zero-extra-query helper on the common path.
 */
export async function upsertContact(supabase, payload, existingRows = []) {
  const incoming = {
    ...payload,
    email: normalizeEmail(payload.email),
    phone: payload.phone ? (normalizePhone(payload.phone) || payload.phone) : null,
  }

  const existing = findExistingContact(existingRows, incoming)

  if (existing) {
    // Fill only the gaps, so a richer existing record is never downgraded.
    const patch = {}
    for (const [k, v] of Object.entries(incoming)) {
      if (v === null || v === undefined || v === '') continue
      const current = existing[k]
      const isBlank = current === null || current === undefined || current === '' ||
                      (Array.isArray(current) && current.length === 0)
      if (isBlank) patch[k] = v
    }
    // Tags are additive rather than replaced — a cold-call tag shouldn't erase
    // a newsletter tag.
    if (Array.isArray(incoming.tags) && incoming.tags.length) {
      const merged = [...new Set([...(existing.tags || []), ...incoming.tags])]
      if (merged.length !== (existing.tags || []).length) patch.tags = merged
    }

    if (!Object.keys(patch).length) return { contact: existing, created: false, error: null }

    const { data, error } = await supabase
      .from('contacts').update(patch).eq('id', existing.id).select().single()
    if (error) return { contact: existing, created: false, error: error.message }
    return { contact: data, created: false, error: null }
  }

  const { data, error } = await supabase.from('contacts').insert([incoming]).select().single()
  if (error) return { contact: null, created: false, error: error.message }
  return { contact: data, created: true, error: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// TODO — the structural fix this helper only papers over.
// Collapse cold_call_leads / lead_captures / mailing_leads /
// mailing_recipients / mailing_subscribers into `contacts` plus a
// `contact_sources(contact_id, source_type, source_id, payload jsonb,
// captured_at)` child. That removes four conversion paths rather than making
// them agree, and deletes ~800 lines. It needs a migration with a backfill, so
// it is deliberately not in this pass. Server-side capture in
// api/campaigns.js:607 and :713 has its own copy of this logic and should move
// to the same model at the same time — it cannot import this module (different
// runtime, no access to the caller's loaded rows).
// ─────────────────────────────────────────────────────────────────────────────
