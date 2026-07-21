import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, Avatar, pushToast, ConfirmDialog } from '../../components/UI.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// Sharing Groups — cross-team partner sharing (migration 0024).
//
// A group is a persistent container (e.g. "Gateway × MAD — Multifamily"). Every
// member sees exactly the contacts & properties placed into it — and nothing
// else. It never touches deals or teams, so partners collaborate on specific
// records without exposing their pipelines to each other.
//
// RLS (0024) enforces: you only see/manage groups you're a member of; the
// creator is seeded as an 'owner'. Admins see all.
// ─────────────────────────────────────────────────────────────────────────────
export default function SharingGroups({ db, activeAgent }) {
  const agents     = db.agents     || []
  const contacts   = db.contacts   || []
  const properties = db.properties || []
  const agentMap = useMemo(() => Object.fromEntries(agents.map(a => [a.id, a])), [agents])

  const [groups, setGroups]       = useState([])
  const [selectedId, setSelected] = useState(null)
  const [members, setMembers]     = useState([])   // sharing_group_members rows
  const [records, setRecords]     = useState([])   // sharing_group_records rows
  const [loading, setLoading]     = useState(true)
  const [busy, setBusy]           = useState(false)
  const [confirm, setConfirm]     = useState(null)  // { message, onConfirm }
  const [newName, setNewName]     = useState('')

  const loadGroups = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('sharing_groups').select('*').order('created_at', { ascending: true })
    setLoading(false)
    // Degrade silently before migration 0024 runs (table absent) — the create
    // flow will surface a clear error if the user tries to act.
    if (error) { setGroups([]); return }
    const list = (data || []).filter(g => !g.archived)
    setGroups(list)
    setSelected(prev => prev && list.some(g => g.id === prev) ? prev : (list[0]?.id || null))
  }, [])

  const loadDetail = useCallback(async (groupId) => {
    if (!groupId) { setMembers([]); setRecords([]); return }
    const [m, r] = await Promise.all([
      supabase.from('sharing_group_members').select('*').eq('group_id', groupId),
      supabase.from('sharing_group_records').select('*').eq('group_id', groupId),
    ])
    setMembers(m.data || [])
    setRecords(r.data || [])
  }, [])

  useEffect(() => { loadGroups() }, [loadGroups])
  useEffect(() => { loadDetail(selectedId) }, [selectedId, loadDetail])

  const selected = groups.find(g => g.id === selectedId) || null

  // ── Create a group (creator becomes owner) ──────────────────────────────────
  const createGroup = async () => {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    const { data, error } = await supabase.from('sharing_groups')
      .insert({ name, created_by: activeAgent?.id || null }).select().single()
    if (error) { setBusy(false); pushToast(error.message || 'Could not create group', 'error'); return }
    // Seed the creator as an owner so they can manage it.
    await supabase.from('sharing_group_members')
      .insert({ group_id: data.id, agent_id: activeAgent?.id, role: 'owner' })
    setBusy(false)
    setNewName('')
    pushToast('Sharing group created')
    await loadGroups()
    setSelected(data.id)
  }

  const archiveGroup = (group) => setConfirm({
    message: `Archive "${group.name}"? Members will lose access to its shared records.`,
    onConfirm: async () => {
      setConfirm(null); setBusy(true)
      const { error } = await supabase.from('sharing_groups').update({ archived: true }).eq('id', group.id)
      setBusy(false)
      if (error) { pushToast(error.message, 'error'); return }
      pushToast('Group archived'); loadGroups()
    },
  })

  // ── Members ──────────────────────────────────────────────────────────────
  const memberAgentIds = new Set(members.map(m => m.agent_id))
  const addableAgents  = agents.filter(a => !memberAgentIds.has(a.id))

  const addMember = async (agentId) => {
    if (!agentId || busy) return
    setBusy(true)
    const { error } = await supabase.from('sharing_group_members')
      .insert({ group_id: selectedId, agent_id: agentId, role: 'member' })
    setBusy(false)
    if (error) { pushToast(error.message || 'Could not add member', 'error'); return }
    pushToast('Member added'); loadDetail(selectedId)
  }
  const removeMember = async (m) => {
    if (busy) return
    setBusy(true)
    const { error } = await supabase.from('sharing_group_members').delete().eq('id', m.id)
    setBusy(false)
    if (error) { pushToast(error.message, 'error'); return }
    loadDetail(selectedId)
  }

  // ── Shared records (contacts + properties) ─────────────────────────────────
  const sharedContactIds  = new Set(records.filter(r => r.entity_type === 'contact').map(r => r.entity_id))
  const sharedPropertyIds = new Set(records.filter(r => r.entity_type === 'property').map(r => r.entity_id))

  const addRecord = async (entityType, entityId) => {
    if (!entityId || busy) return
    setBusy(true)
    const { error } = await supabase.from('sharing_group_records')
      .insert({ group_id: selectedId, entity_type: entityType, entity_id: entityId, shared_by: activeAgent?.id || null })
    setBusy(false)
    if (error) { pushToast(error.message || 'Could not share record', 'error'); return }
    pushToast(`${entityType === 'contact' ? 'Contact' : 'Property'} shared`); loadDetail(selectedId)
  }
  const removeRecord = async (r) => {
    if (busy) return
    setBusy(true)
    const { error } = await supabase.from('sharing_group_records').delete().eq('id', r.id)
    setBusy(false)
    if (error) { pushToast(error.message, 'error'); return }
    loadDetail(selectedId)
  }

  const contactLabel  = (c) => `${c.first_name} ${c.last_name}`.trim() || c.email || 'Contact'
  const propertyLabel = (p) => p.address || 'Property'

  return (
    <div className="settings-section">
      <div className="settings-section__title">Sharing Groups</div>
      <div className="settings-section__sub">
        Share specific contacts &amp; properties with partners on other teams — without exposing your deals or pipeline.
        Everyone in a group sees exactly the records placed in it.
      </div>

      {/* Create */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input className="form-control" placeholder="New group name (e.g. Gateway × MAD — Multifamily)"
          value={newName} onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createGroup() }}
          style={{ flex: 1, minWidth: 240 }} />
        <button className="btn btn--primary" onClick={createGroup} disabled={busy || !newName.trim()}>
          <Icon name="plus" size={14} /> Create group
        </button>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>Loading…</div>
      ) : groups.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>
          No sharing groups yet. Create one above to start sharing with a partner.
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* Group list */}
          <div style={{ minWidth: 200, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {groups.map(g => (
              <button key={g.id} onClick={() => setSelected(g.id)}
                style={{
                  textAlign: 'left', padding: '8px 10px', borderRadius: 8, cursor: 'pointer',
                  border: '1px solid ' + (g.id === selectedId ? 'var(--gw-gold, #c8a04f)' : 'var(--gw-border)'),
                  background: g.id === selectedId ? 'var(--gw-bone)' : 'transparent', fontSize: 13, fontWeight: 600,
                }}>
                {g.name}
              </button>
            ))}
          </div>

          {/* Detail */}
          {selected && (
            <div style={{ flex: 1, minWidth: 280, border: '1px solid var(--gw-border)', borderRadius: 10, padding: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{selected.name}</div>
                <button className="btn btn--ghost" onClick={() => archiveGroup(selected)} disabled={busy}
                  style={{ fontSize: 12 }}>Archive</button>
              </div>

              {/* Members */}
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Members</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
                {members.map(m => {
                  const a = agentMap[m.agent_id]
                  return (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      {a && <Avatar agent={a} size={20} />}
                      <span style={{ fontSize: 12.5 }}>{a?.name || 'Unknown agent'}</span>
                      <span style={{ fontSize: 10, color: 'var(--gw-mist)' }}>{m.role}</span>
                      {m.role !== 'owner' && (
                        <button onClick={() => removeMember(m)} disabled={busy} title="Remove member"
                          style={{ marginLeft: 'auto', border: 'none', background: 'none', color: 'var(--gw-mist)', cursor: 'pointer', padding: 2 }}>
                          <Icon name="x" size={13} />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
              {addableAgents.length > 0 && (
                <select defaultValue="" disabled={busy} className="form-control"
                  onChange={e => { const v = e.target.value; e.target.value = ''; addMember(v) }}
                  style={{ fontSize: 12.5, padding: '5px 8px', marginBottom: 14 }}>
                  <option value="" disabled>+ Add a member…</option>
                  {addableAgents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}

              {/* Shared contacts */}
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Shared contacts</div>
              <SharedList
                rows={records.filter(r => r.entity_type === 'contact')}
                label={id => { const c = contacts.find(x => x.id === id); return c ? contactLabel(c) : '(not visible to you)' }}
                onRemove={removeRecord} busy={busy} />
              <AddPicker
                placeholder="+ Share a contact…"
                options={contacts.filter(c => !sharedContactIds.has(c.id)).map(c => ({ id: c.id, label: contactLabel(c) }))}
                onPick={id => addRecord('contact', id)} busy={busy} />

              {/* Shared properties */}
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--gw-mist)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '12px 0 6px' }}>Shared properties</div>
              <SharedList
                rows={records.filter(r => r.entity_type === 'property')}
                label={id => { const p = properties.find(x => x.id === id); return p ? propertyLabel(p) : '(not visible to you)' }}
                onRemove={removeRecord} busy={busy} />
              <AddPicker
                placeholder="+ Share a property…"
                options={properties.filter(p => !sharedPropertyIds.has(p.id)).map(p => ({ id: p.id, label: propertyLabel(p) }))}
                onPick={id => addRecord('property', id)} busy={busy} />
            </div>
          )}
        </div>
      )}

      {confirm && <ConfirmDialog message={confirm.message} onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} />}
    </div>
  )
}

function SharedList({ rows, label, onRemove, busy }) {
  if (!rows.length) return <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 6 }}>None shared yet.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
      {rows.map(r => (
        <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5 }}>
          <span>{label(r.entity_id)}</span>
          <button onClick={() => onRemove(r)} disabled={busy} title="Unshare"
            style={{ marginLeft: 'auto', border: 'none', background: 'none', color: 'var(--gw-mist)', cursor: 'pointer', padding: 2 }}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

function AddPicker({ placeholder, options, onPick, busy }) {
  if (!options.length) return null
  return (
    <select defaultValue="" disabled={busy} className="form-control"
      onChange={e => { const v = e.target.value; e.target.value = ''; onPick(v) }}
      style={{ fontSize: 12.5, padding: '5px 8px' }}>
      <option value="" disabled>{placeholder}</option>
      {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  )
}
