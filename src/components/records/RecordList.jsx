import React from 'react'
import { Icon, Avatar, Badge, EmptyState } from '../UI.jsx'
import VisibilityBadge from '../VisibilityBadge.jsx'
import { REASON } from '../../lib/visibility.js'

// Generic, presentational grid of "records I can see" — one engine for deals,
// contacts, and properties. Entity specifics arrive via `fields` (render
// functions), so DealList / ContactList / PropertyList are thin config wrappers.
// No fetches, no state: trivially reusable and testable.

function RecordCardSkeleton() {
  return (
    <div className="record-card record-card--skeleton" aria-hidden="true">
      <div className="sk sk--title" />
      <div className="sk sk--chip" />
      <div className="sk sk--value" />
      <div className="sk sk--people" />
    </div>
  )
}

function RecordCard({ record, visibility, agents, fields, onOpen }) {
  const reason = visibility?.reason ?? REASON.NONE
  const isLeak = reason === REASON.NONE
  const partner = visibility?.partnerId ? agents.find(a => a.id === visibility.partnerId) : null
  const owner = fields.ownerId ? agents.find(a => a.id === fields.ownerId(record)) : null

  const badges = fields.badges ? fields.badges(record).filter(Boolean) : []
  const stats  = fields.stats ? fields.stats(record).filter(Boolean) : []
  const open = () => onOpen && onOpen(record)

  return (
    <article
      className={`record-card${isLeak ? ' record-card--leak' : ''}`}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      aria-label={`${fields.title(record)} — ${reason === REASON.PARTNER && partner ? `partner ${partner.name}` : reason}. Open.`}
    >
      <div className="record-card__top">
        <h3 className="record-card__title">{fields.title(record) || 'Untitled'}</h3>
        <VisibilityBadge reason={reason} partnerName={partner?.name} compact />
      </div>

      {fields.subtitle && <div className="record-card__subtitle">{fields.subtitle(record)}</div>}

      {badges.length > 0 && (
        <div className="record-card__meta">
          {badges.map((b, i) => <Badge key={i} variant={b.variant}>{b.label}</Badge>)}
        </div>
      )}

      {stats.length > 0 && (
        <div className="record-card__stats">
          {stats.map((s, i) => (
            <span className="record-card__stat" key={i}>
              {s.icon && <Icon name={s.icon} size={13} />}
              <span>{s.text}</span>
            </span>
          ))}
        </div>
      )}

      {owner && (
        <div className="record-card__owner">
          <Avatar agent={owner} size={22} />
          <span className="record-card__owner-name">{owner.name}</span>
          {reason === REASON.OWN && <span className="record-card__owner-role">You</span>}
        </div>
      )}
    </article>
  )
}

/**
 * @param {object}   props
 * @param {object[]} props.records
 * @param {(record: object) => import('../../lib/visibility.js').Visibility} props.visibilityOf
 * @param {object[]} [props.agents]
 * @param {object}   props.fields   { title, subtitle?, badges?, stats?, ownerId? } — render fns.
 * @param {boolean}  [props.loading]
 * @param {(record: object) => void} [props.onOpen]
 * @param {string}   [props.emptyTitle]
 * @param {string}   [props.emptyMessage]
 * @param {React.ReactNode} [props.emptyAction]
 * @param {string}   [props.emptyIcon]
 * @param {number}   [props.skeletonCount]
 */
export default function RecordList({
  records = [],
  visibilityOf,
  agents = [],
  fields,
  loading = false,
  onOpen,
  emptyTitle = 'Nothing to show',
  emptyMessage = '',
  emptyAction,
  emptyIcon = 'pipeline',
  skeletonCount = 6,
}) {
  if (loading) {
    return (
      <>
        <div className="record-grid" aria-busy="true">
          {Array.from({ length: skeletonCount }).map((_, i) => <RecordCardSkeleton key={i} />)}
        </div>
        <span className="sr-only" role="status">Loading…</span>
      </>
    )
  }

  if (!records.length) {
    return <EmptyState icon={emptyIcon} title={emptyTitle} message={emptyMessage} action={emptyAction} />
  }

  return (
    <div className="record-grid" role="list">
      {records.map(record => (
        <div role="listitem" key={record.id}>
          <RecordCard
            record={record}
            visibility={visibilityOf ? visibilityOf(record) : undefined}
            agents={agents}
            fields={fields}
            onOpen={onOpen}
          />
        </div>
      ))}
    </div>
  )
}
