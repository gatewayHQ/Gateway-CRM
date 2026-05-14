import React, { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatCurrency, formatDate, STAGE_LABELS, STAGE_ORDER, upcomingReminders } from '../lib/helpers.js'
import { Icon, Badge, Avatar, Loading, pushToast } from '../components/UI.jsx'

export default function Dashboard({ db, setDb, activeAgent, go, openCompose }) {
  const today = new Date().toDateString()
  const contacts   = db.contacts   || []
  const deals      = db.deals      || []
  const properties = db.properties || []
  const tasks      = db.tasks      || []
  const agents     = db.agents     || []
  const activities = db.activities || []

  const todayTasks   = tasks.filter(t => !t.completed && t.due_date && new Date(t.due_date).toDateString() === today)
  const activeDeals  = deals.filter(d => d.stage !== 'closed' && d.stage !== 'lost')
  const totalDealValue     = activeDeals.reduce((s, d) => s + (d.value || 0), 0)
  const weightedDealValue  = activeDeals.reduce((s, d) => s + (d.value || 0) * ((d.probability || 0) / 100), 0)

  const upcomingTasks = tasks
    .filter(t => !t.completed && t.due_date)
    .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))
    .slice(0, 5)

  // Overdue tasks for today's action plan
  const now = new Date()
  const weekEnd = new Date(now); weekEnd.setDate(now.getDate() + 7)
  const overdueTasks = tasks.filter(t => !t.completed && t.due_date && new Date(t.due_date) < now)
  const actionPlanItems = [
    ...overdueTasks,
    ...tasks.filter(t => !t.completed && t.due_date && new Date(t.due_date).toDateString() === today),
  ].filter((t, i, arr) => arr.findIndex(x => x.id === t.id) === i).slice(0, 8)

  const stageData = STAGE_ORDER.slice(0, 5).map(s => ({
    stage: s,
    label: STAGE_LABELS[s],
    count: deals.filter(d => d.stage === s).length,
    value: deals.filter(d => d.stage === s).reduce((sum, d) => sum + (d.value || 0), 0)
  }))

  const reminders = useMemo(() => upcomingReminders(contacts, 30), [contacts])

  // Smart follow-up suggestions: contacts with active deals not touched in 14+ days
  const followUpSuggestions = useMemo(() => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14)
    return contacts
      .filter(c => {
        const hasActiveDeal = deals.some(d => d.contact_id === c.id && !['closed','lost'].includes(d.stage))
        if (!hasActiveDeal) return false
        const lastContact = c.last_contacted_at ? new Date(c.last_contacted_at) : null
        const lastActivity = activities
          .filter(a => a.contact_id === c.id)
          .reduce((max, a) => new Date(a.created_at) > max ? new Date(a.created_at) : max, new Date(0))
        const lastTouch = lastActivity > (lastContact || new Date(0)) ? lastActivity : (lastContact || new Date(0))
        return lastTouch < cutoff
      })
      .slice(0, 5)
  }, [contacts, deals, activities])

  const createReminderTask = async (reminder) => {
    const { contact, type, days } = reminder
    const dueDate = new Date()
    dueDate.setDate(dueDate.getDate() + Math.max(0, days - 2))
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

  const createFollowUpTask = async (contact) => {
    const activeDeal = deals.find(d => d.contact_id === contact.id && !['closed','lost'].includes(d.stage))
    const due = new Date(); due.setHours(9, 0, 0, 0)
    const payload = {
      title: `Follow up with ${contact.first_name} ${contact.last_name}${activeDeal ? ` — ${activeDeal.title}` : ''}`,
      type: 'follow-up', priority: 'medium',
      due_date: due.toISOString(),
      contact_id: contact.id,
      deal_id: activeDeal?.id || null,
      agent_id: activeAgent?.id || null,
      completed: false,
    }
    const { data, error } = await supabase.from('tasks').insert([payload]).select().single()
    if (error) { pushToast(error.message, 'error'); return }
    setDb(p => ({ ...p, tasks: [data, ...p.tasks] }))
    pushToast(`Follow-up task created for ${contact.first_name}`)
  }

  const toggleTask = async (task) => {
    const completed = !task.completed
    await supabase.from('tasks').update({ completed }).eq('id', task.id)
    setDb(p => ({ ...p, tasks: p.tasks.map(t => t.id === task.id ? { ...t, completed } : t) }))
    pushToast(completed ? 'Done ✓' : 'Reopened')
  }

  const cstHour = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }),
    10
  )
  const greeting  = cstHour < 12 ? 'Good Morning' : cstHour < 17 ? 'Good Afternoon' : 'Good Evening'
  const greetEmoji = cstHour < 17 ? '👋' : '🌙'
  const firstName = activeAgent?.name?.split(' ')[0] || ''

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">{greeting}{firstName ? `, ${firstName}` : ''} {greetEmoji}</div>
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
          {
            label: 'Pipeline Value',
            value: formatCurrency(totalDealValue),
            icon: 'pipeline',
            sub: weightedDealValue > 0
              ? `${formatCurrency(weightedDealValue)} weighted`
              : `${activeDeals.length} open deals`,
          },
          { label: 'Properties', value: properties.length, icon: 'building', sub: `${properties.filter(p=>p.status==='active').length} active listings` },
          { label: 'Tasks Today', value: todayTasks.length, icon: 'tasks', sub: `${overdueTasks.length > 0 ? overdueTasks.length + ' overdue · ' : ''}${tasks.filter(t=>!t.completed).length} total open` },
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

      {/* ── Today's Action Plan ── */}
      {actionPlanItems.length > 0 && (
        <div className="card" style={{ marginBottom: 0 }}>
          <div className="section-head">
            <div className="section-title">
              Today's Action Plan
              <span style={{ marginLeft: 8, background: overdueTasks.length > 0 ? 'var(--gw-red)' : 'var(--gw-azure)', color: '#fff', borderRadius: 10, fontSize: 10, padding: '2px 7px', fontWeight: 700, verticalAlign: 'middle' }}>
                {actionPlanItems.length}
              </span>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={() => go('tasks')}>All tasks</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {actionPlanItems.map(task => {
              const contact  = contacts.find(c => c.id === task.contact_id)
              const isOverdue = task.due_date && new Date(task.due_date) < now
              return (
                <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--gw-border)' }}>
                  <div
                    onClick={() => toggleTask(task)}
                    style={{ width: 18, height: 18, borderRadius: 4, border: '2px solid var(--gw-border)', background: '#fff', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Icon name="check" size={10} style={{ color: 'transparent' }} />
                  </div>
                  <Icon name={task.type === 'call' ? 'phone' : task.type === 'email' ? 'mail' : 'tasks'} size={13} style={{ color: 'var(--gw-mist)', flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{task.title}</div>
                    {contact && <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{contact.first_name} {contact.last_name}</div>}
                  </div>
                  {isOverdue && (
                    <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--gw-red)', background: '#fef2f2', padding: '2px 6px', borderRadius: 4, flexShrink: 0 }}>Overdue</span>
                  )}
                  <div style={{ fontSize: 11, color: isOverdue ? 'var(--gw-red)' : 'var(--gw-mist)', fontWeight: isOverdue ? 600 : 400, whiteSpace: 'nowrap' }}>{formatDate(task.due_date)}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

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
                const contact = contacts.find(c => c.id === task.contact_id)
                const overdue = task.due_date && new Date(task.due_date) < now
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

        {/* ── Smart Follow-Up Suggestions ── */}
        {followUpSuggestions.length > 0 && (
          <div className="card">
            <div className="section-head">
              <div className="section-title">
                Needs Attention
                <span style={{ marginLeft: 8, background: 'var(--gw-amber)', color: '#fff', borderRadius: 10, fontSize: 10, padding: '2px 7px', fontWeight: 700, verticalAlign: 'middle' }}>
                  {followUpSuggestions.length}
                </span>
              </div>
              <button className="btn btn--ghost btn--sm" onClick={() => go('contacts')}>All contacts</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 10 }}>Active deals · no contact in 14+ days</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {followUpSuggestions.map(contact => {
                const activeDeal = deals.find(d => d.contact_id === contact.id && !['closed','lost'].includes(d.stage))
                const alreadyHasTask = tasks.some(t => !t.completed && t.contact_id === contact.id && t.type === 'follow-up')
                return (
                  <div key={contact.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{contact.first_name} {contact.last_name}</div>
                      {activeDeal && <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>{activeDeal.title}</div>}
                    </div>
                    {alreadyHasTask ? (
                      <span style={{ fontSize: 11, color: 'var(--gw-green)', fontWeight: 600 }}>✓ Task set</span>
                    ) : (
                      <button className="btn btn--ghost btn--sm" onClick={() => createFollowUpTask(contact)} title="Create follow-up task">
                        + Task
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

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
                      <button className="btn btn--ghost btn--sm" onClick={() => createReminderTask(r)} title="Create a reminder task">
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
