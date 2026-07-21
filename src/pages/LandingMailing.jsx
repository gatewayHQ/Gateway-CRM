/**
 * Mailing-List Landing — public-facing, served at /lp/mailing/:mailingId
 *
 * A luxurious, conversion-optimized email-capture page an agent uses to grow a
 * personal / team mailing list. Everything visible is editable from the
 * Campaigns builder and stored on mailings.landing_config:
 *
 *   {
 *     theme,            // 'dark' (default) | 'light' — luxury dark or ivory light
 *     accent,           // brand accent color (default gold)
 *     eyebrow,          // small kicker above the headline
 *     cta_headline,     // TOP CTA headline   ("Get Insider Updates Delivered Weekly")
 *     subheadline,      // supporting copy under the headline
 *     list_heading,     // EDITABLE form heading, replaces the old static "Notes"
 *                       // ("Join My Exclusive Mailing List")
 *     list_subheading,  // small copy under the form heading
 *     submit_label,     // BOTTOM submit button text ("Subscribe Now" / "Join the List")
 *     success_message,  // shown after a successful subscribe
 *     collect_name,     // bool — ask for name (default true)
 *     collect_phone,    // bool — ask for phone (default false)
 *     perks,            // string[] — "what you'll get" bullet list
 *     highlights,       // [{value,label}] — optional credibility strip (count-up)
 *     images,           // [{url}] — optional hero imagery (parallax)
 *     consent_text,     // fine print under the button
 *   }
 *
 * Design: mobile-first (single column on phones, two columns from 900px up),
 * subtle scroll-reveal + parallax + count-up animations that all respect
 * prefers-reduced-motion, and full dark/light luxury theming from one accent.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useReveal, useCountUp, useScrollProgress, useParallax, usePrefersReducedMotion } from '../components/landing/hooks.js'

// Light / dark luxury palettes. Everything else is derived from `accent`.
const THEMES = {
  dark: {
    bg:        'radial-gradient(1100px 620px at 12% -8%, #1c2230 0%, #101013 52%, #0a0a0b 100%)',
    ink:       '#f4f1e9',
    mist:      '#b8b6ad',
    faint:     '#83817a',
    card:      'rgba(20,20,22,0.72)',
    cardSolid: '#141416',
    cardBorder:'rgba(255,255,255,0.09)',
    input:     '#0e0e10',
    inputBorder:'#2c2c2e',
    rule:      'rgba(255,255,255,0.08)',
    headerBg:  'rgba(10,10,11,0.72)',
    grain:     0.05,
  },
  light: {
    bg:        'radial-gradient(1100px 620px at 12% -8%, #fdfaf3 0%, #f5f0e5 58%, #efe9db 100%)',
    ink:       '#1b1a17',
    mist:      '#5d5a52',
    faint:     '#8b887f',
    card:      'rgba(255,255,255,0.82)',
    cardSolid: '#ffffff',
    cardBorder:'rgba(28,26,22,0.10)',
    input:     '#fbf9f4',
    inputBorder:'#ded8c8',
    rule:      'rgba(28,26,22,0.10)',
    headerBg:  'rgba(250,247,240,0.72)',
    grain:     0.03,
  },
}

// Split a stat like "2,400+", "$240M", "18" into an animatable number + affixes.
function parseStat(raw) {
  const s = String(raw ?? '').trim()
  const m = s.match(/^([^\d]*)([\d.,]+)(.*)$/)
  if (!m) return null
  const num = parseFloat(m[2].replace(/,/g, ''))
  if (!Number.isFinite(num)) return null
  return { prefix: m[1], num, suffix: m[3] }
}

export default function LandingMailing({ mailingId }) {
  const reduced = usePrefersReducedMotion()
  const progress = useScrollProgress()
  const [mailing,    setMailing]    = useState(null)
  const [agents,     setAgents]     = useState([])
  const [loading,    setLoading]    = useState(true)
  const [submitted,  setSubmitted]  = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState(null)
  const [form, setForm] = useState({ email: '', name: '', phone: '', message: '' })

  useEffect(() => {
    let active = true
    ;(async () => {
      const { data: m } = await supabase
        .from('mailings')
        .select('id, name, agent_id, landing_config')
        .eq('id', mailingId).maybeSingle()
      if (!active) return
      if (!m) { setError('notfound'); setLoading(false); return }
      setMailing(m)

      const cfg = m.landing_config || {}
      const ids = [...new Set([m.agent_id, ...(Array.isArray(cfg.agent_ids) ? cfg.agent_ids : [])].filter(Boolean))]
      if (ids.length) {
        let { data: rows, error: agErr } = await supabase.from('agents')
          .select('id, name, phone, email, photo_url, color, role, bio').in('id', ids)
        if (agErr) {
          ;({ data: rows } = await supabase.from('agents')
            .select('id, name, phone, email, photo_url, color, role').in('id', ids))
        }
        const overrides = cfg.agent_overrides || {}
        const ordered = ids.map(id => (rows || []).find(r => r.id === id)).filter(Boolean)
          .map(r => ({ ...r, ...(overrides[r.id] || {}) }))
        if (active) setAgents(ordered)
      }
      setLoading(false)
    })()
    return () => { active = false }
  }, [mailingId])

  const cfg    = mailing?.landing_config || {}
  const theme  = THEMES[cfg.theme === 'light' ? 'light' : 'dark']
  const accent = cfg.accent || '#c9a961'
  const agent  = agents[0] || null

  const eyebrow   = cfg.eyebrow      || 'The Gateway List'
  const headline  = cfg.cta_headline || cfg.headline || 'Get insider updates, delivered.'
  const subhead   = cfg.subheadline  || 'Off-market deals, market moves, and first looks — straight to your inbox. No noise, unsubscribe anytime.'
  const listHead  = cfg.list_heading || 'Join the list'
  const listSub   = cfg.list_subheading || 'Enter your email — takes five seconds.'
  const submitLbl = cfg.submit_label || 'Subscribe'
  const successMsg = cfg.success_message || "You're on the list. Watch your inbox for the next one."
  const collectName    = cfg.collect_name    !== false
  const collectPhone   = cfg.collect_phone   === true
  const collectMessage = cfg.collect_message !== false          // on by default
  const messageLabel   = cfg.message_label   || 'What are you hoping to get? (optional)'
  const messagePlaceholder = cfg.message_placeholder || 'Tell us what you want from the list — a submarket, deal size, or what you’d like us to reach out about.'
  const perks    = (Array.isArray(cfg.perks) ? cfg.perks : []).filter(Boolean)
  const highlights = (Array.isArray(cfg.highlights) ? cfg.highlights : []).filter(h => h && (h.value || h.label)).slice(0, 4)
  const images   = (Array.isArray(cfg.images) ? cfg.images : [])
    .map(v => (typeof v === 'string' ? { url: v } : v)).filter(v => v?.url)
  const heroImage = images[0]?.url
  const consent  = cfg.consent_text || 'By subscribing you agree to receive occasional emails. We never sell your data.'

  const parallaxRef = useParallax(0.12)

  const submit = async (e) => {
    e.preventDefault()
    const email = form.email.trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError('Please enter a valid email address'); return }
    setError(null); setSubmitting(true)
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'capture_subscriber', mailing_id: mailingId,
          email, name: collectName ? form.name : '', phone: collectPhone ? form.phone : '',
          message: collectMessage ? form.message : '',
          consent: true,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) throw new Error(data.error || 'Could not subscribe — please try again.')
      setSubmitted(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const page = { minHeight: '100vh', width: '100%', overflowX: 'hidden', background: theme.bg,
                 color: theme.ink, fontFamily: 'DM Sans, system-ui, sans-serif', position: 'relative' }

  if (loading) return (
    <div style={{ ...page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <div className="ml-pulse" style={{ width: 42, height: 42, borderRadius: '50%',
              border: `2px solid ${accent}`, borderTopColor: 'transparent' }} />
        <div style={{ color: theme.mist, fontSize: 13, letterSpacing: 1 }}>Loading…</div>
      </div>
      <style>{`@keyframes ml-spin{to{transform:rotate(360deg)}} .ml-pulse{animation:ml-spin .9s linear infinite}`}</style>
    </div>
  )
  if (error === 'notfound') return (
    <div style={{ ...page, padding: 60, textAlign: 'center', display: 'grid', placeItems: 'center' }}>
      <div>
        <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 26 }}>Gateway <span style={{ color: accent }}>Real Estate</span></div>
        <div style={{ marginTop: 10, color: theme.mist }}>This list is no longer available.</div>
      </div>
    </div>
  )

  const inp = {
    width: '100%', boxSizing: 'border-box', padding: '13px 14px',
    background: theme.input, border: `1px solid ${theme.inputBorder}`, borderRadius: 10,
    color: theme.ink, fontSize: 16, fontFamily: 'inherit', outline: 'none',
    transition: 'border-color 160ms, box-shadow 160ms',
  }

  return (
    <div className="ml-page" style={page}>
      {/* Scroll progress */}
      <div aria-hidden="true" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 3, zIndex: 50,
            transformOrigin: '0 50%', transform: `scaleX(${progress})`, background: accent, opacity: 0.9,
            transition: reduced ? 'none' : 'transform 90ms linear' }} />

      {/* Ambient accent glow (decorative) */}
      <div aria-hidden="true" style={{ position: 'absolute', top: -160, right: -120, width: 460, height: 460,
            borderRadius: '50%', background: accent, opacity: 0.10, filter: 'blur(120px)', pointerEvents: 'none' }} />

      {/* Header */}
      <Header theme={theme} accent={accent} agent={agent} reduced={reduced} />

      <section style={{ maxWidth: 1120, margin: '0 auto', padding: '20px 22px 64px', position: 'relative' }}>
        <div className="ml-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,0.95fr)',
                                          gap: 52, alignItems: 'start' }}>
          {/* Left — pitch */}
          <div>
            <Reveal reduced={reduced}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 11, letterSpacing: 2,
                            textTransform: 'uppercase', color: accent, padding: '5px 12px',
                            border: `1px solid ${accent}55`, borderRadius: 99 }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: accent }} />
                {eyebrow}
              </div>
            </Reveal>

            <Reveal reduced={reduced} delay={70}>
              <h1 style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 'clamp(40px,6.2vw,66px)', fontWeight: 500,
                           lineHeight: 1.04, margin: '18px 0 16px', letterSpacing: '-0.015em' }}>
                {headline}
              </h1>
            </Reveal>

            <Reveal reduced={reduced} delay={130}>
              <p style={{ fontSize: 17.5, lineHeight: 1.6, color: theme.mist, maxWidth: 540, margin: 0 }}>
                {subhead}
              </p>
            </Reveal>

            {heroImage && (
              <Reveal reduced={reduced} delay={180}>
                <div style={{ marginTop: 32, borderRadius: 14, overflow: 'hidden', position: 'relative',
                              boxShadow: '0 26px 70px rgba(0,0,0,0.4)', aspectRatio: '16 / 9' }}>
                  <div ref={parallaxRef} style={{ position: 'absolute', inset: '-12% 0', backgroundImage: `url(${heroImage})`,
                        backgroundSize: 'cover', backgroundPosition: 'center', willChange: 'transform' }} />
                  <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 55%, rgba(0,0,0,0.35))' }} />
                </div>
              </Reveal>
            )}

            {perks.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '32px 0 0', display: 'grid', gap: 13 }}>
                {perks.map((p, i) => (
                  <Reveal as="li" key={i} reduced={reduced} delay={200 + i * 70}
                          style={{ display: 'flex', gap: 12, lineHeight: 1.5, fontSize: 15.5 }}>
                    <span style={{ flexShrink: 0, marginTop: 2, width: 20, height: 20, borderRadius: '50%',
                                   background: `${accent}22`, color: accent, display: 'grid', placeItems: 'center',
                                   fontSize: 11, fontWeight: 800 }}>✓</span>
                    <span style={{ color: theme.ink }}>{p}</span>
                  </Reveal>
                ))}
              </ul>
            )}

            {highlights.length > 0 && <Highlights highlights={highlights} theme={theme} reduced={reduced} />}
          </div>

          {/* Right — subscribe card (sticky on desktop) */}
          <div className="ml-sticky" style={{ position: 'sticky', top: 26 }}>
            <Reveal reduced={reduced} delay={90}>
              <div style={{ background: theme.card, backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)',
                            border: `1px solid ${theme.cardBorder}`, borderRadius: 16, padding: 30,
                            boxShadow: '0 30px 80px rgba(0,0,0,0.38)' }}>
                {submitted ? (
                  <div style={{ textAlign: 'center', padding: '18px 0' }} role="status">
                    <div className="ml-pop" style={{ width: 64, height: 64, borderRadius: '50%', background: `${accent}22`,
                          color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          margin: '0 auto', fontSize: 32 }}>✓</div>
                    <h2 style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 30, margin: '18px 0 8px', fontWeight: 500 }}>
                      Welcome aboard.
                    </h2>
                    <p style={{ color: theme.mist, fontSize: 15, lineHeight: 1.6, margin: 0 }}>{successMsg}</p>
                  </div>
                ) : (
                  <>
                    {/* EDITABLE section heading — replaces the old static "Notes/Questions" */}
                    <h2 style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 27, margin: '0 0 4px', fontWeight: 500 }}>
                      {listHead}
                    </h2>
                    <p style={{ fontSize: 13, color: theme.faint, margin: '0 0 20px' }}>{listSub}</p>

                    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
                      {collectName && (
                        <Field label="Name" theme={theme}>
                          <input value={form.name} autoComplete="name" style={inp} placeholder="Your name"
                                 onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                        </Field>
                      )}
                      <Field label="Email address" theme={theme}>
                        <input required type="email" inputMode="email" autoComplete="email" value={form.email}
                               placeholder="you@email.com" style={inp}
                               onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
                      </Field>
                      {collectPhone && (
                        <Field label="Phone (optional)" theme={theme}>
                          <input type="tel" inputMode="tel" autoComplete="tel" value={form.phone}
                                 placeholder="(555) 555-5555" style={inp}
                                 onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} />
                        </Field>
                      )}
                      {collectMessage && (
                        <Field label={messageLabel} theme={theme}>
                          <textarea rows={3} value={form.message} placeholder={messagePlaceholder}
                                    style={{ ...inp, resize: 'vertical', minHeight: 76, lineHeight: 1.5 }}
                                    onChange={e => setForm(p => ({ ...p, message: e.target.value }))} />
                        </Field>
                      )}

                      {error && (
                        <div style={{ color: '#e57373', fontSize: 13, background: 'rgba(229,115,115,0.12)',
                                      padding: '10px 12px', borderRadius: 8 }}>{error}</div>
                      )}

                      {/* EDITABLE bottom submit button text */}
                      <button type="submit" disabled={submitting} className="ml-submit"
                              style={{ background: accent, color: '#141210', padding: '15px 16px', border: 'none',
                                       borderRadius: 10, fontSize: 16, fontWeight: 700, letterSpacing: 0.3,
                                       cursor: submitting ? 'default' : 'pointer', marginTop: 4,
                                       opacity: submitting ? 0.6 : 1 }}>
                        {submitting ? 'Subscribing…' : `${submitLbl} →`}
                      </button>
                      <p style={{ fontSize: 11, color: theme.faint, textAlign: 'center', margin: '4px 0 0', lineHeight: 1.5 }}>
                        {consent}
                      </p>
                    </form>
                  </>
                )}
              </div>
            </Reveal>

            {agent && <AdvisorCard agent={agent} theme={theme} accent={accent} reduced={reduced} />}

            <Reveal reduced={reduced} delay={160}>
              <div style={{ display: 'flex', justifyContent: 'center', gap: 18, marginTop: 16,
                            fontSize: 11.5, color: theme.faint, flexWrap: 'wrap' }}>
                <span>🔒 Private &amp; secure</span>
                <span>✦ No spam</span>
                <span>✕ Unsubscribe anytime</span>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <footer style={{ borderTop: `1px solid ${theme.rule}`, padding: '22px 22px 44px',
                       textAlign: 'center', fontSize: 12, color: theme.faint }}>
        Gateway Real Estate Advisors · Licensed Brokerage · You can unsubscribe from any email at any time.
      </footer>

      <style>{`
        html, body { margin: 0; }
        #root { overflow-x: hidden; }
        .ml-page, .ml-page * { box-sizing: border-box; }
        .ml-page input:focus, .ml-page textarea:focus { border-color: ${accent} !important; box-shadow: 0 0 0 3px ${accent}22; }
        .ml-page input::placeholder, .ml-page textarea::placeholder { color: ${theme.faint}; }
        .ml-submit { transition: transform 140ms ease, box-shadow 140ms ease, filter 140ms ease; }
        .ml-submit:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 10px 26px ${accent}55; filter: brightness(1.04); }
        .ml-submit:active:not(:disabled) { transform: translateY(0); }
        @keyframes ml-pop { 0%{transform:scale(.5);opacity:0} 60%{transform:scale(1.08)} 100%{transform:scale(1);opacity:1} }
        .ml-pop { animation: ml-pop .5s cubic-bezier(.22,.61,.36,1) both; }
        @media (max-width: 900px) {
          .ml-grid { grid-template-columns: 1fr !important; gap: 30px !important; }
          .ml-sticky { position: static !important; }
        }
        @media (max-width: 560px) {
          .ml-highlights { grid-template-columns: repeat(2, minmax(0,1fr)) !important; gap: 16px !important; }
        }
        @media (prefers-reduced-motion: reduce) {
          .ml-submit, .ml-pop, .ml-pulse { transition: none !important; animation: none !important; }
        }
      `}</style>
    </div>
  )
}

/* ── Sticky, blur-on-scroll header ──────────────────────────────────────────── */
function Header({ theme, accent, agent, reduced }) {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const on = () => setStuck(window.scrollY > 8)
    on(); window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  return (
    <header style={{ position: 'sticky', top: 0, zIndex: 40,
                     padding: stuck ? '12px 22px' : '18px 22px',
                     background: stuck ? theme.headerBg : 'transparent',
                     backdropFilter: stuck ? 'blur(12px)' : 'none',
                     WebkitBackdropFilter: stuck ? 'blur(12px)' : 'none',
                     borderBottom: `1px solid ${stuck ? theme.rule : 'transparent'}`,
                     transition: reduced ? 'none' : 'padding 200ms ease, background 200ms ease, border-color 200ms ease' }}>
      <div style={{ maxWidth: 1120, margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 21, color: theme.ink }}>
          Gateway <span style={{ color: accent }}>Real Estate Advisors</span>
        </div>
        {agent?.phone && (
          <a href={`tel:${agent.phone}`} style={{ color: theme.ink, textDecoration: 'none', fontSize: 13, opacity: 0.85 }}>
            <span style={{ color: accent, marginRight: 6 }}>●</span>{agent.phone}
          </a>
        )}
      </div>
    </header>
  )
}

/* ── Credibility strip with count-up ────────────────────────────────────────── */
function Highlights({ highlights, theme, reduced }) {
  const [ref, shown] = useReveal()
  return (
    <div ref={ref} className="ml-highlights"
         style={{ marginTop: 36, display: 'grid', gridTemplateColumns: `repeat(${highlights.length}, minmax(0,1fr))`,
                  gap: 22, padding: '24px 0', borderTop: `1px solid ${theme.rule}`, borderBottom: `1px solid ${theme.rule}`,
                  opacity: shown ? 1 : 0, transform: shown ? 'none' : 'translateY(14px)',
                  transition: reduced ? 'none' : 'opacity .7s ease, transform .7s ease' }}>
      {highlights.map((h, i) => (
        <div key={i} style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 'clamp(24px,4.2vw,32px)', fontWeight: 600, lineHeight: 1.05 }}>
            <StatValue value={h.value} start={shown} />
          </div>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.2, color: theme.faint, marginTop: 6, lineHeight: 1.3 }}>
            {h.label}
          </div>
        </div>
      ))}
    </div>
  )
}

function StatValue({ value, start }) {
  const parsed = parseStat(value)
  const n = useCountUp(parsed ? parsed.num : NaN, { start })
  if (!parsed) return <>{value}</>
  return <>{parsed.prefix}{Math.round(n).toLocaleString()}{parsed.suffix}</>
}

/* ── Advisor card ───────────────────────────────────────────────────────────── */
function AdvisorCard({ agent, theme, accent, reduced }) {
  const [ref, shown] = useReveal()
  return (
    <div ref={ref} style={{ marginTop: 16, padding: '14px 18px', background: theme.cardSolid,
          border: `1px solid ${theme.cardBorder}`, borderRadius: 12, display: 'flex', alignItems: 'center', gap: 14,
          opacity: shown ? 1 : 0, transform: shown ? 'none' : 'translateY(12px)',
          transition: reduced ? 'none' : 'opacity .6s ease .1s, transform .6s ease .1s' }}>
      {agent.photo_url ? (
        <img src={agent.photo_url} alt={agent.name}
             style={{ width: 46, height: 46, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
      ) : (
        <div style={{ width: 46, height: 46, borderRadius: '50%', background: agent.color || accent,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontWeight: 700, color: '#141210', fontSize: 16, flexShrink: 0 }}>
          {(agent.name || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>{agent.name}</div>
        <div style={{ fontSize: 11.5, color: theme.faint }}>
          {agent.role || 'Real Estate Advisor'} · Gateway Real Estate
        </div>
      </div>
    </div>
  )
}

/* ── Reveal-on-scroll wrapper (inline styles → theme-agnostic) ──────────────── */
function Reveal({ children, delay = 0, style, as: Tag = 'div', reduced, ...rest }) {
  const [ref, shown] = useReveal()
  return (
    <Tag ref={ref} style={{
      opacity: shown ? 1 : 0,
      transform: shown ? 'none' : 'translateY(16px)',
      transition: reduced ? 'none' : `opacity .7s cubic-bezier(.22,.61,.36,1) ${delay}ms, transform .7s cubic-bezier(.22,.61,.36,1) ${delay}ms`,
      ...style,
    }} {...rest}>
      {children}
    </Tag>
  )
}

function Field({ label, children, theme }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.8, color: theme.mist, fontWeight: 600 }}>
        {label}
      </span>
      {children}
    </label>
  )
}
