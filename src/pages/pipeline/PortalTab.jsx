import React from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, pushToast } from '../../components/UI.jsx'

// Generates a tokenized read-only client portal URL for a deal. The portal
// itself lives elsewhere (/portal/:token) and pulls only documents the agent
// marked "Share with client" on the Documents tab.
export default function PortalTab({ deal }) {
  const [enabled, setEnabled] = React.useState(false)
  const [token, setToken]     = React.useState(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy]       = React.useState(false)
  const [copied, setCopied]   = React.useState(false)

  React.useEffect(() => {
    if (!deal?.id) return
    supabase.from('deals').select('portal_token, portal_enabled').eq('id', deal.id).single()
      .then(({ data, error }) => {
        if (!error && data) { setEnabled(!!data.portal_enabled); setToken(data.portal_token || null) }
        setLoading(false)
      })
  }, [deal?.id])

  const portalUrl = token ? `${window.location.origin}/portal/${token}` : ''

  const enable = async () => {
    setBusy(true)
    const newToken = token || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const { error } = await supabase.from('deals').update({ portal_token: newToken, portal_enabled: true }).eq('id', deal.id)
    setBusy(false)
    if (error) { pushToast(error.message, 'error'); return }
    setToken(newToken); setEnabled(true)
    pushToast('Client portal enabled')
  }

  const disable = async () => {
    setBusy(true)
    const { error } = await supabase.from('deals').update({ portal_enabled: false }).eq('id', deal.id)
    setBusy(false)
    if (error) { pushToast(error.message, 'error'); return }
    setEnabled(false)
    pushToast('Client portal disabled', 'info')
  }

  const copy = () => {
    navigator.clipboard.writeText(portalUrl)
    setCopied(true); setTimeout(() => setCopied(false), 1800)
  }

  if (loading) return <div style={{ padding: 24, color: 'var(--gw-mist)', fontSize: 13 }}>Loading…</div>

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      <div style={{ fontSize: 13, color: 'var(--gw-mist)', lineHeight: 1.6, marginBottom: 16 }}>
        Give your client a private, read-only link to track their transaction — closing progress,
        key dates, shared documents, and your contact info. Updates in real time as you work the deal.
      </div>

      {!enabled ? (
        <button className="btn btn--primary" onClick={enable} disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          <Icon name="link" size={14} /> {busy ? 'Enabling…' : 'Enable Client Portal'}
        </button>
      ) : (
        <>
          <div style={{ background: 'var(--gw-green-light)', border: '1px solid var(--gw-green)', borderRadius: 'var(--radius)', padding: '10px 12px', fontSize: 12, color: 'var(--gw-green)', fontWeight: 600, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="check" size={13} /> Portal is live
          </div>

          <label className="form-label">Shareable Link</label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input className="form-control" readOnly value={portalUrl} style={{ flex: 1, fontSize: 12 }} onFocus={e => e.target.select()} />
            <button className="btn btn--secondary btn--sm" onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <a className="btn btn--secondary btn--sm" href={portalUrl} target="_blank" rel="noopener noreferrer" style={{ flex: 1, justifyContent: 'center' }}>
              <Icon name="eye" size={12} /> Preview
            </a>
            <button className="btn btn--ghost btn--sm" onClick={disable} disabled={busy} style={{ color: 'var(--gw-red)' }}>
              Disable
            </button>
          </div>

          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 14, lineHeight: 1.6, borderTop: '1px solid var(--gw-border)', paddingTop: 12 }}>
            Anyone with this link can view the portal — no login required. Only documents you mark
            <strong> "Share with client"</strong> on the Documents tab appear. Disable any time to revoke access.
          </div>
        </>
      )}
    </div>
  )
}
