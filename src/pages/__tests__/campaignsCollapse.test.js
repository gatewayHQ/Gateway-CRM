// The collapsed/expanded state of the campaign sections lives in localStorage.
// The failure that matters is a corrupt or hostile value there taking the whole
// Campaigns page down on load — an agent would just see a blank screen.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readCollapsePrefs } from '../Campaigns.jsx'

const KEY = 'gw.campaigns.sections'

beforeEach(() => {
  const store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  })
})

describe('readCollapsePrefs', () => {
  it('returns an empty object when nothing has been saved yet', () => {
    expect(readCollapsePrefs()).toEqual({})
  })

  it('reads back saved section state', () => {
    localStorage.setItem(KEY, JSON.stringify({ quickStart: false, list: true }))
    expect(readCollapsePrefs()).toEqual({ quickStart: false, list: true })
  })

  it('ignores malformed JSON instead of throwing', () => {
    localStorage.setItem(KEY, '{not json')
    expect(readCollapsePrefs()).toEqual({})
  })

  it('ignores non-object values such as a bare string or null', () => {
    localStorage.setItem(KEY, '"collapsed"')
    expect(readCollapsePrefs()).toEqual({})
    localStorage.setItem(KEY, 'null')
    expect(readCollapsePrefs()).toEqual({})
  })

  it('survives localStorage being unavailable (private mode)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('access denied') },
      setItem: () => { throw new Error('access denied') },
    })
    expect(readCollapsePrefs()).toEqual({})
  })
})
