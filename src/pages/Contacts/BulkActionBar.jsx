import React from 'react'
import { Icon } from '../../components/UI.jsx'

/**
 * BulkActionBar — floating action bar that appears when contacts are selected.
 * Mobile-responsive: collapses to icon-only buttons on narrow screens.
 */
export default function BulkActionBar({
  selectedCount,
  agents,
  reassignTo,
  setReassignTo,
  onReassign,
  onDelete,
  onSetStatus,
  onClear,
}) {
  if (selectedCount === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#1a2236',
        color: '#fff',
        borderRadius: 12,
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        zIndex: 500,
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        flexWrap: 'wrap',
        maxWidth: 'calc(100vw - 32px)',
        fontFamily: 'var(--font-body)',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {selectedCount} selected
      </span>

      <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.15)' }} />

      {/* Reassign */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <select
          value={reassignTo}
          onChange={(e) => setReassignTo(e.target.value)}
          style={{
            padding: '5px 10px',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.1)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.25)',
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'inherit',
            maxWidth: 160,
          }}
        >
          <option value="">Reassign to…</option>
          {agents.map(a => (
            <option key={a.id} value={a.id} style={{ color: '#000' }}>
              {a.name}
            </option>
          ))}
        </select>
        {reassignTo && (
          <button
            onClick={() => onReassign(reassignTo)}
            style={{
              padding: '5px 12px',
              borderRadius: 6,
              background: 'var(--gw-azure)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Assign
          </button>
        )}
      </div>

      {/* Status change */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <select
          onChange={(e) => { if (e.target.value) { onSetStatus(e.target.value); e.target.value = '' } }}
          defaultValue=""
          style={{
            padding: '5px 10px',
            borderRadius: 6,
            background: 'rgba(255,255,255,0.1)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.25)',
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'inherit',
          }}
        >
          <option value="">Set status…</option>
          <option value="active" style={{ color: '#000' }}>Active</option>
          <option value="cold"   style={{ color: '#000' }}>Cold</option>
          <option value="closed" style={{ color: '#000' }}>Closed</option>
        </select>
      </div>

      <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.15)' }} />

      <button
        style={{
          padding: '5px 12px',
          borderRadius: 6,
          background: '#ef4444',
          color: '#fff',
          border: 'none',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
        onClick={onDelete}
      >
        <Icon name="trash" size={13} /> Delete
      </button>

      <button
        style={{
          padding: '5px 10px',
          borderRadius: 6,
          background: 'transparent',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.25)',
          cursor: 'pointer',
          fontSize: 12,
        }}
        onClick={onClear}
      >
        Cancel
      </button>
    </div>
  )
}
