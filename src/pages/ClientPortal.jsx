import React, { useState, useEffect } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// Client Portal — public, read-only transaction tracker.
// Served at /portal/<token>. Fetches everything from /api/portal (service-role,
// token-validated) so no Supabase credentials or RLS exposure on the client.
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  ink: '#1e2642', slate: '#2d3561', mist: '#9aa3b2', border: '#e6e9ef',
  bone: '#f7f8fa', azure: '#4a6fa5', green: '#16a34a', amber: '#d97706',
  sky: '#eef2f8', red: '#c0392b',
}

const fmtDate = (d) => {
  if (!d) return ''
  const dt = new Date(d + (d.length === 10 ? 'T00:00:00' : ''))
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })
}
const daysUntil = (d) => {
  if (!d) return null
  const dt = new Date(d + (d.length === 10 ? 'T00:00:00' : ''))
  return Math.ceil((dt - new Date().setHours(0, 0, 0, 0)) / 86400000)
}

function Loader() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14, fontFamily: 'DM Sans, system-ui, sans-serif' }}>
      <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 30, fontWeight: 600, color: C.slate }}>Gateway</div>
      <div style={{ width: 28, height: 28, border: `3px solid ${C.border}`, borderTopColor: C.azure, borderRadius: '50%', animation: 'gwspin 0.8s linear infinite' }} />
      <style>{`@keyframes gwspin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )
}

function ErrorView({ message }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 12, fontFamily: 'DM Sans, system-ui, sans-serif', padding: 24, textAlign: 'center' }}>
      <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 30, fontWeight: 600, color: C.slate }}>Gateway Real Estate</div>
      <div style={{ fontSize: 44 }}>🔒</div>
      <div style={{ color: C.ink, fontSize: 18, fontWeight: 600 }}>Portal Unavailable</div>
      <div style={{ color: C.mist, fontSize: 14, maxWidth: 360 }}>{message}</div>
    </div>
  )
}

function Card({ title, children, style }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14, padding: 20, boxShadow: '0 1px 3px rgba(20,30,60,0.04)', ...style }}>
      {title && <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: C.mist, marginBottom: 14 }}>{title}</div>}
      {children}
    </div>
  )
}

export default function ClientPortal({ token }) {
  const [data, setData]   = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    fetch(`/api/portal?token=${encodeURIComponent(token)}`)
      .then(async r => {
        const j = await r.json().catch(() => ({}))
        if (!alive) return
        if (!r.ok) setError(j.error || 'This portal link is not available.')
        else setData(j)
      })
      .catch(() => { if (alive) setError('Could not connect. Please check your link and try again.') })
    return () => { alive = false }
  }, [token])

  if (error) return <ErrorView message={error} />
  if (!data) return <Loader />

  const { checklist, keyDates, documents, agent } = data
  const upcoming = [...keyDates]
    .map(d => ({ ...d, days: daysUntil(d.date) }))
    .sort((a, b) => new Date(a.date) - new Date(b.date))

  return (
    <div style={{ minHeight: '100vh', background: C.bone, fontFamily: 'DM Sans, system-ui, sans-serif', color: C.ink }}>
      {/* Header */}
      <div style={{ background: C.slate, color: '#fff', padding: '28px 24px 64px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 26, fontWeight: 600 }}>Gateway</div>
          <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: '0.04em' }}>Real Estate Advisors</div>
        </div>
      </div>

      <div style={{ maxWidth: 760, margin: '-44px auto 0', padding: '0 16px 56px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Hero / transaction summary */}
        <Card>
          <div style={{ fontSize: 13, color: C.mist, marginBottom: 4 }}>
            {data.clientFirstName ? `Welcome, ${data.clientFirstName} —` : 'Welcome —'} here's where your transaction stands
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'Cormorant Garamond, serif', lineHeight: 1.2 }}>{data.title}</div>
          {data.property && <div style={{ fontSize: 13, color: C.mist, marginTop: 4 }}>{data.property}</div>}

          {/* Stage progress */}
          <div style={{ marginTop: 18 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{data.stageLabel}</span>
              {data.isClosed && <span style={{ fontSize: 13 }}>🎉 Congratulations!</span>}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {data.stageFlow.map(s => (
                <div key={s.key} title={s.label} style={{ flex: 1, height: 6, borderRadius: 3, background: s.reached ? C.green : C.border, transition: 'background 300ms' }} />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              {data.stageFlow.map(s => (
                <span key={s.key} style={{ fontSize: 9, color: s.reached ? C.slate : C.mist, fontWeight: s.key === data.stage ? 700 : 400, flex: 1, textAlign: 'center' }}>{s.label}</span>
              ))}
            </div>
          </div>
        </Card>

        {/* Next key date highlight */}
        {upcoming.filter(d => d.days != null && d.days >= 0).slice(0, 1).map(d => (
          <div key="next" style={{ background: C.sky, border: `1px solid ${C.border}`, borderRadius: 14, padding: 16, display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: C.azure, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', flexShrink: 0 }}>
              <span style={{ fontSize: 18, fontWeight: 800, lineHeight: 1 }}>{d.days}</span>
              <span style={{ fontSize: 8, textTransform: 'uppercase', opacity: 0.9 }}>days</span>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Next up: {d.type}</div>
              <div style={{ fontSize: 12, color: C.mist }}>{fmtDate(d.date)}</div>
            </div>
          </div>
        ))}

        {/* Checklist */}
        {checklist.total > 0 && (
          <Card title="Your Closing Progress">
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
              <span>{checklist.done} of {checklist.total} steps complete</span>
              <span style={{ color: checklist.pct === 100 ? C.green : C.mist }}>{checklist.pct}%</span>
            </div>
            <div style={{ height: 8, background: C.border, borderRadius: 4, overflow: 'hidden', marginBottom: 16 }}>
              <div style={{ width: `${checklist.pct}%`, height: '100%', background: checklist.pct === 100 ? C.green : C.azure, borderRadius: 4, transition: 'width 400ms ease' }} />
            </div>
            {checklist.steps.map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: i < checklist.steps.length - 1 ? `1px solid ${C.bone}` : 'none' }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: s.completed ? C.green : '#fff', border: `2px solid ${s.completed ? C.green : C.border}`, color: '#fff', fontSize: 11, fontWeight: 700 }}>
                  {s.completed ? '✓' : ''}
                </div>
                <span style={{ flex: 1, fontSize: 13, color: s.completed ? C.mist : C.ink, textDecoration: s.completed ? 'line-through' : 'none' }}>{s.title}</span>
                {s.completed && s.completedAt && (
                  <span style={{ fontSize: 10, color: C.mist }}>{new Date(s.completedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                )}
              </div>
            ))}
          </Card>
        )}

        {/* Key dates */}
        {upcoming.length > 0 && (
          <Card title="Important Dates">
            {upcoming.map((d, i) => {
              const past = d.days != null && d.days < 0
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: i < upcoming.length - 1 ? `1px solid ${C.bone}` : 'none', opacity: past ? 0.5 : 1 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: past ? C.mist : (d.days <= 7 ? C.amber : C.azure), flexShrink: 0 }} />
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{d.type}</span>
                  <span style={{ fontSize: 12, color: C.mist }}>{fmtDate(d.date)}</span>
                </div>
              )
            })}
          </Card>
        )}

        {/* Documents */}
        {documents.length > 0 && (
          <Card title="Shared Documents">
            {documents.map((doc, i) => (
              <a key={i} href={doc.url} target="_blank" rel="noopener noreferrer"
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: i < documents.length - 1 ? `1px solid ${C.bone}` : 'none', textDecoration: 'none', color: C.ink }}>
                <div style={{ width: 34, height: 34, borderRadius: 7, background: C.sky, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 16 }}>📄</div>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{doc.name}</span>
                <span style={{ fontSize: 12, color: C.azure, fontWeight: 600 }}>View ↗</span>
              </a>
            ))}
          </Card>
        )}

        {/* Agent contact */}
        {agent && (
          <Card title="Your Agent">
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ width: 52, height: 52, borderRadius: 12, background: agent.color || C.slate, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 19, fontWeight: 700, flexShrink: 0 }}>
                {agent.initials}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{agent.name}</div>
                <div style={{ fontSize: 12, color: C.mist }}>{agent.role}</div>
              </div>
              {agent.email && (
                <a href={`mailto:${agent.email}`} style={{ fontSize: 13, fontWeight: 600, color: '#fff', background: C.azure, padding: '8px 14px', borderRadius: 8, textDecoration: 'none' }}>
                  Contact
                </a>
              )}
            </div>
          </Card>
        )}

        <div style={{ textAlign: 'center', fontSize: 11, color: C.mist, marginTop: 8 }}>
          This is a private, read-only view of your transaction.<br />
          Powered by Gateway Real Estate Advisors
        </div>
      </div>
    </div>
  )
}
