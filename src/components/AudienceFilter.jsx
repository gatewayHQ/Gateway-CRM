// ─────────────────────────────────────────────────────────────────────────────
import { parseContactList, matchContactList, describeMatch } from '../lib/services/contactList.js'
// AudienceFilter — pick who a mass email goes to, by asset type and market side.
//
// Standalone from the deal-announcement wizard on purpose: "everyone who buys
// or sells multifamily" is a question an agent asks for reasons other than a
// closing announcement, so the segmentation half of this feature is a component
// any future send screen can mount.
//
// The rules live in src/lib/audience.js (pure + unit-tested); this file is the
// surface for them. Every number shown here is computed from the same functions
// the server re-checks at send time, so the count an agent approves is the count
// that gets mailed — minus anything that changed in between, which the send
// reports rather than hides.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react'
import { Icon, SearchDropdown } from './UI.jsx'
import ChipToggleGroup from './ChipToggleGroup.jsx'
import {
  AUDIENCE_SIDES, AUDIENCE_SIDE_LABELS, AUDIENCE_SIDE_HINTS,
  resolveAudience, dedupeByEmail, unreachableReason, matchesAudience,
} from '../lib/audience.js'

const cardStyle = {
  border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)',
  background: '#fff', padding: 16, marginBottom: 14,
}

/**
 * @param contacts  every contact the agent may see (already RLS-scoped)
 * @param audience  { assetTypes, sides }
 * @param manual    { added: [ids], removed: [ids] } — the agent's hand edits
 * @param onChange  (audience) => void
 * @param onManualChange (manual) => void
 * @param listRecipients [{ email, name }] — addresses off a pasted/uploaded
 *                       list that are NOT contacts and are mailed as
 *                       themselves. Lifted to the parent because they are part
 *                       of the send, not of this filter's state.
 * @param listSource     the file name or 'pasted list', for the blast record
 * @param onListChange   (listRecipients, listSource) => void
 * @param onResolved     ({ recipients, skipped, duplicates }) => void — the
 *                       final list, so the parent can send it without
 *                       recomputing (and diverging from) what is shown here
 */
export default function AudienceFilter({
  contacts = [], audience, manual = { added: [], removed: [] },
  listRecipients = [], listSource = '',
  onChange, onManualChange, onResolved, onListChange,
}) {
  const [showList, setShowList] = useState(true)

  const { recipients, skipped, duplicates } = useMemo(() => {
    const { recipients: matched, skipped: unreachable } = resolveAudience(contacts, audience, manual)
    const { unique, duplicates: dupes } = dedupeByEmail(matched)
    return { recipients: unique, skipped: unreachable, duplicates: dupes }
  }, [contacts, audience, manual])

  // Report upward during render's commit, not in an effect chained off state:
  // the parent's "Send to N" button must never be able to describe a different
  // list than the one on screen.
  React.useEffect(() => {
    onResolved?.({ recipients, skipped, duplicates })
  }, [recipients, skipped, duplicates])   // eslint-disable-line react-hooks/exhaustive-deps

  // Contacts + pasted addresses. The one number the agent is deciding on, and
  // the one the send has to agree with.
  const totalRecipients = recipients.length + listRecipients.length

  const toggleSide = (side) => {
    const sides = audience.sides.includes(side)
      ? audience.sides.filter(s => s !== side)
      : [...audience.sides, side]
    onChange({ ...audience, sides })
  }

  const matchedIds = useMemo(() => new Set(recipients.map(c => c.id)), [recipients])

  // Anyone not already on the list is addable by hand — including contacts the
  // filter never considered. An agent who knows a name the criteria missed
  // shouldn't have to edit the contact record to include them in one send.
  const addable = useMemo(
    () => contacts
      .filter(c => !matchedIds.has(c.id))
      .map(c => ({ ...c, name: `${c.first_name} ${c.last_name}${c.email ? ` · ${c.email}` : ' · no email'}` })),
    [contacts, matchedIds])

  const addContact = (id) => {
    const added   = [...new Set([...(manual.added || []), id])]
    const removed = (manual.removed || []).filter(x => x !== id)
    onManualChange?.({ added, removed })
  }

  // ─── "Here are the people I want this to go to." ─────────────────────────
  // An agent with a spreadsheet of owners had no way in: the audience could
  // only be built from filters over contacts already in the CRM. A pasted list
  // is matched against the contact book by email — and, since migration 0048,
  // the addresses that match NOBODY are mailable too, as themselves.
  //
  // It still does not create contacts, and that is the point rather than a
  // limitation: 122 unqualified addresses off a county roll would bury a
  // working contact book, and the proper importer on the Contacts page (column
  // mapping, de-duplication, agent assignment) is still where a real contact
  // comes from. A list recipient's record is their row on the send: status,
  // opens, replies and opt-out all live there.
  const [listOpen,  setListOpen]  = useState(false)
  const [listText,  setListText]  = useState('')
  const [listName,  setListName]  = useState('')
  const [listMatch, setListMatch] = useState(null)

  const readList = (text, name = '') => {
    setListText(text)
    setListName(name)
    const parsed = parseContactList(text)
    setListMatch({ parsed, match: matchContactList(parsed.rows, contacts) })
  }

  /**
   * Take the whole list into the send: matched rows join as contacts, unmatched
   * addresses join as themselves.
   *
   * One button rather than two, because "add the 0 that matched" was the only
   * thing the old UI offered on a file where nothing matched — which is the
   * normal case for a county roll, and read as the feature being broken.
   */
  const addWholeList = () => {
    const ids = (listMatch?.match?.matched || []).map(m => m.contact?.id).filter(Boolean)
    if (ids.length) {
      const added   = [...new Set([...(manual.added || []), ...ids])]
      const removed = (manual.removed || []).filter(x => !ids.includes(x))
      onManualChange?.({ added, removed })
    }

    // Unsubscribed rows are NOT here: matchContactList already separated them,
    // and they stay separated. The server checks the suppression list again at
    // send time, so this is the friendly half of a guarantee rather than the
    // whole of it.
    const fresh = listMatch?.match?.fresh || []
    if (fresh.length) {
      const byEmail = new Map(listRecipients.map(r => [String(r.email).toLowerCase(), r]))
      for (const row of fresh) {
        const key = String(row.email || '').toLowerCase()
        if (key && !byEmail.has(key)) byEmail.set(key, { email: row.email, name: row.name || '' })
      }
      onListChange?.([...byEmail.values()], listSource || listName || 'pasted list')
    }
  }

  const removeListRecipient = (email) => {
    const key  = String(email || '').toLowerCase()
    const next = listRecipients.filter(r => String(r.email).toLowerCase() !== key)
    onListChange?.(next, next.length ? (listSource || listName || 'pasted list') : '')
  }

  const clearListRecipients = () => onListChange?.([], '')

  // How many of the parsed rows are already on the send, so the button can stop
  // offering to add a list the agent has already added.
  const listOnSend = useMemo(() => {
    const onSend = new Set(listRecipients.map(r => String(r.email).toLowerCase()))
    const rows   = listMatch?.match?.fresh || []
    return rows.filter(r => onSend.has(String(r.email || '').toLowerCase())).length
  }, [listRecipients, listMatch])

  const removeContact = (id) => {
    // A contact the filter matched is suppressed via `removed`; one the agent
    // added by hand is simply un-added. Keeping those apart is what lets the
    // filter be re-run without resurrecting a name the agent took off.
    const wasManual = (manual.added || []).includes(id)
    onManualChange?.({
      added:   wasManual ? (manual.added || []).filter(x => x !== id) : (manual.added || []),
      removed: wasManual ? (manual.removed || []) : [...new Set([...(manual.removed || []), id])],
    })
  }

  const removedContacts = (manual.removed || [])
    .map(id => contacts.find(c => c.id === id))
    .filter(Boolean)

  const hasFilter = (audience.assetTypes || []).length > 0 && (audience.sides || []).length > 0

  return (
    <div>
      {/* ── Upload a list ── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label className="form-label" style={{ margin: 0, flex: 1 }}>
            Have a list already?
            <span style={{ fontWeight: 400, color: 'var(--gw-mist)' }}> — paste it or upload a CSV</span>
          </label>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setListOpen(o => !o)}>
            {listOpen ? 'Hide' : 'Upload a list'}
          </button>
        </div>

        {listOpen && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <label className="btn btn--secondary btn--sm" style={{ cursor: 'pointer' }}>
                Choose a CSV
                <input
                  type="file" accept=".csv,.txt,text/csv,text/plain" style={{ display: 'none' }}
                  onChange={async e => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (!file) return
                    readList(await file.text(), file.name)
                  }}
                />
              </label>
              <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>or paste addresses below — one per line, or a whole spreadsheet row</span>
            </div>

            <textarea
              className="form-control form-control--textarea" style={{ minHeight: 78, fontSize: 12.5 }}
              value={listText}
              placeholder={'janet@example.com\nSmith, John\tjohn@example.com'}
              onChange={e => readList(e.target.value, listName)}
            />

            {listMatch && (
              <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--gw-mist)' }}>
                <div>{describeMatch(listName, listMatch.parsed, listMatch.match)}</div>

                {listMatch.match.unsubscribed.length > 0 && (
                  <div style={{ color: 'var(--gw-red)' }}>
                    {listMatch.match.unsubscribed.length} on this list {listMatch.match.unsubscribed.length === 1 ? 'has' : 'have'} unsubscribed
                    and will not be emailed, whichever list they appear on.
                  </div>
                )}

                {listMatch.match.fresh.length > 0 && (
                  <div>
                    {listMatch.match.fresh.length} address{listMatch.match.fresh.length === 1 ? ' is' : 'es are'} not a contact —
                    {listMatch.match.fresh.length === 1 ? ' it' : ' they'} can still be emailed, and no contact record is created.
                    {' '}To make {listMatch.match.fresh.length === 1 ? 'it a real contact' : 'them real contacts'} instead, use the
                    importer on the <strong>Contacts</strong> page.
                  </div>
                )}

                {(listMatch.match.matched.length + listMatch.match.fresh.length) > 0 && (
                  <button type="button" className="btn btn--primary btn--sm" style={{ marginTop: 6 }}
                          onClick={addWholeList}
                          disabled={listOnSend === listMatch.match.fresh.length && listMatch.match.matched.length === 0}>
                    {listOnSend === listMatch.match.fresh.length && listMatch.match.matched.length === 0
                      ? 'Already added to this send'
                      : `Add all ${listMatch.match.matched.length + listMatch.match.fresh.length} to this send`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Asset types ── */}
      <div style={cardStyle}>
        <label className="form-label">Asset Types</label>
        <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 10 }}>
          Contacts matching <strong>any</strong> of the selected types are included.
        </div>
        <ChipToggleGroup
          fieldKey="asset_type"
          value={audience.assetTypes || []}
          onChange={(assetTypes) => onChange({ ...audience, assetTypes })}
          mode="grid"
          allowAdd={false}
        />
      </div>

      {/* ── Sides ── */}
      <div style={cardStyle}>
        <label className="form-label">Match against</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
          {AUDIENCE_SIDES.map(side => {
            const on = (audience.sides || []).includes(side)
            return (
              <button key={side} type="button" onClick={() => toggleSide(side)}
                style={{
                  flex: '1 1 220px', textAlign: 'left', cursor: 'pointer',
                  padding: '10px 12px', borderRadius: 'var(--radius)',
                  border: `1px solid ${on ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                  background: on ? 'var(--gw-sky)' : '#fff',
                  fontFamily: 'var(--font-body)',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 600, fontSize: 13 }}>
                  <Icon name={on ? 'check' : 'plus'} size={12} />
                  {AUDIENCE_SIDE_LABELS[side]}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--gw-mist)', marginTop: 3 }}>
                  {AUDIENCE_SIDE_HINTS[side]}
                </div>
              </button>
            )
          })}
        </div>
        {(audience.sides || []).length === 0 && (
          <div style={{ fontSize: 12, color: '#b45309', marginTop: 10 }}>
            Pick at least one — with neither selected, nobody matches.
          </div>
        )}
      </div>

      {/* ── Addresses off a list, on this send ──
          Their own card rather than mixed into the contact list: these people
          have no contact record, so "open the contact" is not an action that
          exists for them and a row that looked identical would imply it did. */}
      {listRecipients.length > 0 && (
        <div style={cardStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <label className="form-label" style={{ margin: 0, flex: 1 }}>
              {listRecipients.length} address{listRecipients.length === 1 ? '' : 'es'} from your list
              <span style={{ fontWeight: 400, color: 'var(--gw-mist)' }}>
                {listSource ? ` — ${listSource}` : ''} · not contacts, and none will be created
              </span>
            </label>
            <button type="button" className="btn btn--ghost btn--sm" onClick={clearListRecipients}>
              Remove all
            </button>
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)' }}>
            {listRecipients.map(r => (
              <div key={r.email} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
                borderBottom: '1px solid var(--gw-border)', fontSize: 12.5,
              }}>
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.name ? <span style={{ fontWeight: 600 }}>{r.name} · </span> : null}
                  <span style={{ color: 'var(--gw-mist)' }}>{r.email}</span>
                </div>
                <button type="button" className="btn btn--ghost btn--icon btn--sm"
                  onClick={() => removeListRecipient(r.email)} title="Remove from this send">
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 8 }}>
            Each still gets their own individual email with a working unsubscribe link. Opens, replies and
            opt-outs are tracked on this send's report rather than on a contact timeline.
          </div>
        </div>
      )}

      {/* ── Live count + list ── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: totalRecipients ? 'var(--gw-slate)' : 'var(--gw-mist)' }}>
            {totalRecipients}
          </div>
          <div style={{ fontSize: 13, color: 'var(--gw-mist)', flex: 1 }}>
            {totalRecipients === 1 ? 'recipient will receive this' : 'recipients will receive this'}
            {listRecipients.length > 0 && recipients.length > 0 && (
              <div style={{ fontSize: 12 }}>
                {recipients.length} from your contacts · {listRecipients.length} from your list
              </div>
            )}
            {!hasFilter && listRecipients.length === 0 && (
              <div style={{ fontSize: 12 }}>Select at least one asset type and one side to build an audience — or paste a list above.</div>
            )}
          </div>
          {recipients.length > 0 && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowList(v => !v)}>
              {showList ? 'Hide contacts' : 'Show contacts'}
            </button>
          )}
        </div>

        {showList && recipients.length > 0 && (
          <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)' }}>
            {recipients.map(c => (
              <div key={c.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
                borderBottom: '1px solid var(--gw-border)', fontSize: 13,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {c.first_name} {c.last_name}
                    {!matchesAudience(c, audience) && (
                      <span style={{ marginLeft: 7, fontSize: 10.5, color: 'var(--gw-azure)', fontWeight: 600 }}>ADDED</span>
                    )}
                  </div>
                  <div style={{ color: 'var(--gw-mist)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.email} · {c.type}{c.asset_types?.length ? ` · ${c.asset_types.join(', ')}` : ''}
                  </div>
                </div>
                <button type="button" className="btn btn--ghost btn--icon btn--sm"
                  onClick={() => removeContact(c.id)} title="Remove from this send">
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <label className="form-label">Add someone the filter missed</label>
          <SearchDropdown items={addable} onSelect={addContact} value={null}
            placeholder="Search contacts to add…" />
        </div>
      </div>

      {/* ── What was left out, and why ── */}
      {(skipped.length > 0 || duplicates.length > 0 || removedContacts.length > 0) && (
        <div style={{ ...cardStyle, background: 'var(--gw-bone)' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 8 }}>Not receiving this send</div>
          {[...skipped, ...duplicates].map(({ contact: c, reason }) => (
            <div key={`${c.id}-${reason}`} style={{ fontSize: 12.5, color: 'var(--gw-mist)', padding: '3px 0' }}>
              {c.first_name} {c.last_name} — {reason}
            </div>
          ))}
          {removedContacts.map(c => (
            <div key={c.id} style={{ fontSize: 12.5, color: 'var(--gw-mist)', padding: '3px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{c.first_name} {c.last_name} — removed by you{unreachableReason(c) ? ` (${unreachableReason(c)})` : ''}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => addContact(c.id)}>Undo</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
