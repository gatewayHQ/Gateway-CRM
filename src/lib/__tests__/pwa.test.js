// ─────────────────────────────────────────────────────────────────────────────
// src/lib/pwa.js — when the "Install Gateway CRM" card may show.
//
// The card is a nag if it gets this wrong: it must stay away once the app is
// installed and for a month after "Not now", and it must only offer what the
// browser can actually do (a native dialog on Chrome/Edge/Android, the manual
// Share → Add to Home Screen steps on iOS).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { installMode, isIos, isStandalone, INSTALL_SNOOZE_MS } from '../pwa.js'

const NOW = Date.UTC(2026, 8, 26)

describe('installMode', () => {
  const base = { standalone: false, hasPrompt: false, ios: false, dismissedAt: 0, now: NOW }

  it('offers the native dialog when the browser provided one', () => {
    expect(installMode({ ...base, hasPrompt: true })).toBe('prompt')
  })

  it('offers the manual steps on iOS, which has no install dialog', () => {
    expect(installMode({ ...base, ios: true })).toBe('ios')
  })

  it('shows nothing where the browser cannot install (e.g. desktop Safari, Firefox)', () => {
    expect(installMode(base)).toBeNull()
  })

  it('shows nothing once running as the installed app', () => {
    expect(installMode({ ...base, standalone: true, hasPrompt: true, ios: true })).toBeNull()
  })

  it('stays dismissed for the snooze window, then may return', () => {
    const justNow = { ...base, hasPrompt: true, dismissedAt: NOW - 1000 }
    expect(installMode(justNow)).toBeNull()
    const lastMonth = { ...base, hasPrompt: true, dismissedAt: NOW - INSTALL_SNOOZE_MS - 1 }
    expect(installMode(lastMonth)).toBe('prompt')
  })
})

describe('isIos', () => {
  it('recognises iPhone and iPad user agents', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).toBe(true)
    expect(isIos({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' })).toBe(true)
  })

  it('recognises iPadOS, which claims to be a Mac, by its touch screen', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
  })

  it('does not mistake a real Mac or Android for iOS', () => {
    expect(isIos({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
    expect(isIos({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe(false)
  })
})

describe('isStandalone', () => {
  const win = (standaloneMedia, iosFlag) => ({
    matchMedia: () => ({ matches: standaloneMedia }),
    navigator: { standalone: iosFlag },
  })

  it('is true when launched as an installed app', () => {
    expect(isStandalone(win(true, undefined))).toBe(true)
    expect(isStandalone(win(false, true))).toBe(true)    // older iOS
  })

  it('is false in a normal browser tab', () => {
    expect(isStandalone(win(false, undefined))).toBe(false)
    expect(isStandalone(win(false, false))).toBe(false)
  })
})
