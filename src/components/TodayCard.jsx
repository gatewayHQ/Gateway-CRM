import React, { useMemo, useState } from 'react'
import { Icon, pushToast } from './UI.jsx'
import { todayAgenda } from '../lib/today.js'
import { setTaskCompleted } from '../lib/services/tasks.js'
import { mutationErrorMessage } from '../lib/services/db.js'
import { formatPhone } from '../lib/phone.js'
import { titleCase } from '../lib/enums.js'

// ── Today ────────────────────────────────────────────────────────────────────
// The top of the dashboard: tasks due (tick them off here), new leads nobody
// has reached yet (one tap to call), and deals that need a look. Everything
// opens the record it's about. Nothing waiting → a short all-clear line.

const TASK_ICON = { call: 'phone', email: 'mail', showing: 'building', document: 'document' }
const MAX_ROWS = 6

const timeLabel = (iso, overdue) => {
  const d = new Date(iso)
  if (overdue) {
    const days = Math.max(1, Math.round((Date.now() - d) / 86400000))
    return days === 1 ? 'Yesterday' : `${days} days late`
  }
  const h = d.getHours(), m = d.getMinutes()
  return h === 0 && m === 0 ? 'Today' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function Section({ title, count, children, more, onMore }) {
  return (
    <section className="today__section">
      <div className="today__section-head">
        <span>{title}</span>
        <span className="today__count">{count}</span>
        {more > 0 && <button type="button" className="today__more" onClick={onMore}>+{more} more</button>}
      </div>
      <ul className="today__list">{children}</ul>
    </section>
  )
}

export default function TodayCard({ db, setDb, activeAgent, go, openContact }) {
  const [busy, setBusy] = useState(null)
  const contactsById = useMemo(() => new Map((db.contacts || []).map(c => [c.id, c])), [db.contacts])
  const agenda = useMemo(() => todayAgenda({
    tasks: db.tasks, contacts: db.contacts, deals: db.deals, agentId: activeAgent?.id,
  }), [db.tasks, db.contacts, db.deals, activeAgent?.id])

  const complete = async (task) => {
    setBusy(task.id)
    const { error } = await setTaskCompleted(task.id, true)
    setBusy(null)
    if (error) { pushToast(mutationErrorMessage(error), 'error'); return }
    setDb(p => ({ ...p, tasks: (p.tasks || []).map(t => t.id === task.id ? { ...t, completed: true } : t) }))
    pushToast('Task done ✓')
  }

  const openTask = (t) => {
    if (t.deal_id) go(`deal/${t.deal_id}`)
    else if (t.contact_id) openContact(t.contact_id)
    else go('tasks')
  }

  const { tasks, leads, deals } = agenda
  const total = tasks.length + leads.length + deals.length

  return (
    <div className="card today" style={{ gridColumn: '1 / -1' }}>
      <div className="section-head">
        <div className="section-title">Today</div>
        {total > 0 && <span className="today__summary">{total} thing{total !== 1 ? 's' : ''} to do</span>}
      </div>

      {total === 0 ? (
        <div className="today__clear">
          <Icon name="check" size={16} /> You're all caught up — nothing overdue, no new leads waiting.
        </div>
      ) : (
        <div className="today__grid">
          {tasks.length > 0 && (
            <Section title="Tasks due" count={tasks.length} more={tasks.length - MAX_ROWS} onMore={() => go('tasks')}>
              {tasks.slice(0, MAX_ROWS).map(t => {
                const contact = t.contact_id && contactsById.get(t.contact_id)
                return (
                  <li key={t.id} className="today__row">
                    <button type="button" className="today__tick" disabled={busy === t.id}
                      onClick={() => complete(t)} aria-label={`Mark "${t.title}" done`} title="Mark done">
                      <Icon name="check" size={12} />
                    </button>
                    <button type="button" className="today__main" onClick={() => openTask(t)}>
                      <span className="today__title">{t.title}</span>
                      <span className="today__meta">
                        <Icon name={TASK_ICON[t.type] || 'tasks'} size={11} />
                        {contact ? `${contact.first_name} ${contact.last_name}` : titleCase(t.type || 'task')}
                      </span>
                    </button>
                    <span className={`today__when${t.overdue ? ' today__when--late' : ''}`}>{timeLabel(t.due_date, t.overdue)}</span>
                  </li>
                )
              })}
            </Section>
          )}

          {leads.length > 0 && (
            <Section title="New leads to reach" count={leads.length} more={leads.length - MAX_ROWS} onMore={() => go('contacts')}>
              {leads.slice(0, MAX_ROWS).map(c => (
                <li key={c.id} className="today__row">
                  <span className="today__dot today__dot--lead" aria-hidden="true" />
                  <button type="button" className="today__main" onClick={() => openContact(c.id)}>
                    <span className="today__title">{c.first_name} {c.last_name}</span>
                    <span className="today__meta">{[c.source && titleCase(c.source.replace(/_/g, ' ')), c.type && titleCase(c.type)].filter(Boolean).join(' · ') || 'New contact'}</span>
                  </button>
                  {c.phone
                    ? <a className="today__call" href={`tel:${c.phone}`} title={`Call ${formatPhone(c.phone)}`} aria-label={`Call ${c.first_name}`}><Icon name="phone" size={14} /></a>
                    : <span className="today__when">No phone</span>}
                </li>
              ))}
            </Section>
          )}

          {deals.length > 0 && (
            <Section title="Deals needing a look" count={deals.length} more={deals.length - MAX_ROWS} onMore={() => go('pipeline')}>
              {deals.slice(0, MAX_ROWS).map(item => (
                <li key={item.deal.id} className="today__row">
                  <span className={`today__dot today__dot--${item.severity}`} aria-hidden="true" />
                  <button type="button" className="today__main" onClick={() => go(`deal/${item.deal.id}`)}>
                    <span className="today__title">{item.deal.title}</span>
                    <span className="today__meta">{item.kind === 'task' ? item.detail : item.label}</span>
                  </button>
                  <span className={`today__when${item.severity === 'critical' ? ' today__when--late' : ''}`}>
                    {item.kind === 'task' ? item.label.replace('Task overdue ', '') + ' late' : item.kind === 'rotting' ? 'Idle' : 'Soon'}
                  </span>
                </li>
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  )
}
