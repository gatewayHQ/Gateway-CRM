// The signer picker. Two failures matter: retyping somebody the CRM already
// knows, and a typo'd address — which is the worst failure in this whole
// integration because nothing reports it. BoldSign accepts the address, sends
// to it, and the document sits at "waiting" forever while the agent believes
// the client is ignoring them.
import { describe, it, expect } from 'vitest'
import { buildCandidates, filterCandidates, matchKnown, isValidEmail } from '../SignerPicker.jsx'

const contacts = [
  { id: 'c1', first_name: 'Jane',  last_name: 'Doe',   email: 'jane@example.com',  type: 'buyer' },
  { id: 'c2', first_name: 'John',  last_name: 'Doe',   email: 'john@example.com',  type: 'buyer' },
  { id: 'c3', first_name: 'Priya', last_name: 'Shah',  email: 'priya@example.com', type: 'seller' },
]
const dealAgents = [{ id: 'a1', name: 'Alex Agent', email: 'alex@gatewayreadvisors.com' }]

describe('buildCandidates', () => {
  // On a listing agreement the signer is nearly always already on the deal, so
  // relevance beats alphabetical every time.
  it('puts the deal’s own people first, then agents, then the address book', () => {
    const out = buildCandidates({
      dealContacts: [contacts[2]],
      dealAgents,
      contacts,
    })
    expect(out.map(c => c.email)).toEqual([
      'priya@example.com',                 // on this deal
      'alex@gatewayreadvisors.com',        // agent on this deal
      'jane@example.com',
      'john@example.com',
    ])
    expect(out[0].note).toBe('on this deal')
  })

  it('dedupes by email so a deal contact is not offered twice', () => {
    const out = buildCandidates({ dealContacts: [contacts[0]], contacts })
    expect(out.filter(c => c.email === 'jane@example.com')).toHaveLength(1)
    expect(out[0].note).toBe('on this deal')
  })

  it('composes a name from first and last, and survives people with neither', () => {
    const out = buildCandidates({ contacts: [{ id: 'x', first_name: 'Jane', last_name: 'Doe', email: 'j@x.com' }] })
    expect(out[0].name).toBe('Jane Doe')
    expect(buildCandidates({ contacts: [{ id: 'y' }] })).toEqual([])
  })

  it('is empty rather than broken with nothing to offer', () => {
    expect(buildCandidates()).toEqual([])
    expect(buildCandidates({ contacts: [] })).toEqual([])
  })
})

describe('filterCandidates', () => {
  const all = buildCandidates({ contacts, dealAgents })

  it('matches on name or email', () => {
    expect(filterCandidates(all, 'jane').map(c => c.email)).toEqual(['jane@example.com'])
    expect(filterCandidates(all, 'priya@').map(c => c.email)).toEqual(['priya@example.com'])
  })

  // "Doe" matches both; typing "John" should not make you scan past Jane.
  it('ranks a name that starts with what was typed above one that merely contains it', () => {
    const withSmith = buildCandidates({ contacts: [...contacts, { id: 'c4', first_name: 'Bo', last_name: 'Janes', email: 'bo@example.com' }] })
    expect(filterCandidates(withSmith, 'jane')[0].email).toBe('jane@example.com')
  })

  it('is case-insensitive and ignores surrounding space', () => {
    expect(filterCandidates(all, '  JANE  ').map(c => c.email)).toEqual(['jane@example.com'])
  })

  it('offers a starting shortlist before anything is typed', () => {
    expect(filterCandidates(all, '').length).toBeGreaterThan(0)
    expect(filterCandidates(all, '').length).toBeLessThanOrEqual(8)
  })

  it('returns nothing for a stranger rather than a wrong guess', () => {
    expect(filterCandidates(all, 'zzzz')).toEqual([])
  })
})

describe('matchKnown', () => {
  const all = buildCandidates({ contacts, dealAgents })

  it('recognises a signer by email, whatever they were typed as', () => {
    expect(matchKnown(all, { name: 'J. Doe', email: 'jane@example.com' })?.name).toBe('Jane Doe')
    expect(matchKnown(all, { email: 'JANE@EXAMPLE.COM' })?.name).toBe('Jane Doe')
  })

  it('says nothing for a stranger — typing one is allowed, not an error', () => {
    expect(matchKnown(all, { name: 'New Person', email: 'new@example.com' })).toBeNull()
    expect(matchKnown(all, {})).toBeNull()
    expect(matchKnown(all, { name: 'Jane Doe' })).toBeNull()   // a name alone is not identity
  })
})

describe('isValidEmail', () => {
  // Deliberately the same rule the API validates with, so a value the picker
  // calls good is one the send will accept.
  it('accepts what BoldSign will accept', () => {
    for (const e of ['jane@example.com', 'a.b+c@sub.example.co.uk', 'x@y.io']) {
      expect(isValidEmail(e), e).toBe(true)
    }
  })

  it('rejects the shapes that silently fail a send', () => {
    for (const e of ['jane@example', 'jane.example.com', 'jane @example.com', '@example.com', 'jane@', '', null, undefined]) {
      expect(isValidEmail(e), String(e)).toBe(false)
    }
  })
})
