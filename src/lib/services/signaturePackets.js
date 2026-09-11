// ─────────────────────────────────────────────────────────────────────────────
// Signature Packets — the deal-level envelope module's PURE rules.
//
// No network, no Supabase, no browser globals, so the same rules run in the
// Signatures tab, in the serverless function, and in tests — the same shape as
// boldsignSigners.js and boldsignCaptions.js, both of which api/boldsign.js
// imports directly.
//
// WHAT THIS FILE DECIDES
//   • what a packet's state is CALLED, and which actions that state allows;
//   • that a completed packet is never mutated — corrections are clones;
//   • what the MLS packager may pick from, and in what order.
//
// THE ONE RULE EVERYTHING ELSE HANGS OFF: a completed BoldSign envelope is
// immutable. BoldSign will not let us edit it, we do not try, and no button in
// this app is named "Edit signed document". A correction after signing is a NEW
// envelope (an embedded clone) carrying an acknowledgement label and required
// initials, stored beside the original with `correction_of_document_id` set.
// Both PDFs stay on the deal, because the original is what MLS receives.
// ─────────────────────────────────────────────────────────────────────────────

// ── Status vocabulary ────────────────────────────────────────────────────────
// The CRM stores a NORMALIZED, forward-only lifecycle in
// `boldsign_documents.status`: draft | sent | delivered | needs_attention |
// completed | declined | expired | voided. That column is load-bearing — the
// client portal, the nightly reminder sweep and the closing compliance gate all
// filter on those exact strings — so the packet module reads it rather than
// introducing a second one.
//
// What the packet UI SHOWS is a different question. Agents (and the product
// spec) think in BoldSign's own words: Draft, In progress, Completed, Declined,
// Revoked, Expired, Needs attention, Queued. This is the translation, and it is
// display-only in one direction: nothing here is ever written back to `status`.
//
// `Queued` is deliberately NOT a stored status. BoldSign answers an async file
// edit (Add/Update/Remove) with a queued document, which is a property of the
// EDIT, not of the document's lifecycle — writing it into `status` would take a
// live, out-for-signature document out of the portal, the reminder sweep and
// the compliance gate for as long as the edit took to settle. It is carried by
// `edit_pending_since` and surfaces here as a derived label.
const IN_FLIGHT = Object.freeze(['sent', 'delivered', 'needs_attention'])
const TERMINAL  = Object.freeze(['completed', 'declined', 'expired', 'voided'])

const IN_FLIGHT_SET = new Set(IN_FLIGHT)
const TERMINAL_SET  = new Set(TERMINAL)

export const PACKET_IN_FLIGHT_STATUSES = IN_FLIGHT
export const PACKET_TERMINAL_STATUSES  = TERMINAL

const LABELS = Object.freeze({
  draft:           'Draft',
  sent:            'In progress',
  delivered:       'In progress',
  needs_attention: 'Needs attention',
  completed:       'Completed',
  declined:        'Declined',
  expired:         'Expired',
  voided:          'Revoked',
})

const str = (v) => String(v ?? '').trim()

/**
 * A packet row's state, as the UI names it.
 *
 * An unsettled async file edit wins over the lifecycle status, because it is
 * the fact that decides what the agent may do next: a packet whose pages are
 * still catching up must not be sent, however "in progress" it looks.
 */
export function packetState(row) {
  if (isEditPending(row)) return 'Queued'
  return LABELS[str(row?.status)] || (str(row?.status) ? 'Unknown' : 'Draft')
}

/** True while BoldSign is still applying an async file change to this packet. */
export function isEditPending(row) {
  const since = row?.edit_pending_since
  if (!since) return false
  const t = new Date(since).getTime()
  return Number.isFinite(t)
}

/**
 * How long an edit has been settling, in ms — `null` when nothing is pending.
 * Used to decide when a stuck queue is worth saying out loud rather than
 * spinning forever.
 */
export function editPendingMs(row, now = Date.now()) {
  if (!isEditPending(row)) return null
  return Math.max(0, now - new Date(row.edit_pending_since).getTime())
}

/** Out with signers and not finished: sent, delivered, or needs attention. */
export function isInFlight(row) { return IN_FLIGHT_SET.has(str(row?.status)) }

/** Finished, one way or another. Nothing terminal is ever mutated. */
export function isTerminal(row) { return TERMINAL_SET.has(str(row?.status)) }

// ── What each state allows ───────────────────────────────────────────────────

/**
 * May "Fix packet" be offered?
 *
 * Draft or in-progress only. BoldSign refuses to edit a completed, declined,
 * revoked or expired document and it is right to: those are the settled record.
 * Offering the button anyway and letting the API say no teaches agents that the
 * CRM's buttons are guesses.
 *
 * An edit already in flight also blocks: a second edit stacked on an unsettled
 * one is how a file gets added twice.
 */
export function canFixPacket(row) {
  if (!row) return false
  if (isEditPending(row)) return false
  return str(row.status) === 'draft' || isInFlight(row)
}

/**
 * Why "Fix packet" is unavailable — the tooltip, in the words the spec fixed.
 * Returns null when it IS available.
 */
export function fixPacketBlockedReason(row) {
  if (canFixPacket(row)) return null
  if (isEditPending(row)) {
    return 'A file change on this packet is still being applied by BoldSign. It will be editable again once that lands.'
  }
  if (isTerminal(row)) return 'Use Send correction packet.'
  return 'This packet cannot be edited right now.'
}

/**
 * May a correction packet be sent?
 *
 * A correction is a CLONE, so it needs something to clone: a settled packet.
 * Completed is the main case; declined and revoked qualify too, because the
 * usual next step after either is "send them a fixed one" and rebuilding the
 * whole packet from the template loses every value that was already right.
 * Expired is the same shape.
 *
 * Never offered on a draft or an in-progress packet: those can simply be fixed.
 */
export function canSendCorrection(row) {
  return Boolean(row) && isTerminal(row)
}

/**
 * May the packet be revoked (recalled from its signers)?
 * Only something actually out with signers can be recalled. BoldSign answers a
 * bare 403 for a revoke on a draft — see the delete path in api/boldsign.js.
 */
export function canRevoke(row) {
  return Boolean(row) && isInFlight(row)
}

/**
 * May a recipient still be changed on this packet?
 * Only while it is in flight AND that specific signer has not finished. A
 * completed signature is a legal act; the person who made it does not get
 * swapped out underneath it.
 */
export function canChangeSigner(row, signer) {
  if (!row || !isInFlight(row)) return false
  if (isEditPending(row)) return false
  const state = str(signer?.status)
  return state !== 'signed' && state !== 'declined'
}

// ── The hard rules an in-progress edit must respect ──────────────────────────
//
// BoldSign's in-progress edit is real but narrow, and the narrowness is the
// point: a document people have already started signing is a document whose
// terms other people have already agreed to.

/** Signers who have finished. Their fields, and they themselves, are untouchable. */
export function completedSigners(signers = []) {
  return (Array.isArray(signers) ? signers : []).filter(s => str(s?.status) === 'signed')
}

/** Signers who can still be given something to do. */
export function editableSigners(signers = []) {
  return (Array.isArray(signers) ? signers : [])
    .filter(s => !['signed', 'declined'].includes(str(s?.status)))
}

/**
 * The signer an "add acknowledgement + initials" correction should be aimed at:
 * the first party, in signing order, who has not finished.
 *
 * Returns null when everyone is done — which is the caller's cue that this is a
 * completed packet and the answer is a correction CLONE, not an edit.
 */
export function nextUnfinishedSigner(signers = []) {
  const open = editableSigners(signers)
    .slice()
    .sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
  return open[0] || null
}

// Fields BoldSign fixes when a document is created and refuses to change while
// it is in flight. Sending them anyway earns a validation error at best and, at
// worst, a silently ignored request that reads as success.
export const LOCKED_ON_INFLIGHT_EDIT = Object.freeze(['title', 'brandId', 'enableSigningOrder'])

/**
 * Strip the fields that cannot change on an in-progress edit, and say which
 * were dropped.
 *
 * Refusing the whole request would be the other defensible choice; this one is
 * better because these keys are usually carried along by a payload builder
 * rather than typed by a person, and failing an acknowledgement-and-initials
 * edit because the payload happened to echo the document's own unchanged title
 * helps nobody. What must never happen is sending them and pretending they
 * applied — hence the report.
 */
export function stripLockedEditFields(payload = {}) {
  const out = { ...payload }
  const dropped = []
  for (const key of LOCKED_ON_INFLIGHT_EDIT) {
    if (key in out) { delete out[key]; dropped.push(key) }
  }
  return { payload: out, dropped }
}

// The edit actions that touch FILES. BoldSign processes these asynchronously
// and may answer with the document in a Queued state — the response is a
// promise that the change will land, not a statement that it has.
const FILE_EDIT_ACTIONS = new Set(['add', 'update', 'remove', 'replace'])

/** Does this edit payload change the document's files? */
export function touchesFiles(payload = {}) {
  const files = payload?.files ?? payload?.Files
  if (!Array.isArray(files)) return false
  return files.some(f => FILE_EDIT_ACTIONS.has(str(f?.editAction || f?.EditAction).toLowerCase()))
}

/**
 * Did BoldSign answer this edit with a document that has not settled yet?
 * Accepts the raw response or a plain status string.
 */
export function isQueuedResponse(res) {
  const status = str(typeof res === 'string' ? res : (res?.status ?? res?.documentStatus))
  return /^queued$/i.test(status)
}

// ── Local files (the manifest the MLS packager picks from) ───────────────────

export const LOCAL_FILE_KINDS = Object.freeze(['signed_pdf', 'audit', 'split_part', 'mls_bundle'])

/**
 * One `local_files` entry, normalized. Returns null for anything with no path —
 * an entry that names no object is not a file, and letting one into the list
 * puts a checkbox on the MLS screen that can never be packed.
 */
export function normalizeLocalFile(raw) {
  const path = str(raw?.path)
  const kind = str(raw?.kind)
  if (!path || !LOCAL_FILE_KINDS.includes(kind)) return null
  const pages = Number(raw?.pages)
  return {
    kind,
    path,
    form_name: str(raw?.form_name) || fileNameFromPath(path),
    ...(Number.isFinite(pages) && pages > 0 ? { pages } : {}),
  }
}

export function normalizeLocalFiles(list = []) {
  return (Array.isArray(list) ? list : []).map(normalizeLocalFile).filter(Boolean)
}

/**
 * Add or replace an entry, keyed on its storage path.
 *
 * Keyed on the PATH, not on the kind: archive paths are deterministic (see
 * archivePath() in api/boldsign.js), so a webhook redelivery re-archives to the
 * same object and must update its manifest entry rather than append a second
 * one. A packet whose manifest grows on every retry hands MLS the same
 * disclosure four times.
 */
export function upsertLocalFile(list = [], entry) {
  const next = normalizeLocalFile(entry)
  if (!next) return normalizeLocalFiles(list)
  const rest = normalizeLocalFiles(list).filter(f => f.path !== next.path)
  return [...rest, next]
}

export function fileNameFromPath(path) {
  const base = str(path).split('/').pop() || 'document.pdf'
  return base
}

/** Strip a storage filename back to something a person would call the form. */
export function formNameFromFile(name) {
  return str(name)
    .replace(/\.pdf$/i, '')
    .replace(/^\d{10,}-/, '')          // the epoch prefix uploads carry
    .replace(/^(signed|audit)-/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Document'
}

// ── The MLS packager ─────────────────────────────────────────────────────────
//
// BoldSign will not split pages out of a signed combined PDF, will not merge
// two completed envelopes into a new one, and will not restripe a signed file.
// So MLS packaging happens HERE, on files we already hold, and never goes back
// through BoldSign. Nothing in this section sends anything.

// What an MLS upload may be built from. The audit trail is deliberately
// excluded from the default selection: it is a compliance artifact, not part of
// the filed agreement, and MLS boards reject packets padded with it.
export const MLS_PACKABLE_KINDS = Object.freeze(['signed_pdf', 'split_part'])

/**
 * Every completed file on a deal that MLS could want, across all its packets —
 * originals AND corrections.
 *
 * `rows` is the deal's `boldsign_documents` rows. Each returned entry carries
 * enough for a checkbox to render and for the packer to fetch it without a
 * second lookup.
 */
export function packableFiles(rows = []) {
  const out = []
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (str(row?.status) !== 'completed') continue
    for (const f of normalizeLocalFiles(row.local_files)) {
      if (!MLS_PACKABLE_KINDS.includes(f.kind)) continue
      out.push({
        id:            f.path,                       // the storage path IS the id
        path:          f.path,
        kind:          f.kind,
        form_name:     f.form_name,
        pages:         f.pages ?? null,
        documentId:    str(row.document_id),
        documentName:  str(row.document_name) || f.form_name,
        packetId:      str(row.id),
        isCorrection:  Boolean(row.correction_of_document_id),
        correctionOf:  str(row.correction_of_document_id) || null,
        completedAt:   row.completed_at || null,
      })
    }
  }
  // Oldest packet first: an MLS file reads in the order the deal happened, and a
  // correction belongs after the thing it corrects.
  //
  // NO TIEBREAKER, deliberately. Array.prototype.sort is stable, so the parts of
  // ONE packet keep their manifest order — which is the order they were signed
  // in and the order the combined PDF holds them. An alphabetical tiebreaker
  // would put "Disclosures" ahead of the "Purchase Agreement" it is attached to
  // and hand the board a scrambled filing.
  return out.sort((a, b) => {
    const at = a.completedAt ? new Date(a.completedAt).getTime() : 0
    const bt = b.completedAt ? new Date(b.completedAt).getTime() : 0
    return at - bt
  })
}

/**
 * Apply the user's explicit ordering to a selection.
 *
 * `order` is a list of file ids (storage paths). Anything selected but not
 * named in `order` keeps its natural position AFTER the ordered ones, rather
 * than being dropped — a merge that silently omits a form the agent ticked is
 * the worst possible failure of this feature.
 */
export function orderSelection(files = [], order = []) {
  const byId = new Map((Array.isArray(files) ? files : []).map(f => [f.id ?? f.path, f]))
  const seen = new Set()
  const out  = []
  for (const id of (Array.isArray(order) ? order : [])) {
    const f = byId.get(id)
    if (f && !seen.has(id)) { out.push(f); seen.add(id) }
  }
  for (const f of files) {
    const id = f.id ?? f.path
    if (!seen.has(id)) { out.push(f); seen.add(id) }
  }
  return out
}

/**
 * The correction-only view: an original and the acknowledgement that corrects
 * it, as a pair.
 *
 * Returns the original first and its corrections after, in completion order —
 * "original + acknowledgement" is the phrase MLS uses, and it is an ordering
 * requirement, not a preference.
 */
export function correctionPair(files = [], documentId) {
  const id = str(documentId)
  if (!id) return []
  const original    = files.filter(f => f.documentId === id)
  const corrections = files.filter(f => f.correctionOf === id)
  return [...original, ...corrections]
}

// Presets an agent picks instead of ticking eight boxes.
//
// Matched case-insensitively against the form name AND the packet it came out
// of. The packet name matters because a merged envelope's split parts are
// often named generically ("Page 2", "Addendum") while the envelope itself says
// what the file is — so a part of the purchase packet is selected by the sold
// preset even when its own name gives nothing away. The cost is that a preset
// can pull in a whole envelope; that is the right default for a filing, and the
// checklist is right there to untick from.
//
// A preset that matches nothing selects nothing rather than guessing, and the
// UI says which preset found nothing rather than appearing to do nothing.
export const MLS_PRESETS = Object.freeze([
  {
    id:    'listing',
    label: 'Listing file',
    hint:  'Listing agreement + disclosures',
    mode:  'merge',
    match: ['listing', 'agency', 'disclosure', 'lead paint', 'lead-based'],
  },
  {
    id:    'sold',
    label: 'Sold / closed file',
    hint:  'Purchase + amendments + lead paint + corrections, in order',
    mode:  'merge',
    match: ['purchase', 'amendment', 'addend', 'lead paint', 'lead-based', 'acknowledg', 'correction'],
  },
  {
    id:    'single',
    label: 'Single-form upload',
    hint:  'One form per upload — pick exactly one',
    mode:  'zip',
    match: [],
  },
])

/** The files a preset would select, in packing order. */
export function applyPreset(files = [], presetId) {
  const preset = MLS_PRESETS.find(p => p.id === presetId)
  if (!preset || !preset.match.length) return []
  const hit = (f) => preset.match.some(m => `${f.form_name} ${f.documentName}`.toLowerCase().includes(m))
  return files.filter(hit)
}

/**
 * Name the file an MLS pack produces. Deterministic and human-readable, because
 * it is what an agent uploads and what a board sees.
 */
export function mlsPackName({ mode, mlsNumber, address, count, now = new Date() } = {}) {
  const stamp = new Date(now).toISOString().slice(0, 10)
  const who   = str(mlsNumber) || str(address) || 'deal'
  const slug  = who.replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'deal'
  const ext   = mode === 'zip' ? 'zip' : 'pdf'
  const n     = Number(count) || 0
  return `MLS-${slug}-${stamp}${n ? `-${n}file${n === 1 ? '' : 's'}` : ''}.${ext}`
}

/**
 * Refuse a pack that cannot succeed, in a sentence, before any bytes move.
 * Returns null when the request is fine.
 */
export function validateMlsPack({ mode, files = [] } = {}) {
  if (!['zip', 'merge'].includes(str(mode))) {
    return 'Choose whether to download the forms separately or merge them into one PDF.'
  }
  if (!files.length) return 'Select at least one completed form to pack.'
  if (mode === 'merge' && files.length === 1) {
    return 'Only one form is selected — download it on its own instead of merging.'
  }
  return null
}

// ── Composing a packet before it is sent ─────────────────────────────────────

export const PACKET_MODES = Object.freeze(['merged', 'split', 'single'])

/**
 * Which BoldSign shape a compose request wants.
 *
 * "Together" with several forms is a merged envelope — one signing session, one
 * document, and (paid plans) individually-downloadable files inside it.
 * "Separately" is one envelope per form: separate document ids, separate
 * statuses on the deal, and separate files without needing the paid feature.
 * One form is one send whichever radio is set, and calling that 'merged' would
 * make the tab claim a composition that never happened.
 */
export function packetModeFor({ together, templateIds = [] } = {}) {
  const n = (Array.isArray(templateIds) ? templateIds : []).filter(Boolean).length
  if (n <= 1) return 'single'
  return together ? 'merged' : 'split'
}

// BoldSign's DocumentDownloadOption. `Individually` is what makes per-form
// downloads possible after signing, and it is fixed at CREATION — a packet sent
// as Combined can never be un-combined, because BoldSign does not split pages
// out of a signed PDF and neither will we. So it is the default whenever a
// packet holds more than one file.
export const DOWNLOAD_COMBINED     = 'Combined'
export const DOWNLOAD_INDIVIDUALLY = 'Individually'

/**
 * The download option a send should ask for.
 *
 * `Individually` is a paid-plan feature; when BoldSign rejects it the caller
 * falls back to `Combined` (see the send paths in api/boldsign.js) and records
 * what was actually used, so the MLS packager knows whether per-form files
 * exist without asking BoldSign again.
 */
export function downloadOptionFor({ fileCount = 1 } = {}) {
  return Number(fileCount) > 1 ? DOWNLOAD_INDIVIDUALLY : DOWNLOAD_COMBINED
}

/**
 * Does a BoldSign error mean "your plan does not include DocumentDownloadOption"?
 * Narrow on purpose: a 400 that names something else is a real validation
 * failure and must not be papered over by silently downgrading the packet to
 * Combined, which is the one property of a send that cannot be changed later.
 */
export function isDownloadOptionRejection(err) {
  if (!err) return false
  const status = Number(err.status)
  if (status && status !== 400 && status !== 402 && status !== 403) return false
  const text = `${err.message || ''} ${JSON.stringify(err.data || {})}`.toLowerCase()
  if (!/documentdownloadoption|download option|downloadoption/.test(text)) return false
  return /not (supported|allowed|available)|upgrade|plan|subscription|invalid|permission/.test(text)
}

// ── BoldSign labels ──────────────────────────────────────────────────────────
// Labels are BoldSign's own tagging, and they are how a split send's several
// envelopes are recognizable as one packet from BoldSign's side — which matters
// the day someone is looking at the dashboard rather than the CRM.
export function packetLabels({ dealId, formSlug } = {}) {
  return [str(dealId), str(formSlug)].filter(Boolean)
}

/** A stable, filename-safe slug for a form name, used as its BoldSign label. */
export function formSlug(name) {
  return str(name).toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'form'
}
