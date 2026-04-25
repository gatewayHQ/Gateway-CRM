import React, { useState } from 'react'
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
          {/* Toggle switch */}
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

            {/* Step 1: SQL */}
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

            {/* Step 2: Tracking script */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--gw-slate)', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>2</span>
                Add the tracking script to your website
              </div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 8 }}>Paste this into the <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3, fontSize: 11 }}>&lt;head&gt;</code> of every page on your website:</div>
              <code style={codeStyle}>{TRACKING_SCRIPT}</code>
              <button className="btn btn--secondary btn--sm" style={{ marginTop: 8 }} onClick={() => copy(TRACKING_SCRIPT, 'script')}>
                <Icon name="copy" size={12} /> {copied === 'script' ? 'Copied!' : 'Copy Script'}
              </button>
            </div>

            {/* Step 3: Per-listing tag */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--gw-slate)', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>3</span>
                Tag each property listing page
              </div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 8 }}>Add this tag anywhere on each listing page, replacing the values with the agent's ID (from their profile URL) and the property address:</div>
              <code style={{ ...codeStyle, maxHeight: 'none' }}>{`<div data-gw-agent="AGENT-UUID-HERE"\n     data-gw-property="123 Main St, Sioux Falls, SD"></div>`}</code>
            </div>

            {/* Step 4: Lead capture URL */}
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--gw-slate)', color: '#fff', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>4</span>
                Add "Contact Agent" buttons on your listings
              </div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 8 }}>Link each listing's contact button to this URL pattern (replace the values):</div>
              <code style={{ ...codeStyle, maxHeight: 'none' }}>{`${window.location.origin}/lead?agent=AGENT-UUID&property=123+Main+St`}</code>
              <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 8 }}>
                Find each agent's UUID in their Team profile. The visitor fills out a short form and the lead appears instantly in Website Leads.
              </div>
            </div>

            {/* Agent UUID helper */}
            <div style={{ background: 'var(--gw-sky)', border: '1px solid #c5d9f5', borderRadius: 'var(--radius)', padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--gw-azure)' }}>Agent UUIDs</div>
              {(db.agents || []).length === 0
                ? <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>No agents added yet. Add agents in the Team section.</div>
                : (db.agents || []).map(a => (
                    <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                      <span style={{ fontSize: 13, fontWeight: 600, minWidth: 140 }}>{a.name}</span>
                      <code style={{ fontSize: 10, background: '#fff', padding: '2px 8px', borderRadius: 4, color: 'var(--gw-slate)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.id}</code>
                      <button className="btn btn--ghost btn--icon btn--sm" onClick={() => copy(a.id, a.id)} title="Copy UUID">
                        <Icon name="copy" size={12} />
                      </button>
                    </div>
                  ))
              }
            </div>

          </div>
        )}
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
            <div style={{ fontWeight:600, marginBottom:8, color:'var(--gw-red)' }}>⚠️ This will permanently delete all contacts, properties, deals, tasks, and templates.</div>
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
