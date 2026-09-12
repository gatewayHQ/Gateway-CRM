import { describe, it, expect } from 'vitest'
import {
  DOCUMENT_KINDS, classifyDocument, cleanDocumentName, groupDocuments, documentsSummary,
  isSignedCopy, isAuditTrail, isConfirmed, assignableKinds, kindById,
} from '../documentKinds.js'

// ─────────────────────────────────────────────────────────────────────────────
// Filing a deal's documents by what they are. The classifier reads a filename,
// which is evidence and not truth — so what matters most here is not how clever
// the guesses are, but that a file it cannot place goes to Unfiled rather than
// into a pile an agent will later believe is complete.
// ─────────────────────────────────────────────────────────────────────────────
const file = (name, over = {}) => ({ name, created_at: '2026-09-04T10:00:00Z', metadata: { size: 1024 }, ...over })

describe('cleanDocumentName — the name a person should read', () => {
  it('drops the upload timestamp the uploader adds', () => {
    expect(cleanDocumentName('1788554297769-IA_Listing__Marshalltown.pdf')).toBe('IA Listing Marshalltown')
  })

  it('drops the signed/audit prefix — the row says that with a badge', () => {
    expect(cleanDocumentName('signed-Buyer-Agreement-IA-Agency-Packet.pdf')).toBe('Buyer-Agreement-IA-Agency-Packet')
    expect(cleanDocumentName('audit-Buyer-Agreement.pdf')).toBe('Buyer-Agreement')
  })

  it('never returns nothing', () => {
    expect(cleanDocumentName('')).toBe('Document')
    expect(cleanDocumentName('.pdf')).toBe('Document')
  })
})

describe('classifyDocument — a guess that knows it is one', () => {
  it('files the paperwork it can recognise', () => {
    expect(classifyDocument('IA_Listing__Marshalltown.pdf')).toBe('agency')
    expect(classifyDocument('signed-Buyer-Agreement-IA-Agency-Packet.pdf')).toBe('agency')
    expect(classifyDocument('Purchase Agreement 611 E South.pdf')).toBe('offers')
    expect(classifyDocument('Addendum No 1.pdf')).toBe('offers')
    expect(classifyDocument('Lead-Based Paint Disclosure.pdf')).toBe('disclosures')
    expect(classifyDocument('Home inspection report.pdf')).toBe('reports')
    expect(classifyDocument('rent roll 2026.pdf')).toBe('reports')
    expect(classifyDocument('ALTA settlement statement.pdf')).toBe('closing')
  })

  it('sends what it cannot place to Unfiled, not to a wrong pile', () => {
    // The whole design rests on this: a misfiled disclosure is worse than an
    // unfiled one, because nobody searches a pile they believe is complete.
    expect(classifyDocument('scan_0042.pdf')).toBe('unfiled')
    expect(classifyDocument('IMG_2291.pdf')).toBe('unfiled')
    expect(classifyDocument('')).toBe('unfiled')
  })

  it('takes an agent’s correction over its own guess', () => {
    const name = 'scan_0042.pdf'
    expect(classifyDocument(name, { [name]: 'disclosures' })).toBe('disclosures')
    // …and over a guess it had already made
    expect(classifyDocument('Home inspection report.pdf', { 'Home inspection report.pdf': 'closing' })).toBe('closing')
  })

  it('ignores a correction that names a pile which does not exist', () => {
    expect(classifyDocument('scan_0042.pdf', { 'scan_0042.pdf': 'nonsense' })).toBe('unfiled')
  })

  it('will not let an audit trail be filed as paperwork', () => {
    // Compliance evidence is not a document anyone reads, and a correction that
    // moved one in among the agreements would bury it.
    const name = 'audit-Buyer-Agreement.pdf'
    expect(classifyDocument(name)).toBe('audit')
    expect(classifyDocument(name, { [name]: 'agency' })).toBe('audit')
  })

  it('sees through the upload timestamp', () => {
    expect(classifyDocument('1788554297769-Lead Based Paint.pdf')).toBe('disclosures')
    expect(isAuditTrail('1788554297769-audit-Buyer.pdf')).toBe(true)
    expect(isSignedCopy('1788554297769-signed-Buyer.pdf')).toBe(true)
  })
})

describe('isConfirmed — was this pile chosen, or guessed?', () => {
  it('is true only for a correction or a fact the CRM wrote itself', () => {
    expect(isConfirmed('scan_0042.pdf', { 'scan_0042.pdf': 'reports' })).toBe(true)
    expect(isConfirmed('audit-x.pdf')).toBe(true)
    expect(isConfirmed('Purchase Agreement.pdf')).toBe(false)
  })
})

describe('groupDocuments', () => {
  const files = [
    file('signed-Buyer-Agreement-IA-Agency-Packet.pdf'),
    file('audit-Buyer-Agreement-IA-Agency-Packet.pdf'),
    file('Lead-Based Paint Disclosure.pdf'),
    file('scan_0042.pdf'),
    file('1788554297769-IA_Listing__Marshalltown.pdf'),
  ]

  it('orders the piles the way a transaction produces them', () => {
    expect(groupDocuments(files).map(g => g.id)).toEqual(['agency', 'disclosures', 'audit', 'unfiled'])
  })

  it('drops an empty pile rather than drawing a header over nothing', () => {
    expect(groupDocuments([file('Purchase Agreement.pdf')]).map(g => g.id)).toEqual(['offers'])
    expect(groupDocuments([])).toEqual([])
  })

  it('loses no file', () => {
    const total = groupDocuments(files).reduce((n, g) => n + g.files.length, 0)
    expect(total).toBe(files.length)
  })

  it('hands the row everything it needs to draw itself', () => {
    const agency = groupDocuments(files).find(g => g.id === 'agency')
    expect(agency.files[0]).toMatchObject({
      label: 'Buyer-Agreement-IA-Agency-Packet',
      signed: true,
      audit: false,
      kind: 'agency',
    })
  })

  it('keeps audit trails collapsed by default', () => {
    expect(groupDocuments(files).find(g => g.id === 'audit').closed).toBe(true)
    expect(groupDocuments(files).find(g => g.id === 'agency').closed).toBeUndefined()
  })
})

describe('documentsSummary — the line above the list', () => {
  it('counts what is there, and what still needs filing', () => {
    const groups = groupDocuments([
      file('signed-Buyer-Agreement.pdf'),
      file('scan_0042.pdf'),
      file('scan_0043.pdf'),
    ])
    expect(documentsSummary(groups)).toBe('3 documents · 1 signed · 2 to file')
  })

  it('says nothing about filing when there is nothing to file', () => {
    expect(documentsSummary(groupDocuments([file('Purchase Agreement.pdf')]))).toBe('1 document')
  })

  it('is silent on an empty deal', () => {
    expect(documentsSummary([])).toBeNull()
  })
})

describe('the pile list itself', () => {
  it('offers every pile but Unfiled as a filing choice', () => {
    const ids = assignableKinds().map(k => k.id)
    expect(ids).not.toContain('unfiled')
    expect(ids).toEqual(DOCUMENT_KINDS.filter(k => k.id !== 'unfiled').map(k => k.id))
  })

  it('always resolves an id to something drawable', () => {
    expect(kindById('agency').label).toBe('Agency & listing agreements')
    expect(kindById('nope').id).toBe('unfiled')
    expect(kindById().id).toBe('unfiled')
  })
})
