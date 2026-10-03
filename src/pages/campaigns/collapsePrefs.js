// Which campaigns-page sections are collapsed, remembered per browser.

import { useCallback, useState } from 'react'

// ─── Collapsible sections ─────────────────────────────────────────────────────
// The page stacks a stat row, five quick-start cards and then the campaign
// list, which pushes the list itself below the fold. These let an agent fold
// the top of the page away so the whole list slides up into view — and the
// choice sticks between visits.

const COLLAPSE_KEY = 'gw.campaigns.sections'

export function readCollapsePrefs() {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/** Open/closed state for one section, remembered in localStorage. */
export function useSectionToggle(id, defaultOpen = true) {
  const [open, setOpen] = useState(() => {
    const saved = readCollapsePrefs()[id]
    return typeof saved === 'boolean' ? saved : defaultOpen
  })
  const set = useCallback(next => {
    setOpen(prev => {
      const value = typeof next === 'function' ? next(prev) : next
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify({ ...readCollapsePrefs(), [id]: value })) } catch { /* private mode */ }
      return value
    })
  }, [id])
  return [open, set]
}
