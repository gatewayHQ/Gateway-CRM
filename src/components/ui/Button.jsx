import React, { forwardRef } from 'react'
import { Icon } from './Icon.jsx'
import { Spinner } from './Feedback.jsx'
import { cx } from './cx.js'

const VARIANTS = new Set(['primary', 'secondary', 'ghost', 'danger', 'link'])

/**
 * The one button. Renders the existing `.btn` classes, so it looks exactly like
 * every hand-written button in the app — what it adds is behaviour:
 *
 *  - `type="button"` by default. A bare <button> inside a <form> submits it,
 *    which is how "Cancel" ends up saving.
 *  - `loading` blocks clicks, marks it aria-busy and swaps the leading
 *    icon for a spinner — the label stays, so the button doesn't change width
 *    and the layout doesn't jump under the cursor. A double-click can't fire
 *    the action twice.
 *  - `loadingText` optionally replaces the label while busy ("Sending…").
 */
export const Button = forwardRef(function Button({
  variant = 'secondary', size = 'md', type = 'button',
  loading = false, loadingText, disabled = false,
  icon, iconRight, fullWidth = false,
  className, children, onClick, ...rest
}, ref) {
  const busy = !!loading
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'btn', `btn--${VARIANTS.has(variant) ? variant : 'secondary'}`,
        size === 'sm' && 'btn--sm', fullWidth && 'btn--block', busy && 'is-loading', className,
      )}
      // Busy uses aria-disabled, not `disabled`: disabling the focused button
      // drops keyboard focus to <body>, so whoever pressed Save loses their place.
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={busy ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {busy ? <Spinner size={size === 'sm' ? 12 : 14} decorative /> : icon && <Icon name={icon} size={size === 'sm' ? 13 : 14} />}
      {busy && loadingText ? loadingText : children}
      {iconRight && !busy && <Icon name={iconRight} size={size === 'sm' ? 13 : 14} />}
    </button>
  )
})

/**
 * A button that is only an icon. `label` is REQUIRED — it becomes the
 * accessible name (screen readers announce it) and the hover tooltip, so the
 * icon is never the only explanation of what the button does.
 */
export const IconButton = forwardRef(function IconButton({
  icon, label, title, variant = 'ghost', size = 'md', tone, loading = false, className, style, ...rest
}, ref) {
  if (import.meta.env?.DEV && !label) {
    console.warn(`IconButton "${icon}" has no label — screen readers will announce it as just "button".`)
  }
  return (
    <Button
      ref={ref}
      variant={variant}
      size={size}
      loading={loading}
      aria-label={label}
      title={title ?? label}
      className={cx('btn--icon', tone && `btn--tone-${tone}`, className)}
      style={style}
      {...rest}
    >
      {!loading && <Icon name={icon} size={size === 'sm' ? 13 : 15} />}
    </Button>
  )
})
