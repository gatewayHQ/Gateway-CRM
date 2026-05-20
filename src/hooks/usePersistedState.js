import { useState, useEffect, useCallback } from 'react'

/**
 * usePersistedState — like useState but mirrors to localStorage.
 *
 * Survives page reloads, syncs across tabs (via the storage event).
 *
 *   const [filter, setFilter] = usePersistedState('contacts.filter', {})
 */
export function usePersistedState(key, defaultValue) {
  const [state, setState] = useState(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored === null) return defaultValue
      return JSON.parse(stored)
    } catch {
      return defaultValue
    }
  })

  // Persist on change
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state))
    } catch {
      // Quota exceeded or disabled — non-fatal
    }
  }, [key, state])

  // Cross-tab sync
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== key || e.newValue === null) return
      try {
        setState(JSON.parse(e.newValue))
      } catch {}
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [key])

  const reset = useCallback(() => {
    localStorage.removeItem(key)
    setState(defaultValue)
  }, [key, defaultValue])

  return [state, setState, reset]
}
