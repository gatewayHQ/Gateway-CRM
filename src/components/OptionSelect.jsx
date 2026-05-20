import React, { useState, useRef, useEffect, useMemo } from 'react'
import { Icon, pushToast } from './UI.jsx'
import { useOptionValues } from '../hooks/useOptionValues.js'

/**
 * OptionSelect — single-value variant of OptionMultiSelect.
 * Used for fields like `industry` or `properties.submarket` where exactly one
 * value should be selected.
 *
 *   <OptionSelect fieldKey="industry" value={form.industry} onChange={v => set('industry', v)} />
 */
export default function OptionSelect({
  fieldKey,
  value = '',
  onChange,
  placeholder = 'Select…',
  allowAdd = true,
  disabled = false,
  clearable = true,
  style,
}) {
  const { values: allValues, add, loading } = useOptionValues(fieldKey)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = useRef(null)
  const inputRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => {
      if (!containerRef.current?.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return allValues
    return allValues.filter(v => v.toLowerCase().includes(q))
  }, [allValues, search])

  const exactMatch = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q && allValues.some(v => v.toLowerCase() === q)
  }, [allValues, search])

  const select = (v) => {
    onChange(v)
    setOpen(false)
    setSearch('')
  }

  const handleAddNew = async () => {
    const v = search.trim()
    if (!v) return
    const result = await add(v)
    if (!result.ok) { pushToast(result.error, 'error'); return }
    select(result.value)
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', ...style }}>
      <div
        onClick={() => { if (!disabled) { setOpen(true); inputRef.current?.focus() } }}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 8px',
          minHeight: 34,
          border: `1px solid ${open ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
          borderRadius: 'var(--radius)',
          background: disabled ? 'var(--gw-bone)' : '#fff',
          cursor: disabled ? 'not-allowed' : 'text',
        }}
      >
        {open ? (
          <input
            ref={inputRef}
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setOpen(false); setSearch('') }
              else if (e.key === 'Enter') {
                e.preventDefault()
                if (filtered.length > 0 && !exactMatch) select(filtered[0])
                else if (allowAdd && search.trim() && !exactMatch) handleAddNew()
                else if (exactMatch) select(allValues.find(v => v.toLowerCase() === search.trim().toLowerCase()))
              }
            }}
            placeholder={value || placeholder}
            disabled={disabled}
            style={{
              flex: 1, border: 'none', outline: 'none',
              padding: 0, fontSize: 13,
              fontFamily: 'var(--font-body)', background: 'transparent',
            }}
          />
        ) : (
          <div style={{ flex: 1, fontSize: 13, color: value ? 'var(--gw-ink)' : 'var(--gw-mist)' }}>
            {value || placeholder}
          </div>
        )}
        {clearable && value && !disabled && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onChange('') }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gw-mist)', padding: '0 4px', display: 'flex' }}
            aria-label="Clear"
          >
            <Icon name="x" size={13} />
          </button>
        )}
        <Icon name="chevronDown" size={13} style={{ color: 'var(--gw-mist)', transform: open ? 'rotate(180deg)' : 'none' }} />
      </div>

      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0,
            marginTop: 4,
            background: '#fff',
            border: '1px solid var(--gw-border)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            zIndex: 100,
            maxHeight: 280, overflowY: 'auto',
          }}
        >
          {loading ? (
            <div style={{ padding: 14, fontSize: 12, color: 'var(--gw-mist)', textAlign: 'center' }}>Loading…</div>
          ) : (
            <>
              {filtered.length === 0 && !allowAdd && (
                <div style={{ padding: 14, fontSize: 12, color: 'var(--gw-mist)', textAlign: 'center' }}>No matches</div>
              )}
              {filtered.map(v => {
                const isCurrent = value === v
                return (
                  <button
                    key={v} type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => select(v)}
                    style={{
                      display: 'block', width: '100%',
                      padding: '8px 12px',
                      background: isCurrent ? 'var(--gw-sky)' : 'transparent',
                      border: 'none', cursor: 'pointer',
                      textAlign: 'left', fontSize: 13,
                      fontFamily: 'var(--font-body)',
                      color: 'var(--gw-ink)',
                      fontWeight: isCurrent ? 600 : 400,
                    }}
                    onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = 'var(--gw-bone)' }}
                    onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = 'transparent' }}
                  >
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
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', padding: '8px 12px',
                    background: 'transparent', border: 'none',
                    borderTop: filtered.length > 0 ? '1px solid var(--gw-border)' : 'none',
                    cursor: 'pointer', textAlign: 'left',
                    fontSize: 13, fontFamily: 'var(--font-body)',
                    color: 'var(--gw-azure)', fontWeight: 600,
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
