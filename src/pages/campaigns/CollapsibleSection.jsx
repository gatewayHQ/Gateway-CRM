import React from 'react'
import { Icon } from '../../components/UI.jsx'

/**
 * A section header that slides its children open and closed. Content stays
 * mounted so scroll position, filters and in-flight edits survive a collapse.
 */
export function CollapsibleSection({ id, title, count, hint, open, onToggle, children, style }) {
  const bodyId = `section-${id}`
  return (
    <div style={style}>
      <button type="button" className="collapse-head" aria-expanded={open} aria-controls={bodyId}
              onClick={() => onToggle(!open)}>
        <span className={`collapse-head__chevron${open ? ' is-open' : ''}`}>
          <Icon name="chevronDown" size={14} />
        </span>
        <span>{title}</span>
        {count != null && <span className="collapse-head__count">({count})</span>}
        {hint && <span className="collapse-head__hint">{hint}</span>}
      </button>
      <div id={bodyId} className={`collapse${open ? ' is-open' : ''}`} aria-hidden={!open}>
        <div className="collapse__inner" {...(open ? {} : { inert: '' })}>{children}</div>
      </div>
    </div>
  )
}
