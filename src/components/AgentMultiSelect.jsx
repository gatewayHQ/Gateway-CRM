import React from 'react'
import { Icon, Avatar, SearchDropdown } from './UI.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// AgentMultiSelect — the "Additional Agents" picker on a deal (deals.co_agent_ids).
// Selected agents render the same way the deal page's "Agents on deal" card
// does — avatar, name, role — as removable rows; the search box below adds
// more. The primary/assigned agent keeps its own single-select field — pass
// its id as `excludeId` so it can't be added twice.
// ─────────────────────────────────────────────────────────────────────────────
export default function AgentMultiSelect({ agents = [], selectedIds = [], onChange, excludeId = null, placeholder = 'Search agents to add…' }) {
  const available = agents.filter(a => a.id !== excludeId && !selectedIds.includes(a.id))
  const selected  = selectedIds.map(id => agents.find(a => a.id === id)).filter(Boolean)

  return (
    <div>
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {selected.map(a => (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '4px 9px',
              background: 'var(--gw-bone)', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)',
            }}>
              <Avatar agent={a} size={20} />
              <span style={{ fontSize: 12.5, fontWeight: 500, flex: 1 }}>{a.name}</span>
              {a.role && <span style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{a.role}</span>}
              <button type="button"
                onClick={() => onChange(selectedIds.filter(id => id !== a.id))}
                aria-label={`Remove ${a.name}`}
                style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, lineHeight: 0, color: 'var(--gw-mist)', display: 'inline-flex' }}>
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <SearchDropdown items={available} value={null}
        onSelect={id => onChange([...selectedIds, id])}
        placeholder={placeholder}
        labelKey="name" />
    </div>
  )
}
