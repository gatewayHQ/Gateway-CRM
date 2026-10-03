import React, { useId, useRef } from 'react'
import { Icon } from './Icon.jsx'
import { useBackdropDismiss, useOverlay } from './hooks.js'
import { cx } from './cx.js'

const SIZES = { sm: 420, md: 520, lg: 720, xl: 960 }

/**
 * An accessible modal dialog with the standard head / body / foot layout.
 *
 *   <Dialog
 *     open={open} onClose={close}
 *     title="Edit contact" eyebrow="Contacts" description="Changes save to the shared record."
 *     footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" loading={saving} onClick={save}>Save</Button></>}
 *   >
 *     …form…
 *   </Dialog>
 *
 * Accessibility comes built in: role="dialog" + aria-modal, labelled by its
 * title and described by its description, focus moved in on open and handed
 * back on close, Tab trapped inside, Escape closes the TOP dialog only.
 *
 * `dismissible={false}` while work is in flight: Escape, the backdrop and the
 * close button stop closing it, so an in-progress save can't be abandoned
 * half-written. `role="alertdialog"` for a decision that interrupts (delete?).
 * `initialFocusRef` — or `data-autofocus` on an element — picks what gets
 * focus first; for a destructive confirm, make that the safe choice.
 */
export function Dialog({
  open, onClose, title, eyebrow, description, children, footer,
  size = 'md', role = 'dialog', dismissible = true, initialFocusRef,
  className, bodyClassName, hideClose = false,
}) {
  const panelRef = useRef(null)
  const uid = useId().replace(/:/g, '')
  const titleId = `${uid}-title`
  const descId = description ? `${uid}-desc` : undefined

  useOverlay(open, { containerRef: panelRef, onClose, kind: 'modal', dismissible, initialFocusRef })
  const backdrop = useBackdropDismiss(onClose, dismissible)

  if (!open) return null
  return (
    <div className="modal-backdrop" {...backdrop}>
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className={cx('modal', 'ui-dialog', `ui-dialog--${size}`, className)}
        style={SIZES[size] ? { width: SIZES[size], maxWidth: 'calc(100vw - 32px)' } : undefined}
      >
        <div className="modal__head">
          <div style={{ minWidth: 0 }}>
            {eyebrow && <div className="eyebrow-label">{eyebrow}</div>}
            <h2 id={titleId} className="ui-dialog__title">{title}</h2>
            {description && <p id={descId} className="ui-dialog__desc">{description}</p>}
          </div>
          {!hideClose && (
            <button
              type="button" className="drawer__close" onClick={onClose}
              disabled={!dismissible} aria-label="Close dialog"
            >
              <Icon name="x" size={18} />
            </button>
          )}
        </div>
        <div className={cx('modal__body', bodyClassName)}>{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  )
}
