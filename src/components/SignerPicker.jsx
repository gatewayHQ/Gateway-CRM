// ─────────────────────────────────────────────────────────────────────────────
// SignerPicker — who signs this role, from a CRM full of people.
//
// WHAT THIS FIXES. Signer rows were two free-text boxes. `seedSignersFromDeal()`
// covers the common case well — client, co-client, agent, co-agent, correctly
// ordered and side-aware — but everyone else was typed by hand: the attorney,
// the lender, the transaction coordinator, the second member of the buying LLC.
// No autocomplete against Contacts, no check that the address was even
// well-formed, and no way to keep a person you had just typed.
//
// A typo in a signer email is the worst kind of failure here, because nothing
// reports it: BoldSign accepts the address, sends to it, and the document sits
// at "waiting" forever while the agent believes the client is ignoring them.
//
// WHY NOT SearchDropdown. That control selects an id and discards anything
// typed. A signer is not a contact id — it is a name and an address that MAY
// correspond to a contact. This is a combobox: pick a known person, or type a
// stranger and keep them.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react'
import { Icon } from './UI.jsx'

// Deliberately the same shape the API validates with, so a value this component
// calls good is one the send will accept.
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export const isValidEmail = (v) => EMAIL_RE.test(String(v || '').trim())

/**
 * Candidate people for a signer row, deduped by email.
 *
 * Order is relevance, not alphabet: the deal's own people first, because on a
 * listing agreement the person you want is nearly always already on the deal;
 * then the agents; then the rest of the address book.
 */
export function buildCandidates({ dealContacts = [], dealAgents = [], contacts = [], agents = [] } = {}) {
  const out = []
  const seen = new Set()
  const add = (person, kind, note) => {
    const name  = String(person?.name || `${person?.first_name || ''} ${person?.last_name || ''}`).trim()
    const email = String(person?.email || '').trim()
    if (!email && !name) return
    const key = (email || name).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push({ id: person?.id || key, name, email, kind, note })
  }
  for (const c of dealContacts) add(c, 'deal', 'on this deal')
  for (const a of dealAgents)   add(a, 'agent', 'agent on this deal')
  for (const a of agents)       add(a, 'agent', 'agent')
  for (const c of contacts)     add(c, 'contact', c?.type || 'contact')
  return out
}

/** Candidates matching what has been typed, most relevant first. */
export function filterCandidates(candidates = [], query = '') {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return candidates.slice(0, 8)
  const hits = candidates.filter(c =>
    c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
  // A name that STARTS with what was typed is what the agent meant.
  hits.sort((a, b) => {
    const as = a.name.toLowerCase().startsWith(q) ? 0 : 1
    const bs = b.name.toLowerCase().startsWith(q) ? 0 : 1
    return as - bs
  })
  return hits.slice(0, 8)
}

/** Is this name/email pair somebody the CRM already knows? */
export function matchKnown(candidates = [], value = {}) {
  const email = String(value?.email || '').trim().toLowerCase()
  if (!email) return null
  return candidates.find(c => c.email.toLowerCase() === email) || null
}

export default function SignerPicker({
  order, roleLabel, color, value = {}, candidates = [], onChange,
  onSaveContact = null, savingContact = false,
}) {
  const [open, setOpen]   = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [touchedEmail, setTouchedEmail] = React.useState(false)

  const name  = value.name || ''
  const email = value.email || ''
  const known = matchKnown(candidates, value)
  const matches = filterCandidates(candidates, query || name)

  const pick = (c) => {
    onChange({ name: c.name, email: c.email })
    setOpen(false)
    setQuery('')
    setTouchedEmail(false)
  }

  // Only complain about an address once the agent has left the box AND typed
  // something. Shouting "invalid email" at an empty field they have not reached
  // yet is how a form teaches people to ignore its warnings.
  const emailBad = touchedEmail && email.trim() !== '' && !isValidEmail(email)

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--gw-mist)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          display: 'inline-flex', width: 18, height: 18, borderRadius: '50%', background: color || '#6b7280',
          color: '#fff', alignItems: 'center', justifyContent: 'center', fontSize: 10, flexShrink: 0,
        }}>{order}</span>
        <span style={{ flex: 1 }}>{roleLabel}</span>
        {/* Which of the three states this row is in, said in one word. */}
        {known && (
          <span style={{ fontWeight: 600, color: 'var(--gw-green)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Icon name="check" size={10} /> {known.note}
          </span>
        )}
        {!known && isValidEmail(email) && (
          <span style={{ fontWeight: 500, color: 'var(--gw-mist)' }}>not in your contacts</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, position: 'relative' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input
            className="form-control"
            placeholder="Search or type a name"
            value={name}
            onChange={e => { onChange({ ...value, name: e.target.value }); setQuery(e.target.value); setOpen(true) }}
            onFocus={() => { setQuery(''); setOpen(true) }}
            // A click on a suggestion has to land before the blur closes it.
            onBlur={() => setTimeout(() => setOpen(false), 180)}
          />
          {open && matches.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff',
              border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)',
              boxShadow: 'var(--shadow-modal)', zIndex: 400, maxHeight: 220, overflowY: 'auto', marginTop: 2,
            }}>
              {matches.map(c => (
                <div
                  key={`${c.kind}-${c.id}`}
                  onMouseDown={() => pick(c)}
                  style={{ padding: '7px 11px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid var(--gw-border)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--gw-bone)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                >
                  <div style={{ fontWeight: 600 }}>{c.name || c.email}</div>
                  <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>
                    {c.email}{c.note ? ` · ${c.note}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <input
          className="form-control"
          style={{ flex: 1, ...(emailBad ? { borderColor: 'var(--gw-red)' } : {}) }}
          placeholder="Email"
          type="email"
          value={email}
          onChange={e => onChange({ ...value, email: e.target.value })}
          onBlur={() => setTouchedEmail(true)}
          aria-invalid={emailBad || undefined}
        />
      </div>

      {/* The failure worth catching before the send, not after: a malformed
          address is accepted by BoldSign, delivered nowhere, and looks exactly
          like a client who is ignoring you. */}
      {emailBad && (
        <div style={{ fontSize: 11, color: 'var(--gw-red)', marginTop: 3 }}>
          That doesn’t look like an email address — check it before sending.
        </div>
      )}

      {/* Somebody real who isn't in the CRM yet. Offered, never automatic: an
          address book that fills itself with every one-off signer is worse than
          one you have to click. */}
      {onSaveContact && !known && name.trim() && isValidEmail(email) && (
        <button
          type="button"
          className="btn btn--link btn--sm"
          style={{ padding: '4px 0 0', fontSize: 11 }}
          onClick={() => onSaveContact({ name: name.trim(), email: email.trim() })}
          disabled={savingContact}
        >
          {savingContact ? 'Saving…' : `+ Save ${name.trim()} to this deal’s contacts`}
        </button>
      )}
    </div>
  )
}
