import React from 'react'

/**
 * SavedViews — preset filter tabs across the top of the contacts table.
 * Linear/Attio pattern: lets users one-click into common segments without
 * having to configure filters every time.
 *
 * View predicate is a pure function over (contact, ctx) → boolean.
 * Persisted views could be added later by reading custom predicates from DB.
 */

const DAY_MS = 86_400_000
const now = () => Date.now()

export const BUILTIN_VIEWS = [
  {
    id: 'all',
    label: 'All',
    predicate: () => true,
  },
  {
    id: 'hot',
    label: 'Hot leads',
    predicate: (c, { heatScores }) => heatScores[c.id] === 'hot',
    accent: '#e63946',
  },
  {
    id: 'untouched',
    label: 'Untouched 30+ days',
    predicate: (c) => {
      if (c.status !== 'active') return false
      const last = c.last_contacted_at ? new Date(c.last_contacted_at).getTime() : 0
      return !last || last < now() - 30 * DAY_MS
    },
    accent: 'var(--gw-amber)',
  },
  {
    id: 'new',
    label: 'New this week',
    predicate: (c) => {
      const created = c.created_at ? new Date(c.created_at).getTime() : 0
      return created > now() - 7 * DAY_MS
    },
    accent: 'var(--gw-azure)',
  },
  {
    id: 'in-deal',
    label: 'In active deal',
    predicate: (c, { activeDealContactIds }) => activeDealContactIds.has(c.id),
    accent: 'var(--gw-green)',
  },
  {
    id: 'mine',
    label: 'Assigned to me',
    predicate: (c, { activeAgentId }) => c.assigned_agent_id === activeAgentId,
    accent: 'var(--gw-purple)',
  },
]

export default function SavedViews({ active, onChange, counts = {} }) {
  return (
    <div style={{
      display: 'flex',
      gap: 4,
      overflowX: 'auto',
      paddingBottom: 8,
      borderBottom: '1px solid var(--gw-border)',
      marginBottom: 12,
    }}>
      {BUILTIN_VIEWS.map(view => {
        const isActive = active === view.id
        const count = counts[view.id]
        return (
          <button
            key={view.id}
            onClick={() => onChange(view.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px',
              background: isActive ? 'var(--gw-slate)' : 'transparent',
              color:      isActive ? '#fff'           : 'var(--gw-mist)',
              border: 'none',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'all 120ms',
              fontFamily: 'var(--font-body)',
            }}
            onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--gw-bone)' }}
            onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
          >
            {view.accent && !isActive && (
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: view.accent }} />
            )}
            {view.label}
            {count !== undefined && (
              <span style={{
                fontSize: 11,
                padding: '1px 6px',
                background: isActive ? 'rgba(255,255,255,0.18)' : 'var(--gw-bone)',
                borderRadius: 8,
                fontWeight: 600,
                color: isActive ? '#fff' : 'var(--gw-mist)',
              }}>
                {count.toLocaleString()}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
