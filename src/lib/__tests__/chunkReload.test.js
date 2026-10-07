import { describe, it, expect, vi } from 'vitest'
import { isChunkLoadError, reloadForNewVersion } from '../chunkReload.js'

const memoryStorage = () => {
  const m = new Map()
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }
}

describe('isChunkLoadError', () => {
  it('recognises each browser\'s wording', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/DealPage-DiHwcAy7.js'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true)
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true)
  })
  it('ignores ordinary errors', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
})

describe('reloadForNewVersion', () => {
  it('reloads once, then refuses inside the guard window', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    expect(reloadForNewVersion(storage, 1_000_000, reload)).toBe(true)
    expect(reloadForNewVersion(storage, 1_005_000, reload)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })
  it('reloads again once the guard window has passed', () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    reloadForNewVersion(storage, 1_000_000, reload)
    expect(reloadForNewVersion(storage, 1_020_000, reload)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
