import React, { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, Avatar, ConfirmDialog, EmptyState, Loading, pushToast } from '../../components/UI.jsx'
import { formatDate } from '../../lib/helpers.js'
import { fetchPartnerLinks, createPartnerLink, removePartnerLink } from '../../lib/services/partners.js'

// ─────────────────────────────────────────────────────────────────────────────
// AdminPartnerManager — the ONLY place Partner (share-all) links are created or
// removed. Admin-only: the component renders nothing for non-admins, and the
// writes are additionally blocked by RLS on agent_partners (migration 0025), so
// the admin gate is enforced at the database, not just hidden in the UI.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object}   props
 * @param {object[]} props.agents
 * @param {object}   props.activeAgent
 * @param {boolean}  props.isAdmin
 * @param {() => void} [props.onChange]  Called after a link is added/removed (so App can re-scope).
 */
export default function AdminPartnerManager({ agents = [], activeAgent, isAdmin, onChange }) {
  const [links, setLinks]       = useState(null) // null = loading
  const [agentA, setAgentA]     = useState('')
  const [agentB, setAgentB]     = useState('')
  const [saving, setSaving]     = useState(false)
  const [confirmId, setConfirm] = useState(null)

  const load = async () => {
    const { data } = await fetchPartnerLinks(supabase)
    setLinks(data || [])
  }
  useEffect(() => { if (isAdmin) load() }, [isAdmin])

  // Defense in depth: never render for non-admins (RLS is the hard backstop).
  if (!isAdmin) return null

  const agentMap = Object.fromEntries(agents.map(a => [a.id, a]))
  const nameOf = (id) => agentMap[id]?.name || 'Unknown agent'

  const alreadyLinked = (x, y) =>
    (links || []).some(l =>
      (l.agent_a === x && l.agent_b === y) || (l.agent_a === y && l.agent_b === x))

  const add = async () => {
    if (!agentA || !agentB) { pushToast('Pick two agents to link.', 'error'); return }
    if (agentA === agentB)  { pushToast('Pick two different agents.', 'error'); return }
    if (alreadyLinked(agentA, agentB)) { pushToast('Those agents are already partnered.', 'info'); return }
    setSaving(true)
    const { error } = await createPartnerLink(supabase, { agentA, agentB, createdBy: activeAgent?.id })
    setSaving(false)
    if (error) { pushToast(error.message || 'Could not create the Partner link', 'error'); return }
    pushToast(`Linked ${nameOf(agentA)} ↔ ${nameOf(agentB)}`)
    setAgentA(''); setAgentB('')
    await load()
    onChange && onChange()
  }

  const remove = async (id) => {
    setConfirm(null)
    const { error } = await removePartnerLink(supabase, id)
    if (error) { pushToast(error.message || 'Could not remove the Partner link', 'error'); return }
    pushToast('Partner link removed', 'info')
    await load()
    onChange && onChange()
  }

  return (
    <div className="partner-manager">
      <div className="partner-manager__head">
        <Icon name="link" size={15} />
        <span className="partner-manager__title">Partner links</span>
        <span className="partner-manager__admin-tag">Admin only</span>
      </div>
      <p className="partner-manager__sub">
        A Partner link lets two agents see each other’s full book — every deal, contact, and property.
        Use it for fixed working pairs. Only admins can add or remove links; agents can’t request or change them.
      </p>

      {/* Create */}
      <div className="partner-manager__form">
        <div className="partner-manager__field">
          <label htmlFor="partner-a">Agent</label>
          <select id="partner-a" className="form-control" value={agentA} onChange={e => setAgentA(e.target.value)}>
            <option value="">Select agent…</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div className="partner-manager__field">
          <label htmlFor="partner-b">Partner</label>
          <select id="partner-b" className="form-control" value={agentB} onChange={e => setAgentB(e.target.value)}>
            <option value="">Select agent…</option>
            {agents.filter(a => a.id !== agentA).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <button className="btn btn--primary" onClick={add} disabled={saving || !agentA || !agentB}>
          <Icon name="link" size={13} /> {saving ? 'Linking…' : 'Link'}
        </button>
      </div>

      {/* Existing links */}
      {links === null ? (
        <Loading />
      ) : links.length === 0 ? (
        <EmptyState icon="link" title="No Partner links yet"
          message="Link two agents above to give them full visibility into each other’s book." />
      ) : (
        <div role="list">
          {links.map(l => (
            <div className="partner-link" role="listitem" key={l.id}>
              <div className="partner-link__pair">
                <Avatar agent={agentMap[l.agent_a]} size={24} />
                <span className="partner-link__names">{nameOf(l.agent_a)}</span>
                <Icon name="link" size={13} style={{ color: 'var(--gw-purple)' }} />
                <Avatar agent={agentMap[l.agent_b]} size={24} />
                <span className="partner-link__names">{nameOf(l.agent_b)}</span>
              </div>
              {l.created_at && <span className="partner-link__meta">since {formatDate(l.created_at)}</span>}
              <button className="btn btn--ghost btn--icon btn--sm" title="Remove Partner link"
                aria-label={`Remove Partner link between ${nameOf(l.agent_a)} and ${nameOf(l.agent_b)}`}
                onClick={() => setConfirm(l.id)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {confirmId && (
        <ConfirmDialog
          message="Remove this Partner link? Each agent will immediately lose visibility into the other’s book (deals, contacts, properties)."
          onConfirm={() => remove(confirmId)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}
