import React from 'react'
import { EmptyState } from '../../components/UI.jsx'
import DealCard from './DealCard.jsx'

// Skeleton placeholders shown while the app's initial data load is in flight.
// aria-hidden + a polite live region below keep screen readers from announcing
// the placeholders while still communicating the loading state.
function DealCardSkeleton() {
  return (
    <div className="deal-card deal-card--skeleton" aria-hidden="true">
      <div className="sk sk--title" />
      <div className="sk sk--chip" />
      <div className="sk sk--value" />
      <div className="sk sk--people" />
    </div>
  )
}

/**
 * Presentational grid of deal cards with loading and empty states.
 *
 * @param {object}   props
 * @param {object[]} props.deals
 * @param {(deal: object) => import('../../lib/dealVisibility.js').DealRelationship} props.relationshipOf
 * @param {boolean}  [props.loading]
 * @param {object[]} [props.agents]
 * @param {(deal: object) => void} [props.onOpenDeal]
 * @param {string}   [props.emptyTitle]
 * @param {string}   [props.emptyMessage]
 * @param {React.ReactNode} [props.emptyAction]
 * @param {number}   [props.skeletonCount]
 */
export default function DealList({
  deals = [],
  relationshipOf,
  loading = false,
  agents = [],
  onOpenDeal,
  emptyTitle = "No deals you're tagged on",
  emptyMessage = "You'll see a deal here as soon as you're the primary agent or added as a co-agent. Deals worked by other team members stay private to them.",
  emptyAction,
  skeletonCount = 6,
}) {
  if (loading) {
    return (
      <>
        <div className="deal-grid" aria-busy="true">
          {Array.from({ length: skeletonCount }).map((_, i) => <DealCardSkeleton key={i} />)}
        </div>
        <span className="sr-only" role="status">Loading your deals…</span>
      </>
    )
  }

  if (!deals.length) {
    return (
      <EmptyState
        icon="pipeline"
        title={emptyTitle}
        message={emptyMessage}
        action={emptyAction}
      />
    )
  }

  return (
    <div className="deal-grid" role="list">
      {deals.map(deal => (
        <div role="listitem" key={deal.id}>
          <DealCard
            deal={deal}
            relationship={relationshipOf ? relationshipOf(deal) : undefined}
            agents={agents}
            onOpen={onOpenDeal}
          />
        </div>
      ))}
    </div>
  )
}
