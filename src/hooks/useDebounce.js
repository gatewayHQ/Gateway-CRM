import { useState, useEffect } from 'react'

/**
 * useDebounce — returns a value that only updates after `delay` ms of stillness.
 *
 *   const debouncedSearch = useDebounce(search, 200)
 *   useEffect(() => { runQuery(debouncedSearch) }, [debouncedSearch])
 */
export function useDebounce(value, delay = 200) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
