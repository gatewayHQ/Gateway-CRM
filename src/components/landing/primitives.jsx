/**
 * Landing kit — low-level primitives. Presentational, accessible, and themed
 * via the `--lx-accent` CSS variable inherited from the page root.
 */
import React, { useId } from 'react'
import { useReveal, useScrollProgress } from './hooks.js'

/** Fade + rise a block into view on scroll. `delay` staggers siblings (ms). */
export function Reveal({ as: Tag = 'div', delay = 0, className = '', style, children, ...rest }) {
  const [ref, shown] = useReveal()
  return (
    <Tag
      ref={ref}
      data-show={shown}
      className={`lx-reveal ${className}`}
      style={{ '--lx-delay': `${delay}ms`, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  )
}

/** Top-of-page scroll progress bar (decorative). */
export function ScrollProgress() {
  const p = useScrollProgress()
  return (
    <div
      className="lx-progress"
      style={{ width: '100%', transform: `scaleX(${p})` }}
      role="presentation"
      aria-hidden="true"
    />
  )
}

/**
 * Button / link. Renders an <a> when `href` is set, else a <button>.
 * variant: 'primary' | 'ghost'. `loading` shows a spinner + disables.
 */
export function Button({
  variant = 'primary', href, loading = false, block = false,
  children, className = '', disabled, ...rest
}) {
  const cls = `lx-btn lx-btn--${variant}${block ? ' lx-btn--block' : ''} ${className}`
  if (href) {
    return <a href={href} className={cls} {...rest}>{children}</a>
  }
  return (
    <button className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <span className="lx-spinner" aria-hidden="true" />}
      {children}
    </button>
  )
}

/**
 * Accessible labelled form field. Always renders a real <label> (even when the
 * design shows only a placeholder), wires aria-invalid + aria-describedby for
 * errors, and supports a textarea via `multiline`.
 */
export function Field({
  label, name, value, onChange, error, hint,
  required = false, multiline = false, hideLabel = false, ...rest
}) {
  const id = useId()
  const errId = `${id}-err`
  const hintId = `${id}-hint`
  const Control = multiline ? 'textarea' : 'input'
  return (
    <div className="lx-field">
      <label htmlFor={id} className={hideLabel ? 'lx-sr-only' : 'lx-field__label'}>
        {label}{required && <span className="lx-field__req" aria-hidden="true"> *</span>}
      </label>
      <Control
        id={id}
        name={name}
        className={multiline ? 'lx-textarea' : 'lx-input'}
        value={value}
        onChange={onChange}
        required={required}
        aria-required={required || undefined}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={[error ? errId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined}
        {...rest}
      />
      {hint && !error && <span id={hintId} className="lx-field__error" style={{ color: 'var(--lx-mist)' }}>{hint}</span>}
      {error && <span id={errId} className="lx-field__error" role="alert">{error}</span>}
    </div>
  )
}

/** Shimmering loading block. Pass width/height (number → px, or any CSS value). */
export function Skeleton({ w = '100%', h = 16, radius, style, className = '' }) {
  const px = (v) => (typeof v === 'number' ? `${v}px` : v)
  return (
    <span
      aria-hidden="true"
      className={`lx-skel ${className}`}
      style={{ display: 'block', width: px(w), height: px(h), borderRadius: radius != null ? px(radius) : undefined, ...style }}
    />
  )
}

/** Full-screen error / empty state with an optional action. */
export function StatePanel({ icon = '⚠️', title, message, action }) {
  return (
    <div className="lx-state" role="alert">
      <div className="lx-state__icon" aria-hidden="true">{icon}</div>
      {title && <h1 className="lx-serif lx-state__title">{title}</h1>}
      {message && <p className="lx-state__msg">{message}</p>}
      {action}
    </div>
  )
}
