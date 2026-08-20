import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, pushToast } from '../../components/UI.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// Contact "Emails" tab — the actual email correspondence with this contact's
// address, in both directions, plus a compose box to write back.
//
// This is not the Outlook Contacts lookup on the Details tab. That one asks the
// agent's ADDRESS BOOK whether it has an entry for this address (useful for
// filling in a blank phone or company, and legitimately empty for most
// correspondents). This asks the MAILBOX what has actually been exchanged —
// which is what an agent opening a contact record wants to see.
//
// Everything comes from one endpoint (?action=outlook-messages), which mirrors
// Graph into the CRM and reads back from there, so re-opening the tab costs
// nothing until the mirror goes stale. `state` on the response is what drives
// the empty-vs-broken distinction below: an agent deciding whether to follow up
// must never see "no emails" when the truth is "we couldn't ask".
// ─────────────────────────────────────────────────────────────────────────────

const PAGE = 50

const fmtDate = (d) => {
  if (!d) return ''
  const date = new Date(d)
  const now  = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  const days = (now - date) / 86400000
  if (days < 1) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  })
}
const fmtFull = (d) => (d ? new Date(d).toLocaleString('en-US', {
  weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit',
}) : '')

const paragraphsToHtml = (body) => body
  .split(/\n\n+/)
  .map(p => `<p style="margin:0 0 16px 0">${p.replace(/\n/g, '<br>')}</p>`)
  .join('')

function Banner({ tone = 'info', children }) {
  const tones = {
    info:  { bg: 'var(--gw-sky)',   border: 'var(--gw-azure)' },
    warn:  { bg: '#fef3c7',         border: 'var(--gw-amber)' },
    error: { bg: '#fdecea',         border: 'var(--gw-red)' },
  }
  const t = tones[tone] || tones.info
  return (
    <div style={{
      padding: '9px 12px', background: t.bg, border: `1px solid ${t.border}`,
      borderRadius: 'var(--radius)', fontSize: 12, lineHeight: 1.5,
    }}>
      {children}
    </div>
  )
}

export default function EmailsTab({ contact, onEmailSent }) {
  const [loading, setLoading]   = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [payload, setPayload]   = useState(null)   // last response from the endpoint
  const [fetchError, setFetchError] = useState(null)   // network-level failure (the endpoint itself unreachable)
  const [limit, setLimit]       = useState(PAGE)
  const [expanded, setExpanded] = useState(null)

  const [composing, setComposing] = useState(false)
  const [subject, setSubject]     = useState('')
  const [body, setBody]           = useState('')
  const [sending, setSending]     = useState(false)

  const contactId = contact?.id
  const contactEmail = contact?.email || ''

  const load = useCallback(async (intent = 'auto', nextLimit = limit) => {
    if (!contactId) return
    if (intent === 'auto') setLoading(true); else setRefreshing(true)
    setFetchError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) { setFetchError('Please sign in again'); return }
      const res = await fetch('/api/email-send?action=outlook-messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ contactId, intent, limit: nextLimit }),
      })
      const data = await res.json()
      if (!res.ok) { setFetchError(data.error || `Could not load email history (HTTP ${res.status})`); return }
      setPayload(data)
    } catch (err) {
      setFetchError(err.message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [contactId, limit])

  useEffect(() => {
    setPayload(null)
    setLimit(PAGE)
    setExpanded(null)
    setComposing(false)
    if (contactId) load('auto', PAGE)
  }, [contactId])   // eslint-disable-line react-hooks/exhaustive-deps

  const messages = payload?.messages || []
  const state    = payload?.state || null

  // "Load more" means two different things depending on where we are: pull an
  // older page out of the mailbox, or just render more of what's already
  // mirrored. Only the first needs a Graph round trip.
  const renderedAll = messages.length < limit
  const loadMore = () => {
    const next = limit + PAGE
    setLimit(next)
    load(renderedAll && payload?.hasMore ? 'more' : 'auto', next)
  }

  const send = async () => {
    if (!contactEmail) return
    if (!body.trim()) { pushToast('Write something to send', 'error'); return }
    setSending(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/email-send?action=outlook-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({
          to: contactEmail,
          subject: subject.trim() || '(no subject)',
          html: paragraphsToHtml(body),
          text: body,
          contactId,
        }),
      })
      const data = await res.json()
      if (!res.ok) { pushToast(`Send failed: ${data.error || 'Unknown error'}`, 'error'); return }
      pushToast(`Email sent to ${contactEmail}`)
      setSubject(''); setBody(''); setComposing(false)
      onEmailSent?.()
      // The send is already logged server-side; re-pull so the new message
      // appears with its real Sent Items metadata rather than a local stub.
      load('refresh', limit)
    } catch (err) {
      pushToast('Send failed: ' + err.message, 'error')
    } finally {
      setSending(false)
    }
  }

  // ── Guard states ───────────────────────────────────────────────────────────

  if (!contactEmail) {
    return (
      <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--gw-mist)' }}>
        <div style={{ fontSize: 28, marginBottom: 10 }}>✉️</div>
        <div style={{ fontWeight: 600, color: 'var(--gw-ink)', marginBottom: 4 }}>No email address on file</div>
        <div style={{ fontSize: 12 }}>Add one in the Details tab to see correspondence with this contact.</div>
      </div>
    )
  }

  // Withheld until the endpoint has actually confirmed a connection that can
  // send — offering a compose box that fails on Send is worse than a short wait.
  const canSend = !!payload && payload.canSend !== false &&
    state !== 'not-connected' && state !== 'missing-mail-scope'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--gw-border)',
        background: 'var(--gw-bone)', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Icon name="mail" size={13} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contactEmail}</span>
          </div>
          {payload?.mailbox && (
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2 }}>
              via {payload.mailbox}
              {payload.lastSyncedAt && ` · synced ${fmtDate(payload.lastSyncedAt)}`}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => load('refresh', limit)}
            disabled={loading || refreshing}
            title="Check Outlook for new mail with this contact"
          >
            {refreshing ? '…' : 'Refresh'}
          </button>
          {canSend && (
            <button className="btn btn--primary btn--sm" onClick={() => setComposing(c => !c)}>
              {composing ? 'Cancel' : 'New Email'}
            </button>
          )}
        </div>
      </div>

      {/* ── Compose ────────────────────────────────────────────────────────── */}
      {composing && (
        <div style={{
          padding: '12px 16px', borderBottom: '1px solid var(--gw-border)',
          flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>
            To <strong style={{ color: 'var(--gw-ink)' }}>{contactEmail}</strong>
            {payload?.mailbox && <> · from {payload.mailbox}</>}
          </div>
          <input
            className="form-control"
            style={{ fontSize: 13 }}
            placeholder="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={sending}
          />
          <textarea
            className="form-control"
            style={{ fontSize: 13, minHeight: 120, resize: 'vertical', fontFamily: 'var(--font-body)' }}
            placeholder={`Write to ${contact.first_name || 'them'}…`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={sending}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn--secondary btn--sm" onClick={() => setComposing(false)} disabled={sending}>
              Discard
            </button>
            <button className="btn btn--primary btn--sm" onClick={send} disabled={sending || !body.trim()}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}

      {/* ── Status banners ─────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {fetchError && (
            <Banner tone="error">
              <strong>Couldn't load email history.</strong> {fetchError}
            </Banner>
          )}

          {state === 'not-connected' && (
            <Banner tone="warn">
              <strong>Outlook isn't connected.</strong> Connect your Microsoft 365 account
              under <strong>Integrations → Outlook</strong> to see and send email from here.
            </Banner>
          )}

          {state === 'missing-mail-scope' && (
            <Banner tone="warn">
              <strong>Your Outlook connection can't read mail.</strong> It was authorized before
              mail access was requested. Reconnect under <strong>Integrations → Outlook</strong> to
              grant {(payload.requiredScopes || []).join(' and ')}.
            </Banner>
          )}

          {state === 'needs-reconnect' && (
            <Banner tone="warn">
              <strong>Outlook needs to be reconnected.</strong>{' '}
              {payload?.error?.message || 'Microsoft 365 stopped accepting the saved authorization.'}
              {' '}Reconnect under <strong>Integrations → Outlook</strong>.
            </Banner>
          )}

          {state === 'graph-error' && (
            <Banner tone="error">
              <strong>Couldn't reach Outlook just now</strong> — {payload?.error?.message}.
              {messages.length > 0
                ? ' Showing what the CRM already has; it may be missing recent mail.'
                : ' This is a connection problem, not an empty inbox — try Refresh in a moment.'}
            </Banner>
          )}

          {payload?.partial && (
            <Banner tone="info">
              This mailbox wouldn't answer a full-text search, so only mail{' '}
              <strong>from</strong> {contactEmail} could be found. Emails you sent them may be missing.
            </Banner>
          )}

          {payload?.snippets === false && (
            <Banner tone="info">
              Your Outlook connection grants metadata only (Mail.ReadBasic), so subjects and dates
              show but previews don't. Reconnect to grant Mail.Read for previews.
            </Banner>
          )}

          {/* ── The list ─────────────────────────────────────────────────── */}
          {loading ? (
            <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 12, color: 'var(--gw-mist)' }}>
              Loading correspondence…
            </div>
          ) : messages.length === 0 ? (
            // Only claim "no correspondence" when we actually got an answer.
            state === 'ok' ? (
              <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--gw-mist)' }}>
                <div style={{ fontSize: 28, marginBottom: 10 }}>📭</div>
                <div style={{ fontWeight: 600, color: 'var(--gw-ink)', marginBottom: 4 }}>No correspondence yet</div>
                <div style={{ fontSize: 12 }}>
                  Nothing in your mailbox to or from {contactEmail}. Use <strong>New Email</strong> to start the thread.
                </div>
              </div>
            ) : null
          ) : (
            <>
              {messages.map(m => {
                const out  = m.direction === 'outbound'
                const open = expanded === m.id
                return (
                  <div
                    key={m.id}
                    onClick={() => setExpanded(open ? null : m.id)}
                    style={{
                      border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)',
                      padding: '10px 12px', cursor: 'pointer',
                      borderLeft: `3px solid ${out ? 'var(--gw-azure)' : 'var(--gw-green)'}`,
                      background: '#fff',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase',
                        color: out ? 'var(--gw-azure)' : 'var(--gw-green)', flexShrink: 0,
                      }}>
                        {out ? 'Sent' : 'Received'}
                      </span>
                      {m.status === 'failed' && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gw-red)' }}>FAILED</span>
                      )}
                      {m.has_attachments && (
                        <span title="Has attachments" style={{ fontSize: 11, color: 'var(--gw-mist)' }}>📎</span>
                      )}
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--gw-mist)', flexShrink: 0 }}
                            title={fmtFull(m.sent_at)}>
                        {fmtDate(m.sent_at)}
                      </span>
                    </div>
                    <div style={{
                      fontSize: 13, fontWeight: 600, marginBottom: m.body_preview ? 3 : 0,
                      ...(open ? {} : { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }),
                    }}>
                      {m.subject || '(no subject)'}
                    </div>
                    {m.body_preview && (
                      <div style={{
                        fontSize: 12, color: 'var(--gw-mist)', lineHeight: 1.5,
                        ...(open ? {} : {
                          overflow: 'hidden', display: '-webkit-box',
                          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        }),
                      }}>
                        {m.body_preview}
                      </div>
                    )}
                    {open && (
                      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--gw-mist)', lineHeight: 1.6 }}>
                        <div>From: {m.from_name ? `${m.from_name} <${m.from_address || ''}>` : (m.from_address || (out ? payload?.mailbox : contactEmail))}</div>
                        {!!(m.to_recipients || []).length && (
                          <div>To: {m.to_recipients.map(r => r.email).filter(Boolean).join(', ')}</div>
                        )}
                        {!!(m.cc_recipients || []).length && (
                          <div>Cc: {m.cc_recipients.map(r => r.email).filter(Boolean).join(', ')}</div>
                        )}
                        <div>{fmtFull(m.sent_at)}</div>
                        {m.web_link && (
                          <a
                            href={m.web_link} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ display: 'inline-block', marginTop: 6, fontWeight: 600, color: 'var(--gw-azure)' }}
                          >
                            Open in Outlook →
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}

              {(payload?.hasMore || !renderedAll) && (
                <button
                  className="btn btn--secondary btn--sm"
                  onClick={loadMore}
                  disabled={refreshing}
                  style={{ alignSelf: 'center', marginTop: 2 }}
                >
                  {refreshing ? 'Loading…' : 'Load older emails'}
                </button>
              )}

              {payload?.hasMore === false && renderedAll && messages.length > 0 && (
                <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--gw-mist)', paddingTop: 2 }}>
                  That's the full history with this address.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
