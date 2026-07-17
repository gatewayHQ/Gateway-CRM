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
 *     highlights,       // [{value,label}] — optional credibility strip
 *     images,           // [{url}] — optional hero imagery
 *     consent_text,     // fine print under the button
 *   }
 *
 * Mobile-first: single column on phones, two columns from 900px up.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'

// Light / dark luxury palettes. Everything else is derived from `accent`.
const THEMES = {
  dark: {
    bg:        'radial-gradient(1200px 600px at 15% -10%, #1a1f2e 0%, #0f0f10 55%, #0a0a0b 100%)',
    ink:       '#f4f1e9',
    mist:      '#b8b6ad',
    faint:     '#86847c',
    card:      '#141416',
    cardBorder:'#2a2a2c',
    input:     '#0e0e10',
    inputBorder:'#2c2c2e',
    rule:      '#242426',
  },
  light: {
    bg:        'radial-gradient(1200px 600px at 15% -10%, #fbf8f1 0%, #f4efe4 60%, #efe9db 100%)',
    ink:       '#1c1b18',
    mist:      '#5f5c54',
    faint:     '#8b887f',
    card:      '#ffffff',
    cardBorder:'#e6e0d2',
    input:     '#fbf9f4',
    inputBorder:'#ded8c8',
    rule:      '#e6e0d2',
  },
}

export default function LandingMailing({ mailingId }) {
  const [mailing,    setMailing]    = useState(null)
  const [agents,     setAgents]     = useState([])
  const [loading,    setLoading]    = useState(true)
  const [submitted,  setSubmitted]  = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState(null)
  const [form, setForm] = useState({ email: '', name: '', phone: '' })

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
  const collectName  = cfg.collect_name  !== false
  const collectPhone = cfg.collect_phone === true
  const perks    = (Array.isArray(cfg.perks) ? cfg.perks : []).filter(Boolean)
  const highlights = (Array.isArray(cfg.highlights) ? cfg.highlights : []).filter(h => h && (h.value || h.label)).slice(0, 4)
  const images   = (Array.isArray(cfg.images) ? cfg.images : [])
    .map(v => (typeof v === 'string' ? { url: v } : v)).filter(v => v?.url)
  const heroImage = images[0]?.url
  const consent  = cfg.consent_text || 'By subscribing you agree to receive occasional emails. We never sell your data.'

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
                 color: theme.ink, fontFamily: 'DM Sans, system-ui, sans-serif' }

  if (loading) return (
    <div style={{ ...page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: theme.mist, fontSize: 14 }}>Loading…</div>
    </div>
  )
  if (error === 'notfound') return (
    <div style={{ ...page, padding: 60, textAlign: 'center' }}>
      <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 22, color: theme.ink }}>Gateway Real Estate</div>
      <div style={{ marginTop: 8, color: theme.mist }}>This list is no longer available.</div>
    </div>
  )

  const inp = {
    width: '100%', boxSizing: 'border-box', padding: '13px 14px',
    background: theme.input, border: `1px solid ${theme.inputBorder}`, borderRadius: 8,
    color: theme.ink, fontSize: 16, fontFamily: 'inherit', outline: 'none', transition: 'border-color 150ms',
  }

  return (
    <div className="ml-page" style={page}>
      {/* Header */}
      <header style={{ padding: '18px 22px', maxWidth: 1120, margin: '0 auto',
                       display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 21 }}>
          Gateway <span style={{ color: accent }}>Real Estate Advisors</span>
        </div>
        {agent?.phone && (
          <a href={`tel:${agent.phone}`} style={{ color: theme.ink, textDecoration: 'none', fontSize: 13, opacity: 0.85 }}>
            <span style={{ color: accent, marginRight: 6 }}>●</span>{agent.phone}
          </a>
        )}
      </header>

      <section style={{ maxWidth: 1120, margin: '0 auto', padding: '20px 22px 56px' }}>
        <div className="ml-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,0.95fr)',
                                          gap: 48, alignItems: 'start' }}>
          {/* Left — pitch */}
          <div>
            <div style={{ display: 'inline-block', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase',
                          color: accent, padding: '4px 11px', border: `1px solid ${accent}55`, borderRadius: 99 }}>
              {eyebrow}
            </div>
            <h1 style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 'clamp(38px,6vw,64px)', fontWeight: 500,
                         lineHeight: 1.05, margin: '18px 0 14px', letterSpacing: '-0.01em' }}>
              {headline}
            </h1>
            <p style={{ fontSize: 17, lineHeight: 1.6, color: theme.mist, maxWidth: 540, margin: 0 }}>
              {subhead}
            </p>

            {heroImage && (
              <div style={{ marginTop: 30, borderRadius: 12, overflow: 'hidden',
                            boxShadow: '0 20px 60px rgba(0,0,0,0.35)', aspectRatio: '16 / 9',
                            backgroundImage: `url(${heroImage})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
            )}

            {perks.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '30px 0 0', display: 'grid', gap: 12,
                           color: theme.ink, fontSize: 15 }}>
                {perks.map((p, i) => (
                  <li key={i} style={{ display: 'flex', gap: 12, lineHeight: 1.5 }}>
                    <span style={{ color: accent, flexShrink: 0, marginTop: 1, fontWeight: 700 }}>✓</span>
                    <span style={{ color: theme.mist }}>{p}</span>
                  </li>
                ))}
              </ul>
            )}

            {highlights.length > 0 && (
              <div className="ml-highlights"
                   style={{ marginTop: 34, display: 'grid', gridTemplateColumns: `repeat(${highlights.length}, minmax(0,1fr))`,
                            gap: 22, padding: '22px 0', borderTop: `1px solid ${theme.rule}`, borderBottom: `1px solid ${theme.rule}` }}>
                {highlights.map((h, i) => (
                  <div key={i} style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 'clamp(22px,4vw,30px)',
                                  fontWeight: 600, lineHeight: 1.05 }}>{h.value}</div>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1.2,
                                  color: theme.faint, marginTop: 6, lineHeight: 1.3 }}>{h.label}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Right — subscribe card (sticky on desktop) */}
          <div className="ml-sticky" style={{ position: 'sticky', top: 24 }}>
            <div style={{ background: theme.card, border: `1px solid ${theme.cardBorder}`, borderRadius: 14,
                          padding: 28, boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
              {submitted ? (
                <div style={{ textAlign: 'center', padding: '20px 0' }} role="status">
                  <div style={{ width: 60, height: 60, borderRadius: '50%', background: `${accent}22`, color: accent,
                                display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto', fontSize: 30 }}>✓</div>
                  <h2 style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 28, margin: '16px 0 8px' }}>
                    Welcome aboard.
                  </h2>
                  <p style={{ color: theme.mist, fontSize: 15, lineHeight: 1.6, margin: 0 }}>{successMsg}</p>
                </div>
              ) : (
                <>
                  {/* EDITABLE section heading — replaces the old static "Notes/Questions" */}
                  <h2 style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 26, margin: '0 0 4px', fontWeight: 500 }}>
                    {listHead}
                  </h2>
                  <p style={{ fontSize: 13, color: theme.faint, margin: '0 0 18px' }}>{listSub}</p>

                  <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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

                    {error && (
                      <div style={{ color: '#e57373', fontSize: 13, background: 'rgba(229,115,115,0.12)',
                                    padding: '9px 11px', borderRadius: 6 }}>{error}</div>
                    )}

                    {/* EDITABLE bottom submit button text */}
                    <button type="submit" disabled={submitting}
                            style={{ background: accent, color: '#141210', padding: '15px 16px', border: 'none',
                                     borderRadius: 8, fontSize: 16, fontWeight: 700, letterSpacing: 0.3,
                                     cursor: submitting ? 'default' : 'pointer', marginTop: 4, opacity: submitting ? 0.6 : 1 }}>
                      {submitting ? 'Subscribing…' : `${submitLbl} →`}
                    </button>
                    <p style={{ fontSize: 11, color: theme.faint, textAlign: 'center', margin: '4px 0 0', lineHeight: 1.5 }}>
                      {consent}
                    </p>
                  </form>
                </>
              )}
            </div>

            {agent && (
              <div style={{ marginTop: 16, padding: '14px 18px', background: theme.card,
                            border: `1px solid ${theme.cardBorder}`, borderRadius: 12,
                            display: 'flex', alignItems: 'center', gap: 14 }}>
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
            )}
          </div>
        </div>
      </section>

      <footer style={{ borderTop: `1px solid ${theme.rule}`, padding: '20px 22px 40px',
                       textAlign: 'center', fontSize: 12, color: theme.faint }}>
        Gateway Real Estate Advisors · Licensed Brokerage · You can unsubscribe from any email at any time.
      </footer>

      <style>{`
        html, body { margin: 0; }
        #root { overflow-x: hidden; }
        .ml-page, .ml-page * { box-sizing: border-box; }
        input:focus, textarea:focus { border-color: ${accent} !important; }
        input::placeholder { color: ${theme.faint}; }
        @media (max-width: 900px) {
          .ml-grid { grid-template-columns: 1fr !important; gap: 30px !important; }
          .ml-sticky { position: static !important; }
        }
        @media (max-width: 560px) {
          .ml-highlights { grid-template-columns: repeat(2, minmax(0,1fr)) !important; gap: 16px !important; }
        }
      `}</style>
    </div>
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
