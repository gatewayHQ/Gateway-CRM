// ─────────────────────────────────────────────────────────────────────────────
// BoldSign admin panel (Settings → admin only)
//   • Sender identities — register each agent so their signature requests come
//     from them; track the Pending → Approved lifecycle; resend/sync.
//
// Template management lives in Form Library (src/pages/FormLibrary.jsx) —
// Form Library is the CRM's single catalog for both plain downloadable forms
// and e-signature templates (an entry with a BoldSign template id attached is
// sendable). This used to be a separate `boldsign_templates` registry; folding
// it into Form Library means admins manage all documents in one place.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, pushToast } from '../../components/UI.jsx'
import { createIdentity, syncIdentities, resendIdentity } from '../../lib/services/boldsign.js'

const STATUS_STYLE = {
  approved: { bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  pending:  { bg: '#fff3cd',               color: '#856404' },
  declined: { bg: 'var(--gw-red-light)',   color: 'var(--gw-red)' },
  none:     { bg: 'var(--gw-bone)',        color: 'var(--gw-mist)' },
}

export default function BoldSignAdmin({ agents = [], go }) {
  const [identities, setIdentities] = useState([])
  const [busy,       setBusy]        = useState('')

  const load = async () => {
    const { data: ids } = await supabase.from('boldsign_sender_identities').select('*')
    setIdentities(ids || [])
  }
  useEffect(() => { load() }, [])

  const idByAgent = Object.fromEntries(identities.map(i => [i.agent_id, i]))

  const register = async (agent) => {
    if (!agent.email) { pushToast(`${agent.name} has no email`, 'error'); return }
    setBusy(agent.id)
    try {
      await createIdentity(agent.id, agent.name, agent.email)
      pushToast(`Invitation sent to ${agent.email}`, 'success')
      await load()
    } catch (e) { pushToast(e.message, 'error') } finally { setBusy('') }
  }

  const resend = async (email) => {
    setBusy(email)
    try { await resendIdentity(email); pushToast('Invitation resent', 'success') }
    catch (e) { pushToast(e.message, 'error') } finally { setBusy('') }
  }

  const sync = async () => {
    setBusy('sync')
    try { const r = await syncIdentities(); pushToast(`Synced ${r.count} identities`, 'success'); await load() }
    catch (e) { pushToast(e.message, 'error') } finally { setBusy('') }
  }

  return (
    <>
      {/* ── Sender identities ─────────────────────────────────────────────── */}
      <div className="settings-section">
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
          <div>
            <div className="settings-section__title">BoldSign — Sender Identities</div>
            <div className="settings-section__sub">
              Register each agent so signature requests are sent from them. The agent must click the
              approval link BoldSign emails before their sends go out under their name.
            </div>
          </div>
          <button className="btn btn--secondary btn--sm" onClick={sync} disabled={busy==='sync'}>
            <Icon name="refresh" size={13}/> {busy==='sync' ? 'Syncing…' : 'Sync statuses'}
          </button>
        </div>
        <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
          {agents.length === 0
            ? <div style={{ padding:14, fontSize:13, color:'var(--gw-mist)' }}>No agents yet.</div>
            : agents.map((a, i) => {
                const id = idByAgent[a.id]
                const status = id?.status || 'none'
                const st = STATUS_STYLE[status] || STATUS_STYLE.none
                return (
                  <div key={a.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderTop: i ? '1px solid var(--gw-border)' : 'none' }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600 }}>{a.name}</div>
                      <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{a.email || 'no email'}</div>
                    </div>
                    <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700, background:st.bg, color:st.color, textTransform:'capitalize' }}>
                      {status === 'none' ? 'not registered' : status}
                    </span>
                    {status === 'none' && (
                      <button className="btn btn--primary btn--sm" onClick={() => register(a)} disabled={busy===a.id}>
                        {busy===a.id ? 'Sending…' : 'Register'}
                      </button>
                    )}
                    {status === 'pending' && (
                      <button className="btn btn--secondary btn--sm" onClick={() => resend(a.email)} disabled={busy===a.email}>
                        {busy===a.email ? 'Resending…' : 'Resend'}
                      </button>
                    )}
                  </div>
                )
              })}
        </div>
      </div>

      {/* ── Templates pointer ────────────────────────────────────────────── */}
      <div className="settings-section">
        <div className="settings-section__title">BoldSign — Templates</div>
        <div className="settings-section__sub">
          Templates now live in <strong>Form Library</strong> — register a template's BoldSign id there
          (or build one from a PDF) and it becomes sendable from a deal's Signatures tab.
        </div>
        <button className="btn btn--secondary btn--sm" onClick={() => go?.('form-library')}>
          <Icon name="document" size={13}/> Open Form Library
        </button>
      </div>
    </>
  )
}
