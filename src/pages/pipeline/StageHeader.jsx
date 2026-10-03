// A board column's header, renameable in place (an agent's own stage labels).

import React, { useState } from 'react'
import { STAGE_LABELS } from '../../lib/helpers.js'
import { STAGE_LABEL_MAX } from '../../lib/stageLabels.js'
import { Icon } from '../../components/UI.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// Editable board column header.
//
// Renaming a column is a personal display preference — "Qualified" becomes
// "Vetted", "Offer" becomes "LOI Out". The deal's stored stage token never
// changes, so reports, automations, the stage CHECK constraint, and the client
// portal keep working off the canonical value; only what this agent reads
// changes, and only for this agent.
//
// Enter or blur commits, Escape reverts, and an empty box restores the built-in
// label — which is the whole undo story, so there's no way to get stuck with a
// header you can't read.
// ─────────────────────────────────────────────────────────────────────────────
export function StageHeader({ stage, label, canRename, onRename }) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(label)

  const begin = () => { if (!canRename) return; setDraft(label); setEditing(true) }
  const commit = () => {
    setEditing(false)
    if (draft.trim() === label) return          // nothing typed, nothing to save
    onRename(stage, draft)
  }

  if (editing) {
    return (
      <input
        className="kanban-col__rename"
        value={draft}
        maxLength={STAGE_LABEL_MAX}
        autoFocus
        onFocus={e => e.target.select()}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter')  { e.preventDefault(); commit() }
          if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
        }}
        aria-label={`Rename the ${label} column`}
        placeholder={STAGE_LABELS[stage]}
      />
    )
  }

  return (
    <div className="kanban-col__label" onDoubleClick={begin}
         title={canRename ? `${label} — double-click to rename` : label}>
      <span>{label}</span>
      {canRename && (
        <button type="button" className="kanban-col__rename-btn" onClick={begin}
                aria-label={`Rename the ${label} column`}>
          <Icon name="edit" size={11} />
        </button>
      )}
    </div>
  )
}
