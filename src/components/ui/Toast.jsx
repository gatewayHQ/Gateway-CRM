import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon.jsx'

/**
 * pushToast(message, type?)
 * pushToast(message, type, { actionLabel, onAction, duration })
 *
 *   pushToast('Contact saved')
 *   pushToast('Send failed', 'error')
 *   pushToast('1 contact deleted', 'info', { actionLabel: 'Undo', onAction: () => restore(id), duration: 8000 })
 *
 * Types: 'success' | 'error' | 'info'. Errors stay twice as long by default —
 * they're the ones someone needs to read, and often to act on.
 */
let toastSetterFn = null
export function setToastSetter(fn) { toastSetterFn = fn }

// Past this many, the oldest goes. A bulk action that toasts per record must
// not paper the screen.
const MAX_TOASTS = 4
const DURATION_MS = 3000
const ERROR_DURATION_MS = 6000
// A paused toast resumes with at least this long left, so it can't vanish the
// instant the pointer leaves it.
const MIN_RESUME_MS = 800

export function pushToast(message, type = 'success', opts = {}) {
  if (!toastSetterFn) return
  const id = Date.now() + Math.random()
  toastSetterFn(prev => [...prev, {
    id,
    message,
    type,
    actionLabel: opts.actionLabel || null,
    onAction:    opts.onAction    || null,
    duration:    opts.duration    || (type === 'error' ? ERROR_DURATION_MS : DURATION_MS),
  }].slice(-MAX_TOASTS))
}

/**
 * One toast, owning its own timer. (One effect re-arming every toast's timer
 * on each change meant every new toast reset the clocks of those already on
 * screen.) The timer pauses while the pointer is over the toast or focus is in
 * it, so an Undo can't vanish from under the cursor.
 */
function ToastItem({ toast, onDismiss }) {
  const [paused, setPaused] = useState(false)
  const remaining = useRef(toast.duration)
  const startedAt = useRef(0)

  useEffect(() => {
    if (paused) return
    startedAt.current = Date.now()
    const t = setTimeout(() => onDismiss(toast.id), remaining.current)
    return () => {
      clearTimeout(t)
      remaining.current = Math.max(MIN_RESUME_MS, remaining.current - (Date.now() - startedAt.current))
    }
  }, [paused]) // eslint-disable-line react-hooks/exhaustive-deps

  const pause = () => setPaused(true)
  const resume = () => setPaused(false)

  return (
    <div
      className={`toast toast--${toast.type}`}
      onMouseEnter={pause} onMouseLeave={resume}
      onFocus={pause} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) resume() }}
    >
      <Icon name={toast.type === 'success' ? 'check' : toast.type === 'error' ? 'x' : 'alert'} size={14} />
      <span style={{ flex: 1 }}>{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button type="button" className="toast__action" onClick={() => { toast.onAction(); onDismiss(toast.id) }}>
          {toast.actionLabel}
        </button>
      )}
      <button type="button" className="toast__close" aria-label="Dismiss notification" onClick={() => onDismiss(toast.id)}>
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

/**
 * Mount once at the app root. Two live regions: errors are announced
 * assertively (role="alert" interrupts), everything else politely — a screen
 * reader user hears "Contact saved" without losing their place.
 */
export function ToastHost() {
  const [toasts, setToasts] = useState([])
  useEffect(() => {
    setToastSetter(setToasts)
    // Only unhook if a newer host hasn't already taken over.
    return () => { if (toastSetterFn === setToasts) setToastSetter(null) }
  }, [])

  const dismiss = (id) => setToasts(prev => prev.filter(t => t.id !== id))
  const errors = toasts.filter(t => t.type === 'error')
  const others = toasts.filter(t => t.type !== 'error')

  return (
    <div className="toast-host">
      <div role="status" aria-live="polite" className="toast-region">
        {others.map(t => <ToastItem key={t.id} toast={t} onDismiss={dismiss} />)}
      </div>
      <div role="alert" aria-live="assertive" className="toast-region">
        {errors.map(t => <ToastItem key={t.id} toast={t} onDismiss={dismiss} />)}
      </div>
    </div>
  )
}
