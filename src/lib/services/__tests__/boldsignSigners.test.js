// Per-signer state. The failure this replaces: one status chip for a whole
// four-party packet, so an agent could see it was unsigned and not see who was
// holding it up — the only fact that decides what they do next.
import { describe, it, expect } from 'vitest'
import {
  normalizeSignerStatus, normalizeSigner, normalizeSigners, signerRows,
  outstandingSigners, signerProgress, waitingOnLabel, describeSignerState, isOutstanding,
} from '../boldsignSigners.js'

describe('normalizeSignerStatus', () => {
  it('maps every spelling BoldSign reports', () => {
    expect(normalizeSignerStatus('Completed')).toBe('signed')
    expect(normalizeSignerStatus('Signed')).toBe('signed')
    expect(normalizeSignerStatus('Declined')).toBe('declined')
    expect(normalizeSignerStatus('Revoked')).toBe('revoked')
    expect(normalizeSignerStatus('Expired')).toBe('expired')
  })

  // BoldSign says NotCompleted for everyone who hasn't finished, whatever the
  // reason. "Have they even opened it" is the distinction an agent acts on, and
  // it comes from a separate flag.
  it('splits "not finished" by whether they have opened it', () => {
    expect(normalizeSignerStatus('NotCompleted')).toBe('waiting')
    expect(normalizeSignerStatus('NotCompleted', { viewed: true })).toBe('viewed')
    expect(normalizeSignerStatus('', { viewed: true })).toBe('viewed')
    expect(normalizeSignerStatus(undefined)).toBe('waiting')
  })

  // These rows are persisted to boldsign_documents.signers and read back, so
  // this function sees its own output as often as it sees BoldSign's. `queued`
  // is ours; without round-tripping it decayed to `waiting` on every reload,
  // turning "not their turn" into "chase this person".
  it('round-trips its own output', () => {
    for (const v of ['queued', 'waiting', 'viewed', 'signed', 'declined', 'expired', 'revoked']) {
      expect(normalizeSignerStatus(v)).toBe(v)
    }
  })
})

describe('normalizeSigner', () => {
  it('reads both naming conventions — ad-hoc sends and template sends differ', () => {
    expect(normalizeSigner({ signerName: 'Jane', signerEmail: 'j@x.com', signerRole: 'Buyer', order: 2 }))
      .toMatchObject({ name: 'Jane', email: 'j@x.com', role: 'Buyer', order: 2 })
    expect(normalizeSigner({ name: 'John', emailAddress: 'jo@x.com' }, 0))
      .toMatchObject({ name: 'John', email: 'jo@x.com', order: 1 })
  })

  it('takes epoch seconds or an ISO string, and never yields an Invalid Date', () => {
    expect(normalizeSigner({ name: 'A', status: 'Completed', signedDate: 1767225600 }).signedAt)
      .toBe(new Date(1767225600 * 1000).toISOString())
    expect(normalizeSigner({ name: 'A', signedDate: '2026-08-01T10:00:00Z' }).signedAt).toBe('2026-08-01T10:00:00.000Z')
    expect(normalizeSigner({ name: 'A', signedDate: 'nonsense' }).signedAt).toBeNull()
  })

  it('drops an entry with nobody in it', () => {
    expect(normalizeSigner({ order: 1 })).toBeNull()
    expect(normalizeSigner(null)).toBeNull()
  })

  it('treats a view date as having viewed it, however the flag arrives', () => {
    expect(normalizeSigner({ name: 'A', status: 'NotCompleted', isViewed: true }).status).toBe('viewed')
    expect(normalizeSigner({ name: 'A', status: 'NotCompleted', viewedDate: 1767225600 }).status).toBe('viewed')
    expect(normalizeSigner({ name: 'A', status: 'NotCompleted', isViewed: 'true' }).status).toBe('viewed')
  })
})

describe('signing order', () => {
  const three = [
    { signerName: 'Client',  status: 'Completed',    order: 1 },
    { signerName: 'Co-buyer', status: 'NotCompleted', order: 2 },
    { signerName: 'Agent',   status: 'NotCompleted', order: 3 },
  ]

  it('sorts into signing order whatever order BoldSign returns', () => {
    const rows = normalizeSigners([...three].reverse())
    expect(rows.map(r => r.name)).toEqual(['Client', 'Co-buyer', 'Agent'])
  })

  // On a sequential send BoldSign has not emailed the people behind the active
  // signer. Showing them as "waiting" sends an agent chasing someone who has
  // never been asked — and a reminder to them is a reminder about nothing.
  it('marks everyone behind the active signer as queued on a sequential send', () => {
    const rows = normalizeSigners(three, { inOrder: true })
    expect(rows.map(r => r.status)).toEqual(['signed', 'waiting', 'queued'])
  })

  it('leaves everyone waiting on a parallel send — they all have it right now', () => {
    const rows = normalizeSigners(three, { inOrder: false })
    expect(rows.map(r => r.status)).toEqual(['signed', 'waiting', 'waiting'])
  })

  it('never demotes someone who has already opened it', () => {
    const rows = normalizeSigners([
      { signerName: 'A', status: 'NotCompleted', order: 1 },
      { signerName: 'B', status: 'NotCompleted', order: 2, isViewed: true },
    ], { inOrder: true })
    expect(rows.map(r => r.status)).toEqual(['waiting', 'viewed'])
  })
})

describe('signerRows — reading a stored document row', () => {
  it('uses the stored signer array when there is one', () => {
    const rows = signerRows({ signers: [{ name: 'Jane', status: 'signed' }, { name: 'John', status: 'waiting' }] })
    expect(rows.map(r => r.status)).toEqual(['signed', 'waiting'])
  })

  // Documents sent before per-signer state was captured still have to render as
  // people rather than as one comma-joined string.
  it('falls back to the legacy comma-joined columns', () => {
    const rows = signerRows({ signer_name: 'Jane Doe, John Doe', signer_email: 'j@x.com, jo@x.com', status: 'sent' })
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ name: 'John Doe', email: 'jo@x.com', order: 2, status: 'waiting' })
  })

  it('calls a completed legacy document signed by everyone, because it was', () => {
    const rows = signerRows({ signer_name: 'Jane Doe, John Doe', status: 'completed', completed_at: '2026-08-01T00:00:00Z' })
    expect(rows.every(r => r.status === 'signed')).toBe(true)
  })

  it('is empty, not broken, for a row with nothing recorded', () => {
    expect(signerRows({})).toEqual([])
    expect(signerRows(null)).toEqual([])
  })
})

describe('who to chase', () => {
  const rows = normalizeSigners([
    { signerName: 'Jane', status: 'Completed',    order: 1 },
    { signerName: 'John', status: 'NotCompleted', order: 2, isViewed: true },
    { signerName: 'Amy',  status: 'NotCompleted', order: 3 },
  ])

  it('excludes anyone who has already signed — reminding them teaches clients to ignore us', () => {
    expect(outstandingSigners(rows).map(r => r.name)).toEqual(['John', 'Amy'])
    expect(isOutstanding('signed')).toBe(false)
    expect(isOutstanding('declined')).toBe(false)
    expect(isOutstanding('queued')).toBe(true)
  })

  it('counts progress honestly', () => {
    expect(signerProgress(rows)).toEqual({ signed: 1, total: 3 })
    expect(signerProgress([])).toEqual({ signed: 0, total: 0 })
  })
})

describe('waitingOnLabel', () => {
  it('names one person when one person is holding it up', () => {
    expect(waitingOnLabel(normalizeSigners([
      { signerName: 'Jane', status: 'Completed', order: 1 },
      { signerName: 'John', status: 'NotCompleted', order: 2 },
    ]))).toBe('waiting on John')
  })

  it('leads with whoever can actually act, on a sequential send', () => {
    const rows = normalizeSigners([
      { signerName: 'Client', status: 'NotCompleted', order: 1 },
      { signerName: 'Agent',  status: 'NotCompleted', order: 2 },
      { signerName: 'Broker', status: 'NotCompleted', order: 3 },
    ], { inOrder: true })
    expect(waitingOnLabel(rows)).toBe('waiting on Client and 2 others')
  })

  it('says a decline outright — it outranks everything else on the row', () => {
    expect(waitingOnLabel(normalizeSigners([
      { signerName: 'Jane', status: 'Completed', order: 1 },
      { signerName: 'John', status: 'Declined',  order: 2 },
    ]))).toBe('declined by John')
  })

  it('says when there is nothing left to wait for', () => {
    expect(waitingOnLabel(normalizeSigners([{ signerName: 'Jane', status: 'Completed' }]))).toBe('everyone has signed')
    expect(waitingOnLabel([])).toBe('no recipients recorded')
  })
})

describe('describeSignerState', () => {
  it('says what happened, in the words an agent would use', () => {
    expect(describeSignerState({ status: 'signed', signedAt: '2026-08-14T00:00:00Z' })).toMatch(/^signed Aug 1[34]$/)
    expect(describeSignerState({ status: 'signed' })).toBe('signed')
    expect(describeSignerState({ status: 'viewed' })).toBe('opened, not signed')
    expect(describeSignerState({ status: 'waiting' })).toBe('not opened yet')
    expect(describeSignerState({ status: 'queued' })).toBe('not their turn yet')
    expect(describeSignerState({ status: 'declined' })).toBe('declined')
  })
})
