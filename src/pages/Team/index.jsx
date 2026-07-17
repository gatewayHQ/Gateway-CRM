import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, EmptyState, ConfirmDialog, pushToast } from '../../components/UI.jsx'
import TeamModal  from './TeamModal.jsx'
import AgentCard  from './AgentCard.jsx'
import AgentDrawer from './AgentDrawer.jsx'

export default function TeamPage({ db, setDb, activeAgent, isAdmin, onSwitchAgent }) {
  const [agentDrawer, setAgentDrawer] = useState(false)
  const [editingAgent, setEditingAgent] = useState(null)
  const [confirmAgent, setConfirmAgent] = useState(null)

  const [teamModal,   setTeamModal]   = useState(false)
  const [editingTeam, setEditingTeam] = useState(null)
  const [confirmTeam, setConfirmTeam] = useState(null)

  const [teams,  setTeams]  = useState([])
  const [splits, setSplits] = useState([])

  const agents   = db.agents   || []
  const contacts = db.contacts || []
  const deals    = db.deals    || []
  const tasks    = db.tasks    || []

  useEffect(() => { loadTeams() }, [])

  const loadTeams = async () => {
    const [teamsRes, splitsRes] = await Promise.all([
      supabase.from('teams').select('*').order('name', { ascending: true }),
      supabase.from('team_splits').select('*').catch(() => ({ data: [] })),
    ])
    setTeams(teamsRes.data || [])
    setSplits(splitsRes.data || [])
  }

  const reloadAgents = async () => {
    const { data } = await supabase.from('agents').select('*').order('created_at', { ascending: true })
    setDb(p => ({ ...p, agents: data || [] }))
  }

  const deleteAgent = async (id) => {
    // Routed through the authenticated profile API, which enforces admin-only
    // deletion server-side (RLS on `agents` enforces the same rule regardless).
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
      body: JSON.stringify({ action: 'profile-delete', id }),
    })
    const data = await res.json().catch(() => ({}))
    setConfirmAgent(null)
    if (!res.ok || data.error) { pushToast(data.error || 'Could not remove agent', 'error'); return }
    pushToast('Agent removed', 'info')
    reloadAgents()
  }

  const deleteTeam = async (id) => {
    // Cascade: splits are deleted by FK, but delete explicitly for safety
    await supabase.from('team_splits').delete().eq('team_id', id)
    await supabase.from('teams').delete().eq('id', id)
    pushToast('Team deleted', 'info')
    setConfirmTeam(null)
    loadTeams()
  }

  // team_splits is the single source of truth for membership
  const agentMap         = Object.fromEntries(agents.map(a => [a.id, a]))
  const assignedAgentIds = new Set(splits.map(s => s.agent_id))
  const unassigned       = agents.filter(a => !assignedAgentIds.has(a.id))

  const teamsWithMembers = teams.map(t => {
    const teamSplits = splits.filter(s => s.team_id === t.id)
    return {
      ...t,
      members:   teamSplits.map(s => agentMap[s.agent_id]).filter(Boolean),
      splitRows: teamSplits,
    }
  })

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <div className="page-title">Team</div>
          <div className="page-sub">{agents.length} agent{agents.length !== 1 ? 's' : ''} · {teams.length} team{teams.length !== 1 ? 's' : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {isAdmin && (
            <button className="btn btn--secondary" onClick={() => { setEditingTeam(null); setTeamModal(true) }}>
              <Icon name="plus" size={14} /> New Team
            </button>
          )}
          {isAdmin && (
            <button className="btn btn--primary" onClick={() => { setEditingAgent(null); setAgentDrawer(true) }}>
              <Icon name="plus" size={14} /> Add Agent
            </button>
          )}
        </div>
      </div>

      {agents.length === 0 ? (
        <EmptyState icon="team" title="No agents yet"
          message={isAdmin
            ? "Add your team members to assign contacts, deals, and tasks."
            : "No agents have been added yet. Ask an office admin to set up the roster."}
          action={isAdmin && (
            <button className="btn btn--primary" onClick={() => { setEditingAgent(null); setAgentDrawer(true) }}>
              <Icon name="plus" size={14} /> Add Agent
            </button>
          )}
        />
      ) : (
        <div>
          {/* Teams */}
          {teamsWithMembers.map(team => (
            <div key={team.id} style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, paddingBottom: 8, borderBottom: '2px solid var(--gw-azure)' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--gw-ink)', flex: 1 }}>{team.name}</div>
                {team.description && (
                  <span style={{ fontSize: 11, color: 'var(--gw-mist)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={team.description}>
                    {team.description}
                  </span>
                )}
                <span style={{ fontSize: 11, color: 'var(--gw-mist)', background: 'var(--gw-bone)', padding: '2px 8px', borderRadius: 8 }}>
                  {team.members.length} {team.members.length === 1 ? 'agent' : 'agents'}
                </span>
                <button className="btn btn--ghost btn--icon btn--sm"
                  onClick={() => { setEditingTeam(team); setTeamModal(true) }}>
                  <Icon name="edit" size={13} />
                </button>
                <button className="btn btn--ghost btn--icon btn--sm"
                  onClick={() => setConfirmTeam(team.id)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>

              {team.members.length === 0
                ? <div style={{ fontSize: 12, color: 'var(--gw-mist)', paddingLeft: 4 }}>No agents assigned to this team yet.</div>
                : (
                  <div className="team-grid">
                    {team.members.map(agent => (
                      <AgentCard key={agent.id}
                        agent={agent} contacts={contacts} deals={deals} tasks={tasks}
                        activeAgent={activeAgent} isAdmin={isAdmin} onSwitchAgent={onSwitchAgent}
                        onEdit={() => { setEditingAgent(agent); setAgentDrawer(true) }}
                        onDelete={() => setConfirmAgent(agent.id)}
                      />
                    ))}
                  </div>
                )
              }
            </div>
          ))}

          {/* Unassigned agents */}
          {unassigned.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, paddingBottom: 8, borderBottom: '2px solid var(--gw-border)' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--gw-mist)', flex: 1 }}>Unassigned</div>
                <span style={{ fontSize: 11, color: 'var(--gw-mist)', background: 'var(--gw-bone)', padding: '2px 8px', borderRadius: 8 }}>
                  {unassigned.length} {unassigned.length === 1 ? 'agent' : 'agents'}
                </span>
              </div>
              <div className="team-grid">
                {unassigned.map(agent => (
                  <AgentCard key={agent.id}
                    agent={agent} contacts={contacts} deals={deals} tasks={tasks}
                    activeAgent={activeAgent} onSwitchAgent={onSwitchAgent}
                    onEdit={() => { setEditingAgent(agent); setAgentDrawer(true) }}
                    onDelete={() => setConfirmAgent(agent.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <AgentDrawer
        open={agentDrawer} onClose={() => setAgentDrawer(false)}
        agent={editingAgent} onSave={reloadAgents}
        isAdmin={isAdmin} activeAgent={activeAgent}
      />
      <TeamModal
        open={teamModal} onClose={() => setTeamModal(false)}
        team={editingTeam} agents={agents} splits={splits}
        onSave={() => { loadTeams(); reloadAgents() }}
      />
      {confirmAgent && (
        <ConfirmDialog message="Remove this agent?"
          onConfirm={() => deleteAgent(confirmAgent)}
          onCancel={() => setConfirmAgent(null)} />
      )}
      {confirmTeam && (
        <ConfirmDialog message="Delete this team and all its settings?"
          onConfirm={() => deleteTeam(confirmTeam)}
          onCancel={() => setConfirmTeam(null)} />
      )}
    </div>
  )
}
