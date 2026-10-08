/**
 * NdaStep — the Confidentiality Agreement between registration and the Deal Room.
 *
 * Shown by OmGate when the campaign has an NDA attached and this visitor has not
 * signed it. The visitor can open the agreement, types their full legal name as
 * their signature, ticks "I agree", and signs. The server records the time, IP,
 * browser and a hash of the exact file, builds a signed copy, and only then
 * hands back the OM and the room (api/campaigns.js action=nda_sign).
 *
 * `pending` is { mailing_id, access_token, nda: { title, filename, size }, visitor }.
 */
import React, { useState } from 'react'
import { requestNda, signNda } from '../../lib/dealRoomAccess.js'
import { openDownload } from './OmGate.jsx'

export function NdaStep({ pending, accent, dark, onSigned, primaryBtn }) {
  const [name, setName]       = useState(pending?.visitor?.name || '')
  const [company, setCompany] = useState('')
  const [agree, setAgree]     = useState(false)
  const [status, setStatus]   = useState('idle')   // idle | opening | signing
  const [error, setError]     = useState(null)

  const title    = pending?.nda?.title || 'Confidentiality Agreement'
  const inkBody  = dark ? '#bdbcb4' : 'var(--lx-ink-2, #4a5163)'
  const inkSoft  = dark ? '#8c8c84' : 'var(--lx-mist, #7b8393)'
  const inkStrong = dark ? '#f3f0e6' : 'var(--lx-ink, #1e2642)'
  const line     = dark ? '#333' : 'var(--lx-line, #e5e2da)'

  const open = async () => {
    setStatus('opening'); setError(null)
    try {
      const grant = await requestNda(pending.mailing_id, pending.access_token)
      // No `download` name: the agreement should open in the PDF viewer to be read.
      openDownload({ url: grant.url })
    } catch (err) {
      setError(err.message)
    } finally {
      setStatus('idle')
    }
  }

  const sign = async (e) => {
    e.preventDefault()
    if (name.trim().length < 2) { setError('Type your full legal name to sign'); return }
    if (!agree) { setError('Please confirm you agree to the Confidentiality Agreement'); return }
    setStatus('signing'); setError(null)
    try {
      const res = await signNda(pending.mailing_id, pending.access_token, {
        signer_name: name.trim(), company: company.trim(), agree: true,
      })
      onSigned(res)
    } catch (err) {
      setError(err.message)
      setStatus('idle')
    }
  }

  const input = {
    width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 14, borderRadius: 3, outline: 'none',
    border: `1px solid ${line}`, background: dark ? '#101010' : '#fff', color: inkStrong,
  }
  const label = {
    display: 'block', fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase',
    color: inkSoft, marginBottom: 5, fontWeight: 600,
  }

  return (
    <form onSubmit={sign} noValidate style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: inkBody, margin: 0 }}>
        {pending?.visitor?.name ? `Thanks, ${pending.visitor.name.split(/\s+/)[0]}. ` : ''}
        The seller requires a signed {title} before the offering memorandum, photos, rent roll and
        financials are released. Read it, then sign below — it takes a few seconds.
      </p>

      <button type="button" onClick={open} disabled={status !== 'idle'}
              style={{
                padding: '11px 14px', borderRadius: 3, cursor: 'pointer', fontWeight: 600, fontSize: 13,
                background: 'transparent', color: inkStrong, border: `1px solid ${accent}`,
              }}>
        {status === 'opening' ? 'Opening…' : `Read the ${title} (PDF)`}
      </button>

      <div>
        <label htmlFor="nda-name" style={label}>Full legal name — your signature *</label>
        <input id="nda-name" style={{ ...input, fontFamily: 'Cormorant Garamond, serif', fontStyle: 'italic', fontSize: 18 }}
               value={name} onChange={e => setName(e.target.value)} autoComplete="name" placeholder="Jane Investor" />
      </div>
      <div>
        <label htmlFor="nda-company" style={label}>Company (optional)</label>
        <input id="nda-company" style={input} value={company} onChange={e => setCompany(e.target.value)}
               autoComplete="organization" placeholder="Investor Capital LLC" />
      </div>

      <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.5, color: inkBody, cursor: 'pointer' }}>
        <input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)}
               style={{ marginTop: 3, accentColor: accent }} />
        <span>
          I have read and agree to the {title}, and I agree that typing my name above is my electronic
          signature.
        </span>
      </label>

      <div aria-live="polite">
        {error && <div role="alert" style={{ fontSize: 12, color: '#e57373' }}>{error}</div>}
      </div>

      <button type="submit" disabled={status !== 'idle'} aria-busy={status === 'signing' || undefined}
              style={{ ...primaryBtn, opacity: status === 'signing' ? 0.7 : 1 }}>
        {status === 'signing' ? 'Signing…' : 'Sign & enter the Deal Room'}
      </button>
      <p style={{ fontSize: 11, color: inkSoft, textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
        We record the date, time and your IP address with your signature, and you'll get a signed copy.
      </p>
    </form>
  )
}
