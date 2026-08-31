/**
 * OmGate — the Offering Memorandum download gate.
 *
 * The trade at the centre of every QR landing page: the visitor gets the OM,
 * the broker gets a name, a phone number and an email. All three are required
 * here (the ordinary LeadForm asks for far less) because this is an exchange,
 * and an OM is not a brochure — whoever downloads it is a real prospect and is
 * worth being able to call.
 *
 * Mechanics that matter:
 *   • Nothing is rendered unless the campaign actually has an OM attached.
 *   • The PDF lives in a private bucket. This component never has a URL for it;
 *     it POSTs to `action=om_request` and receives one that expires in minutes.
 *   • The download is triggered by a real anchor click rather than
 *     `location.href`, so iOS Safari — where most QR scans land — opens the PDF
 *     in its viewer instead of blanking the page the visitor came from.
 *   • On success the panel stays put with a "Download again" link. A visitor who
 *     lost the tab must not have to re-type their details to get the file back.
 *
 * `theme="dark"` matches the multifamily/valuation pages; the default light
 * theme matches the luxury landing kit.
 */
import React, { useState } from 'react'

const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim())
const digits  = (v) => (String(v).match(/\d/g) || []).length

export function OmGate({
  om,                       // normalized descriptor from lib/om.js (null → renders nothing)
  onUnlock,                 // async ({ name, phone, email }) => ({ url, filename })
  accent = '#c9a961',
  theme = 'light',
  title,
  subtext,
}) {
  const [form, setForm]     = useState({ name: '', phone: '', email: '' })
  const [errors, setErrors] = useState({})
  const [status, setStatus] = useState('idle')   // idle | submitting | done | error
  const [topError, setTopError] = useState(null)
  const [grant, setGrant]   = useState(null)     // { url, filename } once unlocked

  if (!om) return null

  const dark = theme === 'dark'
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))

  const heading  = title   || om.title || 'Offering Memorandum'
  const sizeHint = om.size ? `PDF · ${formatSize(om.size)}` : 'PDF'

  const submit = async (e) => {
    e.preventDefault()
    const next = {}
    if (form.name.trim().length < 2) next.name  = 'Please enter your full name'
    if (digits(form.phone) < 10)     next.phone = 'A phone number with area code, please'
    if (!isEmail(form.email))        next.email = "That doesn't look like an email address"
    setErrors(next)
    if (Object.keys(next).length) return

    setStatus('submitting'); setTopError(null)
    try {
      const res = await onUnlock({
        name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim(),
      })
      setGrant(res)
      setStatus('done')
      openDownload(res)
    } catch (err) {
      setStatus('error')
      setTopError(err?.message || "We couldn't prepare the download. Please try again.")
    }
  }

  const panel = {
    borderRadius: 12,
    padding: 22,
    border: dark ? '1px solid #2f2f2f' : '1px solid var(--lx-line, #e5e2da)',
    background: dark ? '#181818' : '#fff',
    boxShadow: dark ? '0 24px 64px rgba(0,0,0,0.45)' : 'var(--lx-shadow-md, 0 12px 32px rgba(20,24,40,0.08))',
  }
  const inkStrong = dark ? '#f3f0e6' : 'var(--lx-ink, #1e2642)'
  const inkSoft   = dark ? '#8c8c84' : 'var(--lx-mist, #7b8393)'

  return (
    <section style={panel} aria-labelledby="om-gate-heading">
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div aria-hidden="true" style={{
          width: 40, height: 40, borderRadius: 8, flexShrink: 0, fontSize: 18,
          display: 'grid', placeItems: 'center',
          background: `${accent}22`, color: accent, border: `1px solid ${accent}55`,
        }}>📄</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10.5, letterSpacing: 1.6, textTransform: 'uppercase', color: accent, marginBottom: 4 }}>
            {status === 'done' ? 'Unlocked' : 'Instant access'}
          </div>
          <h2 id="om-gate-heading" className="lx-serif"
              style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 22, fontWeight: 600,
                       margin: 0, color: inkStrong, lineHeight: 1.2 }}>
            {heading}
          </h2>
          <div style={{ fontSize: 11.5, color: inkSoft, marginTop: 3 }}>{sizeHint}</div>
        </div>
      </div>

      {status === 'done' && grant ? (
        <div style={{ marginTop: 16 }} role="status">
          <p style={{ fontSize: 13.5, lineHeight: 1.6, color: dark ? '#bdbcb4' : 'var(--lx-ink-2, #4a5163)', margin: '0 0 14px' }}>
            Your download has started. If nothing happened, use the button below.
          </p>
          <a href={grant.url} download={grant.filename} target="_blank" rel="noopener noreferrer"
             onClick={(e) => { e.preventDefault(); openDownload(grant) }}
             style={{
               display: 'block', textAlign: 'center', textDecoration: 'none',
               padding: '12px 16px', borderRadius: 8, fontWeight: 700, fontSize: 13.5,
               background: accent, color: '#15130f',
             }}>
            Download the {heading} ↓
          </a>
          <p style={{ fontSize: 11, color: inkSoft, textAlign: 'center', margin: '10px 0 0' }}>
            This link expires shortly — download it now and keep the file.
          </p>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: dark ? '#bdbcb4' : 'var(--lx-ink-2, #4a5163)', margin: '14px 0 16px' }}>
            {subtext || 'Full financials, rent roll and photos. Tell us where to send it and it downloads immediately.'}
          </p>
          <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <GateField label="Full name *" error={errors.name} dark={dark} accent={accent}
                       value={form.name} onChange={set('name')} autoComplete="name" placeholder="Jane Investor" />
            <GateField label="Phone *" error={errors.phone} dark={dark} accent={accent} type="tel"
                       value={form.phone} onChange={set('phone')} autoComplete="tel" placeholder="(515) 555-0134" />
            <GateField label="Email *" error={errors.email} dark={dark} accent={accent} type="email"
                       value={form.email} onChange={set('email')} autoComplete="email" placeholder="jane@company.com" />
            <div aria-live="polite">
              {topError && (
                <div role="alert" style={{ fontSize: 12, color: '#e57373', marginBottom: 2 }}>{topError}</div>
              )}
            </div>
            <button type="submit" disabled={status === 'submitting'} aria-busy={status === 'submitting' || undefined}
                    style={{
                      padding: '12px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                      fontWeight: 700, fontSize: 13.5, background: accent, color: '#15130f',
                      opacity: status === 'submitting' ? 0.7 : 1,
                    }}>
              {status === 'submitting' ? 'Preparing your download…' : 'Get the OM →'}
            </button>
            <p style={{ fontSize: 11, color: inkSoft, textAlign: 'center', margin: '2px 0 0', lineHeight: 1.5 }}>
              We'll only use this to follow up on this property. No lists, no spam.
            </p>
          </form>
        </>
      )}
    </section>
  )
}

/**
 * Hand the browser the signed URL through a real anchor click.
 *
 * `window.location = url` is the obvious thing and the wrong one: on iOS — where
 * the majority of QR scans are opened — navigating the current tab to a PDF
 * loses the landing page, and in an in-app browser (Instagram, Facebook) it can
 * leave the visitor on a blank screen with no back button. A synthesized click
 * on an `<a target="_blank" download>` opens the viewer alongside the page and
 * degrades to a normal navigation where popups are blocked.
 */
function openDownload({ url, filename }) {
  if (!url) return
  try {
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    if (filename) a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } catch {
    window.open(url, '_blank', 'noopener')
  }
}

function GateField({ label, error, dark, accent, ...rest }) {
  const id = React.useId()
  return (
    <div>
      <label htmlFor={id} style={{
        display: 'block', fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase',
        color: dark ? '#8c8c84' : 'var(--lx-mist, #7b8393)', marginBottom: 5, fontWeight: 600,
      }}>{label}</label>
      <input id={id} aria-invalid={error ? 'true' : undefined}
             aria-describedby={error ? `${id}-err` : undefined}
             style={{
               width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 14,
               borderRadius: 7, outline: 'none',
               border: `1px solid ${error ? '#e57373' : (dark ? '#333' : 'var(--lx-line, #e5e2da)')}`,
               background: dark ? '#101010' : '#fff',
               color: dark ? '#f3f0e6' : 'var(--lx-ink, #1e2642)',
             }}
             onFocus={(e) => { e.target.style.borderColor = accent }}
             onBlur={(e) => { e.target.style.borderColor = error ? '#e57373' : (dark ? '#333' : '#e5e2da') }}
             {...rest} />
      {error && <div id={`${id}-err`} role="alert" style={{ fontSize: 11.5, color: '#e57373', marginTop: 4 }}>{error}</div>}
    </div>
  )
}

function formatSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
