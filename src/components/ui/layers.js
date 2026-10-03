// The overlay stack — which open modal, drawer or sheet is "on top".
//
// Every overlay registers here while it is open. Exactly one of them, the top,
// gets Escape and owns the focus trap. Without this each overlay listened on
// `window` for itself, so one Escape closed a confirm dialog AND the modal it
// was confirming for, and Tab could wander from a modal into the drawer behind it.
//
// Ranking, in order:
//  1. kind — a modal beats a drawer regardless of open order;
//  2. nesting — an overlay rendered INSIDE another overlay's panel is above it;
//  3. recency — otherwise the most recently opened wins.
// (1) and (2) exist because React runs child effects before parent effects: a
// modal that mounts in the same render as the confirm nested inside it
// registers AFTER the confirm, and on recency alone would steal the top spot
// from the dialog sitting on it.
//
// No React in here — the hooks in ./hooks.js drive it, the tests call it directly.

const RANK = { drawer: 1, modal: 2 }

let seq = 0
let layers = []
let listening = false

function onKeyDown(e) { handleEscape(e) }

function syncListener() {
  if (typeof window === 'undefined') return
  if (layers.length && !listening) { window.addEventListener('keydown', onKeyDown); listening = true }
  if (!layers.length && listening) { window.removeEventListener('keydown', onKeyDown); listening = false }
}

/**
 * Register an open overlay. Returns a handle whose `update` swaps the Escape
 * callback without changing the layer's place in the stack (callers re-create
 * their onClose every render), and whose `remove` takes it off the stack.
 */
export function registerLayer({ kind = 'modal', onEscape = null, getNode = null } = {}) {
  const layer = { id: ++seq, kind, rank: RANK[kind] ?? RANK.modal, onEscape, getNode }
  layers = [...layers, layer]
  syncListener()
  return {
    id: layer.id,
    update(patch) { Object.assign(layer, patch) },
    remove() {
      layers = layers.filter(l => l !== layer)
      syncListener()
    },
  }
}

function isAbove(a, b) {
  if (a.rank !== b.rank) return a.rank > b.rank
  const na = a.getNode?.()
  const nb = b.getNode?.()
  if (na && nb && na !== nb) {
    if (nb.contains(na)) return true
    if (na.contains(nb)) return false
  }
  return a.id > b.id
}

export function topLayer() {
  let top = null
  for (const l of layers) if (!top || isAbove(l, top)) top = l
  return top
}

export const isTopLayer = (id) => id != null && topLayer()?.id === id
export const hasOpenLayer = (kind) => layers.some(l => !kind || l.kind === kind)

/**
 * Route an Escape keypress to the top layer only. A control inside the overlay
 * that uses Escape itself (an open listbox, an inline editor) calls
 * `e.preventDefault()` and the overlay leaves it alone.
 * Returns true when a layer took the key.
 */
export function handleEscape(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return false
  const top = topLayer()
  if (!top) return false
  top.onEscape?.(e)
  return true
}

/** Tests only — forget every registered layer. */
export function _resetLayers() {
  layers = []
  syncListener()
}
