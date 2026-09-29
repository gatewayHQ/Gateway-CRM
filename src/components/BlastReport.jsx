// ─────────────────────────────────────────────────────────────────────────────
// BlastReport — what happened after a mass email went out.
//
// WHY THIS EXISTS. A send can now reach addresses that are deliberately NOT
// contacts (a pasted county roll, migration 0048). Those recipients have no
// contact record, so they have no timeline and no Emails tab — the recipient
// row is their entire history. Without a screen that reads those rows, opens,
// replies and opt-outs for most of a 122-person send would be data the CRM
// collected and nobody could see.
//
// Reads straight from Supabase rather than through an API action: the select
// policies on email_blasts and email_blast_recipients already scope a blast to
// its agent, their sharing team and admins (migration 0039), so a second
// server-side gate would be a copy of a rule that is already enforced where it
// can't be bypassed.
//
// "FAILED" HAS TWO HALVES. A message Microsoft refused is 'failed' the moment
// it is sent. A message Microsoft accepted and the receiving server later
// rejected comes back as a bounce notice in the agent's inbox, which the inbox
// sync reads (api/_lib/bounces.js, migration 0059). Both are "didn't arrive",
// and the recipient filter below puts them in one list so an agent can see
// exactly who to follow up with another way.
//
// ON OPEN RATES, SAID OUT LOUD IN THE UI. Outlook and Gmail block or proxy
// remote images by default, and some proxies fetch the pixel on delivery
// whether or not a human looked. A recorded open is weak evidence somebody
// read it; a missing open is no evidence at all. Presenting the number without
// that caveat would invite an agent to conclude a send flopped when it didn't,
// so the caveat ships next to the number rather than in documentation nobody
// opens.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Badge, EmptyState, Icon, pushToast } from './UI.jsx'
import { announcementHeader } from '../lib/dealAnnouncement.js'

const card = {
  border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)',
  background: '#fff', padding: 16, marginBottom: 14,
}

const RECENT_LIMIT = 25

const RECIPIENT_COLS = 'id, email, first_name, last_name, status, source, skip_reason, error_message, sent_at, first_opened_at, open_count, replied_at, reply_subject, unsubscribed_at'
const BOUNCE_COLS    = 'bounced_at, bounce_reason, bounce_permanent'

// The recipient list's filter chips. `didntArrive` is the one an agent needs
// after a send: everyone who has to be reached some other way.
const FILTERS = [
  { key: 'all',         label: 'Everyone',       test: () => true },
  { key: 'opened',      label: 'Opened',         test: r => Boolean(r.first_opened_at) },
  { key: 'replied',     label: 'Replied',        test: r => Boolean(r.replied_at) },
  { key: 'didntArrive', label: "Didn't arrive",  test: r => r.status === 'failed' || Boolean(r.bounced_at) },
  { key: 'skipped',     label: 'Skipped',        test: r => r.status === 'skipped' },
]

async function authedPost(action, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`/api/email-send?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`)
  return data
}

const fmtDate = (iso) => {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  } catch { return '' }
}

/** Percentage of a base, or null when the base is zero — never "0% of 0". */
const pct = (n, base) => (base > 0 ? Math.round((n / base) * 100) : null)

const badgeVariant = (status) =>
  status === 'sent' ? 'closed' : status === 'failed' ? 'cold' : status === 'cancelled' ? 'cold' : 'active'

export default function BlastReport({ activeAgent }) {
  const [blasts, setBlasts]   = useState(null)   // null = loading
  const [error, setError]     = useState('')
  const [openId, setOpenId]   = useState(null)
  const [rows, setRows]       = useState({})     // blastId -> recipient rows
  const [loadingRows, setLoadingRows] = useState(false)
  const [filter, setFilter]   = useState('all')
  const [checking, setChecking] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let live = true
    ;(async () => {
      const { data, error: err } = await supabase
        .from('email_blasts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(RECENT_LIMIT)
      if (!live) return
      if (err) { setError(err.message); setBlasts([]); return }
      setBlasts(data || [])
    })()
    return () => { live = false }
  }, [activeAgent?.id, reloadKey])

  // Runs the same inbox pass as the nightly sync, for this agent, now — the
  // cron only runs once a day, and a bounce from this morning's send is most
  // useful this morning.
  const checkInbox = async () => {
    setChecking(true)
    try {
      const { replies = 0, bounces = 0 } = await authedPost('blast-inbox-refresh')
      pushToast(replies || bounces
        ? `Found ${replies} new repl${replies === 1 ? 'y' : 'ies'} and ${bounces} bounce${bounces === 1 ? '' : 's'}`
        : 'Inbox checked — nothing new since the last check')
      setRows({})
      setOpenId(null)
      setReloadKey(k => k + 1)
    } catch (err) {
      pushToast(err.message, 'error')
    }
    setChecking(false)
  }

  const toggle = async (blast) => {
    if (openId === blast.id) { setOpenId(null); return }
    setOpenId(blast.id)
    setFilter('all')
    if (rows[blast.id]) return
    setLoadingRows(true)
    const read = (cols) => supabase
      .from('email_blast_recipients')
      .select(cols)
      .eq('blast_id', blast.id)
      .order('status', { ascending: true })
    // The bounce columns arrive with migration 0059; until then the report
    // reads everything else rather than failing outright.
    let { data, error: err } = await read(`${RECIPIENT_COLS}, ${BOUNCE_COLS}`)
    if (err) ({ data, error: err } = await read(RECIPIENT_COLS))
    setLoadingRows(false)
    if (err) { setError(err.message); return }
    setRows(r => ({ ...r, [blast.id]: data || [] }))
  }

  if (blasts === null) {
    return <div style={{ ...card, color: 'var(--gw-mist)', fontSize: 13 }}>Loading past sends…</div>
  }

  if (error && blasts.length === 0) {
    return (
      <div style={{ ...card, fontSize: 13, color: '#b91c1c' }}>
        Could not load past sends: {error}
      </div>
    )
  }

  if (blasts.length === 0) {
    return (
      <EmptyState icon="mail" title="No sends yet"
        message="Once you send an announcement, it shows up here with who opened it, who replied and who opted out." />
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220, fontSize: 12.5, color: 'var(--gw-mist)' }}>
          Replies and bounces are picked up from your Outlook inbox every morning.
        </div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={checkInbox} disabled={checking}>
          <Icon name="refresh" size={12} style={{ marginRight: 6 }} />
          {checking ? 'Checking your inbox…' : 'Check for replies & bounces now'}
        </button>
      </div>
      {blasts.map(b => {
        const isOpen    = openId === b.id
        const recipients = rows[b.id] || []
        const sent      = b.sent_count || 0
        const openRate  = pct(b.opened_count || 0, sent)
        const didntArrive = (b.failed_count || 0) + (b.bounced_count || 0)
        const active    = FILTERS.find(f => f.key === filter) || FILTERS[0]
        const shown     = recipients.filter(active.test)

        return (
          <div key={b.id} style={card}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <Badge variant={badgeVariant(b.status)}>{b.status}</Badge>
              <div style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 200 }}>
                {titleOf(b)}
              </div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>
                {fmtDate(b.completed_at || b.started_at || b.created_at)}
              </div>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => toggle(b)}>
                {isOpen ? 'Hide recipients' : 'Recipients'}
              </button>
            </div>

            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12 }}>
              <Metric label="Sent" value={sent} />
              <Metric label="Opened" value={b.opened_count || 0}
                      sub={openRate === null ? '' : `${openRate}% of sent`} />
              <Metric label="Replied" value={b.replied_count || 0} />
              <Metric label="Unsubscribed" value={b.unsubscribed_count || 0} />
              {b.failed_count > 0  && <Metric label="Failed"  value={b.failed_count} tone="#b91c1c"
                                              sub="Microsoft refused it" />}
              {b.bounced_count > 0 && <Metric label="Bounced" value={b.bounced_count} tone="#b91c1c"
                                              sub="Rejected on arrival" />}
              {b.skipped_count > 0 && <Metric label="Skipped" value={b.skipped_count} />}
            </div>

            {(b.list_recipient_count > 0 || b.list_source) && (
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 10 }}>
                {b.list_recipient_count} of these came from{' '}
                <strong style={{ color: 'var(--gw-slate)' }}>{b.list_source || 'a pasted list'}</strong>{' '}
                and are not contacts — this report is the only record of how they responded.
              </div>
            )}

            {(b.opened_count > 0 || sent > 0) && (
              <div style={{ fontSize: 11.5, color: 'var(--gw-mist)', marginTop: 8, lineHeight: 1.5 }}>
                Opens are measured with a tracking image. Most mail apps block those by default, so a
                recorded open is real but a missing one tells you nothing — read this number as a floor,
                never as a read receipt.
              </div>
            )}

            {didntArrive > 0 && (
              <button type="button" onClick={() => { if (!isOpen) toggle(b); setFilter('didntArrive') }}
                style={{
                  marginTop: 10, padding: '6px 10px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer',
                  border: '1px solid #fecaca', background: '#fef2f2', color: '#991b1b', fontFamily: 'var(--font-body)',
                }}>
                {didntArrive} {didntArrive === 1 ? 'person' : 'people'} didn't get this email — see who
              </button>
            )}

            {b.last_error && (
              <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 8 }}>{b.last_error}</div>
            )}

            {isOpen && (
              <div style={{ marginTop: 12 }}>
                {loadingRows && recipients.length === 0 && (
                  <div style={{ fontSize: 12.5, color: 'var(--gw-mist)' }}>Loading recipients…</div>
                )}
                {recipients.length > 0 && (
                  <>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                      {FILTERS.map(f => {
                        const n  = recipients.filter(f.test).length
                        const on = f.key === filter
                        return (
                          <button key={f.key} type="button" onClick={() => setFilter(f.key)}
                            style={{
                              padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
                              fontFamily: 'var(--font-body)',
                              border: `1px solid ${on ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                              background: on ? 'var(--gw-azure)' : '#fff',
                              color: on ? '#fff' : n === 0 ? 'var(--gw-mist)' : 'var(--gw-slate)',
                            }}>
                            {f.label} · {n}
                          </button>
                        )
                      })}
                    </div>
                    <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)' }}>
                      {shown.map(r => <RecipientRow key={r.id} r={r} />)}
                      {shown.length === 0 && (
                        <div style={{ padding: 12, fontSize: 12.5, color: 'var(--gw-mist)' }}>Nobody in this group.</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// "Market Update — Market Update from Daniel" says it twice; the header only
// prefixes a subject that doesn't already carry it.
function titleOf(b) {
  const header = b.deal_status ? announcementHeader(b.deal_status, b.custom_header) : ''
  const subject = b.subject || ''
  if (!header || subject.toLowerCase().includes(header.toLowerCase())) return subject
  return `${header} — ${subject}`
}

function Metric({ label, value, sub = '', tone }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--gw-mist)' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2, color: tone || 'var(--gw-slate)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{sub}</div>}
    </div>
  )
}

function RecipientRow({ r }) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ')
  // What happened to this one person, most consequential first: an opt-out
  // outranks an open, because it is the thing that changes what the agent may
  // do next.
  const marks = [
    r.status === 'failed' && { text: 'Failed to send', color: '#b91c1c' },
    r.bounced_at      && { text: `Bounced — ${r.bounce_reason || 'not delivered'}`, color: '#b91c1c' },
    r.status === 'skipped' && { text: 'Skipped', color: 'var(--gw-mist)' },
    r.unsubscribed_at && { text: 'Unsubscribed', color: '#b91c1c' },
    r.replied_at      && { text: r.reply_subject ? `Replied — "${r.reply_subject}"` : 'Replied', color: '#0f766e' },
    r.first_opened_at && { text: r.open_count > 1 ? `Opened ×${r.open_count}` : 'Opened', color: 'var(--gw-azure)' },
  ].filter(Boolean)

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
      borderBottom: '1px solid var(--gw-border)', fontSize: 12.5,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {name || r.email}
          {r.source === 'list' && (
            <span style={{
              fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, padding: '1px 5px', borderRadius: 3,
              background: 'var(--gw-bone)', color: 'var(--gw-mist)', border: '1px solid var(--gw-border)',
            }}>FROM LIST</span>
          )}
        </div>
        <div title={r.error_message || r.skip_reason || ''}
          style={{ color: 'var(--gw-mist)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.email}
          {r.skip_reason    ? ` · skipped: ${r.skip_reason}` : ''}
          {r.error_message  ? ` · failed: ${r.error_message}` : ''}
          {r.bounced_at && r.bounce_permanent ? ' · removed from future sends' : ''}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
        {marks.length === 0 && (
          <span style={{ fontSize: 11.5, color: 'var(--gw-mist)' }}>{r.status}</span>
        )}
        {marks.map(m => (
          <span key={m.text} style={{ fontSize: 11, fontWeight: 600, color: m.color }}>{m.text}</span>
        ))}
      </div>
    </div>
  )
}
