import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatCurrency, formatDate, STAGE_LABELS, STAGE_ORDER, upcomingReminders } from '../lib/helpers.js'
import { Icon, Badge, Avatar, Loading, pushToast } from '../components/UI.jsx'

export default function Dashboard({ db, setDb, activeAgent, go, openCompose }) {
  const today = new Date().toDateString()
  const contacts = db.contacts || []
  const deals = db.deals || []
  const properties = db.properties || []
  const tasks = db.tasks || []
  const agents = db.agents || []

  const todayTasks = tasks.filter(t => !t.completed && t.due_date && new Date(t.due_date).toDateString() === today)
  const activeDeals = deals.filter(d => d.stage !== 'closed' && d.stage !== 'lost')
  const totalDealValue = activeDeals.reduce((s, d) => s + (d.value || 0), 0)

  const upcomingTasks = tasks
    .filter(t => !t.completed && t.due_date)
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))
    .slice(0, 5)

  const stageData = STAGE_ORDER.slice(0, 5).map(s => ({
    stage: s,
    label: STAGE_LABELS[s],
    count: deals.filter(d => d.stage === s).length,
    value: deals.filter(d => d.stage === s).reduce((sum, d) => sum + (d.value || 0), 0)
  }))

  const reminders = upcomingReminders(contacts, 30)

  const createReminderTask = async (reminder) => {
    const { contact, type, days } = reminder
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + Math.max(0, days - 2))  // remind 2 days early
    dueDate.setHours(9, 0, 0, 0)
    const title = type === 'birthday'
      ? `Send birthday message to ${contact.first_name} ${contact.last_name}`
      : `Send closing anniversary message to ${contact.first_name} ${contact.last_name}`
    const payload = {
      title, type: 'call', priority: 'medium',
      due_date: dueDate.toISOString(),
      contact_id: contact.id,
      agent_id: activeAgent?.id || null,
      completed: false,
    }
    const { data, error } = await supabase.from('tasks').insert([payload]).select().single()
    if (error) { pushToast(error.message, 'error'); return }
    setDb(p => ({ ...p, tasks: [data, ...p.tasks] }))
    pushToast(`Task created for ${contact.first_name}'s ${type}`)
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Good morning 👋</div>
          <div className="page-sub">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn--secondary" onClick={() => go('contacts')}><Icon name="plus" size={14} /> Contact</button>
          <button className="btn btn--primary" onClick={() => go('pipeline')}><Icon name="plus" size={14} /> Deal</button>
        </div>
      </div>

      <div className="stats-grid">
        {[
          { label: 'Total Contacts', value: contacts.length, icon: 'contacts', sub: `${contacts.filter(c=>c.status==='active').length} active` },
          { label: 'Active Deals', value: formatCurrency(totalDealValue), icon: 'pipeline', sub: `${activeDeals.length} open deals` },
          { label: 'Properties', value: properties.length, icon: 'building', sub: `${properties.filter(p=>p.status==='active').length} active listings` },
          { label: 'Tasks Today', value: todayTasks.length, icon: 'tasks', sub: `${tasks.filter(t=>!t.completed).length} total open` },
        ].map((s, i) => (
          <div key={i} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <div className="card__label">{s.label}</div>
              <div style={{ color: 'var(--gw-azure)' }}><Icon name={s.icon} size={16} /></div>
            </div>
            <div className="card__value">{s.value}</div>
            <div className="card__sub">{s.sub}</div>
          </div>
        ))}
      </div>

      <div className="dash-grid">
        <div className="card">
          <div className="section-head">
            <div className="section-title">Pipeline Overview</div>
            <button className="btn btn--ghost btn--sm" onClick={() => go('pipeline')}>View all</button>
          </div>
          {stageData.every(s => s.count === 0) ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--gw-mist)', fontSize: 13 }}>No deals yet — add your first deal in Pipeline</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {stageData.filter(s => s.count > 0).map(s => (
                <div key={s.stage} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 100, fontSize: 12, fontWeight: 500 }}>{s.label}</div>
                  <div style={{ flex: 1, height: 8, background: 'var(--gw-bone)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: 'var(--gw-azure)', borderRadius: 4, width: `${Math.min(100, (s.count / Math.max(...stageData.map(x=>x.count),1)) * 100)}%`, transition: 'width 600ms ease' }} />
                  </div>
                  <div style={{ width: 20, fontSize: 12, fontWeight: 600, textAlign: 'right' }}>{s.count}</div>
                  <div style={{ width: 80, fontSize: 12, color: 'var(--gw-mist)', textAlign: 'right' }}>{formatCurrency(s.value)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="section-head">
            <div className="section-title">Upcoming Tasks</div>
            <button className="btn btn--ghost btn--sm" onClick={() => go('tasks')}>View all</button>
          </div>
          {upcomingTasks.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--gw-mist)', fontSize: 13 }}>No upcoming tasks</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {upcomingTasks.map(task => {
                const contact = (db.contacts||[]).find(c => c.id === task.contact_id)
                const overdue = task.due_date && new Date(task.due_date) < new Date()
                return (
                  <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--gw-border)' }}>
                    <Icon name={task.type === 'call' ? 'phone' : task.type === 'email' ? 'mail' : 'tasks'} size={14} style={{ color: 'var(--gw-mist)' }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{task.title}</div>
                      {contact && <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{contact.first_name} {contact.last_name}</div>}
                    </div>
                    <div style={{ fontSize: 11, color: overdue ? 'var(--gw-red)' : 'var(--gw-mist)', fontWeight: overdue ? 600 : 400 }}>{formatDate(task.due_date)}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ── Upcoming Reminders ── */}
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="section-head">
            <div className="section-title">
              Upcoming Birthdays &amp; Anniversaries
              {reminders.length > 0 && (
                <span style={{ marginLeft: 8, background: 'var(--gw-amber)', color: '#fff', borderRadius: 10, fontSize: 10, padding: '2px 7px', fontWeight: 700, verticalAlign: 'middle' }}>
                  {reminders.length}
                </span>
              )}
            </div>
            <button className="btn btn--ghost btn--sm" onClick={() => go('contacts')}>All contacts</button>
          </div>
          {reminders.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--gw-mist)', fontSize: 13 }}>
              No birthdays or anniversaries in the next 30 days — add them in Contact details
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10 }}>
              {reminders.map((r, i) => {
                const isBday  = r.type === 'birthday'
                const isToday = r.days === 0
                const label   = isToday ? 'Today!' : r.days === 1 ? 'Tomorrow' : `In ${r.days} days`
                const alreadyHasTask = tasks.some(t =>
                  !t.completed && t.contact_id === r.contact.id &&
                  t.title.toLowerCase().includes(r.type === 'birthday' ? 'birthday' : 'anniversary')
                )
                return (
                  <div key={`${r.contact.id}-${r.type}`} style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                    borderRadius: 'var(--radius)', border: `1px solid ${isToday ? 'var(--gw-amber)' : 'var(--gw-border)'}`,
                    background: isToday ? '#fef9ec' : '#fff',
                  }}>
                    <div style={{ fontSize: 22, lineHeight: 1 }}>{isBday ? '🎂' : '🏡'}</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.contact.first_name} {r.contact.last_name}
                      </div>
                      <div style={{ fontSize: 11, color: isToday ? 'var(--gw-amber)' : 'var(--gw-mist)', fontWeight: isToday ? 700 : 400 }}>
                        {isBday ? 'Birthday' : 'Closing Anniversary'} · {label}
                      </div>
                    </div>
                    {alreadyHasTask ? (
                      <span style={{ fontSize: 11, color: 'var(--gw-green)', fontWeight: 600 }}>✓ Task set</span>
                    ) : (
                      <button className="btn btn--ghost btn--sm" onClick={() => createReminderTask(r)}
                        title="Create a reminder task">
                        + Task
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
