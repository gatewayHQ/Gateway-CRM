import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, pushToast } from '../components/UI.jsx'

export default function SettingsPage({ db, setDb }) {
  const [companyName, setCompanyName] = useState('Gateway Real Estate Advisors')
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

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
