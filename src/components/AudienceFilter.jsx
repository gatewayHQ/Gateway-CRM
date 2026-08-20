// ─────────────────────────────────────────────────────────────────────────────
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
 * @param onResolved     ({ recipients, skipped, duplicates }) => void — the
 *                       final list, so the parent can send it without
 *                       recomputing (and diverging from) what is shown here
 */
export default function AudienceFilter({
  contacts = [], audience, manual = { added: [], removed: [] },
  onChange, onManualChange, onResolved,
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

      {/* ── Live count + list ── */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 26, fontWeight: 700, color: recipients.length ? 'var(--gw-slate)' : 'var(--gw-mist)' }}>
            {recipients.length}
          </div>
          <div style={{ fontSize: 13, color: 'var(--gw-mist)', flex: 1 }}>
            {recipients.length === 1 ? 'contact will receive this' : 'contacts will receive this'}
            {!hasFilter && <div style={{ fontSize: 12 }}>Select at least one asset type and one side to build an audience.</div>}
          </div>
          {recipients.length > 0 && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowList(v => !v)}>
              {showList ? 'Hide list' : 'Show list'}
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
