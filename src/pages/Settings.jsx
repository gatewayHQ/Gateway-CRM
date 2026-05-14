import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, pushToast } from '../components/UI.jsx'

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

const SCHEMA_SQL = `-- Run this in Supabase → SQL Editor

create table if not exists visitor_events (
  id uuid primary key default gen_random_uuid(),
  session_key text not null,
  agent_id uuid references agents(id) on delete set null,
  property_address text,
  property_url text,
  created_at timestamptz default now()
);

create table if not exists lead_captures (
  id uuid primary key default gen_random_uuid(),
  session_key text,
  agent_id uuid references agents(id) on delete set null,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text,
  property_address text,
  message text,
  converted_contact_id uuid references contacts(id) on delete set null,
  created_at timestamptz default now()
);

alter table visitor_events enable row level security;
create policy "Public insert" on visitor_events for insert with check (true);
create policy "Auth read" on visitor_events for select using (auth.role() = 'authenticated');

alter table lead_captures enable row level security;
create policy "Public insert" on lead_captures for insert with check (true);
create policy "Auth read" on lead_captures for select using (auth.role() = 'authenticated');`

export default function SettingsPage({ db, setDb, websiteEnabled, setWebsiteEnabled }) {
  const [companyName, setCompanyName] = useState('Gateway Real Estate Advisors')
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [copied, setCopied] = useState(null)

  // Gateway Toolkit URL — stored in localStorage
  const [toolkitUrl, setToolkitUrl]         = useState(() => localStorage.getItem('gw_toolkit_url') || '')
  const [toolkitSaved, setToolkitSaved]     = useState(false)

  const saveToolkitUrl = () => {
    localStorage.setItem('gw_toolkit_url', toolkitUrl.trim())
    setToolkitSaved(true)
    setTimeout(() => setToolkitSaved(false), 2000)
    pushToast('Toolkit URL saved')
  }

  // AI key — loaded from Supabase auth metadata (persists across devices)
  const [aiKey, setAiKey]         = useState('')
  const [aiKeySaved, setAiKeySaved] = useState(false)
  const [showAiKey, setShowAiKey] = useState(false)
  const [aiKeyTesting, setAiKeyTesting] = useState(false)
  const [aiKeyTestResult, setAiKeyTestResult] = useState(null) // null | 'ok' | 'fail'

  // Resend key — same storage strategy
  const [resendKey, setResendKey]         = useState('')
  const [resendKeySaved, setResendKeySaved] = useState(false)
  const [showResendKey, setShowResendKey]   = useState(false)
  const [resendFrom, setResendFrom]         = useState('')
  const [resendFromSaved, setResendFromSaved] = useState(false)

  // Load keys from Supabase auth user metadata on mount
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      const meta = user.user_metadata || {}
      setAiKey(meta.anthropic_key || localStorage.getItem('gw_anthropic_key') || '')
      setResendKey(meta.resend_key || localStorage.getItem('gw_resend_key') || '')
      setResendFrom(meta.resend_from || localStorage.getItem('gw_resend_from') || '')
    })
  }, [])

  const saveAiKey = async () => {
    await supabase.auth.updateUser({ data: { anthropic_key: aiKey.trim() } })
    localStorage.setItem('gw_anthropic_key', aiKey.trim())
    setAiKeySaved(true)
    setTimeout(() => setAiKeySaved(false), 2000)
    pushToast('AI key saved — works on all your devices now')
  }

  const testAiKey = async () => {
    setAiKeyTesting(true)
    setAiKeyTestResult(null)
    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: aiKey.trim(),
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        }),
      })
      const json = await res.json()
      const text = json?.content?.[0]?.text || ''
      if (res.ok && text) {
        setAiKeyTestResult('ok')
        pushToast('API key is valid!')
      } else {
        setAiKeyTestResult('fail')
        pushToast(json?.error?.message || 'Key test failed', 'error')
      }
    } catch (e) {
      setAiKeyTestResult('fail')
      pushToast('Key test failed: ' + e.message, 'error')
    }
    setAiKeyTesting(false)
    setTimeout(() => setAiKeyTestResult(null), 5000)
  }

  const saveResendKey = async () => {
    await supabase.auth.updateUser({ data: { resend_key: resendKey.trim(), resend_from: resendFrom.trim() } })
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

  const toggleWebsite = () => {
    const next = !websiteEnabled
    setWebsiteEnabled(next)
    localStorage.setItem('gw_website_enabled', String(next))
    pushToast(next ? 'Website Leads enabled' : 'Website Leads hidden')
  }

  const exportData = () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'gateway-crm-export.json'; a.click()
    URL.revokeObjectURL(url)
    pushToast('Data exported successfully')
  }

  const clearAll = async () => {
    setClearing(true)
    await Promise.all([
      supabase.from('tasks').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
      supabase.from('deals').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
      supabase.from('properties').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
      supabase.from('templates').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
      supabase.from('contacts').delete().neq('id', '00000000-0000-0000-0000-000000000000'),
    ])
    setDb(p => ({ ...p, contacts:[], properties:[], deals:[], tasks:[], templates:[] }))
    setClearing(false); setConfirmClear(false)
    pushToast('All data cleared', 'info')
  }

  const stats = [
    { label: 'Contacts', count: (db.contacts||[]).length },
    { label: 'Properties', count: (db.properties||[]).length },
    { label: 'Deals', count: (db.deals||[]).length },
    { label: 'Tasks', count: (db.tasks||[]).length },
    { label: 'Templates', count: (db.templates||[]).length },
    { label: 'Agents', count: (db.agents||[]).length },
  ]

  const codeStyle = {
    background: '#1a1a2e', color: '#c9a84c', fontFamily: 'JetBrains Mono, monospace',
    fontSize: 11, padding: 14, borderRadius: 'var(--radius)', overflowX: 'auto',
    whiteSpace: 'pre', lineHeight: 1.6, display: 'block', maxHeight: 200, overflowY: 'auto',
  }

  return (
    <div className="page-content" style={{ maxWidth: 720 }}>
      <div className="page-header">
        <div><div className="page-title">Settings</div><div className="page-sub">Workspace configuration</div></div>
      </div>

      <div className="settings-section">
        <div className="settings-section__title">Workspace</div>
        <div className="settings-section__sub">Basic information about your organization</div>
        <div className="form-group" style={{ maxWidth: 400 }}>
          <label className="form-label">Company Name</label>
          <input className="form-control" value={companyName} onChange={e=>setCompanyName(e.target.value)} />
        </div>
        <button className="btn btn--primary btn--sm" onClick={() => pushToast('Settings saved')}>Save Changes</button>
      </div>

      <div className="settings-section">
        <div className="settings-section__title">Database Overview</div>
        <div className="settings-section__sub">Current records in your CRM</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12 }}>
          {stats.map(s => (
            <div key={s.label} style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'14px 16px' }}>
              <div style={{ fontSize:24, fontWeight:700, fontFamily:'var(--font-display)' }}>{s.count}</div>
              <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Website Integration ── */}
      <div className="settings-section">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 4 }}>
          <div>
            <div className="settings-section__title">Website Lead Tracking</div>
            <div className="settings-section__sub" style={{ marginBottom: 0 }}>Capture visitor activity and leads from your real estate website</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, marginTop: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--gw-mist)' }}>{websiteEnabled ? 'Enabled' : 'Hidden'}</span>
            <div onClick={toggleWebsite} style={{
              width: 44, height: 24, borderRadius: 12, cursor: 'pointer', position: 'relative', flexShrink: 0,
              background: websiteEnabled ? 'var(--gw-green)' : 'var(--gw-border)',
              transition: 'background 200ms ease',
            }}>
              <div style={{
                position: 'absolute', top: 3, left: websiteEnabled ? 23 : 3,
                width: 18, height: 18, borderRadius: '50%', background: '#fff',
                transition: 'left 200ms ease', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }} />
            </div>
          </div>
        </div>

        {!websiteEnabled && (
          <div style={{ marginTop: 16, padding: '12px 14px', background: 'var(--gw-bone)', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', fontSize: 13, color: 'var(--gw-mist)' }}>
            Toggle on when you're ready to connect your website. The "Website Leads" section will appear in the navigation.
          </div>
        )}

        {websiteEnabled && (
          <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--gw-slate)', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>1</span>
                Set up your Supabase database
              </div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 8 }}>Go to Supabase → SQL Editor and run this once:</div>
              <code style={codeStyle}>{SCHEMA_SQL}</code>
              <button className="btn btn--secondary btn--sm" style={{ marginTop: 8 }} onClick={() => copy(SCHEMA_SQL, 'sql')}>
                <Icon name="copy" size={12} /> {copied === 'sql' ? 'Copied!' : 'Copy SQL'}
              </button>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--gw-slate)', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>2</span>
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
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--gw-slate)', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>3</span>
                Tag each property listing page
              </div>
              <code style={{ ...codeStyle, maxHeight: 'none' }}>{`<div data-gw-agent="AGENT-UUID-HERE"\n     data-gw-property="123 Main St, Sioux Falls, SD"></div>`}</code>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--gw-slate)', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>4</span>
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

      {/* ── Gateway Toolkit ── */}
      <div className="settings-section">
        <div className="settings-section__title">Gateway Toolkit</div>
        <div className="settings-section__sub">
          Paste the URL to your Gateway Toolkit (Canva, OM Generator, Social Templates, etc.).
          A launcher icon will appear in the top bar so agents can jump to it instantly.
        </div>
        <div style={{ maxWidth: 480 }}>
          <div className="form-group">
            <label className="form-label">Toolkit URL</label>
            <input
              className="form-control"
              type="url"
              value={toolkitUrl}
              onChange={e => setToolkitUrl(e.target.value)}
              placeholder="https://www.canva.com/design/…"
            />
            <div className="form-hint">Saved to this browser only. Each agent sets their own Toolkit link.</div>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn--primary btn--sm" onClick={saveToolkitUrl} disabled={!toolkitUrl.trim()}>
              {toolkitSaved ? '✓ Saved' : 'Save Toolkit URL'}
            </button>
            {toolkitUrl && (
              <button className="btn btn--ghost btn--sm" onClick={() => { setToolkitUrl(''); localStorage.removeItem('gw_toolkit_url'); pushToast('Toolkit URL removed') }}>Remove</button>
            )}
          </div>
        </div>
      </div>

      {/* ── AI Configuration ── */}
      <div className="settings-section">
        <div className="settings-section__title">AI Configuration</div>
        <div className="settings-section__sub">Powers AI email generation in the Templates page. Key is saved to your account — works on any device you log in from.</div>
        <div style={{ maxWidth: 480 }}>
          <div className="form-group">
            <label className="form-label">Anthropic API Key</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="form-control"
                type={showAiKey ? 'text' : 'password'}
                value={aiKey}
                onChange={e => setAiKey(e.target.value)}
                placeholder="sk-ant-..."
                style={{ flex: 1, fontFamily: aiKey && !showAiKey ? 'var(--font-mono)' : undefined }}
              />
              <button className="btn btn--ghost btn--icon" onClick={() => setShowAiKey(v => !v)}>
                <Icon name="eye" size={15} />
              </button>
            </div>
            <div className="form-hint">Get your key at <strong>console.anthropic.com</strong> → API Keys.</div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
            <button className="btn btn--primary btn--sm" onClick={saveAiKey} disabled={!aiKey.trim()}>
              {aiKeySaved ? '✓ Saved' : 'Save Key'}
            </button>
            {aiKey.trim() && (
              <button className="btn btn--secondary btn--sm" onClick={testAiKey} disabled={aiKeyTesting}>
                {aiKeyTesting ? 'Testing…' : aiKeyTestResult === 'ok' ? '✓ Valid' : aiKeyTestResult === 'fail' ? '✗ Failed' : 'Test Key'}
              </button>
            )}
            {aiKey && (
              <button className="btn btn--ghost btn--sm" onClick={async () => {
                await supabase.auth.updateUser({ data: { anthropic_key: '' } })
                localStorage.removeItem('gw_anthropic_key')
                setAiKey('')
                setAiKeyTestResult(null)
                pushToast('Key removed')
              }}>Remove</button>
            )}
          </div>
        </div>
      </div>

      {/* ── Email Sending (Resend) ── */}
      <div className="settings-section">
        <div className="settings-section__title">Email Sending</div>
        <div className="settings-section__sub">
          Uses <strong>Resend</strong> to send emails directly from the CRM. Free tier: 3,000 emails/month.{' '}
          Sign up at <strong>resend.com</strong>, verify your domain, and paste your API key below.
        </div>

        {/* Setup steps */}
        <div style={{ background: 'var(--gw-sky)', border: '1px solid #c5d9f5', borderRadius: 'var(--radius)', padding: 14, marginBottom: 20, fontSize: 12, lineHeight: 1.8 }}>
          <strong style={{ fontSize: 13 }}>Quick setup (5 min):</strong>
          <ol style={{ margin: '8px 0 0 16px', padding: 0 }}>
            <li>Go to <strong>resend.com</strong> → sign up for free</li>
            <li>Click <strong>Domains</strong> → Add Domain → enter your domain (e.g. <code style={{ background: '#fff', padding: '1px 5px', borderRadius: 3 }}>gatewayrealestate.com</code>)</li>
            <li>Add the DNS records Resend shows you (takes ~5 min to verify)</li>
            <li>Go to <strong>API Keys</strong> → Create API Key → paste it below</li>
            <li>Set your From address to any email on your verified domain</li>
          </ol>
          <div style={{ marginTop: 8, color: 'var(--gw-mist)' }}>
            No domain yet? Use <code style={{ background: '#fff', padding: '1px 4px', borderRadius: 3 }}>onboarding@resend.dev</code> as the From address during testing — it works without domain verification.
          </div>
        </div>

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
              await supabase.auth.updateUser({ data: { resend_key: '', resend_from: '' } })
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
        <div className="settings-section__sub">Export or reset your CRM data</div>
        <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
          <button className="btn btn--secondary" onClick={exportData}><Icon name="document" size={14} /> Export All Data (JSON)</button>
          <button className="btn btn--danger" onClick={() => setConfirmClear(true)}><Icon name="trash" size={14} /> Clear All Data</button>
        </div>
        {confirmClear && (
          <div style={{ marginTop:16, padding:16, background:'var(--gw-red-light)', border:'1px solid var(--gw-red)', borderRadius:'var(--radius)' }}>
            <div style={{ fontWeight:600, marginBottom:8, color:'var(--gw-red)' }}>This will permanently delete all contacts, properties, deals, tasks, and templates.</div>
            <div style={{ display:'flex', gap:8 }}>
              <button className="btn btn--danger btn--sm" onClick={clearAll} disabled={clearing}>{clearing?'Clearing…':'Yes, delete everything'}</button>
              <button className="btn btn--secondary btn--sm" onClick={() => setConfirmClear(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section__title">About</div>
        <div className="settings-section__sub">Gateway CRM version information</div>
        <div style={{ fontSize:13, color:'var(--gw-mist)', lineHeight:1.8 }}>
          <div>Gateway CRM <span style={{ fontFamily:'var(--font-mono)', fontSize:11 }}>v1.0.0</span></div>
          <div>Built with React + Vite + Supabase</div>
          <div>Gateway Real Estate Advisors</div>
        </div>
      </div>
    </div>
  )
}
