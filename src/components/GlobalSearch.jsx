// ─────────────────────────────────────────────────────────────────────────────
// GlobalSearch — the topbar search box.
//
// The input existed in App.jsx with no onChange, no state and no handler, while
// search_contacts() and search_properties() sat in the database GIN-indexed,
// granted to `authenticated`, and called from nowhere. This connects the two.
//
// Contacts and properties are searched server-side through those RPCs (they can
// be large, and an admin sees the whole firm). Deals are filtered in memory —
// App.jsx already holds every deal the user can see, so a round trip would be
// pure latency.
//
// If the RPCs are missing (an older database that never ran the schema), the
// component falls back to filtering the already-loaded rows rather than
// rendering an error. Search degrades; it never breaks.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { useDebounce } from '../hooks/useDebounce.js'
import { Icon } from './UI.jsx'
import { STAGE_LABELS } from '../lib/stages.js'
import {
  PER_SECTION, isSearchable, searchAgentIds,
  filterContacts, filterProperties, filterDeals,
  flattenResults, moveCursor,
} from '../lib/search.js'

export default function GlobalSearch({ db, visibleAgentIds = [], propertyAgentIds = [], isAdmin = false, onNavigate }) {
  const [q, setQ]             = useState('')
  const [open, setOpen]       = useState(false)
  const [loading, setLoading] = useState(false)
  const [cursor, setCursor]   = useState(0)
  const [remote, setRemote]   = useState({ contacts: [], properties: [] })
  const inputRef              = useRef(null)
  const boxRef                = useRef(null)
  const debounced             = useDebounce(q, 200)

  // An admin searches the whole roster; everyone else searches the agents they
  // can already see. The RPC filters on this list AND RLS applies on top.
  // Contacts and properties are shared under separate team flags, so they get
  // separate lists — search must not surface a property the Properties page
  // (correctly) won't show.
  const agentIds = useMemo(
    () => searchAgentIds({ isAdmin, agents: db.agents || [], visibleAgentIds }),
    [isAdmin, db.agents, visibleAgentIds]
  )
  const propertyIds = useMemo(
    () => searchAgentIds({ isAdmin, agents: db.agents || [], visibleAgentIds: propertyAgentIds }),
    [isAdmin, db.agents, propertyAgentIds]
  )

  useEffect(() => {
    const term = debounced.trim()
    if (!isSearchable(term)) { setRemote({ contacts: [], properties: [] }); setLoading(false); return }

    let cancelled = false
    setLoading(true)
    ;(async () => {
      const [c, p] = await Promise.all([
        supabase.rpc('search_contacts',   { search_term: term, agent_ids: agentIds,    result_limit: PER_SECTION }),
        supabase.rpc('search_properties', { search_term: term, agent_ids: propertyIds, result_limit: PER_SECTION }),
      ])
      if (cancelled) return

      // Fall back to the in-memory rows if an RPC is unavailable.
      const contacts   = c.error ? filterContacts(db.contacts || [], term)     : (c.data || [])
      const properties = p.error ? filterProperties(db.properties || [], term) : (p.data || [])

      setRemote({ contacts, properties })
      setLoading(false)
    })()

    return () => { cancelled = true }
  }, [debounced, agentIds, propertyIds, db.contacts, db.properties])

  // Deals are already in memory — filter directly.
  const deals = useMemo(
    () => filterDeals(db.deals || [], debounced),
    [debounced, db.deals]
  )

  // One flat list so arrow keys cross section boundaries.
  const flat = useMemo(
    () => flattenResults({ ...remote, deals }, (s) => STAGE_LABELS[s] || s),
    [remote, deals]
  )

  useEffect(() => { setCursor(0) }, [flat.length])

  const close = useCallback(() => { setOpen(false); setCursor(0) }, [])

  const choose = useCallback((item) => {
    if (!item) return
    onNavigate?.(item)
    setQ('')
    close()
    inputRef.current?.blur()
  }, [onNavigate, close])

  // ⌘K / Ctrl+K focuses the box from anywhere. Registered directly rather than
  // through useKeyboard because that hook ignores events originating in inputs,
  // and Escape has to work while the box itself has focus.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Click-away
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) close() }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])

  const onKeyDown = (e) => {
    if (e.key === 'Escape')    { e.stopPropagation(); setQ(''); close(); inputRef.current?.blur(); return }
    if (!flat.length) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(i => moveCursor(i,  1, flat.length)) }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(i => moveCursor(i, -1, flat.length)) }
    if (e.key === 'Enter')     { e.preventDefault(); choose(flat[cursor]) }
  }

  const showPanel = open && isSearchable(debounced)

  const section = (kind, title, icon) => {
    const items = flat.filter(f => f.kind === kind)
    if (!items.length) return null
    return (
      <div key={kind}>
        <div className="gsearch__section">{title}</div>
        {items.map(item => {
          const idx = flat.indexOf(item)
          return (
            <div
              key={`${kind}-${item.id}`}
              className={`gsearch__item${idx === cursor ? ' is-active' : ''}`}
              onMouseEnter={() => setCursor(idx)}
              onMouseDown={(e) => { e.preventDefault(); choose(item) }}
              role="option"
              aria-selected={idx === cursor}
            >
              <Icon name={icon} size={14} className="gsearch__icon" />
              <div className="gsearch__text">
                <div className="gsearch__label">{item.label || '—'}</div>
                <div className="gsearch__sub">{item.sub}</div>
              </div>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="topbar__search" ref={boxRef}>
      <Icon name="search" size={14} style={{ color: 'var(--gw-mist)' }} />
      <input
        ref={inputRef}
        value={q}
        placeholder="Search contacts, properties, deals…"
        onChange={e => { setQ(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label="Search contacts, properties and deals"
        aria-expanded={showPanel}
        role="combobox"
        aria-controls="gsearch-results"
      />
      {!q && <kbd className="gsearch__kbd">⌘K</kbd>}

      {showPanel && (
        <div className="gsearch__panel" id="gsearch-results" role="listbox">
          {loading && !flat.length && <div className="gsearch__empty">Searching…</div>}
          {!loading && !flat.length && (
            <div className="gsearch__empty">No matches for “{debounced.trim()}”</div>
          )}
          {section('contact',  'Contacts',   'contacts')}
          {section('property', 'Properties', 'building')}
          {section('deal',     'Deals',      'pipeline')}
        </div>
      )}
    </div>
  )
}
