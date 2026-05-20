import React, { useRef, useState, useEffect, useMemo } from 'react'
import { Icon, Avatar, Badge, HeatBadge } from '../../components/UI.jsx'
import { formatPhone } from '../../lib/phone.js'
import { formatDate } from '../../lib/helpers.js'

/**
 * ContactsTable — virtualized, inline-editable contacts grid.
 *
 * Rendering: only ~30 rows in DOM at a time regardless of dataset size.
 * Selection: checkbox column appears on hover (Linear-style).
 * Inline edit: click status/agent cell → dropdown → save without opening drawer.
 * Keyboard: J/K to navigate, Enter to open, Space to toggle selection.
 */

const ROW_HEIGHT = 56
const OVERSCAN   = 8

export default function ContactsTable({
  rows,
  agents,
  heatScores,
  selected,
  setSelected,
  sortKey,
  sortDir,
  onSort,
  onOpen,
  onCompose,
  onDelete,
  onInlineUpdate,
  focusedIndex,
  setFocusedIndex,
}) {
  const containerRef = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const [editingCell, setEditingCell] = useState(null) // { id, field }

  // Track container height for virtualization
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setViewH(entry.contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Scroll focused row into view
  useEffect(() => {
    if (focusedIndex == null || !containerRef.current) return
    const el = containerRef.current
    const top    = focusedIndex * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
  }, [focusedIndex])

  const totalH = rows.length * ROW_HEIGHT
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(viewH / ROW_HEIGHT) + OVERSCAN * 2
  const endIndex = Math.min(rows.length - 1, startIndex + visibleCount)

  const visibleRows = useMemo(() => {
    const out = []
    for (let i = startIndex; i <= endIndex; i++) out.push({ contact: rows[i], index: i })
    return out
  }, [rows, startIndex, endIndex])

  const allSelected = rows.length > 0 && rows.every(r => selected.has(r.id))
  const someSelected = rows.some(r => selected.has(r.id))
  const toggleAll = () => {
    setSelected(prev => {
      const next = new Set(prev)
      if (allSelected) rows.forEach(r => next.delete(r.id))
      else             rows.forEach(r => next.add(r.id))
      return next
    })
  }
  const toggleOne = (id) => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const SortArrow = ({ k }) => {
    if (sortKey !== k) return <Icon name="chevronDown" size={10} style={{ opacity: 0.3 }} />
    return <Icon name={sortDir === 'asc' ? 'chevronDown' : 'chevronDown'} size={10}
                 style={{ transform: sortDir === 'asc' ? 'rotate(180deg)' : 'none' }} />
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 400 }}>
      {/* ── Sticky header ── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '36px 1.8fr 80px 90px 100px 1.2fr 1.6fr 1.2fr 120px 100px',
          alignItems: 'center',
          padding: '0 16px',
          height: 38,
          background: 'var(--gw-bone)',
          borderBottom: '1px solid var(--gw-border)',
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--gw-mist)',
          flexShrink: 0,
        }}
      >
        <div onClick={toggleAll} style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={allSelected}
            ref={el => el && (el.indeterminate = someSelected && !allSelected)}
            onChange={toggleAll}
            style={{ cursor: 'pointer' }}
          />
        </div>
        <HeaderCell label="Name"        sortKey="first_name"        onSort={onSort} active={sortKey === 'first_name'}        dir={sortDir} />
        <HeaderCell label="Heat"        sortKey="_heat"             onSort={onSort} active={sortKey === '_heat'}             dir={sortDir} />
        <HeaderCell label="Type"        sortKey="type"              onSort={onSort} active={sortKey === 'type'}              dir={sortDir} />
        <HeaderCell label="Status"      sortKey="status"            onSort={onSort} active={sortKey === 'status'}            dir={sortDir} />
        <HeaderCell label="Phone"       sortKey="phone"             onSort={onSort} active={sortKey === 'phone'}             dir={sortDir} />
        <HeaderCell label="Email"       sortKey="email"             onSort={onSort} active={sortKey === 'email'}             dir={sortDir} />
        <HeaderCell label="Agent"       sortKey="_agent"            onSort={onSort} active={sortKey === '_agent'}            dir={sortDir} />
        <HeaderCell label="Last Contact" sortKey="last_contacted_at" onSort={onSort} active={sortKey === 'last_contacted_at'} dir={sortDir} />
        <div />
      </div>

      {/* ── Scrollable virtualized body ── */}
      <div
        ref={containerRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        style={{
          flex: 1,
          overflowY: 'auto',
          position: 'relative',
          contain: 'strict',
        }}
      >
        <div style={{ height: totalH, position: 'relative' }}>
          {visibleRows.map(({ contact: c, index }) => {
            if (!c) return null
            const agent = agents.find(a => a.id === c.assigned_agent_id)
            const isSelected = selected.has(c.id)
            const isFocused  = focusedIndex === index

            return (
              <ContactRow
                key={c.id}
                contact={c}
                index={index}
                agent={agent}
                agents={agents}
                heat={heatScores[c.id]}
                isSelected={isSelected}
                isFocused={isFocused}
                isEditing={editingCell?.id === c.id ? editingCell.field : null}
                onToggleSelect={() => toggleOne(c.id)}
                onOpen={() => onOpen(c)}
                onCompose={() => onCompose(c)}
                onDelete={() => onDelete(c.id)}
                onStartEdit={(field) => setEditingCell({ id: c.id, field })}
                onCommitEdit={(field, value) => {
                  onInlineUpdate(c.id, field, value)
                  setEditingCell(null)
                }}
                onCancelEdit={() => setEditingCell(null)}
                onFocus={() => setFocusedIndex(index)}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}

function HeaderCell({ label, sortKey, onSort, active, dir }) {
  return (
    <button
      onClick={() => onSort(sortKey)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        color: active ? 'var(--gw-slate)' : 'inherit',
        fontSize: 'inherit',
        fontWeight: 'inherit',
        textTransform: 'inherit',
        letterSpacing: 'inherit',
        fontFamily: 'inherit',
      }}
    >
      {label}
      {active && <Icon name="chevronDown" size={10} style={{ transform: dir === 'asc' ? 'rotate(180deg)' : 'none' }} />}
    </button>
  )
}

/**
 * ContactRow — absolutely positioned for virtualization.
 * Memoized so unchanged rows skip re-render during scroll.
 */
const ContactRow = React.memo(function ContactRow({
  contact: c, index, agent, agents, heat,
  isSelected, isFocused, isEditing,
  onToggleSelect, onOpen, onCompose, onDelete,
  onStartEdit, onCommitEdit, onCancelEdit, onFocus,
}) {
  return (
    <div
      onMouseEnter={onFocus}
      onClick={(e) => {
        // Only open if click is on the row itself (not on action buttons)
        if (e.target.closest('[data-action]')) return
        onOpen()
      }}
      style={{
        position: 'absolute',
        top: index * ROW_HEIGHT,
        left: 0,
        right: 0,
        height: ROW_HEIGHT,
        display: 'grid',
        gridTemplateColumns: '36px 1.8fr 80px 90px 100px 1.2fr 1.6fr 1.2fr 120px 100px',
        alignItems: 'center',
        padding: '0 16px',
        gap: 0,
        background: isFocused ? 'var(--gw-bone)' : '#fff',
        borderBottom: '1px solid var(--gw-border)',
        cursor: 'pointer',
        transition: 'background 100ms',
      }}
    >
      {/* Selection */}
      <div data-action onClick={(e) => { e.stopPropagation(); onToggleSelect() }}>
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => {}}
          style={{ cursor: 'pointer' }}
        />
      </div>

      {/* Name + initials */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 'var(--radius)',
          background: 'var(--gw-sky)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700, color: 'var(--gw-azure)',
          flexShrink: 0,
        }}>
          {(c.first_name || '')[0]}{(c.last_name || '')[0]}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {c.first_name} {c.last_name}
          </div>
          {c.tags?.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--gw-mist)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {c.tags.slice(0, 3).join(' · ')}
            </div>
          )}
        </div>
      </div>

      {/* Heat */}
      <div><HeatBadge score={heat || 'cold'} /></div>

      {/* Type */}
      <div><Badge variant={c.type}>{c.type}</Badge></div>

      {/* Status — inline editable */}
      <div data-action onClick={(e) => { e.stopPropagation(); onStartEdit('status') }}>
        {isEditing === 'status' ? (
          <select
            autoFocus
            defaultValue={c.status}
            onBlur={(e) => onCommitEdit('status', e.target.value)}
            onChange={(e) => onCommitEdit('status', e.target.value)}
            onClick={(e) => e.stopPropagation()}
            style={{
              padding: '2px 6px',
              fontSize: 12,
              border: '1px solid var(--gw-azure)',
              borderRadius: 4,
              fontFamily: 'var(--font-body)',
            }}
          >
            <option value="active">Active</option>
            <option value="cold">Cold</option>
            <option value="closed">Closed</option>
          </select>
        ) : (
          <Badge variant={c.status}>{c.status}</Badge>
        )}
      </div>

      {/* Phone */}
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {formatPhone(c.phone) || '—'}
      </div>

      {/* Email */}
      <div style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: c.email ? 'inherit' : 'var(--gw-mist)' }}>
        {c.email || '—'}
      </div>

      {/* Agent — inline editable */}
      <div data-action onClick={(e) => { e.stopPropagation(); onStartEdit('assigned_agent_id') }}>
        {isEditing === 'assigned_agent_id' ? (
          <select
            autoFocus
            defaultValue={c.assigned_agent_id || ''}
            onBlur={(e) => onCommitEdit('assigned_agent_id', e.target.value || null)}
            onChange={(e) => onCommitEdit('assigned_agent_id', e.target.value || null)}
            onClick={(e) => e.stopPropagation()}
            style={{
              padding: '2px 6px',
              fontSize: 12,
              border: '1px solid var(--gw-azure)',
              borderRadius: 4,
              fontFamily: 'var(--font-body)',
            }}
          >
            <option value="">Unassigned</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        ) : (
          agent ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <Avatar agent={agent} size={22} />
              <span style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{agent.name}</span>
            </div>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>Unassigned</span>
          )
        )}
      </div>

      {/* Last contact */}
      <div style={{ fontSize: 12, color: 'var(--gw-mist)', whiteSpace: 'nowrap' }}>
        {formatDate(c.last_contacted_at) || '—'}
      </div>

      {/* Actions */}
      <div data-action onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 2, justifyContent: 'flex-end', opacity: isFocused ? 1 : 0.0, transition: 'opacity 120ms' }}>
        {c.email && (
          <button
            className="btn btn--ghost btn--icon"
            title="Email"
            onClick={onCompose}
          >
            <Icon name="mail" size={13} />
          </button>
        )}
        <button
          className="btn btn--ghost btn--icon"
          title="Open"
          onClick={onOpen}
        >
          <Icon name="edit" size={13} />
        </button>
        <button
          className="btn btn--ghost btn--icon"
          title="Delete"
          onClick={onDelete}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
    </div>
  )
})
