import { useEffect, useRef } from 'react'

/**
 * useKeyboard — register keyboard shortcuts scoped to a component lifecycle.
 *
 * Usage:
 *   useKeyboard({
 *     '/':            () => searchRef.current?.focus(),
 *     'j':            () => moveFocus('down'),
 *     'k':            () => moveFocus('up'),
 *     'Enter':        () => openSelected(),
 *     'Escape':       () => clearSelection(),
 *     'cmd+a':        () => selectAll(),
 *     'cmd+backspace': () => deleteSelected(),
 *   }, { enabled: !drawerOpen })
 *
 * Modifier syntax: `cmd+x`, `ctrl+x`, `shift+x`, `alt+x`, or combos: `cmd+shift+k`.
 * On Mac `cmd` matches metaKey; elsewhere it falls back to ctrlKey.
 */
export function useKeyboard(bindings, { enabled = true, ignoreInputs = true } = {}) {
  // Use a ref so the listener doesn't re-register on every render
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings

  useEffect(() => {
    if (!enabled) return

    const handler = (e) => {
      // Don't intercept typing in form fields (except for Escape and ⌘ shortcuts)
      if (ignoreInputs) {
        const target = e.target
        const inField = target?.tagName === 'INPUT' ||
                        target?.tagName === 'TEXTAREA' ||
                        target?.isContentEditable
        const isCmd = e.metaKey || e.ctrlKey
        if (inField && !isCmd && e.key !== 'Escape') return
      }

      const parts = []
      if (e.metaKey || e.ctrlKey) parts.push('cmd')
      if (e.shiftKey) parts.push('shift')
      if (e.altKey)   parts.push('alt')
      // Normalize the key — match either "Enter" or single chars in lowercase
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      parts.push(key)
      const combo = parts.join('+')

      // Also accept the bare key without modifiers as fallback
      const bare = key
      const handler = bindingsRef.current[combo] || bindingsRef.current[bare]
      if (!handler) return

      // Bare keys should NOT fire when modifiers are held (avoids 'j' triggering on cmd+j)
      if (handler === bindingsRef.current[bare] && (e.metaKey || e.ctrlKey || e.altKey)) return

      e.preventDefault()
      handler(e)
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enabled, ignoreInputs])
}
