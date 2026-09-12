import { describe, it, expect } from 'vitest'
import { splitRow, isHeaderRow, parseContactList, matchContactList, describeMatch, MAX_ROWS } from '../contactList.js'

// ─────────────────────────────────────────────────────────────────────────────
// Uploading a list of people to email. The stakes here are not tidiness: this
// decides who receives a real email from a real mailbox. The rules that matter
// most are the refusals — never send to someone who unsubscribed, never invent
// a contact, never drop a row silently.
// ─────────────────────────────────────────────────────────────────────────────
const contacts = [
  { id: 'c1', name: 'Janet Hala',   email: 'Janet_Hala@Yahoo.com' },
  { id: 'c2', name: 'Curtis Epling', email: 'curtis@example.com', unsubscribed: true },
  { id: 'c3', name: 'Nic Madsen',   email: 'nic@gatewayre.com', email_opt_out: true },
]

describe('splitRow — a spreadsheet row as people actually export it', () => {
  it('splits on commas, tabs and semicolons', () => {
    expect(splitRow('John,Smith,j@x.com')).toEqual(['John', 'Smith', 'j@x.com'])
    expect(splitRow('John\tSmith\tj@x.com')).toEqual(['John', 'Smith', 'j@x.com'])
    expect(splitRow('John;Smith;j@x.com')).toEqual(['John', 'Smith', 'j@x.com'])
  })

  it('keeps a quoted comma inside its own cell', () => {
    expect(splitRow('"Smith, John",j@x.com')).toEqual(['Smith, John', 'j@x.com'])
  })

  it('unescapes a doubled quote', () => {
    expect(splitRow('"He said ""hi""",j@x.com')).toEqual(['He said "hi"', 'j@x.com'])
  })
})

describe('isHeaderRow', () => {
  it('recognises a header, and never mistakes a person for one', () => {
    expect(isHeaderRow(['First Name', 'Last Name', 'Email'])).toBe(true)
    expect(isHeaderRow(['John', 'Smith', 'j@x.com'])).toBe(false)
    // A row with an email is a person even if a column is called "name"
    expect(isHeaderRow(['name', 'j@x.com'])).toBe(false)
  })
})

describe('parseContactList', () => {
  it('reads a normal CSV with a header', () => {
    const { rows } = parseContactList('First,Last,Email\nJanet,Hala,janet_hala@yahoo.com\nJohn,Smith,j@x.com')
    expect(rows).toEqual([
      { email: 'janet_hala@yahoo.com', name: 'Janet Hala' },
      { email: 'j@x.com', name: 'John Smith' },
    ])
  })

  it('does not care which column the email is in', () => {
    // The agent did not make this file; assuming column order is how a parser
    // silently emails the wrong people.
    const { rows } = parseContactList('j@x.com,John,Smith\nOwner LLC,k@y.com')
    expect(rows.map(r => r.email)).toEqual(['j@x.com', 'k@y.com'])
    expect(rows[1].name).toBe('Owner LLC')
  })

  it('takes a bare column pasted out of a spreadsheet', () => {
    const { rows } = parseContactList('a@x.com\nb@x.com\nc@x.com')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ email: 'a@x.com', name: '' })
  })

  it('lowercases addresses so a match is not missed on capitalisation', () => {
    expect(parseContactList('Janet_Hala@Yahoo.COM').rows[0].email).toBe('janet_hala@yahoo.com')
  })

  it('sends once to an address that appears twice', () => {
    const { rows } = parseContactList('a@x.com\nA@X.com\nb@x.com')
    expect(rows.map(r => r.email)).toEqual(['a@x.com', 'b@x.com'])
  })

  it('reports a line it cannot read instead of dropping it', () => {
    const { rows, unusable } = parseContactList('a@x.com\nJust a name, no address\nb@x.com')
    expect(rows).toHaveLength(2)
    expect(unusable).toEqual([{ line: 2, text: 'Just a name, no address' }])
  })

  it('pulls the address out of a "Name <email>" cell', () => {
    expect(parseContactList('Janet Hala <janet@x.com>').rows[0].email).toBe('janet@x.com')
  })

  it('stops at the row cap and says so', () => {
    const huge = Array.from({ length: MAX_ROWS + 40 }, (_, i) => `p${i}@x.com`).join('\n')
    const out = parseContactList(huge)
    expect(out.rows).toHaveLength(MAX_ROWS)
    expect(out.truncated).toBe(true)
  })

  it('handles nothing at all', () => {
    expect(parseContactList('').rows).toEqual([])
    expect(parseContactList().rows).toEqual([])
  })
})

describe('matchContactList — who actually gets the email', () => {
  const parsed = parseContactList([
    'janet_hala@yahoo.com',      // matches c1
    'curtis@example.com',        // matches c2 — unsubscribed
    'nic@gatewayre.com',         // matches c3 — opted out
    'stranger@new.com',          // nobody
  ].join('\n'))

  it('never sends to somebody who unsubscribed, however they opted out', () => {
    const m = matchContactList(parsed.rows, contacts)
    expect(m.unsubscribed.map(u => u.email)).toEqual(['curtis@example.com', 'nic@gatewayre.com'])
    expect(m.recipients.map(r => r.email)).not.toContain('curtis@example.com')
    expect(m.recipients.map(r => r.email)).not.toContain('nic@gatewayre.com')
  })

  it('matches on email regardless of capitalisation', () => {
    const m = matchContactList(parsed.rows, contacts)
    expect(m.matched).toHaveLength(1)
    expect(m.matched[0].contact.id).toBe('c1')
  })

  it('reports an address that is nobody as new, rather than inventing a contact', () => {
    const m = matchContactList(parsed.rows, contacts)
    expect(m.fresh.map(f => f.email)).toEqual(['stranger@new.com'])
    expect(m.recipients.find(r => r.email === 'stranger@new.com').contact_id).toBeNull()
  })

  it('prefers the contact’s own name over whatever the file called them', () => {
    const rows = parseContactList('Jan Hala-Smith,janet_hala@yahoo.com').rows
    const m = matchContactList(rows, contacts)
    expect(m.recipients[0].name).toBe('Janet Hala')
  })

  it('hands back a recipient list that is already safe to send', () => {
    const m = matchContactList(parsed.rows, contacts)
    expect(m.recipients).toHaveLength(2)   // 1 matched + 1 new; both opt-outs gone
  })
})

describe('describeMatch — the line under the upload box', () => {
  it('says what was dropped and why', () => {
    const parsed = parseContactList('janet_hala@yahoo.com\ncurtis@example.com\nno address here')
    const match  = matchContactList(parsed.rows, contacts)
    const line   = describeMatch('okoboji-owners.csv', parsed, match)
    expect(line).toContain('okoboji-owners.csv')
    expect(line).toContain('1 matched a contact')
    expect(line).toContain('1 unsubscribed — skipped')
    expect(line).toContain('1 line had no email address')
  })

  it('stays quiet about problems that did not happen', () => {
    const parsed = parseContactList('janet_hala@yahoo.com')
    const line = describeMatch('clean.csv', parsed, matchContactList(parsed.rows, contacts))
    expect(line).not.toContain('unsubscribed')
    expect(line).not.toContain('no email address')
  })
})
