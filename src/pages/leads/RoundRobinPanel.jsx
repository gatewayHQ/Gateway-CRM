/**
 * Lead rotation — who the website's round robin hands the next lead to.
 *
 * The rotation itself lives in SQL (assign_lead_round_robin(), migration 0037):
 * one ring per lane, a locked cursor, members in (sort_order, name) order. This
 * panel is the missing front end for it. Everyone can see the rings; only an
 * office admin can change them (lead_rotation_members_admin_write).
 *
 *   • In rotation — the "park an agent for vacation" toggle (members.active)
 *   • Order       — sort_order; ties fall back to name, as the SQL does
 *   • Next up     — computed exactly the way the SQL picks: the first active
 *                   member after the cursor, wrapping around
 *
 * An agent's drip starts automatically when they have marked one of their own
 * sequences to auto-start for that lane — that setting is on each agent's Drip
 * Sequences page, and private to them.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Avatar, Icon, pushToast } from '../../components/UI.jsx'
import { formatDate } from '../../lib/helpers.js'
import { orderRing, nextUp } from '../../lib/leadRotation.js'

const LANES = [
  { id: 'residential', label: 'Residential' },
  { id: 'commercial',  label: 'Commercial' },
]

export default function RoundRobinPanel({ agents = [], isAdmin }) {
  const [members, setMembers]     = useState([])
  const [rotations, setRotations] = useState([])
  const [state, setState]         = useState('loading')   // loading | ready | missing
  const [busy, setBusy]           = useState(false)
  const agentsById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents])

  const load = async () => {
    const [m, r] = await Promise.all([
      supabase.from('lead_rotation_members').select('*'),
      supabase.from('lead_rotations').select('*'),
    ])
    if (m.error || r.error) { setState('missing'); return }
    setMembers(m.data || [])
    setRotations(r.data || [])
    setState('ready')
  }
  useEffect(() => { load() }, [])

  const run = async (fn, ok) => {
    setBusy(true)
    try {
      const { error } = await fn()
      if (error) throw error
      if (ok) pushToast(ok)
      await load()
    } catch (err) {
      pushToast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (m) => run(
    () => supabase.from('lead_rotation_members').update({ active: !m.active }).eq('lane', m.lane).eq('agent_id', m.agent_id),
    `${agentsById.get(m.agent_id)?.name || 'Agent'} ${m.active ? 'paused — skipped until turned back on' : 'back in the rotation'}`)

  const remove = (m) => run(
    () => supabase.from('lead_rotation_members').delete().eq('lane', m.lane).eq('agent_id', m.agent_id),
    'Removed from the rotation')

  const add = (lane, agentId, count) => agentId && run(
    () => supabase.from('lead_rotation_members').upsert(
      [{ lane, agent_id: agentId, active: true, sort_order: (count + 1) * 10 }], { onConflict: 'lane,agent_id' }),
    'Added to the rotation')

  // Rewrites every member's sort_order in the lane, so the displayed order and
  // the SQL order can never disagree about ties.
  const move = (ordered, idx, dir) => {
    const j = idx + dir
    if (j < 0 || j >= ordered.length) return
    const next = [...ordered]; [next[idx], next[j]] = [next[j], next[idx]]
    run(() => supabase.from('lead_rotation_members').upsert(
      next.map((m, i) => ({ lane: m.lane, agent_id: m.agent_id, active: m.active, sort_order: (i + 1) * 10 })),
      { onConflict: 'lane,agent_id' }))
  }

  if (state === 'loading') return <div className="loading"><div className="spinner" /> Loading…</div>
  if (state === 'missing') return (
    <div className="card" style={{ padding: 20, fontSize: 13 }}>
      The round-robin tables are not in the database yet. Apply <code>migrations/0037_website_lead_intake.sql</code>.
    </div>
  )

  return (
    <div>
      <div style={{ fontSize: 13, color: 'var(--gw-mist)', marginBottom: 14, lineHeight: 1.6, maxWidth: 820 }}>
        Every new website inquiry goes to the <strong>next agent up</strong> in its lane, one at a time, in this order.
        A lead who is already a contact stays with their current agent and does not use a turn. If a lane has nobody
        active, its leads go to the other lane. Each agent picks the drip that starts automatically for their leads
        on their own <strong>Drip Sequences</strong> page.
        {!isAdmin && <> Only an office admin can change the rotation.</>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        {LANES.map(lane => {
          const rot = rotations.find(r => r.lane === lane.id) || {}
          const ordered = orderRing(members.filter(m => m.lane === lane.id), agentsById)
          const up = nextUp(ordered, rot.cursor_agent_id)
          const notIn = agents.filter(a => !ordered.some(m => m.agent_id === a.id))
          return (
            <div key={lane.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--gw-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ fontWeight: 700 }}>{lane.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--gw-mist)' }}>
                  {Number(rot.assigned_count || 0).toLocaleString()} assigned
                  {rot.last_assigned_at && <> · last {formatDate(rot.last_assigned_at)}</>}
                </div>
              </div>
              {ordered.length === 0 && (
                <div style={{ padding: 16, fontSize: 13, color: 'var(--gw-mist)' }}>Nobody in this lane.</div>
              )}
              {ordered.map((m, i) => {
                const a = agentsById.get(m.agent_id)
                return (
                  <div key={m.agent_id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px', borderBottom: '1px solid var(--gw-border)', opacity: m.active ? 1 : 0.55 }}>
                    <span style={{ width: 18, fontSize: 11, color: 'var(--gw-mist)', textAlign: 'right' }}>{i + 1}</span>
                    {a && <Avatar agent={a} size={24} />}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{a?.name || 'Former agent'}</div>
                      <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>
                        {m.agent_id === up ? <span style={{ color: 'var(--gw-green)', fontWeight: 700 }}>Next up</span>
                          : m.agent_id === rot.cursor_agent_id ? 'Got the last lead'
                          : m.active ? 'In rotation' : 'Paused'}
                      </div>
                    </div>
                    {isAdmin && (
                      <>
                        <button className="btn btn--ghost btn--icon btn--sm" disabled={busy || i === 0} onClick={() => move(ordered, i, -1)} title="Move up">↑</button>
                        <button className="btn btn--ghost btn--icon btn--sm" disabled={busy || i === ordered.length - 1} onClick={() => move(ordered, i, 1)} title="Move down">↓</button>
                        <button className="btn btn--secondary btn--sm" disabled={busy} onClick={() => toggle(m)}>{m.active ? 'Pause' : 'Resume'}</button>
                        <button className="btn btn--ghost btn--icon btn--sm" disabled={busy} onClick={() => remove(m)} title="Remove from lane"><Icon name="x" size={12} /></button>
                      </>
                    )}
                  </div>
                )
              })}
              {isAdmin && notIn.length > 0 && (
                <div style={{ padding: '10px 16px' }}>
                  <select className="form-control" style={{ fontSize: 12 }} value="" disabled={busy}
                    onChange={e => add(lane.id, e.target.value, ordered.length)}>
                    <option value="">+ Add an agent to {lane.label.toLowerCase()}…</option>
                    {notIn.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
