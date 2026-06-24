import React, { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, pushToast } from '../../components/UI.jsx'
import { DEFAULT_KEY_DATE_TYPES } from './checklistConstants.js'

// Urgency: returns 'urgent' (≤1d), 'warning' (2-3d), 'ok' (4-7d), null (>7d or past)
function dateUrgency(dateStr) {
  if (!dateStr) return null
  const days = Math.ceil((new Date(dateStr + 'T00:00:00') - new Date().setHours(0, 0, 0, 0)) / 86400000)
  if (days < 0) return null
  if (days <= 1) return 'urgent'
  if (days <= 3) return 'warning'
  if (days <= 7) return 'ok'
  return null
}

const URGENCY_COLORS = { urgent: 'var(--gw-red)', warning: 'var(--gw-amber)', ok: 'var(--gw-green)' }

export default function KeyDatesTab({ deal }) {
  const [dates, setDates]         = useState([])
  const [saving, setSaving]       = useState(false)
  const [newType, setNewType]     = useState('')
  const [customType, setCustomType] = useState('')
  const [showCustom, setShowCustom] = useState(false)
  const [sentReminders, setSentReminders] = useState([])   // [{date_type, threshold}]
  const [testSending, setTestSending]     = useState(false)

  React.useEffect(() => {
    if (!deal?.id) return
    // Always fetch fresh from DB so custom dates survive tab switches
    supabase.from('deals').select('comp_data').eq('id', deal.id).single()
      .then(({ data }) => {
        const existing = data?.comp_data?.key_dates
        if (existing && existing.length > 0) {
          setDates(existing)
        } else {
          setDates(DEFAULT_KEY_DATE_TYPES.map(type => ({ type, date: '' })))
        }
      })
    // Load sent reminders for this deal
    supabase.from('deadline_reminders').select('date_type, threshold').eq('deal_id', deal.id)
      .then(({ data }) => setSentReminders(data || []))
  }, [deal?.id])

  const sendTestReminder = async () => {
    setTestSending(true)
    try {
      const resp = await fetch('/api/cron?task=reminders&secret=' + encodeURIComponent(window.__gwCronSecret || ''))
      const data = await resp.json()
      pushToast(`Test run: ${data.sent || 0} sent, ${data.skipped || 0} skipped`)
      // Refresh sent status
      const { data: fresh } = await supabase.from('deadline_reminders').select('date_type, threshold').eq('deal_id', deal.id)
      setSentReminders(fresh || [])
    } catch (e) {
      pushToast('Could not run reminders: ' + e.message, 'error')
    } finally {
      setTestSending(false)
    }
  }

  const persist = async (updated) => {
    setSaving(true)
    const comp_data = { ...(deal.comp_data || {}), key_dates: updated }
    await supabase.from('deals').update({ comp_data, updated_at: new Date().toISOString() }).eq('id', deal.id)
    setSaving(false)
  }

  const updateDate = (i, date) => {
    const updated = dates.map((d, idx) => idx === i ? { ...d, date } : d)
    setDates(updated)
    persist(updated)
  }

  const addRow = (type) => {
    const t = type.trim()
    if (!t || dates.some(d => d.type.toLowerCase() === t.toLowerCase())) return
    const updated = [...dates, { type: t, date: '' }]
    setDates(updated)
    persist(updated)
    setNewType(''); setCustomType(''); setShowCustom(false)
  }

  const removeRow = (i) => {
    const updated = dates.filter((_, idx) => idx !== i)
    setDates(updated)
    persist(updated)
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
