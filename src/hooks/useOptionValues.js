import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase.js'

/**
 * useOptionValues — single source of truth for a controlled-vocabulary field.
 *
 * Fields are scoped by `fieldKey` (e.g. 'submarket', 'asset_type', 'tag', 'industry').
 * Values live in the `option_values` table; this hook caches them per field and
 * provides imperative add / rename / merge / delete operations.
 *
 *   const { values, add, loading } = useOptionValues('submarket')
 *
 * All instances of the hook on the same fieldKey share a module-level cache,
 * so adding a value in one component immediately appears in another.
 */

// Module-level shared cache + subscribers (so multiple components stay in sync)
const cache = new Map()         // fieldKey → string[]
const listeners = new Map()     // fieldKey → Set<callback>
const inflight = new Map()      // fieldKey → Promise

function notify(fieldKey) {
  const subs = listeners.get(fieldKey)
  if (subs) subs.forEach(fn => fn(cache.get(fieldKey) || []))
}

async function fetchValues(fieldKey) {
  if (inflight.has(fieldKey)) return inflight.get(fieldKey)
  const promise = supabase
    .from('option_values')
    .select('value')
    .eq('field_key', fieldKey)
    .order('value', { ascending: true })
    .then(({ data, error }) => {
      inflight.delete(fieldKey)
      if (error) {
        // Table might not exist yet — return empty so UI degrades gracefully
        cache.set(fieldKey, [])
        notify(fieldKey)
        return []
      }
      const values = (data || []).map(r => r.value)
      cache.set(fieldKey, values)
      notify(fieldKey)
      return values
    })
  inflight.set(fieldKey, promise)
  return promise
}

export function useOptionValues(fieldKey) {
  const [values, setValues] = useState(() => cache.get(fieldKey) || [])
  const [loading, setLoading] = useState(() => !cache.has(fieldKey))
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Subscribe to shared updates
  useEffect(() => {
    if (!fieldKey) return
    if (!listeners.has(fieldKey)) listeners.set(fieldKey, new Set())
    const cb = (next) => { if (mountedRef.current) setValues(next) }
    listeners.get(fieldKey).add(cb)

    // Trigger initial fetch if not cached
    if (!cache.has(fieldKey)) {
      setLoading(true)
      fetchValues(fieldKey).finally(() => {
        if (mountedRef.current) setLoading(false)
      })
    } else {
      setLoading(false)
    }

    return () => listeners.get(fieldKey)?.delete(cb)
  }, [fieldKey])

  const add = useCallback(async (rawValue) => {
    const value = (rawValue || '').trim()
    if (!value) return { ok: false, error: 'Empty value' }

    // Optimistic update — append to cache and notify
    const current = cache.get(fieldKey) || []
    if (current.some(v => v.toLowerCase() === value.toLowerCase())) {
      // Already exists — return the canonical capitalization
      const existing = current.find(v => v.toLowerCase() === value.toLowerCase())
      return { ok: true, value: existing, alreadyExisted: true }
    }
    cache.set(fieldKey, [...current, value].sort((a, b) => a.localeCompare(b)))
    notify(fieldKey)

    const { error } = await supabase
      .from('option_values')
      .insert({ field_key: fieldKey, value })

    if (error) {
      // 23505 = unique violation (case-insensitive race) — silently treat as success
      if (error.code !== '23505') {
        // Rollback optimistic update on real error
        cache.set(fieldKey, current)
        notify(fieldKey)
        return { ok: false, error: error.message }
      }
    }
    return { ok: true, value }
  }, [fieldKey])

  const rename = useCallback(async (fromValue, toValue) => {
    const from = fromValue.trim()
    const to = toValue.trim()
    if (!from || !to || from === to) return { ok: false, error: 'Invalid rename' }

    // Use the merge RPC — it handles both option_values + referencing rows atomically
    const { data, error } = await supabase.rpc('merge_option_values', {
      p_field: fieldKey,
      p_from:  from,
      p_to:    to,
    })
    if (error) return { ok: false, error: error.message }

    // Refetch to refresh
    cache.delete(fieldKey)
    await fetchValues(fieldKey)
    return { ok: true, affected: data }
  }, [fieldKey])

  const merge = useCallback(async (fromValues, toValue) => {
    let totalAffected = 0
    for (const from of fromValues) {
      if (from === toValue) continue
      const { data, error } = await supabase.rpc('merge_option_values', {
        p_field: fieldKey,
        p_from:  from,
        p_to:    toValue,
      })
      if (error) return { ok: false, error: error.message }
      totalAffected += data || 0
    }
    cache.delete(fieldKey)
    await fetchValues(fieldKey)
    return { ok: true, affected: totalAffected }
  }, [fieldKey])

  const remove = useCallback(async (value) => {
    const { error } = await supabase
      .from('option_values')
      .delete()
      .eq('field_key', fieldKey)
      .eq('value', value)
    if (error) return { ok: false, error: error.message }
    cache.delete(fieldKey)
    await fetchValues(fieldKey)
    return { ok: true }
  }, [fieldKey])

  const refetch = useCallback(async () => {
    cache.delete(fieldKey)
    return fetchValues(fieldKey)
  }, [fieldKey])

  return { values, loading, add, rename, merge, remove, refetch }
}

/**
 * primeOptionValues — pre-seed the cache from a bulk fetch (e.g. on app init).
 * Lets multiple selects open instantly without waiting on per-field fetches.
 */
export function primeOptionValues(byField) {
  for (const [fieldKey, values] of Object.entries(byField || {})) {
    cache.set(fieldKey, values)
    notify(fieldKey)
  }
}
