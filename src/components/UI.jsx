import React, { useState, useEffect, useRef, useCallback, useId, Component } from 'react'
import { useOverlay, useBackdropDismiss } from './ui/hooks.js'
import { hasOpenLayer } from './ui/layers.js'
import { EmptyState } from './ui/Feedback.jsx'
import { pushToast, setToastSetter, ToastHost } from './ui/Toast.jsx'
import { Tabs } from './ui/Tabs.jsx'

// ─── ICONS ───────────────────────────────────────────────────────────────────
// Lives in ./ui/Icon.jsx so the design-system primitives can use it without
// importing this file (which re-exports them).
export { Icon } from './ui/Icon.jsx'
import { Icon } from './ui/Icon.jsx'

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
// Free-form modal: the caller supplies the .modal__head / __body / __foot.
// For new code prefer <Dialog> from ./ui, which lays those out for you.
//
// Overlay behaviour (Escape, focus, scroll lock) comes from useOverlay, which
// registers on a shared stack so only the TOPMOST overlay answers Escape.
// Modals open on top of drawers (the deal drawer's Signatures tab, for one) and
// on top of each other (a leave-confirmation inside the BoldSign workspace);
// when each listened on window for itself, one Escape closed every layer at
// once — unfinished signature prep included.
//
// The dialog names itself from its first heading (aria-labelledby) unless
// `ariaLabel` is passed. `role="alertdialog"` for interrupting decisions.
export const modalIsOpen = () => hasOpenLayer('modal')

// `width` is the usual inline pixel width for a form-shaped dialog. Pass
// `width={null}` together with a sizing `className` (e.g. "modal--workspace") when
// the size belongs in CSS instead — an inline width would beat the stylesheet and
// silently defeat both the class and its responsive fallbacks.
export function Modal({ open, onClose, children, width = 520, className = '', ariaLabel, role = 'dialog', dismissible = true }) {
  const panelRef = useRef(null)
  useOverlay(open, { containerRef: panelRef, onClose, kind: 'modal', dismissible, autoLabel: !ariaLabel })
  const backdrop = useBackdropDismiss(onClose, dismissible)

  if (!open) return null
  return (
    <div className="modal-backdrop" {...backdrop}>
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        className={`modal${className ? ` ${className}` : ''}`}
        style={width != null ? { width, maxWidth: 'calc(100vw - 48px)' } : undefined}
      >
        {children}
      </div>
    </div>
  )
}

// ─── DRAWER ───────────────────────────────────────────────────────────────────
// A side panel over the page. Same overlay behaviour as Modal, ranked below it:
// a modal opened from inside a drawer gets Escape and Tab first.
export function Drawer({ open, onClose, title, children, width = 480, headerExtra = null }) {
  const panelRef = useRef(null)
  const titleId = `drawer-title-${useId().replace(/:/g, '')}`
  useOverlay(open, { containerRef: panelRef, onClose, kind: 'drawer' })

  if (!open) return null
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className="drawer" style={{ width, maxWidth: 'calc(100vw - 48px)' }}
      >
        <div className="drawer__head">
          <div className="drawer__title" id={titleId}>{title}</div>
          {/* Anything the drawer's owner wants beside the close button — the
              deal drawer puts its widen/narrow toggle here. */}
          {headerExtra}
          <button type="button" className="drawer__close" onClick={onClose} aria-label="Close panel"><Icon name="x" size={18} /></button>
        </div>
        {children}
      </div>
    </>
  )
}

// ─── EMPTY STATE ──────────────────────────────────────────────────────────────
// Lives in ./ui (variants: empty / no-results / error). Same props as before.
export { EmptyState }

// ─── CONFIRM DIALOG ───────────────────────────────────────────────────────────
// Defaults are the delete confirmation this started as, so existing callers are
// unchanged. `title` / `confirmLabel` / `eyebrow` let it speak plainly for other
// decisions — "Leave" reads very differently from "Delete" when what's at stake is
// half an hour of field placement.
export function ConfirmDialog({
  message, onConfirm, onCancel,
  title = 'Are you sure?', confirmLabel = 'Delete', eyebrow = 'Confirm Action',
  // `busyLabel` because the default reads "Saving…" — right for the edit dialogs
  // this started as, wrong (and briefly alarming) on a dialog whose button sends
  // a binding agreement to a client.
  confirmVariant = 'btn--danger', cancelLabel = 'Cancel', busy = false, busyLabel = 'Saving…',
  // A THIRD DOOR, for the dialogs where "cancel or confirm" is a false choice.
  // Leaving a half-prepared agreement is the case that needs it: save the work,
  // throw it away, or go back to it are three different answers, and folding
  // "throw it away" into Cancel is how work gets lost by someone who read the
  // buttons correctly. { label, onClick, variant } — omitted, nothing renders
  // and every existing dialog is unchanged.
  extraAction = null,
}) {
  return (
    // An interrupting decision: alertdialog, and focus starts on Cancel — the
    // safe choice — so a stray Enter can't delete or send anything.
    <Modal open={true} onClose={onCancel} width={420} role="alertdialog" dismissible={!busy}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">{eyebrow}</div>
          <h3 style={{ margin: 0, fontSize: 18, fontFamily: 'var(--font-display)' }}>{title}</h3>
        </div>
        <button type="button" className="drawer__close" onClick={onCancel} disabled={busy} aria-label="Close"><Icon name="x" size={18} /></button>
      </div>
      <div className="modal__body">
        <div style={{ fontSize: 14, color: 'var(--gw-mist)', lineHeight: 1.6 }}>{message}</div>
      </div>
      <div className="modal__foot">
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={busy} data-autofocus>{cancelLabel}</button>
        {extraAction && (
          <button
            type="button"
            className={`btn ${extraAction.variant || 'btn--secondary'}`}
            onClick={extraAction.onClick}
            disabled={busy || extraAction.disabled}
          >
            {extraAction.label}
          </button>
        )}
        <button type="button" className={`btn ${confirmVariant}`} onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>
          {busy ? busyLabel : confirmLabel}
        </button>
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
// Lives in ./ui/Toast.jsx — pushToast(message, type?, { actionLabel, onAction, duration }).
export { pushToast, setToastSetter, ToastHost }

// ─── HEAT BADGE ───────────────────────────────────────────────────────────────
export function HeatBadge({ score }) {
  if (!score) return null
  const cfg = {
    hot:  { bg: '#fde8e8', color: '#c0392b', label: 'Hot' },
    warm: { bg: '#fef3cd', color: '#856404', label: 'Warm' },
    cold: { bg: 'var(--gw-bone)', color: 'var(--gw-mist)', label: 'Cold' },
  }
  const c = cfg[score] || cfg.cold
  return (
    <span style={{ padding: '2px 7px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: c.bg, color: c.color, whiteSpace: 'nowrap', letterSpacing: '0.03em' }}>
      {c.label}
    </span>
  )
}

// ─── BRAND ────────────────────────────────────────────────────────────────────
// The Wolf CRM seal — the only place the artwork path is spelled out. Both
// spots that show the mark (the boot screen and the top-left brand slot in the
// app chrome) render this, so the asset moves in one edit.
//
// The artwork is square, so width === height and `object-fit: contain` keeps
// the circle circular at any size. Two raster widths ship: 128px covers the
// header up to 3x, 512px covers the boot screen up to 2x — the browser picks
// from `sizes`, which is just the CSS size the caller asked for.
const BRAND_SRCSET = (ext) =>
  `/brand/wolf-crm-logo-128.${ext} 128w, /brand/wolf-crm-logo-512.${ext} 512w`

export function BrandLogo({ size = 32, className = '', priority = false }) {
  return (
    <picture>
      <source type="image/webp" srcSet={BRAND_SRCSET('webp')} sizes={`${size}px`} />
      <img
        src="/brand/wolf-crm-logo-512.png"
        srcSet={BRAND_SRCSET('png')}
        sizes={`${size}px`}
        width={size}
        height={size}
        alt="The Wolf CRM"
        className={`brand-seal${className ? ' ' + className : ''}`}
        draggable={false}
        decoding={priority ? 'sync' : 'async'}
        fetchPriority={priority ? 'high' : 'auto'}
      />
    </picture>
  )
}

// ─── LOADING ──────────────────────────────────────────────────────────────────
export function Loading() {
  return <div className="loading" role="status"><div className="spinner" aria-hidden="true" /> Loading…</div>
}

// Full-screen boot state, shown while the session and the initial dataset are
// still in flight. Dark field so the seal's own charcoal ground disappears
// into the page instead of sitting on a bright rectangle.
export function BootScreen() {
  return (
    <div className="boot" role="status" aria-live="polite">
      <BrandLogo size={220} className="boot__seal" priority />
      <div className="boot__spinner" aria-hidden="true" />
      <span className="sr-only">Loading…</span>
    </div>
  )
}

/** The boot screen when the first load failed: what happened, and a retry. */
export function BootError({ message, onRetry, onSignOut }) {
  return (
    <div className="boot boot--error" role="alert">
      <BrandLogo size={120} className="boot__seal" priority />
      <div className="boot__error-title">Your CRM didn't load</div>
      <div className="boot__error-msg">{message} Nothing has been lost — your records are safe.</div>
      <div className="boot__error-actions">
        <button type="button" className="btn btn--primary" onClick={onRetry}><Icon name="refresh" size={14} /> Try again</button>
        {onSignOut && <button type="button" className="btn btn--ghost boot__error-signout" onClick={onSignOut}>Sign out</button>}
      </div>
    </div>
  )
}

// ─── OVERFLOW MENU ────────────────────────────────────────────────────────────
// The "…" a row's less-used actions live behind.
//
// It exists because a row that shows every action it supports shows none of
// them: the Signatures tab used to put nine controls on one packet, and the one
// an agent wanted was never the one their eye landed on. Here the row keeps the
// action that moves the packet forward and this holds the rest — nothing is
// removed, it just stops competing.
//
// `items` is [{ label, onClick, title, disabled, danger, divider }]. A `divider`
// entry draws a rule instead of a button, which is how "delete" gets separated
// from everything that is not destructive.
//
// Closes on pick, on Escape, and on any click outside — including a click on
// another menu's trigger, so two can never be open at once.
// Roughly how tall the menu will be, from what is in it. Used only to decide
// whether it opens downward or upward, so an estimate is enough — being a few
// pixels out picks the same side.
const MENU_ITEM_H = 29
const MENU_DIVIDER_H = 9
const MENU_GAP = 4
const menuHeight = (items) => items.reduce((h, it) => h + (it.divider ? MENU_DIVIDER_H : MENU_ITEM_H), 8)

// Two placements are the same when every side they pin is the same. Compared by
// value because each call to place() builds a fresh object.
const POS_KEYS = ['top', 'bottom', 'left', 'right', 'maxHeight']
const samePos = (a, b) => POS_KEYS.every(k => a[k] === b[k])

export function MenuButton({ items = [], label = '⋯', title = 'More actions', align = 'right', disabled = false, className = 'btn btn--ghost btn--icon btn--sm' }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const wrap = useRef(null)
  const btn = useRef(null)

  const usable = items.filter(Boolean)
  // Read through a ref inside place(). `usable` is a fresh array on every
  // render, so depending on it directly would rebuild place(), which would
  // re-run the effect, which calls place(), which sets state, which renders
  // again — a loop that spins for as long as the menu is open and churns the
  // scroll listener so fast it never catches a scroll.
  const usableRef = useRef(usable)
  usableRef.current = usable

  // WHY THIS IS position: fixed AND NOT position: absolute.
  //
  // An absolutely-positioned menu is clipped by any ancestor with `overflow:
  // hidden`, and cards clip on purpose — the signature rows use it to keep a
  // colour rail and a footer strip inside their rounded corners. The menu was
  // opening into that clip and vanishing completely: the button worked, the
  // items rendered, and nothing was on screen. A fixed element is positioned
  // against the viewport, so ancestor overflow cannot cut it off.
  //
  // It still lives inside `wrap` in the DOM, which is what keeps the click-away
  // check below honest — DOM containment does not care where a box is painted.
  const place = useCallback(() => {
    const el = btn.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 8
    // Open upward when there is not room beneath and there is more above — a
    // row near the bottom of a scrolling drawer is the common case.
    const up = menuHeight(usableRef.current) > below && r.top > below
    const next = {
      ...(up ? { bottom: window.innerHeight - r.top + MENU_GAP } : { top: r.bottom + MENU_GAP }),
      ...(align === 'right'
        ? { right: Math.max(8, window.innerWidth - r.right) }
        : { left: Math.max(8, r.left) }),
      // Never taller than the room it has; scroll rather than run off-screen.
      maxHeight: Math.max(120, (up ? r.top - 12 : below)),
    }
    // Keep the previous object when nothing moved, so a scroll that does not
    // shift the button does not re-render every listener on the page.
    setPos(prev => (prev && samePos(prev, next) ? prev : next))
  }, [align])

  useEffect(() => {
    if (!open) return
    place()
    const away = (e) => { if (!wrap.current?.contains(e.target)) setOpen(false) }
    const esc  = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    // Fixed coordinates go stale the moment anything scrolls, so follow the
    // button rather than leaving the menu behind. Capture phase catches scrolls
    // on inner panes (the deal drawer) as well as the window.
    const follow = () => place()
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', esc, true)
    document.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', esc, true)
      document.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [open, place])

  if (!usable.length) return null

  return (
    <span ref={wrap} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={btn}
        type="button" className={className} title={title} aria-haspopup="menu" aria-expanded={open}
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
      >
        {label}
      </button>
      {open && pos && (
        <div
          role="menu"
          onClick={e => e.stopPropagation()}
          style={{
            position: 'fixed', ...pos, zIndex: 160,
            background: '#fff', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)',
            boxShadow: 'var(--shadow-card)', padding: 4, minWidth: 186,
            display: 'flex', flexDirection: 'column', overflowY: 'auto',
          }}
        >
          {usable.map((item, i) => item.divider ? (
            <hr key={`d${i}`} style={{ border: 0, borderTop: '1px solid var(--gw-border)', margin: '4px 2px' }} />
          ) : (
            <button
              key={item.label}
              type="button" role="menuitem" title={item.title || undefined} disabled={item.disabled}
              onClick={(e) => { e.stopPropagation(); setOpen(false); item.onClick?.(e) }}
              style={{
                textAlign: 'left', fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: 1.5,
                padding: '6px 9px', border: 0, borderRadius: 4, background: 'transparent',
                color: item.disabled ? 'var(--gw-mist)' : item.danger ? 'var(--gw-red)' : 'var(--gw-ink)',
                cursor: item.disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
              }}
              onMouseEnter={e => { if (!item.disabled) e.currentTarget.style.background = 'var(--gw-bone)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

// Lives in ./ui/Tabs.jsx — WAI-ARIA tabs with arrow-key navigation. Same props.
export { Tabs }

// ─── ERROR BOUNDARY ───────────────────────────────────────────────────────────
export class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 8 }}>Something went wrong</div>
          <div style={{ fontSize: 13, color: 'var(--gw-mist)', marginBottom: 20, maxWidth: 400, margin: '0 auto 20px' }}>
            {this.state.error.message}
          </div>
          <button className="btn btn--secondary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
