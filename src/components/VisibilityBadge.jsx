import React from 'react'
import { Icon } from './UI.jsx'
import { REASON } from '../lib/visibility.js'

// Communicates WHY a record is visible to the current agent. Reusable across
// deals, contacts, and properties. Colour is never the only signal — every
// variant pairs an icon with text (WCAG 2.1 AA, 1.4.1 Use of Color).
const TONE = {
  [REASON.OWN]:      { key: 'own',     icon: 'star',  label: 'Yours',    full: 'You own this' },
  [REASON.CO_AGENT]: { key: 'co',      icon: 'users', label: 'Co-agent', full: "You're tagged as a co-agent" },
  [REASON.PARTNER]:  { key: 'partner', icon: 'link',  label: 'Partner',  full: 'Shared via an admin Partner link' },
  [REASON.NONE]:     { key: 'none',    icon: 'alert', label: 'Not visible', full: 'You should not be able to see this' },
}

/**
 * @param {object} props
 * @param {import('../lib/visibility.js').VisibilityReason} props.reason
 * @param {string} [props.partnerName]  Shown on the PARTNER variant ("Partner · Nic").
 * @param {boolean} [props.compact]     Short label (dense rows/cards).
 */
export default function VisibilityBadge({ reason = REASON.NONE, partnerName, compact = false }) {
  const tone = TONE[reason] || TONE[REASON.NONE]
  const isPartner = reason === REASON.PARTNER
  const text = compact
    ? (isPartner && partnerName ? `Partner · ${partnerName}` : tone.label)
    : (isPartner && partnerName ? `Shared by ${partnerName} (Partner)` : tone.full)
  const aria = isPartner && partnerName
    ? `Visible through an admin Partner link with ${partnerName}`
    : tone.full

  return (
    <span className={`vis-badge vis-badge--${tone.key}`} role="img" aria-label={aria} title={aria}>
      <Icon name={tone.icon} size={12} />
      <span>{text}</span>
    </span>
  )
}
