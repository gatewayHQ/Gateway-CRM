// Shared behaviour for the design-system primitives: overlay focus management,
// responsive queries and the controlled/uncontrolled state pattern.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { registerLayer, isTopLayer } from './layers.js'

// ─── Focus ────────────────────────────────────────────────────────────────────

const TABBABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', 'iframe', 'audio[controls]', 'video[controls]',
  '[contenteditable]:not([contenteditable="false"])', '[tabindex]:not([tabindex="-1"])',
].join(',')

/**
 * The elements Tab can reach inside `container`, in DOM order.
 * Hidden elements are skipped — but only when the container itself has layout.
 * Without a layout engine (jsdom) nothing has client rects, and filtering on
 * them would make every element look hidden.
 */
export function getTabbable(container) {
  if (!container) return []
  const hasLayout = container.getClientRects().length > 0
  return [...container.querySelectorAll(TABBABLE)].filter(el =>
    el.tabIndex >= 0 &&
    !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
    (!hasLayout || el.getClientRects().length > 0),
  )
}

// ─── Scroll lock ──────────────────────────────────────────────────────────────
// Counted, so two overlays opening and closing out of order never leave the
// page locked (or unlocked under a still-open dialog).
let lockCount = 0
let savedOverflow = ''
function lockScroll() {
  if (typeof document === 'undefined') return () => {}
  if (lockCount++ === 0) {
    savedOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  return () => {
    if (--lockCount === 0) document.body.style.overflow = savedOverflow
  }
}

/**
 * Everything an overlay (modal, drawer, sheet) needs to behave like one:
 *
 *  - registers on the overlay stack, so only the TOP overlay answers Escape;
 *  - moves focus inside on open — to `initialFocusRef`, else an element marked
 *    `data-autofocus`, else the panel itself — unless an `autoFocus` field
 *    already took it;
 *  - keeps Tab / Shift+Tab cycling inside while it is the top layer;
 *  - returns focus to whatever opened it, on close;
 *  - locks page scroll behind it;
 *  - optionally names itself from its first heading (`autoLabel`), for the
 *    legacy Modal whose callers pass free-form children and no title.
 *
 * `containerRef` is the element with role="dialog".
 */
export function useOverlay(open, {
  containerRef, onClose, kind = 'modal', dismissible = true,
  initialFocusRef = null, restoreFocus = true, autoLabel = false,
}) {
  const layerRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const dismissibleRef = useRef(dismissible)
  dismissibleRef.current = dismissible

  // Layout effect: register before children's passive effects run, and capture
  // the opener before an autoFocus field moves focus away from it.
  const openerRef = useRef(null)
  useLayoutEffect(() => {
    if (!open) return
    openerRef.current = typeof document !== 'undefined' ? document.activeElement : null
    const layer = registerLayer({
      kind,
      getNode: () => containerRef.current,
      onEscape: () => { if (dismissibleRef.current) onCloseRef.current?.() },
    })
    layerRef.current = layer
    const unlock = lockScroll()
    return () => {
      layer.remove()
      layerRef.current = null
      unlock()
      // Only hand focus back if it was lost with the overlay (it's on <body>
      // now) — never yank it from somewhere the user deliberately went.
      const opener = openerRef.current
      if (restoreFocus && opener?.isConnected && typeof opener.focus === 'function') {
        const active = document.activeElement
        const panel = containerRef.current
        if (!active || active === document.body || panel?.contains(active)) {
          // After React finishes removing the overlay's DOM.
          queueMicrotask(() => { if (opener.isConnected) opener.focus({ preventScroll: true }) })
        }
      }
    }
  }, [open, kind]) // eslint-disable-line react-hooks/exhaustive-deps

  // Initial focus + accessible name.
  useEffect(() => {
    if (!open) return
    const panel = containerRef.current
    if (!panel) return
    if (autoLabel && !panel.hasAttribute('aria-label') && !panel.hasAttribute('aria-labelledby')) {
      const heading = panel.querySelector('[data-dialog-title], h1, h2, h3, .drawer__title')
      if (heading) {
        if (!heading.id) heading.id = `dlg-title-${Math.random().toString(36).slice(2, 9)}`
        panel.setAttribute('aria-labelledby', heading.id)
      }
    }
    if (panel.contains(document.activeElement)) return
    const target = initialFocusRef?.current || panel.querySelector('[data-autofocus]') || panel
    target.focus({ preventScroll: true })
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus trap — Tab wraps at the edges while this overlay is on top. Soft by
  // design: it doesn't fight a click that lands outside (a toast's Undo, an
  // embedded iframe), it only stops keyboard focus from leaking behind.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key !== 'Tab' || !isTopLayer(layerRef.current?.id)) return
      const panel = containerRef.current
      if (!panel) return
      const items = getTabbable(panel)
      if (!items.length) { e.preventDefault(); panel.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const inside = panel.contains(active)
      if (e.shiftKey && (!inside || active === first || active === panel)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (!inside || active === last)) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Backdrop click that only closes on a click that STARTED on the backdrop.
 * A plain onClick also fires when someone drags to select text in a field and
 * releases outside the panel — and throws away the half-filled form.
 */
export function useBackdropDismiss(onDismiss, enabled = true) {
  const downOnBackdrop = useRef(false)
  return {
    onMouseDown: (e) => { downOnBackdrop.current = e.target === e.currentTarget },
    onClick: (e) => {
      const ok = enabled && downOnBackdrop.current && e.target === e.currentTarget
      downOnBackdrop.current = false
      if (ok) onDismiss?.()
    },
  }
}

// ─── Responsive ───────────────────────────────────────────────────────────────

/** Live `matchMedia` result. False where matchMedia doesn't exist (SSR, tests). */
export function useMediaQuery(query) {
  const get = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false)
  const [matches, setMatches] = useState(get)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener?.('change', onChange)
    return () => mql.removeEventListener?.('change', onChange)
  }, [query])
  return matches
}

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * The controlled/uncontrolled pattern every input-like component uses: pass
 * `value` + `onChange` to own the state, or `defaultValue` (or nothing) to let
 * the component own it. `onChange` fires either way.
 */
export function useControllableState(value, defaultValue, onChange) {
  const controlled = value !== undefined
  const [inner, setInner] = useState(defaultValue)
  const current = controlled ? value : inner
  const currentRef = useRef(current)
  currentRef.current = current
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const set = useCallback((next) => {
    const resolved = typeof next === 'function' ? next(currentRef.current) : next
    if (Object.is(resolved, currentRef.current)) return
    // So a second updater in the same tick builds on this one, not on stale state.
    currentRef.current = resolved
    if (!controlled) setInner(resolved)
    onChangeRef.current?.(resolved)
  }, [controlled])
  return [current, set]
}
