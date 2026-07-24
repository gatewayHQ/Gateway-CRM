import React, { useState } from 'react'
import { Icon } from '../../components/UI.jsx'
import DealList from '../../components/records/DealList.jsx'
import useVisibleRecords, { VIEW } from '../../hooks/useVisibleRecords.js'

// ─────────────────────────────────────────────────────────────────────────────
// My Deals — the agent-facing view of the visibility model. Shows ONLY the
// deals the active agent may see (own, co-agent, or via an admin Partner link)
// and makes the reason explicit per card. Scoping happens upstream in the data
// layer (docs/co-agent-visibility.md); this view derives the per-record reason
// for badging and quarantines anything that should not have reached the browser.
// ─────────────────────────────────────────────────────────────────────────────

const FILTERS = [
  { key: VIEW.ALL,      label: 'All' },
  { key: VIEW.OWN,      label: 'Owned' },
  { key: VIEW.CO_AGENT, label: 'Co-agent' },
  { key: VIEW.PARTNER,  label: 'Partner' },
]

/**
 * @param {object}  props
 * @param {object}  props.db           App store (deals, agents, coAgentDealIds, partnerIds).
 * @param {object}  props.activeAgent
 * @param {boolean} [props.isAdmin]
 * @param {(route: string) => void} props.go
 */
export default function TeamDealsView({ db, activeAgent, isAdmin = false, go }) {
  const [view, setView] = useState(VIEW.ALL)
  const agentId = activeAgent?.id
  const loading = !activeAgent

  const { records, counts, leaked, visibilityOf } = useVisibleRecords({
    records: db?.deals,
    entity: 'deal',
    agentId,
    coAgentIds: db?.coAgentDealIds,
    partnerIds: db?.partnerIds,
    view,
  })

  const filterCount = {
    [VIEW.ALL]:      counts.total,
    [VIEW.OWN]:      counts.own,
    [VIEW.CO_AGENT]: counts.coAgent,
    [VIEW.PARTNER]:  counts.partner,
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">My Deals</div>
          <div className="page-sub">
            {isAdmin
              ? 'As office admin you can open every deal from Pipeline — this view shows the deals you’re personally on.'
              : 'Deals you own, are tagged on as a co-agent, or can see through an admin Partner link.'}
          </div>
        </div>
      </div>

      <div className="visibility-note" role="note">
        <Icon name="eye" size={15} />
        <span>
          <strong>Why you can see these.</strong> {counts.own} you own · {counts.coAgent} as a co-agent
          {counts.partner > 0 && <> · {counts.partner} via a Partner link</>}.
          {' '}To share a deal with a teammate, add them as a co-agent — a firm-wide Partner link is set up by an admin.
        </span>
      </div>

      {!isAdmin && leaked.length > 0 && (
        <div className="visibility-note visibility-note--warn" role="alert">
          <Icon name="alert" size={15} />
          <span>
            {leaked.length} deal{leaked.length === 1 ? '' : 's'} you’re not entitled to see {leaked.length === 1 ? 'was' : 'were'}
            {' '}hidden. If this keeps happening, let the office know.
          </span>
        </div>
      )}

      <div className="segmented" role="group" aria-label="Filter deals by why they're visible">
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
        deals={records}
        visibilityOf={visibilityOf}
        loading={loading}
        agents={db?.agents || []}
        onOpen={deal => go && go(`deal/${deal.id}`)}
        emptyTitle={
          view === VIEW.CO_AGENT ? 'No deals you’re a co-agent on'
          : view === VIEW.OWN ? 'No deals you own'
          : view === VIEW.PARTNER ? 'No deals shared via a Partner link'
          : 'No deals you can see'
        }
      />
    </div>
  )
}
