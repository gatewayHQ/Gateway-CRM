// ─────────────────────────────────────────────────────────────────────────────
// CoAgentPicker — the co-agent half of a record's agent roster, rendered as
// dropdowns that visually match the "Assigned Agent" field it sits under.
//
// Deliberately NOT a checkbox list: on the Details pages the primary agent is a
// <select>, so co-agents are too. Same block, same control, reading top-to-bottom
// as "Assigned Agent → Co-Agent" — which is how agents describe a co-listing.
//
// Supports 1..N co-agents (a trailing empty select appears while assignable
// agents remain) but optimizes for the common dual-agent case: one extra row.
// The primary and already-chosen co-agents are excluded from every option list,
// so the same agent can never be picked twice or shadow the primary.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react'
import { Icon, Avatar } from './UI.jsx'

export default function CoAgentPicker({
  agents = [],
  primaryAgentId = null,
  value = [],
  onChange,
  label = 'Co-Agent',
  hint = 'shares the commission — appears on the pipeline card and generated paperwork',
}) {
  const chosen = (value || []).filter(Boolean)
  // Everyone eligible to be A co-agent: not the primary.
  const eligible = agents.filter(a => a.id !== primaryAgentId)
  // Rows to render: each existing pick, plus one blank row to add another.
  const remaining = eligible.filter(a => !chosen.includes(a.id))
  const rows = [...chosen, ...(remaining.length ? [''] : [])]

  if (!eligible.length) return null

  const setAt = (i, id) => {
    const next = [...chosen]
    if (id) next[i] = id
    else next.splice(i, 1)          // cleared → drop the row
    onChange(next.filter(Boolean))
  }

  return (
    <div className="form-group">
      <label className="form-label">
        {label}
        {hint && (
          <span style={{ fontWeight: 400, color: 'var(--gw-mist)', marginLeft: 6, fontSize: 11 }}>{hint}</span>
        )}
      </label>
      {rows.map((id, i) => {
        // Options for this row: eligible agents not chosen in a DIFFERENT row.
        const options = eligible.filter(a => a.id === id || !chosen.includes(a.id))
        const agent   = id ? agents.find(a => a.id === id) : null
        return (
          <div key={`${id || 'new'}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            {agent
              ? <Avatar agent={agent} size={26} />
              : <span style={{ width: 26, flexShrink: 0 }} aria-hidden="true" />}
            <select
              className="form-control"
              value={id}
              onChange={e => setAt(i, e.target.value)}
              aria-label={id ? `${label} ${i + 1}` : `Add a ${label.toLowerCase()}`}
            >
              <option value="">{chosen.length ? `Add another ${label.toLowerCase()}…` : 'None'}</option>
              {options.map(a => (
                <option key={a.id} value={a.id}>{a.name}{a.role ? ` · ${a.role}` : ''}</option>
              ))}
            </select>
            {id
              ? (
                <button
                  type="button"
                  className="btn btn--ghost btn--icon btn--sm"
                  title={`Remove ${agent?.name || 'co-agent'}`}
                  onClick={() => setAt(i, '')}
                >
                  <Icon name="x" size={13} />
                </button>
              )
              : <span style={{ width: 28, flexShrink: 0 }} aria-hidden="true" />}
          </div>
        )
      })}
    </div>
  )
}
