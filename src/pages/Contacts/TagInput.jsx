import React, { useState, useRef } from 'react'
import { Icon } from '../../components/UI.jsx'

/**
 * TagInput — chip-style tag editor.
 * Replaces the comma-separated string input that broke on commas-in-tags.
 *
 *   <TagInput value={tags} onChange={setTags} suggestions={allKnownTags} />
 */
export default function TagInput({ value = [], onChange, suggestions = [], placeholder = 'Add tag…' }) {
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  const addTag = (raw) => {
    const tag = raw.trim().replace(/^,+|,+$/g, '').toLowerCase()
    if (!tag || value.includes(tag)) { setDraft(''); return }
    onChange([...value, tag])
    setDraft('')
  }

  const removeTag = (tag) => onChange(value.filter(t => t !== tag))

  const handleKey = (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (draft.trim()) { e.preventDefault(); addTag(draft) }
    } else if (e.key === 'Backspace' && !draft && value.length) {
      removeTag(value[value.length - 1])
    }
  }

  const filteredSuggestions = draft
    ? suggestions.filter(s => s.startsWith(draft.toLowerCase()) && !value.includes(s)).slice(0, 5)
    : []

  return (
    <div style={{ position: 'relative' }}>
      <div
        onClick={() => inputRef.current?.focus()}
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 4,
          padding: '4px 6px',
          minHeight: 32,
          border: '1px solid var(--gw-border)',
          borderRadius: 'var(--radius)',
          background: '#fff',
          cursor: 'text',
        }}
      >
        {value.map(tag => (
          <span key={tag} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 4px 2px 8px',
            background: 'var(--gw-sky)',
            color: 'var(--gw-azure)',
            borderRadius: 4,
            fontSize: 11, fontWeight: 600,
            fontFamily: 'var(--font-body)',
          }}>
            {tag}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(tag) }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', display: 'flex' }}
              aria-label={`Remove ${tag}`}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          onBlur={() => draft.trim() && addTag(draft)}
          placeholder={value.length === 0 ? placeholder : ''}
          style={{
            flex: 1, minWidth: 80,
            border: 'none', outline: 'none',
            padding: '4px 2px',
            fontSize: 13,
            fontFamily: 'var(--font-body)',
            background: 'transparent',
          }}
        />
      </div>
      {filteredSuggestions.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0,
          background: '#fff',
          border: '1px solid var(--gw-border)',
          borderRadius: 'var(--radius)',
          marginTop: 2,
          boxShadow: 'var(--shadow-dropdown)',
          zIndex: 10,
        }}>
          {filteredSuggestions.map(s => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => addTag(s)}
              style={{
                display: 'block', width: '100%',
                padding: '6px 10px',
                background: 'none',
                border: 'none',
                textAlign: 'left',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'var(--font-body)',
              }}
              onMouseEnter={(e) => e.currentTarget.style.background = 'var(--gw-bone)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
