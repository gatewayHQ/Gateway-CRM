// Deal drawer → Key Dates tab: closing, contingencies and other deadlines.

import React, { useState } from 'react'
import { fetchDealCompData, updateDeal } from '../../lib/services/dealRecords.js'
import { Icon, pushToast } from '../../components/UI.jsx'
import { getAuthSession } from '../../lib/services/auth.js'
import { fetchDealSentReminders } from '../../lib/services/deadlineReminders.js'

const DEFAULT_KEY_DATE_TYPES = ['Closing','Expiration','Financing Contingency','Inspection','HUD Approval','Appraisal','Lease Start Date','Possession Date']

// Urgency: returns 'urgent' (≤1d), 'warning' (2-3d), 'ok' (4-7d), null (>7d or past)
function dateUrgency(dateStr) {
  if (!dateStr) return null
  const days = Math.ceil((new Date(dateStr + 'T00:00:00') - new Date().setHours(0,0,0,0)) / 86400000)
  if (days < 0) return null
  if (days <= 1) return 'urgent'
  if (days <= 3) return 'warning'
  if (days <= 7) return 'ok'
  return null
}

const URGENCY_COLORS = { urgent: 'var(--gw-red)', warning: 'var(--gw-amber)', ok: 'var(--gw-green)' }

// ── Why saving a key date waits ──────────────────────────────────────────────
// A native <input type="date"> fires onChange for every VALID intermediate
// value it passes through, and a year typed digit by digit is four of them:
// 0002, then 0020, then 0202, then 2026. Saving and syncing on each one meant
// four writes to the agent's Outlook calendar for one date — three of them for
// a date two millennia in the past, which Outlook answers by firing the
// reminder immediately. Do that across the several dates on a deal and one
// inspection becomes a screenful of alerts.
//
// Two guards, and they are separate problems: the debounce collapses a burst
// into the LAST value, and the year check means a half-typed date never leaves
// the browser at all.
const SAVE_DEBOUNCE_MS = 700

// Empty is a real answer — it clears the date. Anything else has to be a date
// a person could have meant. Exported for its own test: this is the guard
// between a half-typed year and somebody's calendar.
export function plausibleKeyDate(value) {
  if (!value) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const year = Number(value.slice(0, 4))
  return year >= 1900 && year <= 2200
}

export function KeyDatesTab({ deal }) {
  const [dates, setDates]         = useState([])
  const [saving, setSaving]       = useState(false)
  const [customType, setCustomType] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const [sentReminders, setSentReminders] = useState([])   // [{date_type, threshold}]
  const [testSending, setTestSending]     = useState(false)

  React.useEffect(() => {
    if (!deal?.id) return
    // Always fetch fresh from DB so custom dates survive tab switches
    fetchDealCompData(deal.id)
      .then(({ data }) => {
        const existing = data?.comp_data?.key_dates
        if (existing && existing.length > 0) {
          setDates(existing)
        } else {
          setDates(DEFAULT_KEY_DATE_TYPES.map(type => ({ type, date: '' })))
        }
      })
    // Load sent reminders for this deal
    fetchDealSentReminders(deal.id)
      .then(({ data }) => setSentReminders(data || []))
  }, [deal?.id])

  const sendTestReminder = async () => {
    setTestSending(true)
    try {
      const resp = await fetch('/api/cron?task=reminders&secret=' + encodeURIComponent(window.__gwCronSecret || ''))
      const data = await resp.json()
      pushToast(`Test run: ${data.sent || 0} sent, ${data.skipped || 0} skipped`)
      // Refresh sent status
      const { data: fresh } = await fetchDealSentReminders(deal.id)
      setSentReminders(fresh || [])
    } catch (e) {
      pushToast('Could not run reminders: ' + e.message, 'error')
    } finally {
      setTestSending(false)
    }
  }

  const saveTimer  = React.useRef(null)
  const pendingRef = React.useRef(null)   // the rows a scheduled save will write
  const persistRef = React.useRef(null)   // latest persist, for the unmount flush
  const syncingRef = React.useRef(false)  // a sync is in flight right now
  const resyncRef  = React.useRef(false)  // …and another was asked for while it ran

  const persist = async (updated) => {
    setSaving(true)
    const comp_data = { ...(deal.comp_data || {}), key_dates: updated }
    await updateDeal(deal.id, { comp_data, updated_at: new Date().toISOString() })
    setSaving(false)
    syncOutlookCalendar(deal.id)
  }
  persistRef.current = persist

  // Collapse a burst of edits into one save. `immediate` is for the discrete
  // actions — adding or removing a row — where there is no burst coming and the
  // wait would only read as lag.
  const schedulePersist = (updated, { immediate = false } = {}) => {
    pendingRef.current = updated
    clearTimeout(saveTimer.current)
    setSaving(true)          // an edit is owed a write; don't claim "auto-saved" yet
    const run = () => {
      const next = pendingRef.current
      pendingRef.current = null
      if (next) persist(next)
      else setSaving(false)
    }
    if (immediate) run()
    else saveTimer.current = setTimeout(run, SAVE_DEBOUNCE_MS)
  }

  // A pending edit must not die with a tab switch — the label above says the
  // change is saved, so it has to be.
  React.useEffect(() => () => {
    clearTimeout(saveTimer.current)
    const next = pendingRef.current
    pendingRef.current = null
    if (next) persistRef.current?.(next)
  }, [])

  // Best-effort, fire-and-forget: push the updated key dates onto the
  // assigned agent's Outlook calendar (api/email-send.js?action=outlook-calendar-sync).
  // Silently a no-op if Outlook isn't connected, or if the viewer isn't the
  // deal's assigned agent (only they may write to their own calendar) — either
  // way this must never block or interrupt the key-dates save itself, which
  // already has its own "Saving…"/"Changes auto-saved" feedback above.
  //
  // ONE AT A TIME. Two of these in flight together both read "this date has no
  // calendar event yet" and both create one; the server now refuses to strand
  // the loser's copy, but the cheaper fix is not to race in the first place. A
  // request that arrives mid-flight is remembered and run once, after — the
  // sync reads the whole deal, so the later run subsumes the earlier one.
  const syncOutlookCalendar = async (dealId) => {
    if (syncingRef.current) { resyncRef.current = true; return }
    syncingRef.current = true
    try {
      const { data: { session } } = await getAuthSession()
      if (!session?.access_token) return
      await fetch('/api/email-send?action=outlook-calendar-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ dealId }),
      })
    } catch {
      // best-effort — nightly api/cron.js?task=calendar-sync is the safety net
    } finally {
      syncingRef.current = false
      if (resyncRef.current) { resyncRef.current = false; syncOutlookCalendar(dealId) }
    }
  }

  const updateDate = (i, date) => {
    const updated = dates.map((d, idx) => idx === i ? { ...d, date } : d)
    setDates(updated)
    // A year still being typed stays in the box and goes no further. Once it is
    // a date a person could have meant, the debounce above takes it.
    if (!plausibleKeyDate(date)) return
    schedulePersist(updated)
  }

  const addRow = (type) => {
    const t = type.trim()
    if (!t || dates.some(d => d.type.toLowerCase() === t.toLowerCase())) return
    const updated = [...dates, { type: t, date: '' }]
    setDates(updated)
    schedulePersist(updated, { immediate: true })
    setCustomType(''); setShowCustom(false)
  }

  const removeRow = (i) => {
    const updated = dates.filter((_, idx) => idx !== i)
    setDates(updated)
    schedulePersist(updated, { immediate: true })
  }

  const usedTypes = new Set(dates.map(d => d.type))
  const availableTypes = DEFAULT_KEY_DATE_TYPES.filter(t => !usedTypes.has(t))

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>{saving ? 'Saving…' : 'Changes auto-saved'}</div>
        <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={sendTestReminder} disabled={testSending}>
          <Icon name="send" size={11} /> {testSending ? 'Checking…' : 'Run Reminders'}
        </button>
      </div>

      {dates.map((row, i) => {
        const urgency = dateUrgency(row.date)
        const thresholdsSent = sentReminders.filter(r => r.date_type === row.type).map(r => r.threshold)
        return (
          <div key={row.type} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {urgency && <div style={{ width: 6, height: 6, borderRadius: '50%', background: URGENCY_COLORS[urgency], flexShrink: 0 }} />}
              {!urgency && <div style={{ width: 6, flexShrink: 0 }} />}
              <div style={{ flex: '0 0 148px', fontSize: 13, fontWeight: 600, color: urgency ? URGENCY_COLORS[urgency] : 'var(--gw-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {row.type}
              </div>
              <input
                type="date"
                className="form-control"
                style={{ flex: 1, fontSize: 13 }}
                value={row.date || ''}
                onChange={e => updateDate(i, e.target.value)}
              />
              <button className="btn btn--ghost btn--icon btn--sm" title="Remove" onClick={() => removeRow(i)} style={{ opacity: 0.5 }}>
                <Icon name="x" size={12} />
              </button>
            </div>
            {thresholdsSent.length > 0 && (
              <div style={{ marginLeft: 22, marginTop: 3, display: 'flex', gap: 4 }}>
                {thresholdsSent.map(t => (
                  <span key={t} style={{ fontSize: 9, fontWeight: 700, background: 'var(--gw-green-light)', color: 'var(--gw-green)', padding: '1px 6px', borderRadius: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {t} ✓
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {/* Add date row */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--gw-border)', paddingTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--gw-mist)', marginBottom: 8 }}>Add Date</div>
        {!showCustom ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {availableTypes.map(t => (
              <button key={t} className="btn btn--secondary btn--sm" style={{ fontSize: 11 }} onClick={() => addRow(t)}>
                + {t}
              </button>
            ))}
            <button className="btn btn--secondary btn--sm" style={{ fontSize: 11 }} onClick={() => setShowCustom(true)}>
              + Custom…
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="form-control"
              style={{ flex: 1, fontSize: 13 }}
              placeholder="Date type name…"
              value={customType}
              onChange={e => setCustomType(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addRow(customType)}
              autoFocus
            />
            <button className="btn btn--primary btn--sm" onClick={() => addRow(customType)} disabled={!customType.trim()}>Add</button>
            <button className="btn btn--secondary btn--sm" onClick={() => { setShowCustom(false); setCustomType('') }}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  )
}
