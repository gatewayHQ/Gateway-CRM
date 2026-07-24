import React from 'react'
import { Icon } from '../../components/UI.jsx'
import { REL, relationshipLabel } from '../../lib/dealVisibility.js'

// Visual + accessible presentation of the current agent's relationship to a
// deal. Colour is never the only signal — every variant carries an icon and a
// text label (WCAG 2.1 AA, 1.4.1 Use of Color).
const TONE = {
  [REL.PRIMARY]:  { key: 'primary', icon: 'star',  label: 'Primary agent',      full: "You're the primary agent" },
  [REL.CO_AGENT]: { key: 'co',      icon: 'users', label: 'Co-agent',           full: "You're tagged as a co-agent" },
  [REL.BOTH]:     { key: 'both',    icon: 'star',  label: 'Primary + co-agent', full: "You're the primary agent and a co-agent" },
  [REL.NONE]:     { key: 'none',    icon: 'alert', label: 'Not tagged',         full: "You're not tagged on this deal" },
}

/**
 * @param {object} props
 * @param {import('../../lib/dealVisibility.js').DealRelationship} props.relationship
 * @param {boolean} [props.compact]  Icon + short label only (for dense card headers).
 */
export default function CoAgentBadge({ relationship = REL.NONE, compact = false }) {
  const tone = TONE[relationship] || TONE[REL.NONE]
  return (
    <span
      className={`coagent-badge coagent-badge--${tone.key}`}
      role="img"
      aria-label={tone.full || relationshipLabel(relationship)}
      title={tone.full}
    >
      <Icon name={tone.icon} size={12} aria-hidden="true" />
      <span>{compact ? tone.label : (tone.full || tone.label)}</span>
    </span>
  )
}
