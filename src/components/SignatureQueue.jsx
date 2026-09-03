// ─────────────────────────────────────────────────────────────────────────────
// SignatureQueue — every document this agent is waiting on, in one place.
//
// WHY THIS EXISTS. Signature work used to live in exactly one component: the
// Signatures tab inside a deal's drawer. `boldsign_documents` was read nowhere
// else in the app. To learn that a listing agreement sent nine days ago was
// still unsigned, an agent had to remember WHICH deal it was on, open that deal,
// open the drawer, and open the tab — per deal, every morning. Chasing
// signatures is the job; the CRM was making the agent hold the list in their
// head.
//
// This is the list. It is deliberately a dashboard tile and not another nav
// item: it is something an agent glances at on the way to work, not a place
// they go. Every row's real destination is the deal it belongs to.
//
// SCOPE COMES FROM THE DATABASE, NOT FROM HERE. `boldsign_documents` is
// RLS-scoped (own deals + team-shared + co-listed; admins see all), so this
// queries the table plainly and gets exactly the rows this agent may see. The
// partial index `idx_boldsign_docs_awaiting (sent_at) where status in
// ('sent','delivered')` is the index this query was written for.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react'
import { supabase } from '../lib/supabase.js'
import { remindDocument, signerRows, outstandingSigners, waitingOnLabel, signerProgress } from '../lib/services/boldsign.js'
import { Icon, pushToast } from './UI.jsx'

// In flight: the client has it and has not finished with it.
const AWAITING = ['sent', 'delivered']
// Prepared and never sent. These are the ones agents genuinely lose — a send
// interrupted by a screen change leaves a filled, unsent agreement that nothing
// in the app ever mentions again.
const DRAFT = 'draft'

const DAY = 86400000

/** Whole days since a document went out. Null when it hasn't. */
export function daysWaiting(doc, now = Date.now()) {
  const from = doc?.sent_at || doc?.created_at
  if (!from) return null
  const started = new Date(from).getTime()
  if (!Number.isFinite(started)) return null
  return Math.max(0, Math.floor((now - started) / DAY))
}

// How loudly a row reads. Chasing is the job, so age is the only ranking that
// matters and it is encoded in colour as well as in the number — a row that
// needs attention has to be findable without reading every line.
//
// Seven days is not arbitrary: it is when a client has stopped noticing the
// original email, and it is the threshold the nightly sweep already treats as
// stale.
export function urgencyOf(days) {
  if (days == null) return { level: 'new',  color: 'var(--gw-mist)' }
  if (days >= 7)    return { level: 'cold', color: 'var(--gw-red)' }
  if (days >= 3)    return { level: 'warm', color: 'var(--gw-amber)' }
  return { level: 'fresh', color: 'var(--gw-mist)' }
}

/**
 * The queue, ordered the way it should be worked.
 *
 * Awaiting documents first, oldest at the top — that is the chase list, and the
 * oldest one is the one at risk. Drafts follow, newest first, because an unsent
 * draft is a different job (finish it) and the one you just made is the one you
 * meant to come back to.
 */
export function buildQueue(rows = [], now = Date.now()) {
  const awaiting = []
  const drafts   = []
  for (const r of rows) {
    if (AWAITING.includes(r?.status)) awaiting.push({ ...r, days: daysWaiting(r, now) })
    else if (r?.status === DRAFT)     drafts.push({ ...r, days: daysWaiting(r, now) })
  }
  awaiting.sort((a, b) => (b.days ?? -1) - (a.days ?? -1) || String(a.document_name || '').localeCompare(String(b.document_name || '')))
  drafts.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  return { awaiting, drafts }
}

/** "waiting 9 days" / "sent today" — the phrase an agent would actually use. */
export function waitingLabel(days) {
  if (days == null) return 'just sent'
  if (days === 0)   return 'sent today'
  if (days === 1)   return 'waiting 1 day'
  return `waiting ${days} days`
}

// One line naming who still owes a signature — not a list of everyone on the
// document. "waiting on John Doe" is the fact an agent acts on; "Jane Doe, John
// Doe" is the fact they have to decode. See boldsignSigners.js.
export function recipientLine(doc) {
  const rows = signerRows(doc)
  if (!rows.length) return 'no recipients recorded'
  if (doc?.status === 'draft') {
    const names = rows.map(r => r.name || r.email).filter(Boolean)
    return names.length <= 2 ? names.join(' and ') : `${names[0]} and ${names.length - 1} others`
  }
  return waitingOnLabel(rows)
}

const VISIBLE = 6

export default function SignatureQueue({ deals = [], properties = [], go }) {
  const [rows,    setRows]    = React.useState([])
  const [loading, setLoading] = React.useState(true)
  // A database without the table (or without permission) must not blow up the
  // dashboard. The tile simply does not render — see the early return below.
  const [broken,  setBroken]  = React.useState(false)
  const [expanded, setExpanded] = React.useState(false)
  const [reminding, setReminding] = React.useState({})

  const load = React.useCallback(async () => {
    const { data, error } = await supabase
      .from('boldsign_documents')
      .select('id, deal_id, document_id, document_name, signer_name, signers, status, sent_at, created_at, last_reminded_at, reminder_count')
      .in('status', [...AWAITING, DRAFT])
      .order('sent_at', { ascending: true, nullsFirst: false })
      .limit(100)
    if (error) { setBroken(true); setLoading(false); return }
    setBroken(false)
    setRows(data || [])
    setLoading(false)
  }, [])

  React.useEffect(() => {
    load()
    // The webhook flips a status the moment a client signs. Without this the
    // tile is only as fresh as the last page load, and the single most
    // satisfying thing this list does — a row disappearing because someone just
    // signed — would need a refresh to see.
    const channel = supabase.channel('dash-signature-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'boldsign_documents' }, () => load())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

  const { awaiting, drafts } = React.useMemo(() => buildQueue(rows), [rows])

  const dealById = React.useMemo(() => new Map((deals || []).map(d => [d.id, d])), [deals])
  const propById = React.useMemo(() => new Map((properties || []).map(p => [p.id, p])), [properties])

  // What this document is about, in the words the agent filed it under.
  const contextFor = (doc) => {
    const deal = dealById.get(doc.deal_id)
    if (!deal) return ''
    const prop = deal.property_id ? propById.get(deal.property_id) : null
    const addr = prop?.address ? [prop.address, prop.unit].filter(Boolean).join(' ') : ''
    return [deal.title, addr].filter(Boolean).join(' · ')
  }

  const openDocument = (doc) => {
    if (!doc.deal_id) { pushToast('This document is not attached to a deal.', 'info'); return }
    // Straight to the tab it lives on, not just the deal. One click from
    // "somebody owes me a signature" to the row with Remind on it.
    go(`deal/${doc.deal_id}/signatures`)
  }

  const remind = async (doc) => {
    setReminding(p => ({ ...p, [doc.id]: true }))
    try {
      // Only the people who still owe something. Reminding the whole document
      // emails signers who have already finished, which is how a client learns
      // to ignore the next one.
      const pending = outstandingSigners(signerRows(doc)).map(r => r.email).filter(Boolean)
      await remindDocument(doc.document_id, pending)
      const patch = { last_reminded_at: new Date().toISOString(), reminder_count: (doc.reminder_count || 0) + 1 }
      setRows(prev => prev.map(r => (r.id === doc.id ? { ...r, ...patch } : r)))
      pushToast(`Reminder sent — ${recipientLine(doc)}`, 'success')
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setReminding(p => ({ ...p, [doc.id]: false }))
    }
  }

  // Nothing to show and nothing wrong: no tile. A dashboard card that only ever
  // says "none" is noise on every screen of every agent who doesn't use
  // e-signature yet.
  if (broken) return null
  if (!loading && !awaiting.length && !drafts.length) return null

  const stale = awaiting.filter(d => (d.days ?? 0) >= 7).length
  const shown = expanded ? awaiting : awaiting.slice(0, VISIBLE)

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <div className="section-head">
        <div className="section-title">
          Out for Signature
          {awaiting.length > 0 && (
            <span style={{
              marginLeft: 8, background: stale ? 'var(--gw-red)' : 'var(--gw-azure)', color: '#fff',
              borderRadius: 10, fontSize: 10, padding: '2px 7px', fontWeight: 700, verticalAlign: 'middle',
            }}>
              {awaiting.length}
            </span>
          )}
        </div>
        {/* The honest summary, not a restatement of the count. "3 waiting" tells
            an agent nothing they can't see; "1 over a week" tells them where to
            start. */}
        <div style={{ fontSize: 12, color: stale ? 'var(--gw-red)' : 'var(--gw-mist)', fontWeight: stale ? 600 : 400 }}>
          {loading ? 'Loading…'
            : stale ? `${stale} waiting over a week`
            : awaiting.length ? 'all chased recently'
            : 'nothing waiting on a client'}
        </div>
      </div>

      {loading && <div style={{ fontSize: 13, color: 'var(--gw-mist)', padding: '12px 0' }}>Loading…</div>}

      {!loading && awaiting.length === 0 && drafts.length > 0 && (
        <div style={{ fontSize: 13, color: 'var(--gw-green)', padding: '4px 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="check" size={14} /> Nothing is waiting on a client right now.
        </div>
      )}

      {shown.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {shown.map(doc => {
            const urgency = urgencyOf(doc.days)
            const busy = Boolean(reminding[doc.id])
            const context = contextFor(doc)
            return (
              <div
                key={doc.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 10px 10px 12px',
                  borderRadius: 'var(--radius)', border: '1px solid transparent',
                  borderLeft: `3px solid ${urgency.color}`, background: doc.days >= 7 ? '#fff9f8' : 'transparent',
                }}
              >
                <button
                  onClick={() => openDocument(doc)}
                  title="Open this document on its deal"
                  style={{
                    flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none',
                    cursor: 'pointer', padding: 0, font: 'inherit', color: 'var(--gw-ink)',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {doc.document_name || 'Document'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {recipientLine(doc)}
                    {(() => { const p = signerProgress(signerRows(doc)); return p.total > 1 ? ` · ${p.signed}/${p.total} signed` : '' })()}
                    {context ? ` · ${context}` : ''}
                  </div>
                </button>

                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 11.5, color: urgency.color, fontWeight: doc.days >= 3 ? 700 : 500 }}>
                    {waitingLabel(doc.days)}
                  </div>
                  {doc.reminder_count > 0 && (
                    <div style={{ fontSize: 10, color: 'var(--gw-mist)', marginTop: 1 }}>
                      {doc.reminder_count} reminder{doc.reminder_count > 1 ? 's' : ''} sent
                    </div>
                  )}
                </div>

                <button
                  className="btn btn--secondary btn--sm"
                  style={{ fontSize: 11, flexShrink: 0 }}
                  onClick={() => remind(doc)}
                  disabled={busy}
                  title={doc.last_reminded_at
                    ? `Last reminded ${new Date(doc.last_reminded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                    : 'Email whoever still owes a signature'}
                >
                  {busy ? 'Sending…' : 'Remind'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {awaiting.length > VISIBLE && (
        <button
          className="btn btn--link btn--sm"
          style={{ padding: '8px 0 0' }}
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? 'Show fewer' : `Show ${awaiting.length - VISIBLE} more waiting`}
        </button>
      )}

      {/* PREPARED BUT NOT SENT. A different job from chasing — this one is
          "finish what you started" — so it is a separate, quieter block rather
          than more rows in the chase list. These are the documents the CRM used
          to lose entirely. */}
      {drafts.length > 0 && (
        <div style={{ marginTop: awaiting.length ? 14 : 0, paddingTop: awaiting.length ? 12 : 0, borderTop: awaiting.length ? '1px solid var(--gw-border)' : 'none' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--gw-mist)', marginBottom: 8 }}>
            Prepared, not sent ({drafts.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {drafts.slice(0, 4).map(doc => (
              <button
                key={doc.id}
                onClick={() => openDocument(doc)}
                title="Open this draft on its deal"
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px 8px 12px', width: '100%',
                  borderRadius: 'var(--radius)', border: '1px solid transparent', borderLeft: '3px solid var(--gw-amber)',
                  background: 'transparent', cursor: 'pointer', font: 'inherit', textAlign: 'left', color: 'var(--gw-ink)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {doc.document_name || 'Document'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {contextFor(doc) || 'nothing sent yet'}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: 'var(--gw-amber)', fontWeight: 600, flexShrink: 0 }}>Not sent</span>
              </button>
            ))}
          </div>
          {drafts.length > 4 && (
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 6 }}>
              +{drafts.length - 4} more prepared and unsent
            </div>
          )}
        </div>
      )}
    </div>
  )
}
