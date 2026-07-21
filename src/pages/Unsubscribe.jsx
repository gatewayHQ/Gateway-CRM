/**
 * One-click unsubscribe — served at /u/:token (no login required).
 *
 * The token is the per-subscriber `unsubscribe_token` minted in
 * mailing_subscribers. Hitting this page immediately opts the address out via
 * the public campaigns API, then confirms.
 */
import React, { useEffect, useState } from 'react'

export default function Unsubscribe({ token }) {
  const [state, setState] = useState('working') // working | done | error
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch('/api/campaigns', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unsubscribe', token }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.error) { setMessage(data.error || 'This link is no longer valid.'); setState('error'); return }
        setEmail(data.email || '')
        setState('done')
      } catch {
        setMessage('Something went wrong. Please try again.')
        setState('error')
      }
    })()
  }, [token])

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'radial-gradient(1000px 500px at 50% -10%, #1a1f2e 0%, #0f0f10 60%, #0a0a0b 100%)',
                  color: '#f4f1e9', fontFamily: 'DM Sans, system-ui, sans-serif', padding: 24 }}>
      <div style={{ maxWidth: 440, textAlign: 'center' }}>
        <div style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 24 }}>
          Gateway <span style={{ color: '#c9a961' }}>Real Estate Advisors</span>
        </div>
        {state === 'working' && <p style={{ color: '#b8b6ad', marginTop: 20 }}>Updating your preferences…</p>}
        {state === 'done' && (
          <>
            <div style={{ width: 60, height: 60, borderRadius: '50%', background: '#c9a96122', color: '#c9a961',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '24px auto 0', fontSize: 30 }}>✓</div>
            <h1 style={{ fontFamily: 'Cormorant Garamond, serif', fontWeight: 500, fontSize: 30, margin: '16px 0 8px' }}>
              You've been unsubscribed
            </h1>
            <p style={{ color: '#b8b6ad', lineHeight: 1.6 }}>
              {email ? <><b style={{ color: '#f4f1e9' }}>{email}</b> won't receive any more emails from this list.</>
                     : "You won't receive any more emails from this list."}
            </p>
          </>
        )}
        {state === 'error' && (
          <>
            <h1 style={{ fontFamily: 'Cormorant Garamond, serif', fontWeight: 500, fontSize: 28, margin: '20px 0 8px' }}>
              Hmm — that didn't work
            </h1>
            <p style={{ color: '#e57373', lineHeight: 1.6 }}>{message}</p>
          </>
        )}
      </div>
    </div>
  )
}
