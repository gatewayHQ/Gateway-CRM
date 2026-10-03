import React, { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { createAgentProfile } from '../../lib/services/agents.js'

// First sign-in with no agent row: create the user's shared team identity.

const COLORS = ['#2d3561','#4a6fa5','#2e7d5e','#c9a84c','#6b4fa5','#c0392b','#d4820a','#1a1a2e']

const nameFromEmail = (email = '') => {
  const local = (email || '').split('@')[0]
  return local.split(/[._-]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

export default function AgentOnboardingModal({ session, onComplete }) {
  const guessedName = nameFromEmail(session?.user?.email || '')
  const [name, setName] = useState(guessedName)
  const [role, setRole] = useState('')
  const [color, setColor] = useState(COLORS[0])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const autoInitials = (n) => n.trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2)

  const save = async () => {
    if (!name.trim()) { setError('Please enter your full name.'); return }
    setSaving(true)
    const { data, error: err } = await createAgentProfile(supabase, {
      auth_id: session?.user?.id,
      name: name.trim(),
      initials: autoInitials(name),
      role: role.trim() || 'Agent',
      email: session?.user?.email || '',
      color,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    onComplete(data)
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(10,14,28,0.7)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24,
    }}>
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 440, boxShadow: 'var(--shadow-modal)' }}>
        <div style={{ padding: '28px 32px 0' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600, color: 'var(--gw-slate)', marginBottom: 6 }}>
            Welcome to Gateway CRM
          </div>
          <div style={{ fontSize: 14, color: 'var(--gw-mist)', lineHeight: 1.6, marginBottom: 24 }}>
            Let's set up your agent profile. This creates your shared identity across the team.
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <div style={{ width: 64, height: 64, borderRadius: 12, background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 700, color: '#fff', transition: 'background 200ms' }}>
              {autoInitials(name) || '?'}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label required">Full Name</label>
            <input className="form-control" value={name} onChange={e => setName(e.target.value)} placeholder="Jane Smith" autoFocus />
          </div>

          <div className="form-group">
            <label className="form-label">Role / Title</label>
            <input className="form-control" value={role} onChange={e => setRole(e.target.value)} placeholder="Lead Agent, Buyer's Agent, Admin…" />
          </div>

          <div className="form-group">
            <label className="form-label">Avatar Color</label>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              {COLORS.map(c => (
                <div key={c} onClick={() => setColor(c)} style={{ width: 28, height: 28, borderRadius: 6, background: c, cursor: 'pointer', border: color === c ? '3px solid var(--gw-ink)' : '3px solid transparent', transition: 'border 150ms' }} />
              ))}
            </div>
          </div>

          {error && <div style={{ color: 'var(--gw-red)', fontSize: 13, marginBottom: 12 }}>{error}</div>}
        </div>

        <div style={{ padding: '16px 32px 28px', borderTop: '1px solid var(--gw-border)', marginTop: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginBottom: 12 }}>
            Logged in as <strong>{session?.user?.email}</strong>. Your profile is shared with the whole team.
          </div>
          <button className="btn btn--primary" style={{ width: '100%', justifyContent: 'center' }} onClick={save} disabled={saving}>
            {saving ? 'Creating Profile…' : 'Get Started →'}
          </button>
        </div>
      </div>
    </div>
  )
}
