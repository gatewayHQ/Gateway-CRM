import React from 'react'
import { Icon, SearchDropdown } from './UI.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// ContactMultiSelect — the "Additional Contacts" picker on a deal or property
// (husband & wife, co-buyers, co-owners). Selected contacts render as removable
// chips; the search box below adds more. The primary contact keeps its own
// single-select field — pass its id as `excludeId` so it can't be added twice.
// ─────────────────────────────────────────────────────────────────────────────
export default function ContactMultiSelect({ contacts = [], selectedIds = [], onChange, excludeId = null, placeholder = 'Search contacts to add…' }) {
  const available = contacts.filter(c => c.id !== excludeId && !selectedIds.includes(c.id))
  const selected  = selectedIds.map(id => contacts.find(c => c.id === id)).filter(Boolean)

  return (
    <div>
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {selected.map(c => (
            <span key={c.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px',
              background: 'var(--gw-bone)', border: '1px solid var(--gw-border)',
              borderRadius: 'var(--radius)', fontSize: 12.5, fontWeight: 500,
            }}>
              {c.first_name} {c.last_name}
              <button type="button"
                onClick={() => onChange(selectedIds.filter(id => id !== c.id))}
                aria-label={`Remove ${c.first_name} ${c.last_name}`}
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, lineHeight: 0, color: 'var(--gw-mist)', display: 'inline-flex' }}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <SearchDropdown items={available} value={null}
        onSelect={id => onChange([...selectedIds, id])}
        placeholder={placeholder}
        labelKey={c => `${c.first_name} ${c.last_name}`} />
    </div>
  )
}
