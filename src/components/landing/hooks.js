/**
 * Landing kit hooks — small, dependency-free, SSR/edge-safe, and all of the
 * motion hooks short-circuit when the user prefers reduced motion.
 */
import { useEffect, useRef, useState, useCallback } from 'react'

/** True if the user has asked the OS to reduce motion. Reactive to changes. */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia('(prefers-reduced-motion: reduce)')
    const on = () => setReduced(mq.matches)
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

/**
 * Reveal-on-scroll. Returns a ref to attach and a `shown` boolean.
 * Reveals once (then unobserves). Reduced motion → shown immediately.
 */
export function useReveal({ threshold = 0.15, rootMargin = '0px 0px -10% 0px' } = {}) {
  const reduced = usePrefersReducedMotion()
  const ref = useRef(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (reduced) { setShown(true); return }
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') { setShown(true); return }
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setShown(true); io.disconnect() }
    }, { threshold, rootMargin })
    io.observe(el)
    return () => io.disconnect()
  }, [reduced, threshold, rootMargin])

  return [ref, shown]
}

/**
 * Count-up animation for a numeric target. Returns the current display value.
 * Only animates after `start` becomes true (pair with useReveal). Reduced
 * motion or non-finite input → jumps straight to the value.
 */
export function useCountUp(target, { start = true, duration = 1100 } = {}) {
  const reduced = usePrefersReducedMotion()
  const end = Number(target)
  const [val, setVal] = useState(Number.isFinite(end) ? (reduced ? end : 0) : end)
  const raf = useRef(0)

  useEffect(() => {
    if (!Number.isFinite(end)) { setVal(end); return }
    if (reduced || !start) { setVal(end); return }
    const t0 = performance.now()
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / duration)
      const eased = 1 - Math.pow(1 - p, 3) // ease-out cubic
      setVal(end * eased)
      if (p < 1) raf.current = requestAnimationFrame(tick)
      else setVal(end)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [end, start, duration, reduced])

  return val
}

/** Subtle parallax translateY for a hero background. Reduced motion → 0. */
export function useParallax(strength = 0.18) {
  const reduced = usePrefersReducedMotion()
  const ref = useRef(null)
  useEffect(() => {
    if (reduced) return
    const el = ref.current
    if (!el) return
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const y = window.scrollY * strength
        el.style.transform = `translate3d(0, ${y}px, 0)`
      })
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame) }
  }, [reduced, strength])
  return ref
}

/** 0→1 page scroll progress for the top progress bar. */
export function useScrollProgress() {
  const [p, setP] = useState(0)
  useEffect(() => {
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const h = document.documentElement
        const max = h.scrollHeight - h.clientHeight
        setP(max > 0 ? Math.min(1, h.scrollTop / max) : 0)
      })
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame) }
  }, [])
  return p
}

/** True once the page has scrolled past `offset` (for sticky-header styling). */
export function useStuck(offset = 8) {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > offset)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [offset])
  return stuck
}

/** Locks body scroll while `locked` is true (used by the lightbox modal). */
export function useLockBodyScroll(locked) {
  useEffect(() => {
    if (!locked) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [locked])
}
