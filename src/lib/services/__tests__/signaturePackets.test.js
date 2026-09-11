import { describe, it, expect } from 'vitest'
import {
  packetState, isEditPending, editPendingMs, isInFlight, isTerminal,
  canFixPacket, fixPacketBlockedReason, canSendCorrection, canRevoke, canChangeSigner,
  completedSigners, editableSigners, nextUnfinishedSigner,
  stripLockedEditFields, LOCKED_ON_INFLIGHT_EDIT, touchesFiles, isQueuedResponse,
  normalizeLocalFile, normalizeLocalFiles, upsertLocalFile, formNameFromFile,
  packableFiles, orderSelection, correctionPair, applyPreset, MLS_PRESETS,
  mlsPackName, validateMlsPack, packetModeFor, downloadOptionFor,
  isDownloadOptionRejection, packetLabels, formSlug,
  DOWNLOAD_COMBINED, DOWNLOAD_INDIVIDUALLY,
} from '../signaturePackets.js'

const packet = (over = {}) => ({ id: 'row-1', document_id: 'doc-1', status: 'sent', ...over })

describe('packet state vocabulary', () => {
  it('names the stored lifecycle in the words agents and BoldSign use', () => {
    expect(packetState(packet({ status: 'draft' }))).toBe('Draft')
    expect(packetState(packet({ status: 'sent' }))).toBe('In progress')
    expect(packetState(packet({ status: 'delivered' }))).toBe('In progress')
    expect(packetState(packet({ status: 'needs_attention' }))).toBe('Needs attention')
    expect(packetState(packet({ status: 'completed' }))).toBe('Completed')
    expect(packetState(packet({ status: 'declined' }))).toBe('Declined')
    expect(packetState(packet({ status: 'expired' }))).toBe('Expired')
    // `voided` is the column's word; "Revoked" is everyone else's.
    expect(packetState(packet({ status: 'voided' }))).toBe('Revoked')
  })

  it('shows Queued while an async file edit is settling, whatever the lifecycle says', () => {
    const row = packet({ status: 'sent', edit_pending_since: new Date().toISOString() })
    expect(packetState(row)).toBe('Queued')
    expect(isEditPending(row)).toBe(true)
    // The point of not storing it: the row is still `sent`, so the portal, the
    // reminder sweep and the closing gate all still see a live document.
    expect(row.status).toBe('sent')
  })

  it('reports how long an edit has been settling, and nothing when none is', () => {
    const t0 = Date.parse('2026-09-11T10:00:00Z')
    expect(editPendingMs(packet({ edit_pending_since: '2026-09-11T09:59:00Z' }), t0)).toBe(60_000)
    expect(editPendingMs(packet(), t0)).toBeNull()
  })

  it('classifies in-flight and terminal', () => {
    for (const s of ['sent', 'delivered', 'needs_attention']) {
      expect(isInFlight(packet({ status: s }))).toBe(true)
      expect(isTerminal(packet({ status: s }))).toBe(false)
    }
    for (const s of ['completed', 'declined', 'expired', 'voided']) {
      expect(isTerminal(packet({ status: s }))).toBe(true)
      expect(isInFlight(packet({ status: s }))).toBe(false)
    }
    expect(isInFlight(packet({ status: 'draft' }))).toBe(false)
    expect(isTerminal(packet({ status: 'draft' }))).toBe(false)
  })
})

describe('what each state allows', () => {
  it('offers Fix packet on a draft and on anything in flight', () => {
    for (const s of ['draft', 'sent', 'delivered', 'needs_attention']) {
      expect(canFixPacket(packet({ status: s }))).toBe(true)
      expect(fixPacketBlockedReason(packet({ status: s }))).toBeNull()
    }
  })

  it('refuses Fix packet on every settled packet, and points at the correction', () => {
    for (const s of ['completed', 'declined', 'expired', 'voided']) {
      const row = packet({ status: s })
      expect(canFixPacket(row)).toBe(false)
      expect(fixPacketBlockedReason(row)).toBe('Use Send correction packet.')
    }
  })

  it('refuses Fix packet while a file edit is still settling, and says why', () => {
    const row = packet({ status: 'sent', edit_pending_since: new Date().toISOString() })
    expect(canFixPacket(row)).toBe(false)
    expect(fixPacketBlockedReason(row)).toMatch(/still being applied/i)
  })

  it('offers a correction only on a settled packet — a live one can just be fixed', () => {
    expect(canSendCorrection(packet({ status: 'completed' }))).toBe(true)
    expect(canSendCorrection(packet({ status: 'declined' }))).toBe(true)
    expect(canSendCorrection(packet({ status: 'voided' }))).toBe(true)
    expect(canSendCorrection(packet({ status: 'expired' }))).toBe(true)
    expect(canSendCorrection(packet({ status: 'sent' }))).toBe(false)
    expect(canSendCorrection(packet({ status: 'draft' }))).toBe(false)
  })

  it('offers Recall only for something actually out with signers', () => {
    expect(canRevoke(packet({ status: 'sent' }))).toBe(true)
    expect(canRevoke(packet({ status: 'delivered' }))).toBe(true)
    // A draft was never sent; BoldSign answers a bare 403 for a revoke on one.
    expect(canRevoke(packet({ status: 'draft' }))).toBe(false)
    expect(canRevoke(packet({ status: 'completed' }))).toBe(false)
  })

  it('never offers to change a signer who has already acted', () => {
    const live = packet({ status: 'sent' })
    expect(canChangeSigner(live, { status: 'waiting' })).toBe(true)
    expect(canChangeSigner(live, { status: 'viewed' })).toBe(true)
    expect(canChangeSigner(live, { status: 'signed' })).toBe(false)
    expect(canChangeSigner(live, { status: 'declined' })).toBe(false)
    // Nor on a packet that is not in flight at all.
    expect(canChangeSigner(packet({ status: 'completed' }), { status: 'waiting' })).toBe(false)
  })
})

describe('the hard rules an in-progress edit must respect', () => {
  const signers = [
    { name: 'Ann',  email: 'a@x.com', order: 1, status: 'signed' },
    { name: 'Bob',  email: 'b@x.com', order: 2, status: 'viewed' },
    { name: 'Cara', email: 'c@x.com', order: 3, status: 'waiting' },
  ]

  it('separates who has finished from who can still be given something to do', () => {
    expect(completedSigners(signers).map(s => s.name)).toEqual(['Ann'])
    expect(editableSigners(signers).map(s => s.name)).toEqual(['Bob', 'Cara'])
  })

  it('aims an acknowledgement at the first unfinished party in signing order', () => {
    expect(nextUnfinishedSigner(signers).name).toBe('Bob')
    // Order, not array position — a payload that arrives out of order must not
    // send the initials to the wrong party.
    expect(nextUnfinishedSigner([signers[2], signers[1], signers[0]]).name).toBe('Bob')
  })

  it('returns nothing when everyone has finished — the caller must clone instead', () => {
    expect(nextUnfinishedSigner(signers.map(s => ({ ...s, status: 'signed' })))).toBeNull()
    expect(nextUnfinishedSigner([])).toBeNull()
  })

  it('drops title, brand and signing order from an in-progress edit, and names them', () => {
    const { payload, dropped } = stripLockedEditFields({
      title: 'New name', brandId: 'b-2', enableSigningOrder: false, Message: 'keep me',
    })
    expect(payload).toEqual({ Message: 'keep me' })
    expect(dropped.sort()).toEqual([...LOCKED_ON_INFLIGHT_EDIT].sort())
  })

  it('leaves a payload that names none of them untouched', () => {
    const { payload, dropped } = stripLockedEditFields({ Message: 'hi', Signers: [] })
    expect(payload).toEqual({ Message: 'hi', Signers: [] })
    expect(dropped).toEqual([])
  })

  it('recognizes a file-touching edit — the asynchronous kind', () => {
    expect(touchesFiles({ files: [{ editAction: 'Add' }] })).toBe(true)
    expect(touchesFiles({ Files: [{ EditAction: 'Remove' }] })).toBe(true)
    expect(touchesFiles({ files: [{ editAction: 'None' }] })).toBe(false)
    expect(touchesFiles({ Signers: [{ EditAction: 'Update' }] })).toBe(false)
  })

  it('recognizes a Queued response, from the object or a bare status', () => {
    expect(isQueuedResponse({ status: 'Queued' })).toBe(true)
    expect(isQueuedResponse({ documentStatus: 'queued' })).toBe(true)
    expect(isQueuedResponse('Queued')).toBe(true)
    expect(isQueuedResponse({ status: 'InProgress' })).toBe(false)
    expect(isQueuedResponse(null)).toBe(false)
  })
})

describe('the local file manifest', () => {
  it('refuses an entry with no path or an unknown kind — an unpackable checkbox', () => {
    expect(normalizeLocalFile({ kind: 'signed_pdf' })).toBeNull()
    expect(normalizeLocalFile({ kind: 'nonsense', path: 'a.pdf' })).toBeNull()
    expect(normalizeLocalFile({ kind: 'signed_pdf', path: 'deal-1/signed-x.pdf' }))
      .toEqual({ kind: 'signed_pdf', path: 'deal-1/signed-x.pdf', form_name: 'signed-x.pdf' })
  })

  it('keeps a page count only when it is a real one', () => {
    expect(normalizeLocalFile({ kind: 'split_part', path: 'p.pdf', pages: 4 }).pages).toBe(4)
    expect(normalizeLocalFile({ kind: 'split_part', path: 'p.pdf', pages: 0 }).pages).toBeUndefined()
    expect(normalizeLocalFile({ kind: 'split_part', path: 'p.pdf', pages: 'x' }).pages).toBeUndefined()
  })

  it('upserts on the storage path, so a webhook redelivery cannot duplicate a form', () => {
    let m = []
    m = upsertLocalFile(m, { kind: 'signed_pdf', path: 'deal-1/signed-a.pdf', form_name: 'Purchase' })
    m = upsertLocalFile(m, { kind: 'signed_pdf', path: 'deal-1/signed-a.pdf', form_name: 'Purchase' })
    m = upsertLocalFile(m, { kind: 'audit', path: 'deal-1/audit-a.pdf', form_name: 'Audit' })
    expect(m).toHaveLength(2)
    expect(m.map(f => f.kind).sort()).toEqual(['audit', 'signed_pdf'])
  })

  it('drops junk from a stored manifest rather than rendering it', () => {
    expect(normalizeLocalFiles([{ kind: 'signed_pdf', path: 'a.pdf' }, null, { path: 'b.pdf' }]))
      .toHaveLength(1)
  })

  it('turns a storage filename back into something a person would call the form', () => {
    expect(formNameFromFile('1789000000000-Purchase_Agreement.pdf')).toBe('Purchase Agreement')
    expect(formNameFromFile('signed-Lead-Paint-Disclosure.pdf')).toBe('Lead Paint Disclosure')
    expect(formNameFromFile('')).toBe('Document')
  })
})

describe('the MLS packager selection', () => {
  const rows = [
    {
      id: 'r1', document_id: 'd1', document_name: 'Purchase Agreement', status: 'completed',
      completed_at: '2026-09-01T00:00:00Z',
      local_files: [
        { kind: 'signed_pdf', path: 'deal-1/signed-purchase.pdf', form_name: 'Purchase Agreement', pages: 9 },
        { kind: 'split_part', path: 'deal-1/part-01-Disclosures.pdf', form_name: 'Disclosures', pages: 3 },
        // Never offered for an MLS upload: it is a compliance artifact, not part
        // of the filed agreement.
        { kind: 'audit', path: 'deal-1/audit-purchase.pdf', form_name: 'Audit' },
      ],
    },
    {
      id: 'r2', document_id: 'd2', document_name: 'Purchase Agreement — correction', status: 'completed',
      completed_at: '2026-09-05T00:00:00Z', correction_of_document_id: 'd1',
      local_files: [{ kind: 'signed_pdf', path: 'deal-1/signed-correction.pdf', form_name: 'Acknowledgement' }],
    },
    // Still out for signature: nothing to pack.
    { id: 'r3', document_id: 'd3', document_name: 'Lead Paint', status: 'sent', local_files: [] },
  ]

  it('lists only completed, packable files, oldest packet first', () => {
    const files = packableFiles(rows)
    // Within one packet the manifest order is kept — that is the order the
    // parts were signed in. Across packets, oldest first.
    expect(files.map(f => f.form_name)).toEqual(['Purchase Agreement', 'Disclosures', 'Acknowledgement'])
    expect(files.every(f => f.kind !== 'audit')).toBe(true)
    expect(files.find(f => f.documentId === 'd3')).toBeUndefined()
  })

  it('marks a correction as one, and remembers what it corrects', () => {
    const ack = packableFiles(rows).find(f => f.form_name === 'Acknowledgement')
    expect(ack.isCorrection).toBe(true)
    expect(ack.correctionOf).toBe('d1')
  })

  it('applies the user order and keeps anything they ticked but did not place', () => {
    const files = packableFiles(rows)
    const out = orderSelection(files, ['deal-1/signed-correction.pdf', 'deal-1/signed-purchase.pdf'])
    expect(out.map(f => f.form_name)).toEqual(['Acknowledgement', 'Purchase Agreement', 'Disclosures'])
  })

  it('pairs an original with its corrections, original first', () => {
    const pair = correctionPair(packableFiles(rows), 'd1')
    expect(pair.map(f => f.form_name)).toEqual(['Purchase Agreement', 'Disclosures', 'Acknowledgement'])
  })

  it('matches presets against the form and the packet it came from', () => {
    const files = packableFiles(rows)
    expect(applyPreset(files, 'listing').map(f => f.form_name)).toEqual(['Disclosures'])
    // "Disclosures" is a part of the Purchase Agreement envelope, so the sold
    // preset takes it too — matching the packet name is what makes a preset
    // select a whole filing rather than only the parts whose own names happen
    // to be descriptive.
    expect(applyPreset(files, 'sold').map(f => f.form_name).sort())
      .toEqual(['Acknowledgement', 'Disclosures', 'Purchase Agreement'])
    // The single-form preset matches nothing on purpose — it is an instruction
    // to pick one, not a selection.
    expect(applyPreset(files, 'single')).toEqual([])
    expect(applyPreset(files, 'nope')).toEqual([])
    expect(MLS_PRESETS.map(p => p.id)).toEqual(['listing', 'sold', 'single'])
  })

  it('refuses a pack that cannot succeed, before any bytes move', () => {
    expect(validateMlsPack({ mode: 'zip', files: [] })).toMatch(/at least one/i)
    expect(validateMlsPack({ mode: 'nonsense', files: [{}] })).toMatch(/separately or merge/i)
    expect(validateMlsPack({ mode: 'merge', files: [{}] })).toMatch(/on its own/i)
    expect(validateMlsPack({ mode: 'merge', files: [{}, {}] })).toBeNull()
    expect(validateMlsPack({ mode: 'zip', files: [{}] })).toBeNull()
  })

  it('names the output for the board that receives it', () => {
    const now = new Date('2026-09-11T12:00:00Z')
    expect(mlsPackName({ mode: 'zip', mlsNumber: 'DM-99213', count: 3, now }))
      .toBe('MLS-DM-99213-2026-09-11-3files.zip')
    expect(mlsPackName({ mode: 'merge', address: '1420 Grand Ave', count: 1, now }))
      .toBe('MLS-1420-Grand-Ave-2026-09-11-1file.pdf')
    expect(mlsPackName({ mode: 'merge', now })).toBe('MLS-deal-2026-09-11.pdf')
  })
})

describe('composing a packet before it is sent', () => {
  it('calls one form a single send whichever radio is set', () => {
    expect(packetModeFor({ together: true,  templateIds: ['t1'] })).toBe('single')
    expect(packetModeFor({ together: false, templateIds: ['t1'] })).toBe('single')
    expect(packetModeFor({ together: true,  templateIds: [] })).toBe('single')
  })

  it('distinguishes a merged envelope from several split ones', () => {
    expect(packetModeFor({ together: true,  templateIds: ['t1', 't2'] })).toBe('merged')
    expect(packetModeFor({ together: false, templateIds: ['t1', 't2'] })).toBe('split')
  })

  it('asks for per-form downloads whenever a packet holds more than one file', () => {
    expect(downloadOptionFor({ fileCount: 2 })).toBe(DOWNLOAD_INDIVIDUALLY)
    expect(downloadOptionFor({ fileCount: 1 })).toBe(DOWNLOAD_COMBINED)
    expect(downloadOptionFor({})).toBe(DOWNLOAD_COMBINED)
  })

  it('recognizes a plan-level refusal of DocumentDownloadOption', () => {
    expect(isDownloadOptionRejection({
      status: 400, message: 'DocumentDownloadOption is not supported on your current plan',
    })).toBe(true)
    expect(isDownloadOptionRejection({
      status: 403, message: 'download option requires an upgrade',
    })).toBe(true)
  })

  it('does NOT treat an unrelated validation error as a reason to downgrade', () => {
    // Downgrading here would silently make the packet un-splittable forever,
    // which is the one property of a send that cannot be changed later.
    expect(isDownloadOptionRejection({ status: 400, message: 'SignerEmail is missing in roles' })).toBe(false)
    expect(isDownloadOptionRejection({ status: 500, message: 'DocumentDownloadOption not supported' })).toBe(false)
    expect(isDownloadOptionRejection(null)).toBe(false)
  })

  it('labels a split send so BoldSign groups its several envelopes as one packet', () => {
    expect(packetLabels({ dealId: 'deal-9', formSlug: 'lead-paint' })).toEqual(['deal-9', 'lead-paint'])
    expect(packetLabels({ dealId: 'deal-9' })).toEqual(['deal-9'])
    expect(packetLabels({})).toEqual([])
  })

  it('slugs a form name safely and stably', () => {
    expect(formSlug('Lead Paint Disclosure.pdf')).toBe('lead-paint-disclosure')
    expect(formSlug('Listing agreement/SD agency packet')).toBe('listing-agreement-sd-agency-packet')
    expect(formSlug('')).toBe('form')
  })
})
