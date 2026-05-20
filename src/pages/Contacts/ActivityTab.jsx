import React, { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, pushToast } from '../../components/UI.jsx'
import { formatCurrency } from '../../lib/helpers.js'

const ACTIVITY_TYPES  = ['note', 'call', 'email', 'meeting', 'showing']
const ACTIVITY_ICONS  = { note: 'note', call: 'phone', email: 'mail', meeting: 'calendar', showing: 'building' }
const ACTIVITY_COLORS = {
  note:    { bg: 'var(--gw-bone)',        border: 'var(--gw-border)', icon: 'var(--gw-mist)' },
  call:    { bg: '#e8f4fd',               border: 'var(--gw-azure)',  icon: 'var(--gw-azure)' },
  email:   { bg: 'var(--gw-sky)',         border: 'var(--gw-azure)',  icon: 'var(--gw-azure)' },
  meeting: { bg: '#f0ebff',               border: 'var(--gw-purple)', icon: 'var(--gw-purple)' },
  showing: { bg: 'var(--gw-green-light)', border: 'var(--gw-green)',  icon: 'var(--gw-green)' },
}
const STAGE_COLORS = {
  lead: 'var(--gw-mist)', qualified: 'var(--gw-azure)', showing: 'var(--gw-azure)',
  offer: 'var(--gw-amber)', 'under-contract': 'var(--gw-purple)',
  closed: 'var(--gw-green)', lost: 'var(--gw-red)',
}
const fmt = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export default function ActivityTab({ contact, deals, tasks, activities, activeAgent, onActivityAdded }) {
  const [type, setType] = useState('note')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  const contactDeals      = (deals      || []).filter(d => d.contact_id === contact?.id)
  const contactTasks      = (tasks      || []).filter(t => t.contact_id === contact?.id)
  const contactActivities = (activities || []).filter(a => a.contact_id === contact?.id)

  const entries = [
    ...contactActivities.map(a => ({ kind: 'activity', date: a.created_at, data: a })),
    ...contactDeals.map(d      => ({ kind: 'deal',     date: d.created_at, data: d })),
    ...contactTasks.map(t      => ({ kind: 'task',     date: t.due_date || t.created_at, data: t })),
    ...(contact?.created_at    ? [{ kind: 'created',   date: contact.created_at, data: contact }] : []),
  ].sort((a, b) => new Date(b.date) - new Date(a.date))

  const logActivity = async () => {
    if (!body.trim()) return
    setSaving(true)
    const { data, error } = await supabase.from('activities').insert([{
      contact_id: contact.id,
      agent_id:   activeAgent?.id || null,
      type,
      body: body.trim(),
    }]).select().single()
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(`${type.charAt(0).toUpperCase() + type.slice(1)} logged`)
    setBody('')
    onActivityAdded?.(data)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Log form */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--gw-border)', background: 'var(--gw-bone)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {ACTIVITY_TYPES.map(t => (
            <button key={t} onClick={() => setType(t)} style={{
              padding: '3px 10px',
              borderRadius: 14,
              border: `1px solid ${type === t ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
              background: type === t ? 'var(--gw-azure)' : '#fff',
              color: type === t ? '#fff' : 'var(--gw-ink)',
              cursor: 'pointer',
              fontSize: 11, fontWeight: 600,
              fontFamily: 'var(--font-body)',
              transition: 'all 120ms',
            }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="form-control"
            style={{ flex: 1, fontSize: 13 }}
            placeholder={`Log a ${type}…`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && logActivity()}
            disabled={saving}
          />
          <button className="btn btn--primary btn--sm" onClick={logActivity} disabled={saving || !body.trim()} style={{ whiteSpace: 'nowrap' }}>
            {saving ? '…' : 'Log'}
          </button>
        </div>
      </div>

      {/* Timeline */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {entries.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>No activity yet</div>
            <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>Log a call, note, or email above to get started.</div>
          </div>
        ) : entries.map((entry, i) => {
          const isLast = i === entries.length - 1
          return <TimelineEntry key={`${entry.kind}-${entry.data.id || 'created'}`} entry={entry} isLast={isLast} />
        })}
      </div>
    </div>
  )
}

function TimelineEntry({ entry, isLast }) {
  const connector = !isLast && (
    <div style={{ position: 'absolute', left: 27, top: 34, bottom: 0, width: 2, background: 'var(--gw-border)' }} />
  )
  const dateLabel = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  if (entry.kind === 'activity') {
    const a = entry.data
    const c = ACTIVITY_COLORS[a.type] || ACTIVITY_COLORS.note
    return (
      <div style={{ display: 'flex', gap: 12, padding: '10px 16px', position: 'relative' }}>
        {connector}
        <div style={{ width: 22, height: 22, borderRadius: '50%', background: c.bg, border: `2px solid ${c.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
          <Icon name={ACTIVITY_ICONS[a.type] || 'note'} size={10} style={{ color: c.icon }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'capitalize', color: 'var(--gw-mist)', marginBottom: 2 }}>{a.type}</div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>{a.body}</div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--gw-mist)', whiteSpace: 'nowrap', marginTop: 2 }}>{dateLabel(a.created_at)}</div>
      </div>
    )
  }

  if (entry.kind === 'deal') {
    const d = entry.data
    return (
      <div style={{ display: 'flex', gap: 12, padding: '10px 16px', position: 'relative' }}>
        {connector}
        <div style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--gw-sky)', border: '2px solid var(--gw-azure)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
          <Icon name="pipeline" size={10} style={{ color: 'var(--gw-azure)' }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{d.title}</div>
          <div style={{ fontSize: 11, marginTop: 2, display: 'flex', gap: 8 }}>
            <span style={{ color: STAGE_COLORS[d.stage] || 'var(--gw-mist)', fontWeight: 600, textTransform: 'capitalize' }}>{d.stage.replace('-', ' ')}</span>
            {d.value > 0 && <span style={{ color: 'var(--gw-mist)' }}>{formatCurrency(d.value)}</span>}
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--gw-mist)', whiteSpace: 'nowrap', marginTop: 2 }}>{dateLabel(entry.date)}</div>
      </div>
    )
  }

  if (entry.kind === 'task') {
    const t = entry.data
    const overdue  = !t.completed && t.due_date && new Date(t.due_date) < new Date()
    const typeIcon = t.type === 'call' ? 'phone' : t.type === 'email' ? 'mail' : t.type === 'showing' ? 'building' : 'tasks'
    return (
      <div style={{ display: 'flex', gap: 12, padding: '10px 16px', position: 'relative' }}>
        {connector}
        <div style={{ width: 22, height: 22, borderRadius: '50%', background: t.completed ? 'var(--gw-green-light)' : 'var(--gw-bone)', border: `2px solid ${t.completed ? 'var(--gw-green)' : 'var(--gw-border)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
          <Icon name={t.completed ? 'check' : typeIcon} size={10} style={{ color: t.completed ? 'var(--gw-green)' : 'var(--gw-mist)' }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13, textDecoration: t.completed ? 'line-through' : 'none', color: t.completed ? 'var(--gw-mist)' : 'inherit' }}>{t.title}</div>
          <div style={{ fontSize: 11, marginTop: 2, color: overdue ? 'var(--gw-red)' : 'var(--gw-mist)', fontWeight: overdue ? 600 : 400 }}>
            {t.completed ? 'Completed' : overdue ? 'Overdue' : `${t.priority} priority`} · {t.type}
          </div>
        </div>
        <div style={{ fontSize: 11, color: overdue ? 'var(--gw-red)' : 'var(--gw-mist)', whiteSpace: 'nowrap', marginTop: 2 }}>
          {t.due_date ? dateLabel(t.due_date) : '—'}
        </div>
      </div>
    )
  }

  // created
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 16px' }}>
      <div style={{ width: 22, height: 22, borderRadius: '50%', background: '#fef9ec', border: '2px solid var(--gw-amber)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 }}>
        <Icon name="contacts" size={10} style={{ color: 'var(--gw-amber)' }} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Added to CRM</div>
        <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2 }}>Contact record created</div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--gw-mist)', whiteSpace: 'nowrap', marginTop: 2 }}>
        {new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
      </div>
    </div>
  )
}
