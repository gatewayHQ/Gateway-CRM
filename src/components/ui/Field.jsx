import React, { cloneElement, isValidElement, useId } from 'react'
import { cx } from './cx.js'

/**
 * Label + control + hint + error, wired together for assistive tech:
 *
 *   <Field label="Email" hint="We'll send the OM here." error={errors.email} required>
 *     <input className="form-control" type="email" value={email} onChange={…} />
 *   </Field>
 *
 * The single child control receives `id`, `aria-describedby` (hint and error),
 * `aria-invalid` and `aria-required` — so the label is clickable, and a screen
 * reader hears the hint and the error when the field gets focus, not only
 * sighted users who happen to look below it. Anything the child already sets
 * wins, except that described-by ids are merged rather than replaced.
 *
 * For a control that isn't a single element (a chip group, a custom picker),
 * pass a function instead: `{(fieldProps) => <Picker {...fieldProps} />}`.
 */
export function Field({ label, hint, error, required = false, id: idProp, className, labelHidden = false, children }) {
  const auto = useId()
  const id = idProp || `f${auto.replace(/:/g, '')}`
  const hintId = hint ? `${id}-hint` : null
  const errorId = error ? `${id}-error` : null

  const fieldProps = {
    id,
    'aria-describedby': [hintId, errorId].filter(Boolean).join(' ') || undefined,
    'aria-invalid': error ? true : undefined,
    'aria-required': required || undefined,
  }

  // A child that brings its own id keeps it; the label follows.
  const controlId = (isValidElement(children) && children.props.id) || id

  let control = children
  if (typeof children === 'function') control = children(fieldProps)
  else if (isValidElement(children)) {
    const own = children.props
    control = cloneElement(children, {
      ...fieldProps,
      id: controlId,
      'aria-describedby': [own['aria-describedby'], fieldProps['aria-describedby']].filter(Boolean).join(' ') || undefined,
      className: cx(own.className, error && 'error'),
    })
  }

  return (
    <div className={cx('form-group', 'ui-field', error && 'ui-field--invalid', className)}>
      {label && (
        <label htmlFor={controlId} className={cx('form-label', required && 'required', labelHidden && 'sr-only')}>
          {label}
        </label>
      )}
      {control}
      {hint && <div id={hintId} className="form-hint">{hint}</div>}
      {error && <div id={errorId} className="ui-field__error">{error}</div>}
    </div>
  )
}
