/**
 * ChipToggleGroup
 *
 * Two modes:
 *
 *  mode="grid"   (default)
 *    All available options shown upfront as toggleable pill chips.
 *    Best for small finite sets: asset types, property classes.
 *    Search bar auto-appears once options exceed `searchThreshold`.
 *
 *  mode="select"
 *    Compact: shows only selected chips + a search input.
 *    Clicking the input opens a popover of available options as chips.
 *    Best for large/growing lists: tags, where showing everything is noise.
 *
 * Both modes share the same fieldKey → useOptionValues backing and
 * the same allowAdd / keyboard UX.
 */

import React, { useState, useRef, useEffect, useMemo } from 'react'
import { Icon, pushToast } from './UI.jsx'
import { useOptionValues } from '../hooks/useOptionValues.js'

// ─── Shared helpers ───────────────────────────────────────────────────────────

function eqi(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

// ─── ChipToggleGroup ─────────────────────────────────────────────────────────

export default function ChipToggleGroup({
  fieldKey,
  value           = [],
  onChange,
  mode            = 'grid',     // 'grid' | 'select'
  placeholder     = 'Filter or add…',
  allowAdd        = true,
  disabled        = false,
  searchThreshold = 10,         // grid mode: show search bar when options > N
  style,
}) {
  return mode === 'select'
    ? <SelectMode   fieldKey={fieldKey} value={value} onChange={onChange} placeholder={placeholder} allowAdd={allowAdd} disabled={disabled} style={style} />
    : <GridMode     fieldKey={fieldKey} value={value} onChange={onChange} placeholder={placeholder} allowAdd={allowAdd} disabled={disabled} searchThreshold={searchThreshold} style={style} />
}

// ─────────────────────────────────────────────────────────────────────────────
// GRID MODE — all options shown upfront, click to toggle
// ─────────────────────────────────────────────────────────────────────────────

function GridMode({ fieldKey, value, onChange, placeholder, allowAdd, disabled, searchThreshold, style }) {
  const { values: allValues, add, loading } = useOptionValues(fieldKey)

  const [search,   setSearch]   = useState('')
  const [addMode,  setAddMode]  = useState(false)
  const [addDraft, setAddDraft] = useState('')
  const addRef = useRef(null)

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
    selected.has(v.toLowerCase())
      ? onChange((value || []).filter(x => !eqi(x, v)))
      : onChange([...(value || []), v])
    setSearch('')
  }

  const commitAdd = async (raw = addDraft) => {
    const v = (raw || search).trim()
    if (!v) return
    const result = await add(v)
    if (!result.ok) { pushToast(result.error || 'Could not add', 'error'); return }
    if (!selected.has(result.value.toLowerCase())) onChange([...(value || []), result.value])
    setAddDraft(''); setAddMode(false); setSearch('')
  }

  const showSearch = allValues.length > searchThreshold

  return (
    <div style={style}>
      {showSearch && (
        <div style={{ position: 'relative', marginBottom: 8 }}>
          <Icon name="search" size={12} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--gw-mist)', pointerEvents: 'none' }} />
          <input
            className="form-control"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (filtered.length === 1 && !exactMatch) { toggle(filtered[0]); return }
                if (!exactMatch && allowAdd && search.trim()) commitAdd(search)
                if (exactMatch) toggle(allValues.find(v => eqi(v, search.trim())))
              }
              if (e.key === 'Escape') setSearch('')
            }}
            placeholder={placeholder}
            disabled={disabled}
            style={{ paddingLeft: 28, fontSize: 12, height: 30 }}
          />
          {search && (
            <button type="button" onClick={() => setSearch('')}
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gw-mist)', padding: 0, display: 'flex' }}>
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 12, color: 'var(--gw-mist)', padding: '6px 0' }}>Loading…</div>
      ) : (
        <div role="group" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {filtered
            .slice()
            .sort((a, b) => {
              // Selected chips float to front
              const aOn = selected.has(a.toLowerCase())
              const bOn = selected.has(b.toLowerCase())
              return aOn === bOn ? 0 : aOn ? -1 : 1
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
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    padding: isOn ? '4px 8px 4px 10px' : '4px 12px',
                    borderRadius: 99,
                    border: `1.5px solid ${isOn ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                    background: isOn ? 'var(--gw-azure)' : '#fff',
                    color: isOn ? '#fff' : 'var(--gw-ink)',
                    fontSize: 12, fontWeight: isOn ? 600 : 400,
                    fontFamily: 'var(--font-body)',
                    cursor: disabled ? 'default' : 'pointer',
                    transition: 'all 120ms',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {v}
                  {isOn && <Icon name="x" size={9} style={{ opacity: 0.8, flexShrink: 0 }} />}
                </button>
              )
            })}

          {/* Empty list */}
          {allValues.length === 0 && !allowAdd && !loading && (
            <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>
              No options yet — add one below.
            </span>
          )}

          {/* Search miss → add inline */}
          {filtered.length === 0 && search.trim() && allowAdd && !disabled && (
            <button type="button" onClick={() => commitAdd(search)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 12px', borderRadius: 99, border: '1.5px dashed var(--gw-azure)', background: 'var(--gw-sky)', color: 'var(--gw-azure)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
              <Icon name="plus" size={10} />
              Add "{search.trim()}"
            </button>
          )}

          {/* + Add chip (short lists, no search bar) */}
          {!showSearch && allowAdd && !disabled && !addMode && !search.trim() && (
            <button type="button"
              onClick={() => { setAddMode(true); setTimeout(() => addRef.current?.focus(), 0) }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--gw-azure)'; e.currentTarget.style.color = 'var(--gw-azure)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--gw-border)'; e.currentTarget.style.color = 'var(--gw-mist)' }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 99, border: '1.5px dashed var(--gw-border)', background: 'transparent', color: 'var(--gw-mist)', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-body)', transition: 'border-color 120ms, color 120ms' }}>
              <Icon name="plus" size={10} /> Add
            </button>
          )}

          {/* Inline add input */}
          {addMode && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <input
                ref={addRef}
                value={addDraft}
                onChange={e => setAddDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitAdd() }
                  if (e.key === 'Escape') { setAddMode(false); setAddDraft('') }
                }}
                placeholder="New…"
                style={{ padding: '4px 10px', borderRadius: 99, border: '1.5px solid var(--gw-azure)', fontSize: 12, width: 110, outline: 'none', fontFamily: 'var(--font-body)' }}
              />
              <button type="button" onClick={() => commitAdd()}
                style={{ padding: '4px 10px', borderRadius: 99, border: 'none', background: 'var(--gw-azure)', color: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-body)' }}>
                Add
              </button>
              <button type="button" onClick={() => { setAddMode(false); setAddDraft('') }}
                style={{ padding: '4px 8px', borderRadius: 99, border: '1.5px solid var(--gw-border)', background: '#fff', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-body)', color: 'var(--gw-mist)' }}>
                ✕
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECT MODE — compact, shows selected chips + search-to-add popover
// ─────────────────────────────────────────────────────────────────────────────

function SelectMode({ fieldKey, value, onChange, placeholder, allowAdd, disabled, style }) {
  const { values: allValues, add, loading } = useOptionValues(fieldKey)

  const [search,  setSearch]  = useState('')
  const [open,    setOpen]    = useState(false)
  const containerRef = useRef(null)
  const inputRef     = useRef(null)

  const selected = useMemo(
    () => new Set((value || []).map(v => String(v).toLowerCase())),
    [value]
  )

  // Available = not yet selected, matching search
  const available = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allValues.filter(v => {
      if (selected.has(v.toLowerCase())) return false
      return !q || v.toLowerCase().includes(q)
    })
  }, [allValues, selected, search])

  const exactMatch = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? allValues.some(v => v.toLowerCase() === q) : false
  }, [allValues, search])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (!containerRef.current?.contains(e.target)) { setOpen(false); setSearch('') }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const remove = (v) => {
    onChange((value || []).filter(x => !eqi(x, v)))
  }

  const add_ = (v) => {
    if (!selected.has(v.toLowerCase())) onChange([...(value || []), v])
    setSearch('')
    inputRef.current?.focus()
  }

  const addNew = async () => {
    const v = search.trim()
    if (!v) return
    const result = await add(v)
    if (!result.ok) { pushToast(result.error || 'Could not add', 'error'); return }
    add_(result.value)
  }

  const hasSelected = (value || []).length > 0

  return (
    <div ref={containerRef} style={{ position: 'relative', ...style }}>
      {/* Input bar — selected chips + search input */}
      <div
        onClick={() => { if (!disabled) { setOpen(true); inputRef.current?.focus() } }}
        style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5,
          padding: '5px 8px', minHeight: 36,
          border: `1.5px solid ${open ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
          borderRadius: 'var(--radius)',
          background: disabled ? 'var(--gw-bone)' : '#fff',
          cursor: disabled ? 'not-allowed' : 'text',
          transition: 'border-color 120ms',
        }}
      >
        {/* Selected chips */}
        {(value || []).map(v => (
          <span key={v} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 6px 2px 8px',
            borderRadius: 99,
            background: 'var(--gw-azure)',
            color: '#fff',
            fontSize: 11, fontWeight: 600,
            fontFamily: 'var(--font-body)',
            whiteSpace: 'nowrap',
          }}>
            {v}
            {!disabled && (
              <button
                type="button"
                onMouseDown={e => e.preventDefault()}
                onClick={e => { e.stopPropagation(); remove(v) }}
                style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: '50%', width: 14, height: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, color: '#fff', flexShrink: 0 }}
                aria-label={`Remove ${v}`}
              >
                <Icon name="x" size={8} />
              </button>
            )}
          </span>
        ))}

        {/* Search input */}
        <input
          ref={inputRef}
          value={search}
          onChange={e => { setSearch(e.target.value); setOpen(true) }}
          onFocus={() => !disabled && setOpen(true)}
          onKeyDown={e => {
            if (e.key === 'Backspace' && !search && hasSelected) {
              remove((value || []).at(-1))
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              if (available.length > 0 && !exactMatch) { add_(available[0]); return }
              if (!exactMatch && allowAdd && search.trim()) addNew()
              if (exactMatch) {
                const match = allValues.find(v => eqi(v, search.trim()))
                if (match) add_(match)
              }
            }
            if (e.key === 'Escape') { setOpen(false); setSearch('') }
          }}
          placeholder={hasSelected ? '' : placeholder}
          disabled={disabled}
          style={{ flex: 1, minWidth: 80, border: 'none', outline: 'none', padding: '2px 0', fontSize: 12, fontFamily: 'var(--font-body)', background: 'transparent', cursor: 'text' }}
        />

        {/* Clear all */}
        {hasSelected && !disabled && (
          <button type="button" onMouseDown={e => e.preventDefault()}
            onClick={e => { e.stopPropagation(); onChange([]) }}
            title="Clear all"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gw-mist)', padding: '0 2px', display: 'flex', flexShrink: 0 }}>
            <Icon name="x" size={12} />
          </button>
        )}

        <Icon name="chevronDown" size={12}
          style={{ color: 'var(--gw-mist)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms', flexShrink: 0 }} />
      </div>

      {/* Popover — available tags as chips */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
          background: '#fff',
          border: '1.5px solid var(--gw-border)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.10)',
          zIndex: 200,
          padding: 10,
        }}>
          {loading ? (
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', textAlign: 'center', padding: '8px 0' }}>Loading…</div>
          ) : (
            <>
              {available.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {available.map(v => (
                    <button
                      key={v}
                      type="button"
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => add_(v)}
                      style={{
                        padding: '3px 10px', borderRadius: 99,
                        border: '1.5px solid var(--gw-border)',
                        background: '#fff', color: 'var(--gw-ink)',
                        fontSize: 12, cursor: 'pointer',
                        fontFamily: 'var(--font-body)',
                        transition: 'border-color 120ms, background 120ms',
                        whiteSpace: 'nowrap',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--gw-azure)'; e.currentTarget.style.background = 'var(--gw-sky)' }}
                      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--gw-border)'; e.currentTarget.style.background = '#fff' }}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              )}

              {/* No results + add option */}
              {available.length === 0 && !search.trim() && (
                <div style={{ fontSize: 12, color: 'var(--gw-mist)', textAlign: 'center', padding: '4px 0' }}>
                  {allValues.length === 0 ? 'No tags yet — type to add your first.' : 'All tags selected.'}
                </div>
              )}

              {allowAdd && search.trim() && !exactMatch && (
                <button
                  type="button"
                  onMouseDown={e => e.preventDefault()}
                  onClick={addNew}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    marginTop: available.length > 0 ? 8 : 0,
                    padding: '5px 10px', borderRadius: 'var(--radius)',
                    border: '1.5px dashed var(--gw-azure)',
                    background: 'var(--gw-sky)', color: 'var(--gw-azure)',
                    fontSize: 12, fontWeight: 600, cursor: 'pointer',
                    fontFamily: 'var(--font-body)', width: '100%',
                  }}
                >
                  <Icon name="plus" size={11} />
                  Add "{search.trim()}" as a new tag
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
