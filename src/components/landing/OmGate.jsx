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
 *   • Mailing address, "I am a" and 1031 are OPTIONAL. Asked, never demanded:
 *     a required address turns people away, and a lead without one still has
 *     a name, a phone and an email.
 *   • When the campaign has an NDA attached, registering leads to a signing step
 *     (NdaStep) instead of the download: the server releases nothing until the
 *     NDA is signed. `ndaPending` opens straight onto that step for a visitor
 *     who registered earlier but never signed.
 *   • A visitor who registered on any Gateway page before is offered
 *     "Continue as Jane" (src/lib/dealRoomAccess.js) — one tap, and the agent
 *     on THIS campaign still gets the lead.
 *
 * `theme="dark"` matches the multifamily/valuation pages; the default light
 * theme matches the luxury landing kit.
 */
import React, { useEffect, useState } from 'react'
import { loadIdentity, saveIdentity, forgetIdentity } from '../../lib/dealRoomAccess.js'
import { LineIcon } from './dealRoom.jsx'
import { NdaStep } from './NdaStep.jsx'

const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim())
const digits  = (v) => (String(v).match(/\d/g) || []).length

const ROLES = [
  { value: 'principal', label: 'Principal / Buyer' },
  { value: 'broker',    label: 'Broker' },
  { value: 'lender',    label: 'Lender' },
]

export function OmGate({
  om,                       // normalized descriptor from lib/om.js (null → renders nothing unless forceShow)
  onUnlock,                 // async ({ name, phone, email, mailing_address, buyer_role, is_1031 }) => ({ url?, filename? })
  accent = '#c9a961',
  theme = 'light',
  title,
  subtext,
  ctaLabel,                 // submit button text (default "Get the OM →")
  qualifiers = false,       // show the optional "I am a" + 1031 questions
  forceShow = false,        // render even with no OM file (a Deal Room with other documents)
  ndaPending = null,        // { mailing_id, access_token, nda, visitor } — open on the NDA step
  onNdaSigned,              // (res) => void, once the NDA is signed and the room is open
  id,
}) {
  const [form, setForm]     = useState({ name: '', phone: '', email: '', mailing_address: '', buyer_role: '', is_1031: '' })
  const [errors, setErrors] = useState({})
  const [status, setStatus] = useState(ndaPending ? 'nda' : 'idle')   // idle | submitting | nda | done | error
  const [topError, setTopError] = useState(null)
  const [grant, setGrant]   = useState(null)     // { url, filename } once unlocked
  const [known, setKnown]   = useState(null)     // a returning visitor's saved details
  const [nda, setNda]       = useState(ndaPending) // registered, NDA still to sign

  useEffect(() => { setKnown(loadIdentity()) }, [])
  useEffect(() => { if (ndaPending) { setNda(ndaPending); setStatus('nda') } }, [ndaPending])

  if (!om && !forceShow) return null

  const dark = theme === 'dark'
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }))
  const pick = (k, v) => setForm(f => ({ ...f, [k]: f[k] === v ? '' : v }))

  const heading  = title   || om?.title || 'Offering Memorandum'
  const sizeHint = om?.size ? `PDF · ${formatSize(om.size)}` : (om ? 'PDF' : 'Financials · Documents · Updates')

  const send = async (fields) => {
    setStatus('submitting'); setTopError(null)
    try {
      const res = await onUnlock({
        name: fields.name.trim(), phone: fields.phone.trim(), email: fields.email.trim(),
        mailing_address: String(fields.mailing_address || '').trim(),
        buyer_role: fields.buyer_role || undefined,
        is_1031: fields.is_1031 === 'yes' ? true : fields.is_1031 === 'no' ? false : undefined,
      })
      saveIdentity({
        name: fields.name.trim(), phone: fields.phone.trim(), email: fields.email.trim(),
        mailing_address: String(fields.mailing_address || '').trim(),
      })
      if (res?.nda_required) {
        setNda({ mailing_id: res.mailing_id, access_token: res.access_token, nda: res.nda, visitor: res.visitor })
        setStatus('nda')
        return
      }
      setGrant(res || {})
      setStatus('done')
      if (res?.url) openDownload(res)
    } catch (err) {
      setStatus('error')
      setTopError(err?.message || "We couldn't prepare the download. Please try again.")
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    const next = {}
    if (form.name.trim().length < 2) next.name  = 'Please enter your full name'
    if (digits(form.phone) < 10)     next.phone = 'A phone number with area code, please'
    if (!isEmail(form.email))        next.email = "That doesn't look like an email address"
    setErrors(next)
    if (Object.keys(next).length) return
    send(form)
  }

  const panel = {
    borderRadius: 4,
    padding: 22,
    border: dark ? '1px solid #2f2f2f' : '1px solid var(--lx-line, #e5e2da)',
    background: dark ? '#181818' : '#fff',
    boxShadow: 'none',
  }
  const inkStrong = dark ? '#f3f0e6' : 'var(--lx-ink, #1e2642)'
  const inkSoft   = dark ? '#8c8c84' : 'var(--lx-mist, #7b8393)'
  const inkBody   = dark ? '#bdbcb4' : 'var(--lx-ink-2, #4a5163)'

  const chip = (selected) => ({
    padding: '7px 12px', borderRadius: 3, fontSize: 12.5, cursor: 'pointer', fontWeight: 600,
    border: `1px solid ${selected ? accent : (dark ? '#3a3a3a' : 'var(--lx-line, #e5e2da)')}`,
    background: selected ? `${accent}22` : 'transparent',
    color: selected ? inkStrong : inkBody,
  })
  const onAccent = readableOn(accent)
  const primaryBtn = {
    padding: '13px 16px', borderRadius: 3, border: 'none', cursor: 'pointer',
    fontWeight: 600, fontSize: 13, letterSpacing: '.04em', background: accent, color: onAccent,
    opacity: status === 'submitting' ? 0.7 : 1, width: '100%',
  }
  const submitText = status === 'submitting' ? 'Opening…' : (ctaLabel || 'Get the OM')

  const ndaSigned = (res) => {
    setNda(null)
    setGrant(res || {})
    setStatus('done')
    if (res?.url) openDownload(res)
    onNdaSigned?.(res)
  }

  return (
    <section id={id} style={panel} aria-labelledby="om-gate-heading">
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{
          width: 38, height: 38, flexShrink: 0, display: 'grid', placeItems: 'center',
          color: accent, border: `1px solid ${accent}66`, borderRadius: 3,
        }}><LineIcon name={status === 'done' ? 'unlock' : 'lock'} size={18} /></div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10.5, letterSpacing: 1.6, textTransform: 'uppercase', color: accent, marginBottom: 4 }}>
            {status === 'done' ? 'Unlocked' : status === 'nda' ? 'Step 2 of 2 · Sign the NDA' : 'Instant access'}
          </div>
          <h2 id="om-gate-heading" className="lx-serif"
              style={{ fontFamily: 'Cormorant Garamond, serif', fontSize: 22, fontWeight: 600,
                       margin: 0, color: inkStrong, lineHeight: 1.2 }}>
            {status === 'nda' ? (nda?.nda?.title || 'Confidentiality Agreement') : heading}
          </h2>
          <div style={{ fontSize: 11.5, color: inkSoft, marginTop: 3 }}>{sizeHint}</div>
        </div>
      </div>

      {status === 'nda' && nda ? (
        <NdaStep pending={nda} accent={accent} dark={dark} primaryBtn={primaryBtn} onSigned={ndaSigned} />
      ) : status === 'done' && grant ? (
        <div style={{ marginTop: 16 }} role="status">
          {grant.url ? (
            <>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, color: inkBody, margin: '0 0 14px' }}>
                Your download has started. If nothing happened, use the button below.
              </p>
              <a href={grant.url} download={grant.filename} target="_blank" rel="noopener noreferrer"
                 onClick={(e) => { e.preventDefault(); openDownload(grant) }}
                 style={{
                   display: 'block', textAlign: 'center', textDecoration: 'none',
                   padding: '13px 16px', borderRadius: 3, fontWeight: 600, fontSize: 13,
                   background: accent, color: onAccent,
                 }}>
                Download the {heading}
              </a>
              <p style={{ fontSize: 11, color: inkSoft, textAlign: 'center', margin: '10px 0 0' }}>
                This link expires shortly — download it now and keep the file.
              </p>
            </>
          ) : (
            <p style={{ fontSize: 13.5, lineHeight: 1.6, color: inkBody, margin: 0 }}>
              You're in. Everything is open below.
            </p>
          )}
          {grant.nda_copy_url && (
            <p style={{ fontSize: 12, textAlign: 'center', margin: '12px 0 0' }}>
              <a href={grant.nda_copy_url} target="_blank" rel="noopener noreferrer" style={{ color: accent }}>
                Download your signed NDA
              </a>
            </p>
          )}
        </div>
      ) : known ? (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: inkBody, margin: '0 0 14px' }}>
            {subtext || 'Full financials, rent roll and photos — instantly.'}
          </p>
          <div aria-live="polite">
            {topError && <div role="alert" style={{ fontSize: 12, color: '#e57373', marginBottom: 8 }}>{topError}</div>}
          </div>
          <button type="button" style={primaryBtn} disabled={status === 'submitting'}
                  aria-busy={status === 'submitting' || undefined}
                  onClick={() => send({ ...known, buyer_role: '', is_1031: '' })}>
            {status === 'submitting' ? 'Opening…' : `Continue as ${known.name.split(/\s+/)[0]}`}
          </button>
          <p style={{ fontSize: 11.5, color: inkSoft, textAlign: 'center', margin: '10px 0 0' }}>
            {known.email} ·{' '}
            <button type="button" onClick={() => { forgetIdentity(); setKnown(null) }}
                    style={{ background: 'none', border: 0, padding: 0, color: accent, cursor: 'pointer', fontSize: 11.5, textDecoration: 'underline' }}>
              Not you?
            </button>
          </p>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: inkBody, margin: '14px 0 16px' }}>
            {subtext || 'Full financials, rent roll and photos. Tell us where to send it and it downloads immediately.'}
          </p>
          <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <GateField label="Full name *" error={errors.name} dark={dark} accent={accent}
                       value={form.name} onChange={set('name')} autoComplete="name" placeholder="Jane Investor" />
            <GateField label="Phone *" error={errors.phone} dark={dark} accent={accent} type="tel"
                       value={form.phone} onChange={set('phone')} autoComplete="tel" placeholder="(515) 555-0134" />
            <GateField label="Email *" error={errors.email} dark={dark} accent={accent} type="email"
                       value={form.email} onChange={set('email')} autoComplete="email" placeholder="jane@company.com" />
            <GateField label="Mailing address (optional)" dark={dark} accent={accent}
                       value={form.mailing_address} onChange={set('mailing_address')}
                       autoComplete="street-address" placeholder="123 Main St, Des Moines, IA 50309" />
            {qualifiers && (
              <>
                <fieldset style={{ border: 0, padding: 0, margin: '2px 0 0' }}>
                  <legend style={{ fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: inkSoft, fontWeight: 600, marginBottom: 6 }}>
                    I am a (optional)
                  </legend>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {ROLES.map(r => (
                      <button key={r.value} type="button" aria-pressed={form.buyer_role === r.value}
                              style={chip(form.buyer_role === r.value)} onClick={() => pick('buyer_role', r.value)}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset style={{ border: 0, padding: 0, margin: '2px 0 0' }}>
                  <legend style={{ fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: inkSoft, fontWeight: 600, marginBottom: 6 }}>
                    In a 1031 exchange? (optional)
                  </legend>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {[['yes', 'Yes'], ['no', 'No']].map(([v, l]) => (
                      <button key={v} type="button" aria-pressed={form.is_1031 === v}
                              style={chip(form.is_1031 === v)} onClick={() => pick('is_1031', v)}>{l}</button>
                    ))}
                  </div>
                </fieldset>
              </>
            )}
            <div aria-live="polite">
              {topError && (
                <div role="alert" style={{ fontSize: 12, color: '#e57373', marginBottom: 2 }}>{topError}</div>
              )}
            </div>
            <button type="submit" disabled={status === 'submitting'} aria-busy={status === 'submitting' || undefined}
                    style={primaryBtn}>
              {submitText}
            </button>
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
export function openDownload({ url, filename }) {
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
               borderRadius: 3, outline: 'none',
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

/**
 * Dark ink on a light accent (the default gold), white on a dark one (navy):
 * the old fixed near-black label vanished on every navy-accented page.
 */
export function readableOn(hex) {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return '#15130f'
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1]
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.4 ? '#15130f' : '#ffffff'
}

function formatSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}
