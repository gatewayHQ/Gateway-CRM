import React, { useRef } from 'react'
import { cx } from './cx.js'

/**
 * A tab strip, following the WAI-ARIA tabs pattern:
 *
 *  - role="tablist" / role="tab" with aria-selected;
 *  - ONE Tab stop for the whole strip (roving tabindex) — Tab moves past the
 *    tabs into the content, not through all nine of them;
 *  - ← / → move between tabs, Home / End jump to the ends, disabled tabs are
 *    skipped. Selection follows focus (automatic activation), which is right
 *    when switching panels is cheap — it is everywhere in this app.
 *
 *   <Tabs ariaLabel="Contact sections" tabs={[{ id: 'info', label: 'Info' }, …]}
 *         active={tab} onChange={setTab} idPrefix="contact" />
 *   <TabPanel idPrefix="contact" id="info" active={tab}>…</TabPanel>
 *
 * `idPrefix` is optional. Pass it only when you render the panels with
 * <TabPanel> using the same prefix — it wires aria-controls/aria-labelledby
 * between each tab and its panel. Without it the tabs are still fully
 * keyboard- and screen-reader-usable, they just don't point at a panel id.
 *
 * `count` shows a badge on inactive tabs (unread, pending), and is included in
 * the tab's accessible name.
 */
export function Tabs({ tabs = [], active, onChange, ariaLabel, idPrefix, className }) {
  const refs = useRef({})
  const enabled = tabs.filter(t => !t.disabled)

  const focusAt = (index) => {
    const t = enabled[(index + enabled.length) % enabled.length]
    if (!t) return
    refs.current[t.id]?.focus()
    if (t.id !== active) onChange?.(t.id)
  }

  const onKeyDown = (e) => {
    const i = enabled.findIndex(t => t.id === active)
    const moves = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: enabled.length - 1 }
    if (!(e.key in moves)) return
    e.preventDefault()
    focusAt(moves[e.key])
  }

  // If `active` matches nothing (stale id), the first enabled tab takes the
  // Tab stop so the strip is never unreachable by keyboard.
  const tabStop = tabs.some(t => t.id === active && !t.disabled) ? active : enabled[0]?.id

  return (
    <div role="tablist" aria-label={ariaLabel} className={cx('ui-tabs', className)} onKeyDown={onKeyDown}>
      {tabs.map(({ id, label, count, disabled }) => {
        const selected = active === id
        return (
          <button
            key={id}
            ref={el => { refs.current[id] = el }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${id}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${id}` : undefined}
            aria-selected={selected}
            tabIndex={id === tabStop ? 0 : -1}
            disabled={disabled}
            className={cx('ui-tabs__tab', selected && 'is-active')}
            onClick={() => onChange?.(id)}
          >
            {label}
            {count > 0 && !selected && (
              <span className="ui-tabs__count"><span className="sr-only">, </span>{count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** The panel for one tab. Renders nothing while another tab is active. */
export function TabPanel({ idPrefix, id, active, children, className }) {
  if (active !== id) return null
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${id}`}
      aria-labelledby={`${idPrefix}-tab-${id}`}
      tabIndex={0}
      className={className}
    >
      {children}
    </div>
  )
}
