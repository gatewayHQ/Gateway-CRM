import React from 'react'
import { Icon, Avatar, Badge } from '../../components/UI.jsx'
import { formatCurrency, formatDate, STAGE_LABELS } from '../../lib/helpers.js'
import { REL, relationshipLabel } from '../../lib/dealVisibility.js'
import CoAgentBadge from './CoAgentBadge.jsx'

// Pure, presentational deal card. All data is passed in; it performs no fetches
// and holds no state, so it is trivially reusable and testable.
/**
 * @param {object}   props
 * @param {object}   props.deal
 * @param {import('../../lib/dealVisibility.js').DealRelationship} props.relationship
 * @param {object[]} [props.agents]  Roster, to resolve primary + co-agent chips.
 * @param {(deal: object) => void} [props.onOpen]
 */
export default function DealCard({ deal, relationship = REL.NONE, agents = [], onOpen }) {
  const primary  = deal.agent_id ? agents.find(a => a.id === deal.agent_id) : null
  const coAgents = (deal.co_agent_ids || [])
    .map(id => agents.find(a => a.id === id))
    .filter(Boolean)

  const isLeak = relationship === REL.NONE
  const open = () => onOpen && onOpen(deal)
  const onKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() }
  }

  return (
    <article
      className={`deal-card${isLeak ? ' deal-card--leak' : ''}`}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKeyDown}
      aria-label={`${deal.title || 'Untitled deal'} — ${relationshipLabel(relationship)}. Open deal.`}
    >
      <div className="deal-card__top">
        <h3 className="deal-card__title">{deal.title || 'Untitled deal'}</h3>
        <CoAgentBadge relationship={relationship} compact />
      </div>

      <div className="deal-card__meta">
        {deal.stage && <Badge variant={deal.stage}>{STAGE_LABELS[deal.stage] || deal.stage}</Badge>}
        {deal.prop_category && <Badge variant={deal.prop_category}>{deal.prop_category}</Badge>}
      </div>

      <div className="deal-card__value">
        <Icon name="dollar" size={14} aria-hidden="true" />
        <span>{formatCurrency(deal.value)}</span>
        {deal.expected_close_date && (
          <span className="deal-card__date">
            <Icon name="calendar" size={12} aria-hidden="true" />
            {formatDate(deal.expected_close_date)}
          </span>
        )}
      </div>

      <div className="deal-card__people">
        {primary && (
          <span className="deal-card__person" title={`Primary agent: ${primary.name}`}>
            <Avatar agent={primary} size={22} />
            <span className="deal-card__person-name">{primary.name}</span>
            <span className="deal-card__person-role">Primary</span>
          </span>
        )}
        {coAgents.length > 0 && (
          <span className="deal-card__coagents" aria-label={`Co-agents: ${coAgents.map(a => a.name).join(', ')}`}>
            {coAgents.map(a => <Avatar key={a.id} agent={a} size={22} />)}
          </span>
        )}
      </div>
    </article>
  )
}
