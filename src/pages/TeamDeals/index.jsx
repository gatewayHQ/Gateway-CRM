import React, { useState } from 'react'
import { Icon } from '../../components/UI.jsx'
import useTaggedDeals, { VIEW } from './useTaggedDeals.js'
import DealList from './DealList.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// Team Deals — the agent-facing view of the co-agent-only visibility model.
// It renders ONLY the deals the active agent is personally on (primary or
// co-agent) and makes that rule explicit. The scoping itself happens upstream
// in the data layer (see docs/co-agent-visibility.md); this view derives the
// per-deal relationship for badging via useTaggedDeals and quarantines anything
// that should not have reached a member's browser.
// ─────────────────────────────────────────────────────────────────────────────

const FILTERS = [
  { key: VIEW.ALL,      label: 'All' },
  { key: VIEW.PRIMARY,  label: 'Primary' },
  { key: VIEW.CO_AGENT, label: 'Co-agent' },
]

/**
 * @param {object}  props
 * @param {object}  props.db           App data store (deals, commissions, agents, coAgentDealIds).
 * @param {object}  props.activeAgent
 * @param {boolean} [props.isAdmin]
 * @param {(route: string) => void} props.go
 */
export default function TeamDealsView({ db, activeAgent, isAdmin = false, go }) {
  const [view, setView] = useState(VIEW.ALL)
  const agentId = activeAgent?.id
  const loading = !activeAgent

  const { deals, counts, leaked, relationshipOf } = useTaggedDeals({
    deals: db?.deals,
    coAgentDealIds: db?.coAgentDealIds,
    commissions: db?.commissions,
    agentId,
    view,
  })

  const filterCount = {
    [VIEW.ALL]:      counts.total,
    [VIEW.PRIMARY]:  counts.primary + counts.both,
    [VIEW.CO_AGENT]: counts.coAgent + counts.both,
  }

  const openDeal = (deal) => go && go(`deal/${deal.id}`)

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">My Deals</div>
          <div className="page-sub">
            {isAdmin
              ? 'As office admin you can open every deal from Pipeline — this view shows the deals you’re personally on.'
              : 'Deals you own or are tagged on as a co-agent. Deals worked by other team members stay private to them.'}
          </div>
        </div>
      </div>

      {/* Visibility explainer — communicates the rule (accessible, not colour-only) */}
      <div className="visibility-note" role="note">
        <Icon name="eye" size={15} aria-hidden="true" />
        <span>
          <strong>Co-agent visibility.</strong> You’re seeing {counts.total} deal{counts.total === 1 ? '' : 's'} —
          {' '}{counts.primary + counts.both} as primary agent and {counts.coAgent + counts.both} as a co-agent.
          To give a teammate access to a deal, add them as a co-agent on it.
        </span>
      </div>

      {/* Quarantine banner: a member should never receive a deal they're not on.
          If one slips past the data layer we hide it and say so, rather than leak it. */}
      {!isAdmin && leaked.length > 0 && (
        <div className="visibility-note visibility-note--warn" role="alert">
          <Icon name="alert" size={15} aria-hidden="true" />
          <span>
            {leaked.length} deal{leaked.length === 1 ? '' : 's'} you’re not tagged on {leaked.length === 1 ? 'was' : 'were'}
            {' '}hidden from this view. If this keeps happening, let the office know.
          </span>
        </div>
      )}

      {/* Role filter */}
      <div className="segmented" role="group" aria-label="Filter deals by your role on them">
        {FILTERS.map(f => (
          <button
            key={f.key}
            type="button"
            className={`segmented__btn${view === f.key ? ' is-active' : ''}`}
            aria-pressed={view === f.key}
            onClick={() => setView(f.key)}
          >
            {f.label}
            <span className="segmented__count">{filterCount[f.key]}</span>
          </button>
        ))}
      </div>

      <DealList
        deals={deals}
        relationshipOf={relationshipOf}
        loading={loading}
        agents={db?.agents || []}
        onOpenDeal={openDeal}
        emptyTitle={view === VIEW.CO_AGENT ? 'No deals you’re a co-agent on' : view === VIEW.PRIMARY ? 'No deals you own' : "No deals you're tagged on"}
      />
    </div>
  )
}
