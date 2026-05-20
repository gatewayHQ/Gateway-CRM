/**
 * ChipToggleGroup — inline toggleable chip grid backed by the option-values system.
 *
 * Instead of a dropdown, all available options are shown upfront as pill chips.
 * Click to select / deselect. Perfect for short-to-medium lists (tags, asset
 * types, submarkets) where agents need to see everything at a glance.
 *
 * When the list grows beyond `searchThreshold`, a compact filter input appears
 * above the chips so nothing gets buried in a scroll.
 *
 * Usage:
 *   <ChipToggleGroup
 *     fieldKey="asset_type"
 *     value={form.asset_types}
 *     onChange={v => set('asset_types', v)}
 *   />
 */

import React, { useState, useRef, useMemo } from 'react'
import { Icon, pushToast } from './UI.jsx'
import { useOptionValues } from '../hooks/useOptionValues.js'

export default function ChipToggleGroup({
  fieldKey,
  value = [],
  onChange,
  placeholder    = 'Filter or add…',
  allowAdd       = true,
  disabled       = false,
  searchThreshold = 10,   // show search bar once options exceed this count
  emptyMessage   = 'No options yet.',
  style,
}) {
  const { values: allValues, add, loading } = useOptionValues(fieldKey)

  const [search,    setSearch]    = useState('')
  const [addMode,   setAddMode]   = useState(false)
  const [addDraft,  setAddDraft]  = useState('')
  const addInputRef = useRef(null)

  const selected = useMemo(
    () => new Set((value || []).map(v => String(v).toLowerCase())),
    [value]
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? allValues.filter(v => v.toLowerCase().includes(q)) : allValues
  }, [allValues, search])

  const exactMatch = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? allValues.some(v => v.toLowerCase() === q) : false
  }, [allValues, search])

  const toggle = (v) => {
    if (disabled) return
    if (selected.has(v.toLowerCase())) {
      onChange((value || []).filter(x => x.toLowerCase() !== v.toLowerCase()))
    } else {
      onChange([...(value || []), v])
    }
    setSearch('')
  }

  const commitAdd = async () => {
    const v = (addMode ? addDraft : search).trim()
    if (!v) return
    const result = await add(v)
    if (!result.ok) { pushToast(result.error || 'Could not add', 'error'); return }
    if (!selected.has(result.value.toLowerCase())) {
      onChange([...(value || []), result.value])
    }
    setAddDraft('')
    setAddMode(false)
    setSearch('')
  }

  const showSearch = allValues.length > searchThreshold

  return (
    <div style={style}>
      {/* Search / filter bar — only when list is long */}
      {showSearch && (
        <div style={{ position: 'relative', marginBottom: 8 }}>
          <Icon
            name="search"
            size={12}
            style={{
              position: 'absolute', left: 9, top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--gw-mist)', pointerEvents: 'none',
            }}
          />
          <input
            className="form-control"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (filtered.length === 1 && !exactMatch) { toggle(filtered[0]); return }
                if (!exactMatch && allowAdd && search.trim()) commitAdd()
                if (exactMatch) toggle(allValues.find(v => v.toLowerCase() === search.trim().toLowerCase()))
              }
              if (e.key === 'Escape') setSearch('')
            }}
            placeholder={placeholder}
            disabled={disabled}
            style={{ paddingLeft: 28, fontSize: 12, height: 30 }}
            aria-label={placeholder}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              style={{
                position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--gw-mist)', padding: 0, display: 'flex',
              }}
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      )}

      {/* Chip grid */}
      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--gw-mist)', padding: '6px 0' }}>Loading…</div>
      ) : (
        <div
          role="group"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}
        >
          {/* Selected chips always shown first for quick removal */}
          {filtered
            .slice()
            .sort((a, b) => {
              const aOn = selected.has(a.toLowerCase())
              const bOn = selected.has(b.toLowerCase())
              if (aOn && !bOn) return -1
              if (!aOn && bOn) return 1
              return 0
            })
            .map(v => {
              const isOn = selected.has(v.toLowerCase())
              return (
                <button
                  key={v}
                  type="button"
                  role="checkbox"
                  aria-checked={isOn}
                  onClick={() => toggle(v)}
                  disabled={disabled}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: isOn ? '4px 8px 4px 10px' : '4px 12px',
                    borderRadius: 99,
                    border: `1.5px solid ${isOn ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                    background: isOn ? 'var(--gw-azure)' : '#fff',
                    color: isOn ? '#fff' : 'var(--gw-ink)',
                    fontSize: 12,
                    fontWeight: isOn ? 600 : 400,
                    fontFamily: 'var(--font-body)',
                    cursor: disabled ? 'default' : 'pointer',
                    transition: 'all 120ms',
                    whiteSpace: 'nowrap',
                    opacity: disabled ? 0.6 : 1,
                  }}
                >
                  {v}
                  {isOn && (
                    <Icon name="x" size={9} style={{ opacity: 0.85, flexShrink: 0 }} />
                  )}
                </button>
              )
            })}

          {/* "No options" state */}
          {allValues.length === 0 && !allowAdd && !loading && (
            <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>{emptyMessage}</span>
          )}

          {/* No search matches → "+ Add 'x'" inline */}
          {filtered.length === 0 && search.trim() && allowAdd && !disabled && (
            <button
              type="button"
              onClick={commitAdd}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '4px 12px',
                borderRadius: 99,
                border: '1.5px dashed var(--gw-azure)',
                background: 'var(--gw-sky)',
                color: 'var(--gw-azure)',
                fontSize: 12, fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'var(--font-body)',
              }}
            >
              <Icon name="plus" size={10} />
              Add "{search.trim()}"
            </button>
          )}

          {/* Inline "add new" chip — appears when list is short (no search bar) */}
          {!showSearch && allowAdd && !disabled && !addMode && (
            <button
              type="button"
              onClick={() => { setAddMode(true); setTimeout(() => addInputRef.current?.focus(), 0) }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '4px 10px',
                borderRadius: 99,
                border: '1.5px dashed var(--gw-border)',
                background: 'transparent',
                color: 'var(--gw-mist)',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'var(--font-body)',
                transition: 'border-color 120ms, color 120ms',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--gw-azure)'; e.currentTarget.style.color = 'var(--gw-azure)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--gw-border)'; e.currentTarget.style.color = 'var(--gw-mist)' }}
            >
              <Icon name="plus" size={10} />
              Add
            </button>
          )}

          {/* Inline add input */}
          {addMode && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input
                ref={addInputRef}
                value={addDraft}
                onChange={e => setAddDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitAdd() }
                  if (e.key === 'Escape') { setAddMode(false); setAddDraft('') }
                }}
                placeholder="New…"
                style={{
                  padding: '4px 10px',
                  borderRadius: 99,
                  border: '1.5px solid var(--gw-azure)',
                  fontSize: 12, width: 110,
                  outline: 'none',
                  fontFamily: 'var(--font-body)',
                }}
                aria-label="New option value"
              />
              <button
                type="button"
                onClick={commitAdd}
                style={{
                  padding: '4px 10px', borderRadius: 99,
                  border: 'none', background: 'var(--gw-azure)',
                  color: '#fff', fontSize: 12, cursor: 'pointer',
                  fontFamily: 'var(--font-body)',
                }}
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => { setAddMode(false); setAddDraft('') }}
                style={{
                  padding: '4px 8px', borderRadius: 99,
                  border: '1.5px solid var(--gw-border)',
                  background: '#fff', fontSize: 12, cursor: 'pointer',
                  fontFamily: 'var(--font-body)', color: 'var(--gw-mist)',
                }}
              >
                ✕
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
