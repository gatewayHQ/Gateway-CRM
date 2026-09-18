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
import { Badge, EmptyState } from './UI.jsx'
import { statusLabel } from '../lib/dealAnnouncement.js'

const card = {
  border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)',
  background: '#fff', padding: 16, marginBottom: 14,
}

const RECENT_LIMIT = 25

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
  }, [activeAgent?.id])

  const toggle = async (blast) => {
    if (openId === blast.id) { setOpenId(null); return }
    setOpenId(blast.id)
    if (rows[blast.id]) return
    setLoadingRows(true)
    const { data, error: err } = await supabase
      .from('email_blast_recipients')
      .select('id, email, first_name, last_name, status, source, skip_reason, error_message, sent_at, first_opened_at, open_count, replied_at, reply_subject, unsubscribed_at')
      .eq('blast_id', blast.id)
      .order('status', { ascending: true })
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
      {blasts.map(b => {
        const isOpen    = openId === b.id
        const recipients = rows[b.id] || []
        const sent      = b.sent_count || 0
        const openRate  = pct(b.opened_count || 0, sent)

        return (
          <div key={b.id} style={card}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <Badge variant={badgeVariant(b.status)}>{b.status}</Badge>
              <div style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 200 }}>
                {b.deal_status ? `${statusLabel(b.deal_status)} — ` : ''}{b.subject}
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
              {b.failed_count > 0  && <Metric label="Failed"  value={b.failed_count} tone="#b91c1c" />}
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

            {b.last_error && (
              <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 8 }}>{b.last_error}</div>
            )}

            {isOpen && (
              <div style={{ marginTop: 12 }}>
                {loadingRows && recipients.length === 0 && (
                  <div style={{ fontSize: 12.5, color: 'var(--gw-mist)' }}>Loading recipients…</div>
                )}
                {recipients.length > 0 && (
                  <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)' }}>
                    {recipients.map(r => <RecipientRow key={r.id} r={r} />)}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
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
        <div style={{ color: 'var(--gw-mist)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.email}
          {r.skip_reason    ? ` · skipped: ${r.skip_reason}` : ''}
          {r.error_message  ? ` · failed: ${r.error_message}` : ''}
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
