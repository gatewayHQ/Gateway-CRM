// ─────────────────────────────────────────────────────────────────────────────
// WHAT KIND OF DOCUMENT IS THIS, AND WHERE DOES IT FILE?
//
// The Documents tab was one flat list of whatever each file happened to be
// called when it arrived — `1788554297769-IA_Listing__Marshalltown….pdf` next
// to `signed-Buyer-Agreement-IA-Agency-Packet.pdf` — so "where's the agency
// agreement?", the question an agent actually opens this tab with, was answered
// by reading eleven filenames.
//
// THE GUESS IS HONEST ABOUT BEING A GUESS. A filename is evidence, not truth: a
// scan called `scan_0042.pdf` says nothing at all. So classification has three
// levels, in this order:
//
//   1. What the CRM knows it wrote itself — the `signed-` and `audit-` prefixes
//      the BoldSign webhook files things under. Not a guess.
//   2. What an agent has corrected by hand ("File as…"), stored per deal.
//   3. What the filename suggests, by keyword.
//
// Anything none of those can place goes to UNFILED — a named pile with a "File
// as…" on every row — rather than being dropped into a wrong group quietly. A
// misfiled disclosure is worse than an unfiled one: nobody goes looking in the
// pile they already believe is complete.
//
// Pure: no Supabase, no browser. The overrides map is handed in.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The piles, in the order they appear on the tab. Order is roughly the order a
 * transaction produces them, which is also the order an agent looks for them.
 *
 * `match` is tested against the file's name, lowercased, with separators
 * normalised to spaces. First group whose pattern hits wins, so the more
 * specific groups come first.
 */
export const DOCUMENT_KINDS = Object.freeze([
  {
    id: 'agency',
    label: 'Agency & listing agreements',
    tone: 'purple',
    match: /\b(agency|listing|representation|buyer agreement|seller agreement|exclusive|engagement)\b/,
  },
  {
    id: 'offers',
    label: 'Offers & purchase',
    tone: 'amber',
    match: /\b(offer|purchase|contract|counter|addend\w*|amendment|escrow|earnest|loi|letter of intent)\b/,
  },
  {
    id: 'disclosures',
    label: 'Disclosures',
    tone: 'azure',
    match: /\b(disclosure|lead[- ]?based|lbp|spcd|property condition|radon|flood|hoa|seller.?s property)\b/,
  },
  {
    id: 'reports',
    label: 'Inspections & reports',
    tone: 'green',
    match: /\b(inspection|appraisal|survey|title|report|walk[- ]?through|repair|estoppel|rent roll|t12|financials?)\b/,
  },
  {
    id: 'closing',
    label: 'Closing',
    tone: 'gold',
    match: /\b(closing|settlement|hud|alta|deed|cd|final)\b/,
  },
  {
    id: 'audit',
    label: 'Audit trails',
    tone: 'mist',
    match: /^audit\b|\baudit trail\b/,
    // Compliance evidence, not paperwork anyone reads: present, findable, and
    // collapsed by default so it does not double the length of the list.
    closed: true,
  },
  {
    id: 'unfiled',
    label: 'Unfiled',
    tone: 'mist',
    match: null,             // the fallback; nothing matches INTO it
    hint: 'Named too vaguely to place. "File as…" on a row puts it right, and the correction sticks.',
  },
])

const KIND_BY_ID = new Map(DOCUMENT_KINDS.map(k => [k.id, k]))

/** The kind with this id, or the Unfiled pile. */
export function kindById(id) {
  return KIND_BY_ID.get(String(id || '')) || KIND_BY_ID.get('unfiled')
}

/** The kinds an agent may choose from in "File as…" — everything but Unfiled. */
export function assignableKinds() {
  return DOCUMENT_KINDS.filter(k => k.id !== 'unfiled')
}

/**
 * The name a person should see: the upload timestamp gone, separators turned
 * back into spaces, the extension dropped, and the `signed-` / `audit-` prefix
 * removed — that fact is carried by the row's own badge, not by its name.
 */
export function cleanDocumentName(fileName) {
  return String(fileName || '')
    .replace(/^\d{10,}-/, '')
    .replace(/^(signed|audit)-/i, '')
    .replace(/\.[a-z0-9]{1,6}$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/-{2,}/g, ' — ')
    .replace(/\s{2,}/g, ' ')
    .trim() || 'Document'
}

/** True for a file this app filed itself as a completed signed copy. */
export function isSignedCopy(fileName) {
  return /^(?:\d{10,}-)?signed-/i.test(String(fileName || ''))
}

/** True for a BoldSign audit trail. */
export function isAuditTrail(fileName) {
  return /^(?:\d{10,}-)?audit-/i.test(String(fileName || ''))
}

/** The text the classifier reads: lowercase, separators flattened to spaces. */
function searchable(fileName) {
  return cleanDocumentName(fileName).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Which pile a file belongs in.
 *
 * `overrides` is { [storage file name]: kindId } — an agent's own correction,
 * which beats the keyword guess but NOT the audit-trail fact: an audit trail
 * filed as an agreement would put compliance evidence in with the paperwork.
 */
export function classifyDocument(fileName, overrides = {}) {
  if (isAuditTrail(fileName)) return 'audit'
  const override = overrides?.[fileName]
  if (override && KIND_BY_ID.has(override)) return override
  const text = searchable(fileName)
  for (const kind of DOCUMENT_KINDS) {
    if (kind.match && kind.match.test(text)) return kind.id
  }
  return 'unfiled'
}

/** Whether this file's pile was chosen by a person rather than guessed. */
export function isConfirmed(fileName, overrides = {}) {
  return isAuditTrail(fileName) || Boolean(overrides?.[fileName])
}

/**
 * The tab's whole list, grouped and ordered. Empty piles are dropped — a header
 * over nothing is furniture — and files inside a pile stay newest-first, which
 * is the order storage hands them over and the order an agent thinks in.
 *
 * Each returned file carries what the row needs to draw itself, so the
 * component does no parsing of its own.
 */
export function groupDocuments(files = [], overrides = {}) {
  const buckets = new Map(DOCUMENT_KINDS.map(k => [k.id, []]))
  for (const file of files) {
    const id = classifyDocument(file?.name, overrides)
    buckets.get(id).push({
      ...file,
      kind: id,
      label: cleanDocumentName(file?.name),
      signed: isSignedCopy(file?.name),
      audit: isAuditTrail(file?.name),
      confirmed: isConfirmed(file?.name, overrides),
    })
  }
  return DOCUMENT_KINDS
    .map(k => ({ ...k, files: buckets.get(k.id) }))
    .filter(k => k.files.length > 0)
}

/**
 * The one-line summary above the list. Says what is on the deal and, when there
 * is anything to sort out, how much — an Unfiled pile nobody is told about is a
 * pile nobody clears.
 */
export function documentsSummary(groups = []) {
  const total = groups.reduce((n, g) => n + g.files.length, 0)
  if (!total) return null
  const unfiled = groups.find(g => g.id === 'unfiled')?.files.length || 0
  const signed  = groups.reduce((n, g) => n + g.files.filter(f => f.signed).length, 0)
  const bits = [`${total} document${total === 1 ? '' : 's'}`]
  if (signed)  bits.push(`${signed} signed`)
  if (unfiled) bits.push(`${unfiled} to file`)
  return bits.join(' · ')
}
