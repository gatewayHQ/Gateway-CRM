import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, Avatar, Modal, pushToast } from '../../components/UI.jsx'

// What each team member can share with the team
const SHARE_TOGGLES = [
  { key: 'share_contacts',   label: 'Contacts'   },
  { key: 'share_properties', label: 'Properties' },
  { key: 'share_deals',      label: 'Pipeline'   },
]

const defaultMember = (agentId) => ({
  agent_id:         agentId,
  split_pct:        0,
  is_lead:          false,
  share_contacts:   true,
  share_properties: true,
  share_deals:      true,
})

export default function TeamModal({ open, onClose, team, agents, splits, onSave }) {
  const [name,    setName]    = useState('')
  const [notes,   setNotes]   = useState('')
  const [members, setMembers] = useState([])
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    if (!open) return
    setName(team?.name || '')
    setNotes(team?.description || '')
    setMembers(
      team?.id
        ? splits.filter(s => s.team_id === team.id).map(s => ({
            agent_id:         s.agent_id,
            split_pct:        s.split_pct        ?? 0,
            is_lead:          !!s.is_lead,
            share_contacts:   s.share_contacts   ?? true,
            share_properties: s.share_properties ?? true,
            share_deals:      s.share_deals      ?? true,
          }))
        : []
    )
  }, [team, open, splits])

  const addMember = (agentId) => {
    if (!agentId || members.some(m => m.agent_id === agentId)) return
    setMembers(p => [...p, defaultMember(agentId)])
  }

  const updateMember = (agentId, field, value) =>
    setMembers(p => p.map(m => m.agent_id === agentId ? { ...m, [field]: value } : m))

  const removeMember = (agentId) =>
    setMembers(p => p.filter(m => m.agent_id !== agentId))

  const save = async () => {
    if (!name.trim()) return
    setSaving(true)

    let teamId = team?.id
    if (teamId) {
      await supabase.from('teams').update({ name: name.trim(), description: notes.trim() }).eq('id', teamId)
    } else {
      const { data, error } = await supabase
        .from('teams').insert([{ name: name.trim(), description: notes.trim() }]).select().single()
      if (error) { pushToast(error.message, 'error'); setSaving(false); return }
      teamId = data?.id
    }

    if (teamId) {
      await supabase.from('team_splits').delete().eq('team_id', teamId)
      if (members.length > 0) {
        await supabase.from('team_splits').insert(
          members.map(m => ({
            team_id:          teamId,
            agent_id:         m.agent_id,
            split_pct:        parseFloat(m.split_pct) || 0,
            is_lead:          !!m.is_lead,
            share_contacts:   !!m.share_contacts,
            share_properties: !!m.share_properties,
            share_deals:      !!m.share_deals,
          }))
        )
      }
    }

    setSaving(false)
    pushToast(team?.id ? 'Team updated' : 'Team created')
    onSave()
    onClose()
  }

  const unaddedAgents = agents.filter(a => !members.some(m => m.agent_id === a.id))

  return (
    <Modal open={open} onClose={onClose} width={560}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">Teams</div>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 20 }}>
            {team?.id ? 'Edit Team' : 'New Team'}
          </h3>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>

      <div className="modal__body" style={{ overflowY: 'auto', maxHeight: '72vh' }}>
        <div className="form-group">
          <label className="form-label required">Team Name</label>
          <input className="form-control" value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. Commercial Team, Residential Duo" autoFocus />
        </div>

        <div className="form-group">
          <label className="form-label">Notes</label>
          <input className="form-control" value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Internal notes…" />
        </div>

        {/* Members */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Members</label>
          <p style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 4, marginBottom: 12, lineHeight: 1.5 }}>
            Toggle what each member shares with the team.
          </p>

          {members.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', padding: '16px 0', textAlign: 'center', border: '1px dashed var(--gw-border)', borderRadius: 'var(--radius)', marginBottom: 10 }}>
              No members yet — add agents below.
            </div>
          )}

          {members.map(m => {
            const agent = agents.find(a => a.id === m.agent_id)
            if (!agent) return null
            return (
              <div key={m.agent_id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, padding: '10px 12px', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', background: 'var(--gw-bone)' }}>
                <Avatar agent={agent} size={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{agent.name}</div>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {SHARE_TOGGLES.map(f => {
                      const on = !!m[f.key]
                      return (
                        <label key={f.key} style={{
                          display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                          fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
                          color:      on ? 'var(--gw-azure)' : 'var(--gw-mist)',
                          background: on ? 'var(--gw-sky)'   : '#fff',
                          border:     `1px solid ${on ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                          transition: 'all 120ms', userSelect: 'none',
                        }}>
                          <input type="checkbox" checked={on}
                            onChange={e => updateMember(m.agent_id, f.key, e.target.checked)}
                            style={{ display: 'none' }} />
                          {f.label}
                        </label>
                      )
                    })}
                  </div>
                </div>
                <button className="btn btn--ghost btn--icon btn--sm" onClick={() => removeMember(m.agent_id)}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            )
          })}

          {unaddedAgents.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {unaddedAgents.map(a => (
                <button key={a.id} className="btn btn--secondary btn--sm" style={{ fontSize: 11 }}
                  onClick={() => addMember(a.id)}>
                  + {a.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving || !name.trim()}>
          {saving ? 'Saving…' : 'Save Team'}
        </button>
      </div>
    </Modal>
  )
}
