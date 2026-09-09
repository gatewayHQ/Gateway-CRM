import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { BrandLogo } from '../components/UI.jsx'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    if (err) setError(err.message)
    setLoading(false)
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--gw-bone)', fontFamily: 'var(--font-body)',
    }}>
      <div style={{
        width: '100%', maxWidth: 400, background: '#fff',
        border: '1px solid var(--gw-border)', borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-modal)', padding: '40px 36px',
      }}>
        {/* The seal leads the card — it is the first thing anyone sees of the
            product, and it carries the name, so it sits above the company
            lockup rather than beside it as the old "G" tile did. */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 28 }}>
          <BrandLogo size={96} priority />
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, color: 'var(--gw-slate)', marginTop: 16 }}>Gateway</div>
          <div style={{ fontSize: 11, color: 'var(--gw-mist)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Real Estate Advisors</div>
        </div>

        <div style={{ marginBottom: 24, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600, color: 'var(--gw-ink)', marginBottom: 4 }}>Welcome back</div>
          <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>Sign in to access your workspace</div>
        </div>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input
              className="form-control"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              className="form-control"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <div style={{
              fontSize: 13, color: 'var(--gw-red)', background: 'var(--gw-red-light)',
              border: '1px solid #f5c6c2', borderRadius: 'var(--radius)', padding: '10px 12px',
            }}>{error}</div>
          )}

          <button
            className="btn btn--primary"
            type="submit"
            disabled={loading}
            style={{ width: '100%', justifyContent: 'center', marginTop: 4, padding: '10px 0', fontSize: 14 }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
