import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerLayer, topLayer, isTopLayer, hasOpenLayer, handleEscape, _resetLayers } from '../layers.js'

const esc = (extra = {}) => ({ key: 'Escape', defaultPrevented: false, ...extra })

describe('overlay layer stack', () => {
  beforeEach(() => _resetLayers())

  it('routes Escape to the most recently opened layer only', () => {
    const a = vi.fn(); const b = vi.fn()
    registerLayer({ kind: 'modal', onEscape: a })
    const top = registerLayer({ kind: 'modal', onEscape: b })
    expect(handleEscape(esc())).toBe(true)
    expect(b).toHaveBeenCalledTimes(1)
    expect(a).not.toHaveBeenCalled()
    top.remove()
    handleEscape(esc())
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('ranks a modal above a drawer even when the drawer registered later', () => {
    // React runs child effects first: a drawer mounting with a confirm already
    // open registers after it.
    const modal = registerLayer({ kind: 'modal' })
    const drawer = registerLayer({ kind: 'drawer' })
    expect(isTopLayer(modal.id)).toBe(true)
    expect(isTopLayer(drawer.id)).toBe(false)
    modal.remove()
    expect(topLayer().id).toBe(drawer.id)
  })

  it('puts a nested overlay above its parent even when the parent registered last', () => {
    const outerNode = { contains: (n) => n === innerNode }
    const innerNode = { contains: () => false }
    const inner = registerLayer({ kind: 'modal', getNode: () => innerNode })
    const outer = registerLayer({ kind: 'modal', getNode: () => outerNode })
    expect(isTopLayer(inner.id)).toBe(true)
    expect(isTopLayer(outer.id)).toBe(false)
  })

  it('leaves Escape alone when a control inside already handled it', () => {
    const onEscape = vi.fn()
    registerLayer({ onEscape })
    expect(handleEscape(esc({ defaultPrevented: true }))).toBe(false)
    expect(handleEscape({ key: 'Enter' })).toBe(false)
    expect(onEscape).not.toHaveBeenCalled()
  })

  it('updates the callback in place without changing order', () => {
    const first = vi.fn(); const second = vi.fn()
    const l = registerLayer({ onEscape: first })
    l.update({ onEscape: second })
    handleEscape(esc())
    expect(second).toHaveBeenCalled()
    expect(first).not.toHaveBeenCalled()
  })

  it('answers hasOpenLayer by kind', () => {
    expect(hasOpenLayer()).toBe(false)
    const d = registerLayer({ kind: 'drawer' })
    expect(hasOpenLayer('drawer')).toBe(true)
    expect(hasOpenLayer('modal')).toBe(false)
    d.remove()
    expect(hasOpenLayer()).toBe(false)
    expect(handleEscape(esc())).toBe(false)
  })
})
