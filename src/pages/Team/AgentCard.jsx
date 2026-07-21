import React from 'react'
import { Icon, Avatar } from '../../components/UI.jsx'

export default function AgentCard({ agent, contacts, deals, tasks, activeAgent, isAdmin, onSwitchAgent, onEdit, onDelete }) {
  const isActive = agent.id === activeAgent?.id
  // RBAC — what a viewer may do with THIS card:
  //   • view settings (email + book-of-business stats): own card, or admin
  //   • edit profile:                                    own card, or admin
  //   • delete / "switch to" (view-as):                  admin only
  // A non-admin sees colleagues as a minimal directory entry only.
  const isSelf          = agent.id === activeAgent?.id
  const canViewSettings = isAdmin || isSelf
  const canEdit         = isAdmin || isSelf
  const canSwitch       = isAdmin

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

      {/* Email + book-of-business stats are profile settings — own card / admin only. */}
      {canViewSettings ? (
        <>
          <div className="agent-card__email">{agent.email}</div>
          <div className="agent-card__stats">
            {[{ val: agentContacts, label: 'Contacts' }, { val: agentDeals, label: 'Deals' }, { val: agentTasks, label: 'Tasks' }].map(s => (
              <div key={s.label} className="agent-card__stat">
                <div className="agent-card__stat-val">{s.val}</div>
                <div className="agent-card__stat-label">{s.label}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="agent-card__email" style={{ color:'var(--gw-mist)', fontStyle:'italic' }}>
          Private profile
        </div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        {canSwitch && onSwitchAgent && !isActive && (
          <button className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={() => onSwitchAgent(agent.id)}>
            Switch to
          </button>
        )}
        {canEdit && (
          <button className="btn btn--ghost btn--icon" onClick={onEdit} title={isSelf ? 'Edit your profile' : 'Edit profile'}>
            <Icon name="edit" size={14} />
          </button>
        )}
        {isAdmin && !isSelf && (
          <button className="btn btn--ghost btn--icon" onClick={onDelete} title="Remove agent">
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
