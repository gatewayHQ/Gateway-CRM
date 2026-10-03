// Loading and empty feedback: Spinner, Skeleton, SkeletonText, EmptyState.

import React from 'react'
import { Icon } from './Icon.jsx'
import { cx } from './cx.js'

/**
 * Indeterminate progress. Announces `label` to screen readers (role="status")
 * unless `decorative`, for spinners sitting inside something that already says
 * it is busy (a loading Button sets aria-busy itself).
 */
export function Spinner({ size = 18, label = 'Loading…', decorative = false, className }) {
  const ring = (
    <span
      className={cx('ui-spinner', className)}
      style={{ width: size, height: size, borderWidth: size < 16 ? 2 : 2.5 }}
      aria-hidden="true"
    />
  )
  if (decorative) return ring
  return <span role="status" className="ui-spinner-wrap">{ring}<span className="sr-only">{label}</span></span>
}

/**
 * A placeholder block shaped like the content that's coming. Always hidden
 * from assistive tech — the region that is loading carries aria-busy and its
 * own "Loading…" text, so a list of 8 skeleton rows isn't read out 8 times.
 *
 * Prefer skeletons over a spinner for anything with a known shape (tables,
 * cards, a drawer's fields): the page doesn't jump when the data lands, and it
 * feels faster at the same latency.
 */
export function Skeleton({ width = '100%', height = 12, radius = 4, circle = false, className, style }) {
  return (
    <span
      aria-hidden="true"
      className={cx('ui-skeleton', className)}
      style={{ width: circle ? height : width, height, borderRadius: circle ? '50%' : radius, ...style }}
    />
  )
}

/** A paragraph-shaped skeleton; the last line is short, like real text. */
export function SkeletonText({ lines = 3, gap = 8, lineHeight = 12 }) {
  return (
    <span aria-hidden="true" className="ui-skeleton-text" style={{ gap }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={lineHeight} width={i === lines - 1 && lines > 1 ? '60%' : '100%'} />
      ))}
    </span>
  )
}

const VARIANT_ICON = { empty: null, 'no-results': 'search', error: 'alert' }

/**
 * What to show when there is nothing to show. Three variants, because they
 * call for different words and different next steps:
 *
 *  - `empty`       — nothing exists yet. Say what goes here; offer to create it.
 *  - `no-results`  — things exist, the filters hide them all. Offer to clear the
 *                    filters. (Telling someone with 400 listings "No properties
 *                    yet" because a county filter matched none is a bug.)
 *  - `error`       — loading failed. Say so plainly, reassure, offer a retry.
 *                    Announced immediately (role="alert").
 *
 * `message` is the legacy name for `description`; both work.
 */
export function EmptyState({
  variant = 'empty', icon, title, description, message, action, secondaryAction,
  size = 'md', className,
}) {
  const body = description ?? message
  const iconName = icon || VARIANT_ICON[variant] || 'alert'
  return (
    <div
      className={cx('empty-state', `empty-state--${variant}`, size === 'sm' && 'empty-state--sm', className)}
      role={variant === 'error' ? 'alert' : undefined}
    >
      <div className="empty-state__icon"><Icon name={iconName} size={size === 'sm' ? 18 : 24} /></div>
      {title && <div className="empty-state__title">{title}</div>}
      {body && <div className="empty-state__msg">{body}</div>}
      {(action || secondaryAction) && (
        <div className="empty-state__actions">{action}{secondaryAction}</div>
      )}
    </div>
  )
}
