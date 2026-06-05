/**
 * Landing kit — composite sections built from the primitives.
 * These are the pieces a landing page assembles: shell, hero, gallery, etc.
 */
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Reveal, ScrollProgress, Button, Field } from './primitives.jsx'
import { useParallax, useStuck, useCountUp, useReveal, useLockBodyScroll } from './hooks.js'

const initials = (name = '') =>
  name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?'

/* ── LandingShell ───────────────────────────────────────────────────────────
   Page frame: sets the `.lx-root` scope + accent, sticky translucent header,
   scroll-progress bar, and footer. Children render between header and footer. */
export function LandingShell({ accent, brand = 'Gateway Real Estate Advisors', headerCta, footer, children }) {
  const stuck = useStuck()
  return (
    <div className="lx-root" style={{ '--lx-accent': accent || undefined, minHeight: '100vh' }}>
      <ScrollProgress />
      <header className="lx-header" data-stuck={stuck}>
        <span className="lx-serif lx-brand">{brand}</span>
        {headerCta}
      </header>
      <main>{children}</main>
      <footer className="lx-footer">
        {footer || `${brand} · Licensed Brokerage · Information believed accurate but not guaranteed.`}
      </footer>
    </div>
  )
}

/* ── Hero ───────────────────────────────────────────────────────────────────
   Full-bleed parallax image hero with a scrim, eyebrow, serif headline, and an
   optional stat row. Falls back to an accent gradient when no image. */
export function Hero({ image, eyebrow, title, stats = [], showScrollCue = true }) {
  const parallaxRef = useParallax(0.16)
  const bg = image
    ? { backgroundImage: `url(${image})` }
    : { background: 'linear-gradient(135deg, var(--lx-accent) 0%, #2c3a5e 100%)' }
  return (
    <section className="lx-hero" aria-label={typeof title === 'string' ? title : 'Featured property'}>
      <div
        ref={image ? parallaxRef : null}
        className={`lx-hero__bg${image ? ' lx-hero__bg--zoom' : ''}`}
        style={bg}
        aria-hidden="true"
      />
      <div className="lx-hero__scrim" aria-hidden="true" />
      <div className="lx-container lx-hero__inner">
        {eyebrow && (
          <Reveal as="span" className="lx-eyebrow" style={{ color: '#fff' }}>{eyebrow}</Reveal>
        )}
        <Reveal as="h1" delay={80} className="lx-serif">{title}</Reveal>
        {stats.length > 0 && (
          <Reveal delay={160} className="lx-hero__stats">
            {stats.map((s, i) => (
              <span className="lx-hero__stat" key={i} style={{ opacity: .96 }}>
                <b>{s.value}</b> {s.label}
              </span>
            ))}
          </Reveal>
        )}
      </div>
      {showScrollCue && <span className="lx-scrollcue" aria-hidden="true" />}
    </section>
  )
}

/* ── Section ─────────────────────────────────────────────────────────────────
   A revealed content block with an optional serif title. */
export function Section({ title, children, className = '', ...rest }) {
  return (
    <Reveal as="section" className={`lx-section ${className}`} {...rest}>
      {title && <h2 className="lx-serif lx-section__title">{title}</h2>}
      {children}
    </Reveal>
  )
}

/* ── DetailGrid ──────────────────────────────────────────────────────────────
   Key/value spec grid. Numeric values animate with a count-up on reveal. */
export function DetailGrid({ items = [] }) {
  const [ref, shown] = useReveal()
  if (!items.length) return null
  return (
    <div className="lx-details" ref={ref}>
      {items.map((d, i) => <Detail key={i} {...d} start={shown} />)}
    </div>
  )
}
function Detail({ label, value, prefix = '', suffix = '', start }) {
  const numeric = typeof value === 'number'
  const counted = useCountUp(numeric ? value : NaN, { start })
  const display = numeric ? `${prefix}${Math.round(counted).toLocaleString()}${suffix}` : value
  return (
    <div>
      <div className="lx-detail__label">{label}</div>
      <div className="lx-serif lx-detail__value">{display}</div>
    </div>
  )
}

/* ── Gallery + Lightbox ─────────────────────────────────────────────────────── */
function useMosaic(n) {
  return useMemo(() => {
    const L = {
      1: [['a']],
      2: [['a', 'b']],
      3: [['a', 'a', 'b'], ['a', 'a', 'c']],
      4: [['a', 'a', 'b', 'c'], ['a', 'a', 'd', 'b']],
      5: [['a', 'a', 'b', 'c'], ['a', 'a', 'd', 'e']],
    }[Math.min(n, 5)]
    if (!L) return { style: {}, cells: [] }
    const cols = L[0].length
    const unique = [...new Set(L.flat())]
    return {
      style: {
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gridTemplateAreas: L.map(r => `"${r.join(' ')}"`).join(' '),
      },
      cells: unique.map(a => ({ gridArea: a, minHeight: n === 1 ? 340 : n <= 2 ? 240 : 168 })),
    }
  }, [n])
}

export function Gallery({ images = [], onOpen }) {
  const shown = images.slice(0, 5)
  const mosaic = useMosaic(shown.length)
  if (!shown.length) return null
  return (
    <ul className="lx-gallery" style={{ listStyle: 'none', margin: 0, padding: 0, ...mosaic.style }}>
      {shown.map((img, i) => (
        <li key={i} style={mosaic.cells[i]}>
          <button
            type="button"
            className="lx-gallery__cell"
            style={{ width: '100%', height: '100%', minHeight: 'inherit' }}
            onClick={() => onOpen?.(i)}
            aria-label={`View photo ${i + 1} of ${images.length}${img.caption ? `: ${img.caption}` : ''}`}
          >
            <img className="lx-gallery__img" src={img.url} alt={img.caption || ''} loading="lazy" decoding="async" />
            {(img.caption || img.price) && (
              <span className="lx-gallery__cap">
                {img.caption && <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>{img.caption}</span>}
                {img.price && <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--lx-gold)' }}>{img.price}</span>}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Accessible modal lightbox: focus trap, ESC to close, ←/→ to navigate. */
export function Lightbox({ images = [], index = 0, onClose, onIndex }) {
  const dialogRef = useRef(null)
  useLockBodyScroll(true)
  const has = images.length > 0
  const go = useCallback((d) => onIndex?.((index + d + images.length) % images.length), [index, images.length, onIndex])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'Tab') {
        // simple focus trap within the dialog
        const f = dialogRef.current?.querySelectorAll('button')
        if (!f?.length) return
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    dialogRef.current?.querySelector('button')?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [go, onClose])

  if (!has) return null
  const img = images[index]
  return (
    <div className="lx-lightbox" role="dialog" aria-modal="true" aria-label="Photo viewer"
         ref={dialogRef} onClick={(e) => { if (e.target === e.currentTarget) onClose?.() }}>
      <button className="lx-lightbox__btn lx-lightbox__close" onClick={onClose} aria-label="Close photo viewer">×</button>
      {images.length > 1 && (
        <button className="lx-lightbox__btn lx-lightbox__prev" onClick={() => go(-1)} aria-label="Previous photo">‹</button>
      )}
      <img className="lx-lightbox__img" src={img.url} alt={img.caption || `Photo ${index + 1}`} />
      {images.length > 1 && (
        <button className="lx-lightbox__btn lx-lightbox__next" onClick={() => go(1)} aria-label="Next photo">›</button>
      )}
      {images.length > 1 && <div className="lx-lightbox__count">{index + 1} / {images.length}</div>}
    </div>
  )
}

/* ── LeadForm ────────────────────────────────────────────────────────────────
   Self-contained capture form with validation, loading + success states, and
   an aria-live status region. `onSubmit(form)` should resolve or throw. */
export function LeadForm({ title = 'Get more info', cta = 'Get more info', subtext, onSubmit, agentName }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', message: '' })
  const [errors, setErrors] = useState({})
  const [status, setStatus] = useState('idle') // idle | submitting | done | error
  const [topError, setTopError] = useState(null)
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    const next = {}
    if (!form.name.trim()) next.name = 'Please enter your name'
    if (!form.phone.trim()) next.phone = 'Please enter a phone number'
    setErrors(next)
    if (Object.keys(next).length) return
    setStatus('submitting'); setTopError(null)
    try {
      await onSubmit(form)
      setStatus('done')
    } catch (err) {
      setStatus('error')
      setTopError(err?.message || 'Could not submit — please try again.')
    }
  }

  if (status === 'done') {
    return (
      <div className="lx-card" style={{ textAlign: 'center', boxShadow: 'var(--lx-shadow-md)' }} role="status">
        <div style={{
          width: 56, height: 56, borderRadius: '50%', margin: '4px auto 0', fontSize: 26,
          display: 'grid', placeItems: 'center',
          background: 'color-mix(in srgb, var(--lx-accent) 14%, transparent)', color: 'var(--lx-accent)',
        }} aria-hidden="true">✓</div>
        <h2 className="lx-serif" style={{ fontSize: 26, margin: '14px 0 8px' }}>We'll be in touch!</h2>
        <p style={{ color: 'var(--lx-mist)', lineHeight: 1.6, margin: 0 }}>
          {agentName ? `${agentName} will reach out shortly.` : "We'll reach out shortly."}
        </p>
      </div>
    )
  }

  return (
    <div className="lx-card" style={{ boxShadow: 'var(--lx-shadow-md)' }}>
      <h2 className="lx-serif" style={{ fontSize: 22, fontWeight: 600, margin: '0 0 4px' }}>{title}</h2>
      <p style={{ fontSize: 12.5, color: 'var(--lx-mist)', margin: '0 0 16px', lineHeight: 1.5 }}>
        {subtext || 'Leave your info — we’ll get back to you fast. No spam, ever.'}
      </p>
      <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Field label="Your name" required value={form.name} onChange={set('name')}
               error={errors.name} autoComplete="name" placeholder="Your name" />
        <Field label="Phone number" required type="tel" value={form.phone} onChange={set('phone')}
               error={errors.phone} autoComplete="tel" placeholder="Phone number" />
        <Field label="Email (optional)" type="email" value={form.email} onChange={set('email')}
               autoComplete="email" placeholder="Email (optional)" />
        <Field label="Questions or notes (optional)" multiline rows={3} value={form.message}
               onChange={set('message')} placeholder="Questions or notes (optional)" />
        <div aria-live="polite">
          {topError && <div className="lx-field__error" style={{ marginBottom: 4 }}>{topError}</div>}
        </div>
        <Button type="submit" block loading={status === 'submitting'}>
          {status === 'submitting' ? 'Sending…' : `${cta} →`}
        </Button>
        <p style={{ fontSize: 11, color: 'var(--lx-mist)', textAlign: 'center', margin: '2px 0 0' }}>
          Your information stays private.
        </p>
      </form>
    </div>
  )
}

/* ── AgentTeam ("Meet your advisor(s)") ───────────────────────────────────────
   Full bio section that reveals below the gallery. Accepts 1–2 agents, each
   { id?, name, role, bio, photo_url, color, phone, email }. Renders a single
   centered advisor or a two-up grid; stacks on mobile. */
export function AgentTeam({ agents = [], accent, heading }) {
  const list = agents.filter(a => a && a.name).slice(0, 2)
  if (!list.length) return null
  const title = heading || (list.length > 1 ? 'Meet your advisors' : 'Meet your advisor')
  return (
    <Section title={title} aria-label="About your real estate advisors" delay={60}>
      <div className="lx-team__grid" data-count={list.length}>
        {list.map((a, i) => <Advisor key={a.id || i} agent={a} accent={accent} />)}
      </div>
    </Section>
  )
}

function Advisor({ agent, accent }) {
  const { name, role, bio, photo_url, phone, email } = agent
  return (
    <article className="lx-advisor">
      {photo_url ? (
        <img className="lx-advisor__photo" src={photo_url} alt={`${name}, real estate advisor`}
             loading="lazy" decoding="async" />
      ) : (
        <div className="lx-advisor__photo lx-advisor__photo--ph"
             style={{ background: agent.color || accent || 'var(--lx-accent)' }} aria-hidden="true">
          {initials(name)}
        </div>
      )}
      <div style={{ minWidth: 0 }}>
        <h3 className="lx-serif lx-advisor__name">{name}</h3>
        <p className="lx-advisor__role">{role || 'Real Estate Advisor'} · Gateway Real Estate</p>
        <hr className="lx-advisor__rule" aria-hidden="true" />
        {bio && <p className="lx-advisor__bio">{bio}</p>}
        <div className="lx-advisor__cta">
          {phone && <Button href={`tel:${phone}`} style={{ padding: '9px 16px', fontSize: 13 }}>Call</Button>}
          {phone && <Button href={`sms:${phone}`} variant="ghost" style={{ padding: '9px 16px', fontSize: 13 }}>Text</Button>}
          {email && <Button href={`mailto:${email}`} variant="ghost" style={{ padding: '9px 16px', fontSize: 13 }}>Email</Button>}
        </div>
      </div>
    </article>
  )
}

export function AgentCard({ agent, accent }) {
  if (!agent) return null
  return (
    <div className="lx-card" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 18px' }}>
      {agent.photo_url ? (
        <img src={agent.photo_url} alt={agent.name}
             style={{ width: 46, height: 46, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
      ) : (
        <div aria-hidden="true" style={{
          width: 46, height: 46, borderRadius: '50%', flexShrink: 0, color: '#fff', fontWeight: 700,
          display: 'grid', placeItems: 'center', background: agent.color || accent || 'var(--lx-accent)',
        }}>{initials(agent.name)}</div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{agent.name}</div>
        <div style={{ fontSize: 11.5, color: 'var(--lx-mist)' }}>
          {agent.role || 'Listing Agent'} · Gateway Real Estate
        </div>
      </div>
      {agent.phone && (
        <Button href={`tel:${agent.phone}`} variant="ghost" style={{ padding: '8px 14px', fontSize: 13 }}>
          Call
        </Button>
      )}
    </div>
  )
}
