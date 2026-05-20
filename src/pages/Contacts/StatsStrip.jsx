import React, { useMemo } from 'react'
import { Icon } from '../../components/UI.jsx'

const DAY_MS = 86_400_000

/**
 * StatsStrip — KPI cards at the top of the Contacts page.
 * Quick-glance metrics that drive daily activity.
 *
 * Stats:
 *   - Total contacts
 *   - New this week
 *   - Hot leads (computed from heat scores map)
 *   - Untouched 30+ days (the #1 way agents find lost opportunities)
 *   - Active deals tied to contacts
 */
export default function StatsStrip({ contacts, heatScores, deals, onFilterStat }) {
  const stats = useMemo(() => {
    const now = Date.now()
    const weekAgo  = now - 7 * DAY_MS
    const monthAgo = now - 30 * DAY_MS

    let newThisWeek = 0
    let hotCount = 0
    let untouched = 0
    const contactIdsWithActiveDeals = new Set()

    for (const c of contacts) {
      const created = c.created_at ? new Date(c.created_at).getTime() : 0
      if (created > weekAgo) newThisWeek++

      if (heatScores[c.id] === 'hot') hotCount++

      const lastContact = c.last_contacted_at ? new Date(c.last_contacted_at).getTime() : 0
      // "Untouched" = no contact in 30 days AND status is active (lost opportunity risk)
      if (c.status === 'active' && (!lastContact || lastContact < monthAgo)) {
        untouched++
      }
    }

    for (const d of (deals || [])) {
      if (!['closed', 'lost'].includes(d.stage) && d.contact_id) {
        contactIdsWithActiveDeals.add(d.contact_id)
      }
    }

    return {
      total:       contacts.length,
      newThisWeek,
      hot:         hotCount,
      untouched,
      activeDeals: contactIdsWithActiveDeals.size,
    }
  }, [contacts, heatScores, deals])

  const cards = [
    { key: 'total',       label: 'Total contacts',   value: stats.total,       icon: 'contacts', color: 'var(--gw-slate)' },
    { key: 'new',         label: 'New this week',    value: stats.newThisWeek, icon: 'plus',     color: 'var(--gw-azure)' },
    { key: 'hot',         label: 'Hot leads',        value: stats.hot,         icon: 'flame',    color: '#e63946' },
    { key: 'untouched',   label: '30+ days quiet',   value: stats.untouched,   icon: 'alert',    color: 'var(--gw-amber)' },
    { key: 'activeDeals', label: 'In active deal',   value: stats.activeDeals, icon: 'pipeline', color: 'var(--gw-green)' },
  ]

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
      gap: 10,
      marginBottom: 16,
    }}>
      {cards.map(card => (
        <button
          key={card.key}
          onClick={() => onFilterStat?.(card.key)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 14px',
            background: '#fff',
            border: '1px solid var(--gw-border)',
            borderRadius: 'var(--radius)',
            cursor: onFilterStat ? 'pointer' : 'default',
            textAlign: 'left',
            transition: 'all 120ms',
            fontFamily: 'var(--font-body)',
          }}
          onMouseEnter={(e) => { if (onFilterStat) { e.currentTarget.style.borderColor = card.color; e.currentTarget.style.transform = 'translateY(-1px)' } }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--gw-border)'; e.currentTarget.style.transform = 'none' }}
        >
          <div style={{
            width: 36, height: 36,
            borderRadius: 8,
            background: `${card.color}15`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            color: card.color,
          }}>
            <Icon name={card.icon} size={18} />
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1, color: 'var(--gw-slate)', fontFamily: 'var(--font-display)' }}>
              {card.value.toLocaleString()}
            </div>
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4, fontWeight: 500 }}>
              {card.label}
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}
