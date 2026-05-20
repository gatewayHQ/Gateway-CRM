import React, { useState, useRef, useEffect, useMemo } from 'react'
import { Icon, pushToast } from './UI.jsx'
import { useOptionValues } from '../hooks/useOptionValues.js'

/**
 * OptionMultiSelect — chip-style multi-select bound to a managed option-value list.
 *
 *   <OptionMultiSelect
 *     fieldKey="submarket"
 *     value={contact.submarkets}
 *     onChange={(arr) => set('submarkets', arr)}
 *     placeholder="Search submarkets…"
 *     allowAdd        // show "+ Add new" inline
 *   />
 *
 * Mirrors the old CRM pattern from the user's screenshots:
 *   - Selected values rendered as chips inside the input
 *   - Click anywhere → dropdown with checkboxes for each option
 *   - Type to filter; type something new → "+ Add 'foo'"
 *   - Backspace on empty input removes the last chip
 *
 * Storage contract: `value` is always a string[] (never null).
 */
export default function OptionMultiSelect({
  fieldKey,
  value = [],
  onChange,
  placeholder = 'Search…',
  allowAdd = true,
  disabled = false,
  className,
  style,
}) {
  const { values: allValues, add, loading } = useOptionValues(fieldKey)

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef(null)
  const inputRef = useRef(null)

  const selected = useMemo(() => new Set((value || []).map(v => v.toLowerCase())), [value])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (!containerRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Compute filtered + ordered options
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return allValues
    return allValues.filter(v => v.toLowerCase().includes(q))
  }, [allValues, search])

  const exactMatch = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q && allValues.some(v => v.toLowerCase() === q)
  }, [allValues, search])

  const toggleValue = (val) => {
    if (selected.has(val.toLowerCase())) {
      onChange((value || []).filter(v => v.toLowerCase() !== val.toLowerCase()))
    } else {
      onChange([...(value || []), val])
    }
  }

  const handleAddNew = async () => {
    const v = search.trim()
    if (!v) return
    const result = await add(v)
    if (!result.ok) {
      pushToast(result.error || 'Could not add value', 'error')
      return
    }
    // Add to selection if not already there
    if (!selected.has(result.value.toLowerCase())) {
      onChange([...(value || []), result.value])
    }
    setSearch('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Backspace' && !search && value.length) {
      onChange(value.slice(0, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered.length > 0 && !exactMatch) {
        // First filtered match
        toggleValue(filtered[0])
        setSearch('')
      } else if (allowAdd && search.trim() && !exactMatch) {
        handleAddNew()
      } else if (exactMatch) {
        const exact = allValues.find(v => v.toLowerCase() === search.trim().toLowerCase())
        if (exact) {
          toggleValue(exact)
          setSearch('')
        }
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const removeChip = (val, e) => {
    e.stopPropagation()
    onChange((value || []).filter(v => v.toLowerCase() !== val.toLowerCase()))
  }

  return (
    <div ref={containerRef} className={className} style={{ position: 'relative', ...style }}>
      {/* Input/chip container */}
      <div
        onClick={() => { if (!disabled) { setOpen(true); inputRef.current?.focus() } }}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 4,
          padding: '4px 6px',
          minHeight: 34,
          border: `1px solid ${open ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
          borderRadius: 'var(--radius)',
          background: disabled ? 'var(--gw-bone)' : '#fff',
          cursor: disabled ? 'not-allowed' : 'text',
          transition: 'border-color 120ms',
        }}
      >
        {(value || []).map(v => (
          <span
            key={v}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 4px 2px 8px',
              background: 'var(--gw-sky)',
              color: 'var(--gw-azure)',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'var(--font-body)',
              whiteSpace: 'nowrap',
            }}
          >
            {v}
            {!disabled && (
              <button
                type="button"
                onClick={(e) => removeChip(v, e)}
                style={{
                  background: 'rgba(255,255,255,0.6)',
                  border: 'none',
                  borderRadius: '50%',
                  width: 14, height: 14,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer',
                  padding: 0,
                  color: 'var(--gw-azure)',
                }}
                aria-label={`Remove ${v}`}
              >
                <Icon name="x" size={9} />
              </button>
            )}
          </span>
        ))}
        <input
          ref={inputRef}
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
          onKeyDown={handleKeyDown}
          onFocus={() => !disabled && setOpen(true)}
          placeholder={value.length === 0 ? placeholder : ''}
          disabled={disabled}
          style={{
            flex: 1,
            minWidth: 80,
            border: 'none',
            outline: 'none',
            padding: '4px 2px',
            fontSize: 13,
            fontFamily: 'var(--font-body)',
            background: 'transparent',
          }}
        />
        {value.length > 0 && !disabled && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange([]) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gw-mist)', padding: '0 4px', display: 'flex' }}
            aria-label="Clear all"
            title="Clear all"
          >
            <Icon name="x" size={13} />
          </button>
        )}
        <Icon name="chevronDown" size={13} style={{ color: 'var(--gw-mist)', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }} />
      </div>

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: 4,
            background: '#fff',
            border: '1px solid var(--gw-border)',
            borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-dropdown, 0 8px 24px rgba(0,0,0,0.12))',
            zIndex: 100,
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          {loading ? (
            <div style={{ padding: 14, fontSize: 12, color: 'var(--gw-mist)', textAlign: 'center' }}>
              Loading…
            </div>
          ) : (
            <>
              {filtered.length === 0 && !allowAdd && (
                <div style={{ padding: 14, fontSize: 12, color: 'var(--gw-mist)', textAlign: 'center' }}>
                  No matches
                </div>
              )}
              {filtered.map(v => {
                const isSelected = selected.has(v.toLowerCase())
                return (
                  <button
                    key={v}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggleValue(v)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      padding: '8px 12px',
                      background: isSelected ? 'var(--gw-sky)' : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontSize: 13,
                      fontFamily: 'var(--font-body)',
                      color: 'var(--gw-ink)',
                      transition: 'background 100ms',
                    }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--gw-bone)' }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                  >
                    <span style={{
                      width: 16, height: 16,
                      border: `1.5px solid ${isSelected ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                      borderRadius: 3,
                      background: isSelected ? 'var(--gw-azure)' : '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      {isSelected && <Icon name="check" size={11} style={{ color: '#fff' }} />}
                    </span>
                    {v}
                  </button>
                )
              })}

              {allowAdd && search.trim() && !exactMatch && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleAddNew}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '8px 12px',
                    background: 'transparent',
                    border: 'none',
                    borderTop: filtered.length > 0 ? '1px solid var(--gw-border)' : 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontSize: 13,
                    fontFamily: 'var(--font-body)',
                    color: 'var(--gw-azure)',
                    fontWeight: 600,
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--gw-sky)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <Icon name="plus" size={13} />
                  Add new: <strong>"{search.trim()}"</strong>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
