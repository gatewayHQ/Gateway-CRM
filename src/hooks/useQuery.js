import { useState, useEffect, useCallback, useRef } from 'react'
import { query, subscribe, invalidate, setOptimistic, primeCache, getCached } from '../lib/queryCache.js'

/**
 * useQuery — data-fetching hook with cache, dedup, and stale-while-revalidate.
 *
 * Usage:
 *   const { data, loading, error, refetch } = useQuery(
 *     'contacts:agent-abc',
 *     () => supabase.from('contacts').select('*').eq('assigned_agent_id', id),
 *     { ttl: 30_000, enabled: !!agentId }
 *   )
 */
export function useQuery(key, fetcher, opts = {}) {
  const { ttl, stale, enabled = true, initialData = null } = opts

  const [state, setState] = useState(() => {
    // Synchronously return cached data if available — zero loading flash
    const cached = getCached(key)
    if (cached?.data !== undefined && cached?.data !== null) {
      return { data: cached.data, loading: false, error: null }
    }
    return { data: initialData, loading: enabled, error: null }
  })

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const runQuery = useCallback(async (force = false) => {
    if (!enabled) return
    setState(s => ({ ...s, loading: s.data === null })) // only show spinner on cold load
    const result = await query(key, fetcherRef.current, { ttl, stale, force })
    setState({ data: result.data, loading: false, error: result.error })
  }, [key, enabled, ttl, stale])

  // Subscribe to cache invalidations / background revalidations
  useEffect(() => {
    if (!enabled) return
    const unsub = subscribe(key, (entry) => {
      if (entry === null) {
        // Cache was invalidated — refetch
        runQuery(true)
      } else {
        setState({ data: entry.data, loading: false, error: entry.error })
      }
    })
    runQuery()
    return unsub
  }, [key, enabled, runQuery])

  const refetch = useCallback(() => runQuery(true), [runQuery])

  const mutate = useCallback((updater) => {
    setOptimistic(key, updater)
  }, [key])

  return { ...state, refetch, mutate }
}

/**
 * useMutation — wraps a Supabase write with optimistic updates + cache invalidation.
 *
 * Usage:
 *   const { mutate, loading } = useMutation(
 *     async (payload) => supabase.from('contacts').insert([payload]).select().single(),
 *     { invalidates: ['contacts:'] }
 *   )
 */
export function useMutation(mutationFn, opts = {}) {
  const { invalidates = [], onSuccess, onError } = opts
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const mutate = useCallback(async (...args) => {
    setLoading(true)
    setError(null)
    try {
      const result = await mutationFn(...args)
      if (result?.error) throw result.error
      invalidates.forEach(pattern => invalidate(pattern))
      onSuccess?.(result?.data)
      return result?.data
    } catch (err) {
      setError(err)
      onError?.(err)
      throw err
    } finally {
      setLoading(false)
    }
  }, [mutationFn, invalidates, onSuccess, onError])

  return { mutate, loading, error }
}

export { primeCache, invalidate }
