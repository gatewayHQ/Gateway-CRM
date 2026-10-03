import React, { useState, useEffect } from 'react'
import { updateAgentNavHidden } from '../lib/services/teamAgents.js'
import { Icon, pushToast } from '../components/UI.jsx'
import BoldSignAdmin from './settings/BoldSignAdmin.jsx'
import { getAuthUser, updateAuthUserMetadata } from '../lib/services/auth.js'

const TRACKING_SCRIPT = `<!-- Gateway CRM — Lead Tracker -->
<script>
(function(u,k){
  function sid(){var s=localStorage.getItem('_gwsid');if(!s){s=Math.random().toString(36).slice(2)+Date.now().toString(36);localStorage.setItem('_gwsid',s);}return s;}
  window.GatewayTrack=function(agentId,property){
    fetch(u+'/rest/v1/visitor_events',{method:'POST',
      headers:{'Content-Type':'application/json','apikey':k,'Authorization':'Bearer '+k},
      body:JSON.stringify({session_key:sid(),agent_id:agentId||null,
        property_address:property||document.title,property_url:location.href})
    });
  };
  document.addEventListener('DOMContentLoaded',function(){
    var el=document.querySelector('[data-gw-agent]');
    if(el)window.GatewayTrack(el.dataset.gwAgent,el.dataset.gwProperty);
  });
})('https://twgwemkihpwlgliftagg.supabase.co','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3Z3dlbWtpaHB3bGdsaWZ0YWdnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcwNjkzMjAsImV4cCI6MjA5MjY0NTMyMH0.YRaCsDpExXjuPyrssFyzXP9RQktFAW7GTuEMgQq8sZU');
</script>`

export default function SettingsPage({ db, setDb, activeAgentId, hideableNav, go }) {
  const [copied, setCopied] = useState(null)

  // ── Sidebar customization ──────────────────────────────────────────────────
  const activeAgent = (db.agents || []).find(a => a.id === activeAgentId)
  const [hiddenNav, setHiddenNav] = useState(() => activeAgent?.nav_hidden || [])
  const [navSaving, setNavSaving] = useState(false)

  // Keep local state in sync if agent data loads after mount
  useEffect(() => {
    if (activeAgent?.nav_hidden) setHiddenNav(activeAgent.nav_hidden)
  }, [activeAgent?.id])

  const toggleNavItem = (id) => {
    setHiddenNav(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const saveNavPrefs = async () => {
    if (!activeAgentId) return
    setNavSaving(true)
    const { error } = await updateAgentNavHidden(activeAgentId, hiddenNav)
    setNavSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    setDb(p => ({ ...p, agents: (p.agents || []).map(a => a.id === activeAgentId ? { ...a, nav_hidden: hiddenNav } : a) }))
    pushToast('Sidebar preferences saved')
  }

  // Resend key — loaded from Supabase auth metadata (persists across devices)
  const [resendKey, setResendKey]         = useState('')
  const [resendKeySaved, setResendKeySaved] = useState(false)
  const [showResendKey, setShowResendKey]   = useState(false)
  const [resendFrom, setResendFrom]         = useState('')

  // Load the key from Supabase auth user metadata on mount
  useEffect(() => {
    getAuthUser().then(({ data: { user } }) => {
      if (!user) return
      const meta = user.user_metadata || {}
      setResendKey(meta.resend_key || localStorage.getItem('gw_resend_key') || '')
      setResendFrom(meta.resend_from || localStorage.getItem('gw_resend_from') || '')
    })
  }, [])

  const saveResendKey = async () => {
    await updateAuthUserMetadata({ resend_key: resendKey.trim(), resend_from: resendFrom.trim() })
    localStorage.setItem('gw_resend_key', resendKey.trim())
    localStorage.setItem('gw_resend_from', resendFrom.trim())
    setResendKeySaved(true)
    setTimeout(() => setResendKeySaved(false), 2000)
    pushToast('Email settings saved')
  }

  const copy = (text, key) => {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
    pushToast('Copied to clipboard')
  }

  // Export is scoped to the signed-in agent, never the whole workspace. `db` is
  // loaded firm-wide for office admins, so every collection is filtered by
  // ownership here before it reaches the file.
  const exportMyData = () => {
    if (!activeAgentId) { pushToast('No agent profile detected', 'error'); return }

    const mine = (rows, col) => (rows || []).filter(r => r[col] === activeAgentId)

    const contacts   = mine(db.contacts, 'assigned_agent_id')
    const properties = mine(db.properties, 'assigned_agent_id')
    // Own deals plus deals where this agent is a commission co-agent
    const deals = (db.deals || []).filter(d =>
      d.agent_id === activeAgentId || (d.co_agent_ids || []).includes(activeAgentId))
    const dealIds     = new Set(deals.map(d => d.id))
    const propertyIds = new Set(properties.map(p => p.id))

    const payload = {
      exported_at:      new Date().toISOString(),
      agent:            activeAgent || null,
      contacts,
      properties,
      deals,
      tasks:            mine(db.tasks, 'agent_id'),
      templates:        mine(db.templates, 'agent_id'),
      activities:       mine(db.activities, 'agent_id'),
      commissions:      (db.commissions || []).filter(c => dealIds.has(c.deal_id)),
      dealContacts:     (db.dealContacts || []).filter(dc => dealIds.has(dc.deal_id)),
      propertyContacts: (db.propertyContacts || []).filter(pc => propertyIds.has(pc.property_id)),
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'gateway-crm-export.json'; a.click()
    URL.revokeObjectURL(url)
    pushToast('Your data exported successfully')
  }

  const codeStyle = {
    background: '#1a1a2e', color: '#c9a84c', fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11, padding: 14, borderRadius: 'var(--radius)', overflowX: 'auto',
    whiteSpace: 'pre', lineHeight: 1.6, display: 'block', maxHeight: 200, overflowY: 'auto',
  }

  return (
    <div className="page-content" style={{ maxWidth: 720 }}>
      <div className="page-header">
        <div><div className="page-title">Settings</div><div className="page-sub">Your sidebar, email and data</div></div>
      </div>

      {/* ── Sidebar Customization ── */}
      <div className="settings-section">
        <div className="settings-section__title">Customize My Sidebar</div>
        <div className="settings-section__sub">
          Hide sections you don't need — keeping your workspace focused and clutter-free.
          Dashboard, Pipeline, and Settings are always visible.
        </div>
        {!activeAgentId ? (
          <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>No agent profile detected.</div>
        ) : (hideableNav || []).length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>Nav config not loaded.</div>
        ) : (
          <>
            {['Core', 'Office', 'Tools'].map(group => (
              <div key={group} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--gw-mist)', marginBottom: 8 }}>{group}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {(hideableNav || []).filter(n => n.group === group).map(n => {
                    const isHidden = hiddenNav.includes(n.id)
                    return (
                      <button key={n.id} onClick={() => toggleNavItem(n.id)}
                        style={{ padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: '1px solid', transition: 'all 150ms',
                          background: isHidden ? 'var(--gw-bone)' : 'var(--gw-slate)',
                          color:      isHidden ? 'var(--gw-mist)' : '#fff',
                          borderColor: isHidden ? 'var(--gw-border)' : 'var(--gw-slate)',
                          textDecoration: isHidden ? 'line-through' : 'none',
                          opacity: isHidden ? 0.6 : 1,
                        }}>
                        {n.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            <button className="btn btn--primary btn--sm" onClick={saveNavPrefs} disabled={navSaving}>
              {navSaving ? 'Saving…' : 'Save Sidebar Preferences'}
            </button>
            {hiddenNav.length > 0 && (
              <button className="btn btn--ghost btn--sm" style={{ marginLeft: 8 }} onClick={() => setHiddenNav([])}>
                Show all
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Website Integration ── (admin: it's the firm's website) */}
      {activeAgent?.is_admin && (
      <div className="settings-section">
        <div className="settings-section__title">Website Lead Tracking</div>
        <div className="settings-section__sub">Send visitor activity and inquiries from the firm's website into Leads</div>

        {(
          <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--gw-slate)', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>1</span>
                Add the tracking script to your website
              </div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 8 }}>Paste this into the <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3, fontSize: 11 }}>&lt;head&gt;</code> of every page:</div>
              <code style={codeStyle}>{TRACKING_SCRIPT}</code>
              <button className="btn btn--secondary btn--sm" style={{ marginTop: 8 }} onClick={() => copy(TRACKING_SCRIPT, 'script')}>
                <Icon name="copy" size={12} /> {copied === 'script' ? 'Copied!' : 'Copy Script'}
              </button>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--gw-slate)', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>2</span>
                Tag each property listing page
              </div>
              <code style={{ ...codeStyle, maxHeight: 'none' }}>{`<div data-gw-agent="AGENT-UUID-HERE"\n     data-gw-property="123 Main St, Sioux Falls, SD"></div>`}</code>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--gw-slate)', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>3</span>
                Add "Contact Agent" buttons on your listings
              </div>
              <code style={{ ...codeStyle, maxHeight: 'none' }}>{`${window.location.origin}/lead?agent=AGENT-UUID&property=123+Main+St`}</code>
            </div>
            <div style={{ background: 'var(--gw-sky)', border: '1px solid #c5d9f5', borderRadius: 'var(--radius)', padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--gw-azure)' }}>Agent UUIDs</div>
              {(db.agents || []).length === 0
                ? <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>No agents added yet.</div>
                : (db.agents || []).map(a => (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, minWidth: 140 }}>{a.name}</span>
                      <code style={{ fontSize: 10, background: '#fff', padding: '2px 8px', borderRadius: 4, color: 'var(--gw-slate)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.id}</code>
                      <button className="btn btn--ghost btn--icon btn--sm" onClick={() => copy(a.id, a.id)}><Icon name="copy" size={12} /></button>
                    </div>
                  ))
              }
            </div>
          </div>
        )}
      </div>
      )}

      {/* ── Email Sending (Resend) ── */}
      <div className="settings-section">
        <div className="settings-section__title">Email Sending</div>
        <div className="settings-section__sub">Only needed if you don't connect Outlook (Integrations) — Outlook is used first when it's connected.</div>

        <div style={{ maxWidth: 480 }}>
          <div className="form-group">
            <label className="form-label">Resend API Key</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="form-control"
                type={showResendKey ? 'text' : 'password'}
                value={resendKey}
                onChange={e => setResendKey(e.target.value)}
                placeholder="re_..."
                style={{ flex: 1, fontFamily: resendKey && !showResendKey ? 'var(--font-mono)' : undefined }}
              />
              <button className="btn btn--ghost btn--icon" onClick={() => setShowResendKey(v => !v)}>
                <Icon name="eye" size={15} />
              </button>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">From Address</label>
            <input
              className="form-control"
              type="email"
              value={resendFrom}
              onChange={e => setResendFrom(e.target.value)}
              placeholder="Agent Name <agent@yourdomain.com>"
            />
            <div className="form-hint">Must match your verified Resend domain. Format: <code>Name &lt;email@domain.com&gt;</code></div>
          </div>
          <button className="btn btn--primary btn--sm" onClick={saveResendKey} disabled={!resendKey.trim()}>
            {resendKeySaved ? '✓ Saved' : 'Save Email Settings'}
          </button>
          {resendKey && (
            <button className="btn btn--ghost btn--sm" style={{ marginLeft: 8 }} onClick={async () => {
              await updateAuthUserMetadata({ resend_key: '', resend_from: '' })
              localStorage.removeItem('gw_resend_key')
              localStorage.removeItem('gw_resend_from')
              setResendKey(''); setResendFrom('')
              pushToast('Email settings removed')
            }}>Remove</button>
          )}
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section__title">Data Management</div>
        <div className="settings-section__sub">Download a JSON copy of your own CRM records</div>
        <button className="btn btn--secondary" onClick={exportMyData}><Icon name="document" size={14} /> Export My Data (JSON)</button>
      </div>

      {activeAgent?.is_admin && <BoldSignAdmin agents={db.agents || []} go={go} />}

      <div className="settings-section">
        <div className="settings-section__title">About</div>
        <div className="settings-section__sub">Gateway CRM version information</div>
        <div style={{ fontSize:13, color:'var(--gw-mist)', lineHeight:1.8 }}>
          <div>Gateway CRM <span style={{ fontFamily:'var(--font-mono)', fontSize:11 }}>v1.0.0</span></div>
          <div>Gateway Real Estate Advisors</div>
        </div>
      </div>
    </div>
  )
}
