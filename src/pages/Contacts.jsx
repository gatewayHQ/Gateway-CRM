/**
 * Contacts page — orchestrator.
 *
 * Architecture:
 *   - StatsStrip:     KPI cards (total / new / hot / dormant / in-deal)
 *   - SavedViews:     preset filter tabs (All / Hot / Untouched / New / Mine)
 *   - Toolbar:        search + filters + add/import buttons
 *   - ContactsTable:  virtualized + inline-editable grid (handles 50k+ rows)
 *   - ContactDrawer:  detail panel for view/edit
 *   - CSVImportModal: bulk import with duplicate detection
 *   - BulkActionBar:  floating multi-select toolbar
 *
 * Performance characteristics:
 *   - Heat scores memoized once per (contacts, activities, deals) change
 *   - Sort uses a typed comparator that handles nulls correctly
 *   - Search is debounced
 *   - Table virtualizes — 50k rows render in O(viewport)
 *   - Mutations use optimistic updates via cache layer
 *   - Filters persist to localStorage
 *
 * Keyboard:
 *   /   focus search    j/k  navigate    Enter  open
 *   x   select          ⌘a   select all   Esc    clear
 *   ⌘⌫  delete selected
 */

import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { calcHeatScore } from '../lib/helpers.js'
import { CONTACT_TYPES, CONTACT_STATUSES, titleCase } from '../lib/enums.js'
import { normalizePhone } from '../lib/phone.js'
import { Icon, EmptyState, ConfirmDialog, pushToast } from '../components/UI.jsx'
import { useDebounce } from '../hooks/useDebounce.js'
import { useKeyboard } from '../hooks/useKeyboard.js'
import { usePersistedState } from '../hooks/usePersistedState.js'
import StatsStrip from './Contacts/StatsStrip.jsx'
import SavedViews, { BUILTIN_VIEWS } from './Contacts/SavedViews.jsx'
import ContactsTable from './Contacts/ContactsTable.jsx'
import ContactDrawer from './Contacts/ContactDrawer.jsx'
import CSVImportModal from './Contacts/CSVImportModal.jsx'
import BulkActionBar from './Contacts/BulkActionBar.jsx'

// ─── Comparators that handle nulls correctly ────────────────────────────────
function compareValues(a, b, dir = 'asc') {
  // Push nulls/empty to the end regardless of direction
  const aEmpty = a == null || a === ''
  const bEmpty = b == null || b === ''
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1

  // Date strings
  if (typeof a === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a)) {
    return dir === 'asc' ? new Date(a) - new Date(b) : new Date(b) - new Date(a)
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return dir === 'asc' ? a - b : b - a
  }
  // String compare
  const av = String(a).toLowerCase()
  const bv = String(b).toLowerCase()
  if (av === bv) return 0
  return dir === 'asc' ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1)
}

const HEAT_ORDER = { hot: 0, warm: 1, cold: 2 }

export default function ContactsPage({ db, setDb, activeAgent, go, openCompose, visibleAgentIds, isAdmin }) {
  // ── Persistent filter state ─────────────────────────────────────────────
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounce(search, 150)
  const [filters, setFilters] = usePersistedState('contacts.filters.v2', {
    type: '', status: '', agent: '', heat: '',
  })
  const [view, setView] = usePersistedState('contacts.view.v2', 'all')
  const [sort, setSort] = usePersistedState('contacts.sort.v2', { key: 'created_at', dir: 'desc' })

  // ── UI state ────────────────────────────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [importModal, setImportModal] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [reassignTo, setReassignTo] = useState('')
  const [focusedIndex, setFocusedIndex] = useState(0)
  const searchInputRef = useRef(null)

  // ── Data from props ─────────────────────────────────────────────────────
  const contacts   = db.contacts   || []
  const agents     = db.agents     || []
  const activities = db.activities || []
  const deals      = db.deals      || []

  // ── Heat scores: memoized once per data change ─────────────────────────
  const heatScores = useMemo(() => {
    const map = {}
    for (const c of contacts) map[c.id] = calcHeatScore(c, activities, deals)
    return map
  }, [contacts, activities, deals])

  // ── Active deal index for view predicate ────────────────────────────────
  const activeDealContactIds = useMemo(() => {
    const s = new Set()
    for (const d of deals) {
      if (!['closed', 'lost'].includes(d.stage) && d.contact_id) s.add(d.contact_id)
    }
    return s
  }, [deals])

  // ── All known tags (for autocomplete in TagInput) ───────────────────────
  const allTags = useMemo(() => {
    const tagSet = new Set()
    for (const c of contacts) for (const t of (c.tags || [])) tagSet.add(t)
    return [...tagSet].sort()
  }, [contacts])

  // ── Filtered + sorted contacts ──────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = debouncedSearch.toLowerCase().trim()
    const currentView = BUILTIN_VIEWS.find(v => v.id === view)
    const ctx = { heatScores, activeDealContactIds, activeAgentId: activeAgent?.id }

    let result = contacts.filter(c => {
      // Exclude soft-deleted
      if (c.deleted_at) return false

      // Saved view
      if (currentView && !currentView.predicate(c, ctx)) return false

      // Search
      if (q) {
        const name  = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase()
        const email = (c.email || '').toLowerCase()
        const phone = (c.phone || '').toLowerCase()
        const city  = (c.owner_city || '').toLowerCase()
        const tags  = (c.tags || []).join(' ').toLowerCase()
        if (!name.includes(q) && !email.includes(q) && !phone.includes(q) && !city.includes(q) && !tags.includes(q)) return false
      }

      // Filters
      if (filters.type   && c.type              !== filters.type)   return false
      if (filters.status && c.status            !== filters.status) return false
      if (filters.agent  && c.assigned_agent_id !== filters.agent)  return false
      if (filters.heat   && heatScores[c.id]    !== filters.heat)   return false
      return true
    })

    // Sort
    result.sort((a, b) => {
      let av, bv
      if (sort.key === '_heat') {
        av = HEAT_ORDER[heatScores[a.id]] ?? 99
        bv = HEAT_ORDER[heatScores[b.id]] ?? 99
        return sort.dir === 'asc' ? av - bv : bv - av
      }
      if (sort.key === '_agent') {
        av = agents.find(g => g.id === a.assigned_agent_id)?.name || ''
        bv = agents.find(g => g.id === b.assigned_agent_id)?.name || ''
      } else {
        av = a[sort.key]
        bv = b[sort.key]
      }
      return compareValues(av, bv, sort.dir)
    })

    return result
  }, [contacts, debouncedSearch, filters, view, sort, heatScores, activeDealContactIds, activeAgent?.id, agents])

  // ── Counts per saved view ───────────────────────────────────────────────
  const viewCounts = useMemo(() => {
    const ctx = { heatScores, activeDealContactIds, activeAgentId: activeAgent?.id }
    const counts = {}
    for (const v of BUILTIN_VIEWS) {
      counts[v.id] = contacts.filter(c => !c.deleted_at && v.predicate(c, ctx)).length
    }
    return counts
  }, [contacts, heatScores, activeDealContactIds, activeAgent?.id])

  // ── Clear selection when filters change (prevents invisible-selection bug) ──
  useEffect(() => {
    if (selected.size > 0) {
      setSelected(prev => {
        const visibleIds = new Set(filtered.map(c => c.id))
        const next = new Set()
        for (const id of prev) if (visibleIds.has(id)) next.add(id)
        return next
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, filters, view])

  // ── Optimistic update helper ────────────────────────────────────────────
  const optimisticUpdate = useCallback((id, patch) => {
    setDb(prev => ({
      ...prev,
      contacts: (prev.contacts || []).map(c => c.id === id ? { ...c, ...patch } : c),
    }))
  }, [setDb])

  // ── Mutations ───────────────────────────────────────────────────────────
  // Admins see firm-wide on initial load (App.jsx); a reload here must match
  // or the list silently collapses to team-scope after any save.
  const reload = useCallback(async () => {
    if (!isAdmin && !visibleAgentIds?.length) return
    let q = supabase.from('contacts').select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
    if (!isAdmin) q = q.in('assigned_agent_id', visibleAgentIds)
    const { data } = await q
    if (data) setDb(p => ({ ...p, contacts: data }))
  }, [visibleAgentIds, isAdmin, setDb])

  const softDeleteContacts = useCallback(async (ids) => {
    const arr = Array.isArray(ids) ? ids : [ids]
    // Optimistic remove
    setDb(prev => ({
      ...prev,
      contacts: (prev.contacts || []).map(c =>
        arr.includes(c.id) ? { ...c, deleted_at: new Date().toISOString() } : c
      ),
    }))
    setSelected(new Set())

    // Soft-delete in DB; falls back to hard delete if deleted_at column missing
    let { error } = await supabase.from('contacts')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', arr)

    if (error?.message?.includes('column') || error?.message?.includes('deleted_at')) {
      // Schema not yet migrated — fall back to hard delete
      const { error: delErr } = await supabase.from('contacts').delete().in('id', arr)
      error = delErr
    }

    if (error) { pushToast(error.message, 'error'); reload(); return }

    // Undo toast
    pushToast(
      `${arr.length} contact${arr.length !== 1 ? 's' : ''} deleted`,
      'info',
      {
        actionLabel: 'Undo',
        onAction: async () => {
          // Restore by clearing deleted_at (or re-fetching if hard-deleted)
          const { error: restoreErr } = await supabase.from('contacts')
            .update({ deleted_at: null })
            .in('id', arr)
          if (restoreErr) {
            pushToast('Could not undo — contact was hard-deleted', 'error')
          } else {
            pushToast(`${arr.length} contact${arr.length !== 1 ? 's' : ''} restored`)
            reload()
          }
        },
        duration: 8000,
      }
    )
  }, [setDb, reload])

  const inlineUpdate = useCallback(async (id, field, value) => {
    // Optimistic
    optimisticUpdate(id, { [field]: value })
    const { error } = await supabase.from('contacts').update({ [field]: value }).eq('id', id)
    if (error) {
      pushToast(error.message, 'error')
      reload()  // restore truth
    }
  }, [optimisticUpdate, reload])

  const bulkReassign = useCallback(async (agentId) => {
    if (!agentId) return
    const ids = [...selected]
    // Optimistic
    setDb(prev => ({
      ...prev,
      contacts: (prev.contacts || []).map(c => ids.includes(c.id) ? { ...c, assigned_agent_id: agentId } : c),
    }))
    const { error } = await supabase.from('contacts').update({ assigned_agent_id: agentId }).in('id', ids)
    if (error) { pushToast(error.message, 'error'); reload(); return }
    const agent = agents.find(a => a.id === agentId)
    pushToast(`${ids.length} reassigned to ${agent?.name || 'agent'}`)
    setSelected(new Set())
    setReassignTo('')
  }, [selected, agents, setDb, reload])

  const bulkSetStatus = useCallback(async (status) => {
    const ids = [...selected]
    setDb(prev => ({
      ...prev,
      contacts: (prev.contacts || []).map(c => ids.includes(c.id) ? { ...c, status } : c),
    }))
    const { error } = await supabase.from('contacts').update({ status }).in('id', ids)
    if (error) { pushToast(error.message, 'error'); reload(); return }
    pushToast(`${ids.length} set to ${status}`)
    setSelected(new Set())
  }, [selected, setDb, reload])

  // ── Duplicate detection ─────────────────────────────────────────────────
  const checkDuplicate = useCallback((form) => {
    const email = form.email?.trim().toLowerCase()
    const phone = form.phone ? normalizePhone(form.phone) : null
    return contacts.find(c => {
      if (c.deleted_at) return false
      if (email && c.email?.toLowerCase() === email) return true
      if (phone && normalizePhone(c.phone) === phone) return true
      return false
    })
  }, [contacts])

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  useKeyboard({
    '/':            () => searchInputRef.current?.focus(),
    'j':            () => setFocusedIndex(i => Math.min(filtered.length - 1, i + 1)),
    'k':            () => setFocusedIndex(i => Math.max(0, i - 1)),
    'Enter':        () => { if (filtered[focusedIndex]) { setEditing(filtered[focusedIndex]); setDrawerOpen(true) } },
    'Escape':       () => { if (selected.size) setSelected(new Set()); else setSearch('') },
    'cmd+a':        () => setSelected(new Set(filtered.map(c => c.id))),
    'cmd+Backspace': () => { if (selected.size) setConfirm({ ids: [...selected], bulk: true }) },
    'n':            () => { setEditing(null); setDrawerOpen(true) },
  }, { enabled: !drawerOpen && !importModal && !confirm })

  // ── Stat card → view jump ───────────────────────────────────────────────
  const handleStatJump = (statKey) => {
    const map = { total: 'all', new: 'new', hot: 'hot', untouched: 'untouched', activeDeals: 'in-deal' }
    setView(map[statKey] || 'all')
  }

  const sortColumn = (key) => {
    if (sort.key === key) setSort({ key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })
    else setSort({ key, dir: 'asc' })
  }

  const visible = contacts.filter(c => !c.deleted_at)

  return (
    <div className="page-content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="page-header">
        <div>
          <div className="page-title">Contacts</div>
          <div className="page-sub">
            {filtered.length === visible.length
              ? `${visible.length.toLocaleString()} contacts`
              : `${filtered.length.toLocaleString()} of ${visible.length.toLocaleString()}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--secondary" onClick={() => setImportModal(true)}>
            <Icon name="import" size={14} /> Import CSV
          </button>
          <button className="btn btn--primary" onClick={() => { setEditing(null); setDrawerOpen(true) }}>
            <Icon name="plus" size={14} /> Add Contact
          </button>
        </div>
      </div>

      {/* Stats */}
      <StatsStrip
        contacts={visible}
        heatScores={heatScores}
        deals={deals}
        onFilterStat={handleStatJump}
      />

      {/* Saved views */}
      <SavedViews active={view} onChange={setView} counts={viewCounts} />

      {/* Toolbar */}
      <div className="filters-bar" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', padding: '0 10px', height: 34, flex: 1, maxWidth: 320 }}>
          <Icon name="search" size={14} style={{ color: 'var(--gw-mist)' }} />
          <input
            ref={searchInputRef}
            style={{ border: 'none', outline: 'none', fontSize: 13, flex: 1, fontFamily: 'var(--font-body)' }}
            placeholder="Search name, email, phone, city, tag…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gw-mist)', display: 'flex' }}
              aria-label="Clear search"
            >
              <Icon name="x" size={13} />
            </button>
          )}
          <span style={{ fontSize: 10, color: 'var(--gw-mist)', padding: '2px 6px', background: 'var(--gw-bone)', borderRadius: 4, fontFamily: 'var(--font-mono)' }}>/</span>
        </div>
        <select className="filter-select" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
          <option value="">All Types</option>
          {CONTACT_TYPES.map(t => <option key={t} value={t}>{titleCase(t)}</option>)}
        </select>
        <select className="filter-select" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All Statuses</option>
          {CONTACT_STATUSES.map(s => <option key={s} value={s}>{titleCase(s)}</option>)}
        </select>
        <select className="filter-select" value={filters.agent} onChange={(e) => setFilters({ ...filters, agent: e.target.value })}>
          <option value="">All Agents</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select className="filter-select" value={filters.heat} onChange={(e) => setFilters({ ...filters, heat: e.target.value })}>
          <option value="">All Heat</option>
          <option value="hot">🔥 Hot</option>
          <option value="warm">▲ Warm</option>
          <option value="cold">– Cold</option>
        </select>
        {(filters.type || filters.status || filters.agent || filters.heat || search) && (
          <button
            onClick={() => { setFilters({ type: '', status: '', agent: '', heat: '' }); setSearch('') }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gw-mist)', fontSize: 12, padding: '0 8px', fontFamily: 'var(--font-body)' }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <EmptyState
          icon="contacts"
          title={visible.length === 0 ? 'No contacts yet' : 'No matches'}
          message={visible.length === 0
            ? 'Add your first contact to get started.'
            : 'Try clearing filters or adjusting your search.'}
          action={visible.length === 0
            ? <button className="btn btn--primary" onClick={() => { setEditing(null); setDrawerOpen(true) }}><Icon name="plus" size={14} /> Add Contact</button>
            : null
          }
        />
      ) : (
        <ContactsTable
          rows={filtered}
          agents={agents}
          heatScores={heatScores}
          selected={selected}
          setSelected={setSelected}
          sortKey={sort.key}
          sortDir={sort.dir}
          onSort={sortColumn}
          onOpen={(c) => { setEditing(c); setDrawerOpen(true) }}
          onCompose={(c) => openCompose?.({ to: c.email, contactName: `${c.first_name} ${c.last_name}`, contactId: c.id })}
          onDelete={(id) => setConfirm({ ids: [id], bulk: false })}
          onInlineUpdate={inlineUpdate}
          focusedIndex={focusedIndex}
          setFocusedIndex={setFocusedIndex}
        />
      )}

      {/* Drawer */}
      <ContactDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        contact={editing}
        agents={agents}
        deals={deals}
        tasks={db.tasks || []}
        activities={activities}
        activeAgent={activeAgent}
        allTags={allTags}
        properties={db.properties || []}
        onActivityAdded={(act) => setDb(p => ({ ...p, activities: [act, ...(p.activities || [])] }))}
        onSave={(saved) => {
          if (saved) {
            setDb(p => {
              const existing = (p.contacts || []).find(c => c.id === saved.id)
              const next = existing
                ? p.contacts.map(c => c.id === saved.id ? saved : c)
                : [saved, ...(p.contacts || [])]
              return { ...p, contacts: next }
            })
          } else {
            reload()
          }
        }}
        onDuplicateCheck={checkDuplicate}
      />

      {/* Bulk action bar */}
      <BulkActionBar
        selectedCount={selected.size}
        agents={agents}
        reassignTo={reassignTo}
        setReassignTo={setReassignTo}
        onReassign={bulkReassign}
        onSetStatus={bulkSetStatus}
        onDelete={() => setConfirm({ ids: [...selected], bulk: true })}
        onClear={() => { setSelected(new Set()); setReassignTo('') }}
      />

      {/* Confirm dialogs */}
      {confirm && (
        <ConfirmDialog
          message={confirm.bulk
            ? `Delete ${confirm.ids.length} contact${confirm.ids.length !== 1 ? 's' : ''}? You'll have 8 seconds to undo.`
            : 'Delete this contact? You\'ll have 8 seconds to undo.'}
          onConfirm={() => { softDeleteContacts(confirm.ids); setConfirm(null) }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {/* CSV import */}
      {importModal && (
        <CSVImportModal
          agents={agents}
          activeAgent={activeAgent}
          existingContacts={visible}
          onClose={() => setImportModal(false)}
          onImported={reload}
        />
      )}
    </div>
  )
}
