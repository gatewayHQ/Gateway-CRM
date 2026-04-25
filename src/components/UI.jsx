import React, { useState, useEffect } from 'react'

// ─── ICONS ───────────────────────────────────────────────────────────────────
const ICONS = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  contacts: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
  building: <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>,
  pipeline: <><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></>,
  tasks: <><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></>,
  team: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
  mail: <><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
  search: <><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>,
  chevronLeft: <polyline points="15 18 9 12 15 6"/>,
  chevronRight: <polyline points="9 18 15 12 9 6"/>,
  chevronDown: <polyline points="6 9 12 15 18 9"/>,
  plus: <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
  edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></>,
  trash: <><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></>,
  x: <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>,
  check: <polyline points="20 6 9 17 4 12"/>,
  send: <><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></>,
  copy: <><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>,
  phone: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.5 19.79 19.79 0 0 1 1.61 4.93 2 2 0 0 1 3.58 2.72h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 10.07a16 16 0 0 0 6.02 6.02l1.41-1.41a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>,
  calendar: <><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></>,
  tag: <><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></>,
  dollar: <><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></>,
  home: <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>,
  eye: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>,
  alert: <><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></>,
  filter: <><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></>,
  star: <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>,
  call: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.5 19.79 19.79 0 0 1 1.61 4.93 2 2 0 0 1 3.58 2.72h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 10.07a16 16 0 0 0 6.02 6.02l1.41-1.41a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>,
  document: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></>,
  refresh: <><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></>,
}

export function Icon({ name, size = 16, style, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={style} className={className}>
      {ICONS[name] || ICONS.alert}
    </svg>
  )
}

// ─── AVATAR ───────────────────────────────────────────────────────────────────
export function Avatar({ agent, size = 32 }) {
  if (!agent) return null
  return (
    <div className="avatar" style={{ width: size, height: size, background: agent.color || '#2d3561', fontSize: size * 0.35 }}>
      {agent.initials}
    </div>
  )
}

// ─── BADGE ────────────────────────────────────────────────────────────────────
export function Badge({ variant, children }) {
  return <span className={`badge badge--${variant}`}>{children}</span>
}

// ─── MODAL ────────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, children, width = 520 }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    if (open) window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width, maxWidth: 'calc(100vw - 48px)' }}>
        {children}
      </div>
    </div>
  )
}

// ─── DRAWER ───────────────────────────────────────────────────────────────────
export function Drawer({ open, onClose, title, children, width = 480 }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    if (open) window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer" style={{ width, maxWidth: 'calc(100vw - 48px)' }}>
        <div className="drawer__head">
          <div className="drawer__title">{title}</div>
          <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>
        {children}
      </div>
    </>
  )
}

// ─── EMPTY STATE ──────────────────────────────────────────────────────────────
export function EmptyState({ icon = 'alert', title, message, action }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon"><Icon name={icon} size={24} /></div>
      <div className="empty-state__title">{title}</div>
      <div className="empty-state__msg">{message}</div>
      {action}
    </div>
  )
}

// ─── CONFIRM DIALOG ───────────────────────────────────────────────────────────
export function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <Modal open={true} onClose={onCancel} width={400}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">Confirm Action</div>
          <h3 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--font-display)' }}>Are you sure?</h3>
        </div>
        <button className="drawer__close" onClick={onCancel}><Icon name="x" size={18} /></button>
      </div>
      <div className="modal__body">
        <p style={{ fontSize: 14, color: 'var(--gw-mist)', lineHeight: 1.6 }}>{message}</p>
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onCancel}>Cancel</button>
        <button className="btn btn--danger" onClick={onConfirm}>Delete</button>
      </div>
    </Modal>
  )
}

// ─── SEARCH DROPDOWN ─────────────────────────────────────────────────────────
export function SearchDropdown({ items = [], onSelect, placeholder = 'Search...', value, labelKey = 'name' }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const filtered = items.filter(i => {
    const label = typeof labelKey === 'function' ? labelKey(i) : i[labelKey]
    return label?.toLowerCase().includes(query.toLowerCase())
  })

  const selectedItem = items.find(i => i.id === value)
  const displayLabel = selectedItem ? (typeof labelKey === 'function' ? labelKey(selectedItem) : selectedItem[labelKey]) : ''

  return (
    <div style={{ position: 'relative' }}>
      <input
        className="form-control"
        placeholder={placeholder}
        value={open ? query : displayLabel}
        onFocus={() => { setOpen(true); setQuery('') }}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        onChange={e => setQuery(e.target.value)}
      />
      {open && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff',
          border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-modal)', zIndex: 300, maxHeight: 200, overflowY: 'auto', marginTop: 2
        }}>
          <div style={{ padding: '4px 0' }}>
            {filtered.map(item => (
              <div key={item.id}
                onMouseDown={() => { onSelect(item.id); setOpen(false); }}
                style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, transition: 'background 150ms' }}
                onMouseEnter={e => e.target.style.background = 'var(--gw-bone)'}
                onMouseLeave={e => e.target.style.background = 'transparent'}
              >
                {typeof labelKey === 'function' ? labelKey(item) : item[labelKey]}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── TOAST SYSTEM ─────────────────────────────────────────────────────────────
let toastSetterFn = null
export function setToastSetter(fn) { toastSetterFn = fn }
export function pushToast(message, type = 'success') {
  if (toastSetterFn) toastSetterFn(prev => [...prev, { id: Date.now(), message, type }])
}

export function ToastHost() {
  const [toasts, setToasts] = useState([])
  useEffect(() => { setToastSetter(setToasts) }, [])
  useEffect(() => {
    if (toasts.length === 0) return
    const t = setTimeout(() => setToasts(prev => prev.slice(1)), 3000)
    return () => clearTimeout(t)
  }, [toasts])
  return (
    <div className="toast-host">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast--${t.type}`}>
          <Icon name={t.type === 'success' ? 'check' : t.type === 'error' ? 'x' : 'alert'} size={14} />
          {t.message}
        </div>
      ))}
    </div>
  )
}

// ─── LOADING ──────────────────────────────────────────────────────────────────
export function Loading() {
  return <div className="loading"><div className="spinner" /> Loading…</div>
}
