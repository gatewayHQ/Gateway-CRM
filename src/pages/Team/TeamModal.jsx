import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase.js'
import { withRetry, mutationErrorMessage } from '../../lib/services/db.js'
import { Icon, Avatar, Modal, pushToast } from '../../components/UI.jsx'

// What each team member can share with the team
const SHARE_TOGGLES = [
  { key: 'share_contacts',   label: 'Contacts'   },
  { key: 'share_properties', label: 'Properties' },
  { key: 'share_deals',      label: 'Pipeline'   },
]

const TEAM_TYPES = [
  { id: 'collaboration', label: 'Collaboration', hint: 'Shared visibility only — each agent is paid on their own split.' },
  { id: 'split',         label: 'Commission split', hint: 'Team commission is divided between members by the percentages below.' },
]

const defaultMember = (agentId) => ({
  agent_id:         agentId,
  split_pct:        0,
  is_lead:          false,
  share_contacts:   true,
  share_properties: true,
  share_deals:      true,
})

// Split entry is free text so a field can be cleared mid-keystroke; this is the
// gate that decides whether it can be saved.
const memberSplitError = (raw) => {
  const s = String(raw ?? '').trim()
  if (!s) return 'Enter a percentage (0 if this member takes no share).'
  const n = Number(s)
  if (!Number.isFinite(n))  return 'Split must be a number.'
  if (n < 0 || n > 100)     return 'Split must be between 0 and 100.'
  return null
}

const round2 = (n) => Math.round(n * 100) / 100

export default function TeamModal({ open, onClose, team, agents, splits, onSave }) {
  const [name,    setName]    = useState('')
  const [notes,   setNotes]   = useState('')
  const [type,    setType]    = useState('collaboration')
  const [members, setMembers] = useState([])
  const [saving,  setSaving]  = useState(false)

  useEffect(() => {
    if (!open) return
    setName(team?.name || '')
    setNotes(team?.description || '')
    setType(team?.type || 'collaboration')
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

  const isSplitTeam = type === 'split'
  const splitTotal  = round2(members.reduce((sum, m) => sum + (Number(m.split_pct) || 0), 0))
  const totalOk     = !isSplitTeam || splitTotal === 100
  const badSplit    = isSplitTeam && members.some(m => memberSplitError(m.split_pct))

  const addMember = (agentId) => {
    if (!agentId || members.some(m => m.agent_id === agentId)) return
    setMembers(p => [...p, defaultMember(agentId)])
  }

  const updateMember = (agentId, field, value) =>
    setMembers(p => p.map(m => m.agent_id === agentId ? { ...m, [field]: value } : m))

  // Only one lead per team — picking a new one clears the old.
  const setLead = (agentId, on) =>
    setMembers(p => p.map(m => ({ ...m, is_lead: on ? m.agent_id === agentId : (m.agent_id === agentId ? false : m.is_lead) })))

  const removeMember = (agentId) =>
    setMembers(p => p.filter(m => m.agent_id !== agentId))

  // Divide 100% evenly, giving the remainder to the first member so the total
  // lands exactly on 100 instead of 99.99.
  const splitEvenly = () => {
    if (!members.length) return
    const each = Math.floor((100 / members.length) * 100) / 100
    setMembers(p => p.map((m, i) => ({
      ...m,
      split_pct: i === 0 ? round2(100 - each * (p.length - 1)) : each,
    })))
  }

  const save = async () => {
    if (!name.trim()) return
    if (isSplitTeam && badSplit) {
      pushToast('Every member needs a valid split percentage.', 'error')
      return
    }
    if (isSplitTeam && !totalOk) {
      pushToast(`Member splits total ${splitTotal}% — they must add up to 100%.`, 'error')
      return
    }
    setSaving(true)

    const fail = (res, fallback) => {
      setSaving(false)
      pushToast(mutationErrorMessage(res.error, res.status, fallback), 'error')
      onSave()   // re-read: some of the write may already have landed
    }

    // ── 1. The team row ──────────────────────────────────────────────────────
    let teamId = team?.id
    if (teamId) {
      const res = await withRetry(() => supabase.from('teams')
        .update({ name: name.trim(), description: notes.trim(), type }).eq('id', teamId).select().single())
      if (res.error) return fail(res, 'Could not save this team.')
    } else {
      const res = await withRetry(() => supabase.from('teams')
        .insert([{ name: name.trim(), description: notes.trim(), type }]).select().single())
      if (res.error) return fail(res, 'Could not create this team.')
      teamId = res.data?.id
      if (!teamId) { setSaving(false); pushToast('Could not create this team.', 'error'); return }
    }

    // ── 2. Membership ────────────────────────────────────────────────────────
    // Upsert-then-prune, NOT delete-then-insert. The old order wiped every
    // member first, so a failed insert (a bad percentage, an RLS denial, a
    // dropped connection) left the team empty — and because no result was ever
    // checked, it still said "Team updated". Now nothing is removed until the
    // rows that survive are safely written.
    const rows = members.map(m => ({
      team_id:          teamId,
      agent_id:         m.agent_id,
      // A collaboration team has no commission to divide; store 0 rather than
      // stale percentages from when it was a split team.
      split_pct:        isSplitTeam ? (Number(m.split_pct) || 0) : 0,
      is_lead:          !!m.is_lead,
      share_contacts:   !!m.share_contacts,
      share_properties: !!m.share_properties,
      share_deals:      !!m.share_deals,
    }))

    if (rows.length) {
      const res = await withRetry(() => supabase.from('team_splits')
        .upsert(rows, { onConflict: 'team_id,agent_id' }).select())
      if (res.error) return fail(res, 'Could not save the team’s members.')
    }

    // Prune only the members actually dropped in this edit, named explicitly.
    const keepIds  = new Set(rows.map(r => r.agent_id))
    const droppedIds = splits
      .filter(s => s.team_id === teamId && !keepIds.has(s.agent_id))
      .map(s => s.agent_id)
    if (droppedIds.length) {
      const res = await withRetry(() => supabase.from('team_splits')
        .delete().eq('team_id', teamId).in('agent_id', droppedIds))
      if (res.error) return fail(res, 'Members saved, but removing the old ones failed.')
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

        {/* Team type — decides whether the split percentages below mean anything */}
        <div className="form-group">
          <label className="form-label">Team Type</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {TEAM_TYPES.map(t => {
              const on = type === t.id
              return (
                <button key={t.id} type="button" onClick={() => setType(t.id)}
                  style={{
                    flex: 1, textAlign: 'left', cursor: 'pointer', padding: '9px 12px',
                    borderRadius: 'var(--radius)', transition: 'all 120ms',
                    border: `1px solid ${on ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                    background: on ? 'var(--gw-sky)' : '#fff',
                  }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: on ? 'var(--gw-azure)' : 'var(--gw-ink)' }}>{t.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2, lineHeight: 1.4 }}>{t.hint}</div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Members */}
        <div className="form-group" style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <label className="form-label">Members</label>
            {isSplitTeam && members.length > 1 && (
              <button type="button" className="btn btn--ghost btn--sm" style={{ fontSize: 11 }} onClick={splitEvenly}>
                Split evenly
              </button>
            )}
          </div>
          <p style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 4, marginBottom: 12, lineHeight: 1.5 }}>
            {isSplitTeam
              ? 'Set each member’s share of the team commission and what they share with the team.'
              : 'Toggle what each member shares with the team.'}
          </p>

          {members.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--gw-mist)', padding: '16px 0', textAlign: 'center', border: '1px dashed var(--gw-border)', borderRadius: 'var(--radius)', marginBottom: 10 }}>
              No members yet — add agents below.
            </div>
          )}

          {members.map(m => {
            const agent = agents.find(a => a.id === m.agent_id)
            if (!agent) return null
            const splitMsg = isSplitTeam ? memberSplitError(m.split_pct) : null
            return (
              <div key={m.agent_id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8, padding: '10px 12px', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', background: 'var(--gw-bone)' }}>
                <Avatar agent={agent} size={30} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {agent.name}
                    </div>
                    {isSplitTeam && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input className={`form-control${splitMsg ? ' error' : ''}`} type="number"
                          min="0" max="100" step="0.5" style={{ width: 76, fontSize: 12.5, padding: '4px 8px' }}
                          value={m.split_pct}
                          onChange={e => updateMember(m.agent_id, 'split_pct', e.target.value)}
                          aria-label={`${agent.name} team split percent`} />
                        <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>%</span>
                      </div>
                    )}
                  </div>
                  {splitMsg && <div style={{ fontSize: 11, color: 'var(--gw-red)', marginBottom: 6 }}>{splitMsg}</div>}
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
                    <label style={{
                      display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                      fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
                      color:      m.is_lead ? '#8a6d1f' : 'var(--gw-mist)',
                      background: m.is_lead ? '#fdf3d7' : '#fff',
                      border:     `1px solid ${m.is_lead ? '#c9a84c' : 'var(--gw-border)'}`,
                      transition: 'all 120ms', userSelect: 'none',
                    }}>
                      <input type="checkbox" checked={!!m.is_lead}
                        onChange={e => setLead(m.agent_id, e.target.checked)}
                        style={{ display: 'none' }} />
                      Team lead
                    </label>
                  </div>
                </div>
                <button className="btn btn--ghost btn--icon btn--sm" onClick={() => removeMember(m.agent_id)}
                  title={`Remove ${agent.name}`}>
                  <Icon name="x" size={12} />
                </button>
              </div>
            )
          })}

          {isSplitTeam && members.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', borderRadius: 'var(--radius)', marginTop: 4,
              fontSize: 12, fontWeight: 700,
              color:      totalOk ? 'var(--gw-azure)' : '#b45309',
              background: totalOk ? 'var(--gw-sky)'   : '#fef3c7',
            }}>
              <span>Total allocated</span>
              <span>{splitTotal}%{totalOk ? '' : ` · ${round2(100 - splitTotal)}% ${splitTotal > 100 ? 'over' : 'unallocated'}`}</span>
            </div>
          )}

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
        <button className="btn btn--primary" onClick={save}
          disabled={saving || !name.trim() || badSplit || !totalOk}
          title={!totalOk ? `Member splits must total 100% (currently ${splitTotal}%)` : undefined}>
          {saving ? 'Saving…' : 'Save Team'}
        </button>
      </div>
    </Modal>
  )
}
