import React from 'react'
import { Icon, Avatar } from '../../components/UI.jsx'

export default function AgentCard({ agent, contacts, deals, tasks, activeAgent, onSwitchAgent, onEdit, onDelete }) {
  const isActive      = agent.id === activeAgent?.id
  const agentContacts = contacts.filter(c => c.assigned_agent_id === agent.id).length
  const agentDeals    = deals.filter(d => d.agent_id === agent.id && d.stage !== 'closed' && d.stage !== 'lost').length
  const agentTasks    = tasks.filter(t => t.agent_id === agent.id && !t.completed).length

  return (
    <div className="agent-card" style={{ border: isActive ? '2px solid var(--gw-azure)' : undefined }}>
      {isActive && (
        <div style={{ fontSize:10, fontWeight:600, color:'var(--gw-azure)', textTransform:'uppercase', letterSpacing:'0.08em', marginBottom:8 }}>
          ● Active
        </div>
      )}
      <div className="agent-card__avatar" style={{ background: agent.color }}>{agent.initials}</div>
      <div className="agent-card__name">{agent.name}</div>
      <div className="agent-card__role">{agent.role}</div>
      <div className="agent-card__email">{agent.email}</div>
      <div className="agent-card__stats">
        {[{ val: agentContacts, label: 'Contacts' }, { val: agentDeals, label: 'Deals' }, { val: agentTasks, label: 'Tasks' }].map(s => (
          <div key={s.label} className="agent-card__stat">
            <div className="agent-card__stat-val">{s.val}</div>
            <div className="agent-card__stat-label">{s.label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {onSwitchAgent && !isActive && (
          <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={() => onSwitchAgent(agent.id)}>
            Switch to
          </button>
        )}
        <button className="btn btn--ghost btn--icon" onClick={onEdit}><Icon name="edit" size={14} /></button>
        <button className="btn btn--ghost btn--icon" onClick={onDelete}><Icon name="trash" size={14} /></button>
      </div>
    </div>
  )
}
