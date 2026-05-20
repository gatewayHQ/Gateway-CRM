import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Modal, pushToast, EmptyState, ConfirmDialog, SearchDropdown } from '../components/UI.jsx'

// ── SQL migration hint ────────────────────────────────────────────────────────
// Run once in Supabase SQL Editor:
//   ALTER TABLE mail_campaigns ADD COLUMN IF NOT EXISTS channel text DEFAULT 'mail';
//   ALTER TABLE mail_campaigns ADD COLUMN IF NOT EXISTS email_subject text;
//   ALTER TABLE mail_campaigns ADD COLUMN IF NOT EXISTS email_body text;
//   ALTER TABLE mail_sends ADD COLUMN IF NOT EXISTS responded_at timestamptz;

// ── Config ────────────────────────────────────────────────────────────────────
const CHANNEL_CONFIG = {
  mail:        { label: 'Mail Flyer',  icon: 'mail',  bg: '#dbeafe', color: '#1d4ed8' },
  'cold-call': { label: 'Cold Call',   icon: 'phone', bg: '#fef3c7', color: '#92400e' },
  email:       { label: 'Email',       icon: 'send',  bg: '#d1fae5', color: '#065f46' },
  sms:         { label: 'SMS',         icon: 'more',  bg: '#f3e8ff', color: '#7c3aed' },
}

const RESPONSE_CONFIG = {
  'no-response': { label: 'No Response', bg: 'var(--gw-bone)',        color: 'var(--gw-mist)' },
  callback:      { label: 'Callback',    bg: '#fef3c7',               color: '#92400e'         },
  interested:    { label: 'Interested',  bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  dnc:           { label: 'DNC',         bg: 'var(--gw-red-light)',   color: 'var(--gw-red)'   },
  converted:     { label: 'Converted',   bg: '#ede9fe',               color: '#6d28d9'         },
}

const STATUS_CONFIG = {
  draft:     { label: 'Draft',     bg: 'var(--gw-bone)',        color: 'var(--gw-mist)' },
  active:    { label: 'Active',    bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  paused:    { label: 'Paused',    bg: '#fef3c7',               color: '#92400e' },
  completed: { label: 'Completed', bg: '#ede9fe',               color: '#6d28d9' },
}

const PROPERTY_TYPES = ['residential','rental','multifamily','office','land','retail','industrial','mixed-use','commercial']
const CONTACT_TYPES  = ['buyer','seller','owner','investor','landlord','tenant','vendor','other']
const CHANNEL_OPTS   = Object.entries(CHANNEL_CONFIG).map(([v, c]) => ({ value: v, label: c.label }))
const RESPONSE_OPTS  = Object.entries(RESPONSE_CONFIG).map(([v, c]) => ({ value: v, label: c.label }))

// ── Badge helpers ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.draft
  return <span style={{ padding:'2px 9px', borderRadius:10, fontSize:11, fontWeight:700, background:c.bg, color:c.color, whiteSpace:'nowrap' }}>{c.label}</span>
}

function ResponseBadge({ response }) {
  const c = RESPONSE_CONFIG[response] || RESPONSE_CONFIG['no-response']
  return <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700, background:c.bg, color:c.color, whiteSpace:'nowrap' }}>{c.label}</span>
}

function ChannelBadge({ channel }) {
  const c = CHANNEL_CONFIG[channel] || CHANNEL_CONFIG.mail
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:4, padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700, background:c.bg, color:c.color, whiteSpace:'nowrap' }}>
      <Icon name={c.icon} size={10}/>{c.label}
    </span>
  )
}

function StatCard({ value, label, sub, color }) {
  return (
    <div style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'14px 18px', minWidth:100 }}>
      <div style={{ fontSize:26, fontWeight:800, color: color || 'var(--gw-ink)', fontFamily:'var(--font-display)', lineHeight:1 }}>{value}</div>
      <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginTop:2 }}>{label}</div>
      {sub && <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:1 }}>{sub}</div>}
    </div>
  )
}

// ── Analytics funnel ──────────────────────────────────────────────────────────
function FunnelChart({ analytics }) {
  const steps = [
    { label: 'Sent',       value: analytics.total,      color: 'var(--gw-azure)' },
    { label: 'Responded',  value: analytics.responded,  color: '#8b5cf6' },
    { label: 'Interested', value: analytics.interested || analytics.by_response?.interested || 0, color: 'var(--gw-green)' },
    { label: 'Converted',  value: analytics.converted,  color: '#059669' },
  ]
  const max = analytics.total || 1
  return (
    <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
      {steps.map(s => (
        <div key={s.label} style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:80, fontSize:12, fontWeight:600, color:'var(--gw-mist)', textAlign:'right', flexShrink:0 }}>{s.label}</div>
          <div style={{ flex:1, height:26, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden', position:'relative' }}>
            <div style={{
              width: `${Math.round(s.value / max * 100)}%`,
              minWidth: s.value > 0 ? 28 : 0,
              height:'100%', background: s.color, borderRadius:4,
              display:'flex', alignItems:'center', paddingLeft:8,
              transition:'width 500ms ease',
            }}>
              {s.value > 0 && <span style={{ fontSize:11, fontWeight:700, color:'#fff', whiteSpace:'nowrap' }}>{s.value}</span>}
            </div>
          </div>
          <div style={{ width:38, textAlign:'right', fontSize:12, fontWeight:700, color: s.value > 0 ? s.color : 'var(--gw-mist)', flexShrink:0 }}>
            {max > 0 ? `${Math.round(s.value / max * 100)}%` : '—'}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── CSV export ────────────────────────────────────────────────────────────────
function exportCSV(sends, contacts, agents, campaign) {
  const findContact = id => contacts?.find(c => c.id === id)
  const findAgent   = id => agents?.find(a => a.id === id)
  const headers = ['Date','Name','Address','City','State','Zip','Channel','Response','Agent','Notes']
  const rows = sends.map(s => {
    const c = s.contact_id ? findContact(s.contact_id) : null
    const a = s.agent_id   ? findAgent(s.agent_id)   : null
    return [
      new Date(s.sent_at).toLocaleDateString(),
      c ? `${c.first_name} ${c.last_name}` : (s.recipient_name || ''),
      s.recipient_address || c?.owner_address || '',
      s.recipient_city    || c?.owner_city    || '',
      s.recipient_state   || c?.owner_state   || '',
      s.recipient_zip     || c?.owner_zip     || '',
      s.channel,
      s.response,
      a?.name || '',
      s.notes || '',
    ]
  })
  const csv  = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `${(campaign?.name || 'campaign').replace(/[^a-z0-9]/gi, '_')}_sends.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Campaign form ─────────────────────────────────────────────────────────────
function CampaignForm({ initial, agents, properties, activeAgent, onSave, onCancel, saving }) {
  const [form, setForm] = useState({
    name: '', description: '', status: 'active',
    channel: 'mail',
    property_types: [],
    property_id: '', qr_target: 'crm_landing', tracking_url: '',
    frequency_cap: 0, frequency_days: 30,
    agent_id: activeAgent?.id || '',
    email_subject: '', email_body: '',
    ...initial,
  })
  const set      = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const toggleType = (t) => set('property_types',
    form.property_types.includes(t)
      ? form.property_types.filter(x => x !== t)
      : [...form.property_types, t])

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      {/* Channel picker */}
      <div className="form-group">
        <label className="form-label">Campaign Channel</label>
        <div style={{ display:'flex', gap:0, borderRadius:'var(--radius)', border:'1px solid var(--gw-border)', overflow:'hidden' }}>
          {CHANNEL_OPTS.map(({ value, label }) => (
            <button key={value} type="button" onClick={() => set('channel', value)}
              style={{ flex:1, padding:'8px 4px', fontSize:12, fontWeight:700, cursor:'pointer', border:'none',
                background: form.channel === value ? 'var(--gw-azure)' : '#fff',
                color:      form.channel === value ? '#fff' : 'var(--gw-mist)',
                borderRight: '1px solid var(--gw-border)',
              }}>{label}</button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label required">Campaign Name</label>
        <input className="form-control" placeholder="e.g. Q2 Multifamily Mailer" value={form.name} onChange={e => set('name', e.target.value)}/>
      </div>

      <div className="form-group">
        <label className="form-label">Description</label>
        <textarea className="form-control" rows={2} placeholder="Target audience, goal, notes…" value={form.description || ''} onChange={e => set('description', e.target.value)}/>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
        <div className="form-group" style={{ margin:0 }}>
          <label className="form-label">Status</label>
          <select className="form-control" value={form.status} onChange={e => set('status', e.target.value)}>
            {Object.entries(STATUS_CONFIG).map(([v, c]) => <option key={v} value={v}>{c.label}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ margin:0 }}>
          <label className="form-label">Assigned Agent</label>
          <select className="form-control" value={form.agent_id || ''} onChange={e => set('agent_id', e.target.value)}>
            <option value="">— Any —</option>
            {(agents || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Target Property Types <span style={{fontWeight:400,color:'var(--gw-mist)',fontSize:11}}>— leave empty to target all</span></label>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:4 }}>
          {PROPERTY_TYPES.map(t => (
            <button key={t} type="button" onClick={() => toggleType(t)}
              style={{ padding:'4px 10px', borderRadius:10, fontSize:12, fontWeight:700, cursor:'pointer',
                border:`1.5px solid ${form.property_types.includes(t) ? 'var(--gw-azure)' : 'var(--gw-border)'}`,
                background: form.property_types.includes(t) ? '#dbeafe' : '#fff',
                color:      form.property_types.includes(t) ? '#1d4ed8' : 'var(--gw-mist)' }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Email-specific fields */}
      {form.channel === 'email' && (
        <div style={{ background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:'var(--radius)', padding:'12px 14px', display:'flex', flexDirection:'column', gap:10 }}>
          <div style={{ fontSize:12, fontWeight:700, color:'#065f46', marginBottom:2 }}>Email Template <span style={{ fontWeight:400, color:'#065f46' }}>— save default subject &amp; body for this campaign</span></div>
          <input className="form-control" placeholder="Subject — use {{first_name}} for merge" value={form.email_subject || ''} onChange={e => set('email_subject', e.target.value)}/>
          <textarea className="form-control" rows={4} placeholder="Email body — supports {{first_name}}, {{last_name}}, {{full_name}}" value={form.email_body || ''} onChange={e => set('email_body', e.target.value)}/>
        </div>
      )}

      {/* QR Code (mail only) */}
      {(form.channel === 'mail' || !form.channel) && (
        <>
          <div style={{ background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
            <div style={{ fontSize:12, fontWeight:700, marginBottom:8 }}>QR Code Target <span style={{fontWeight:400,color:'var(--gw-mist)'}}>— where your QR code sends leads</span></div>
            <div style={{ display:'flex', gap:0, borderRadius:'var(--radius)', border:'1px solid var(--gw-border)', overflow:'hidden', marginBottom: 10 }}>
              {[['crm_landing','CRM Landing Page'],['custom_url','Custom URL']].map(([v,l]) => (
                <button key={v} type="button" onClick={() => set('qr_target', v)}
                  style={{ flex:1, padding:'7px 0', fontSize:12, fontWeight:700, cursor:'pointer', border:'none',
                    background: form.qr_target === v ? 'var(--gw-azure)' : '#fff',
                    color: form.qr_target === v ? '#fff' : 'var(--gw-mist)' }}>{l}</button>
              ))}
            </div>
            {form.qr_target === 'crm_landing' && (
              <div className="form-group" style={{ margin:0 }}>
                <label className="form-label" style={{fontSize:11}}>Linked Property</label>
                <select className="form-control" value={form.property_id || ''} onChange={e => set('property_id', e.target.value)}>
                  <option value="">— None (CRM home) —</option>
                  {(properties || []).map(p => <option key={p.id} value={p.id}>{p.address}{p.city ? `, ${p.city}` : ''}</option>)}
                </select>
              </div>
            )}
            {form.qr_target === 'custom_url' && (
              <div className="form-group" style={{ margin:0 }}>
                <label className="form-label" style={{fontSize:11}}>Target URL</label>
                <input className="form-control" placeholder="https://…" value={form.tracking_url || ''} onChange={e => set('tracking_url', e.target.value)}/>
              </div>
            )}
          </div>
        </>
      )}

      <div style={{ background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:'12px 14px' }}>
        <div style={{ fontSize:12, fontWeight:700, marginBottom:8 }}>Frequency Cap <span style={{fontWeight:400,color:'var(--gw-mist)'}}>— prevent over-contacting the same person</span></div>
        <div style={{ display:'flex', alignItems:'center', gap:10, fontSize:13 }}>
          <span>Max</span>
          <input type="number" min={0} max={99} className="form-control" style={{ width:60 }}
            value={form.frequency_cap} onChange={e => set('frequency_cap', parseInt(e.target.value)||0)}/>
          <span>sends in</span>
          <input type="number" min={1} max={365} className="form-control" style={{ width:70 }}
            value={form.frequency_days} onChange={e => set('frequency_days', parseInt(e.target.value)||30)}/>
          <span>days <span style={{color:'var(--gw-mist)',fontSize:11}}>(0 = no cap)</span></span>
        </div>
      </div>

      <div style={{ display:'flex', gap:8, justifyContent:'flex-end', paddingTop:4 }}>
        <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn--primary" onClick={() => onSave(form)} disabled={saving || !form.name.trim()}>
          {saving ? 'Saving…' : initial?.id ? 'Update Campaign' : 'Create Campaign'}
        </button>
      </div>
    </div>
  )
}

// ── Log single send modal ─────────────────────────────────────────────────────
function LogSendModal({ campaign, contacts, agents, activeAgent, coldLeads, onSave, onClose }) {
  const [form, setForm] = useState({
    contact_id: '', cold_lead_id: '',
    recipient_name: '', recipient_address: '', recipient_city: '', recipient_state: '', recipient_zip: '',
    channel: campaign.channel || 'mail',
    response: 'no-response',
    sent_at: new Date().toISOString().slice(0, 16),
    agent_id: activeAgent?.id || '',
    notes: '',
  })
  const [recipientMode, setRecipientMode] = useState('contact')
  const [saving,  setSaving]  = useState(false)
  const [warning, setWarning] = useState('')
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const checkHistory = async (contactId) => {
    if (!contactId) return
    const { count } = await supabase
      .from('mail_sends')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('contact_id', contactId)
    if (count > 0) setWarning(`This contact has already been sent to ${count} time${count !== 1 ? 's' : ''} in this campaign.`)
    else setWarning('')
  }

  const save = async () => {
    setSaving(true)
    const payload = {
      action: 'log_send',
      campaign_id:  campaign.id,
      contact_id:   recipientMode === 'contact'   ? form.contact_id   || null : null,
      cold_lead_id: recipientMode === 'cold-lead' ? form.cold_lead_id || null : null,
      recipient_name:    recipientMode === 'manual' ? form.recipient_name    : null,
      recipient_address: recipientMode === 'manual' ? form.recipient_address : null,
      recipient_city:    recipientMode === 'manual' ? form.recipient_city    : null,
      recipient_state:   recipientMode === 'manual' ? form.recipient_state   : null,
      recipient_zip:     recipientMode === 'manual' ? form.recipient_zip     : null,
      channel:  form.channel,
      sent_at:  new Date(form.sent_at).toISOString(),
      agent_id: form.agent_id || null,
      response: form.response,
      notes:    form.notes || null,
    }
    const resp = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await resp.json()
    setSaving(false)
    if (!resp.ok || data.error) {
      if (data.suppressed) pushToast(`Suppressed: ${data.error}`, 'error')
      else if (data.capped) pushToast(data.error, 'error')
      else                  pushToast(data.error || 'Failed to log send', 'error')
      return
    }
    if (form.response === 'interested') pushToast('Follow-up task created automatically', 'info')
    onSave(data.send)
  }

  const contactOpts  = (contacts  || []).map(c => ({ id: c.id, name: `${c.first_name} ${c.last_name}`, sub: c.phone || c.email || '' }))
  const coldLeadOpts = (coldLeads || []).map(l => ({ id: l.id, name: l.owner_name || l.contact_name || l.property_address || 'Unknown', sub: l.property_address || '' }))

  return (
    <Modal open={true} onClose={onClose} width={500}>
      <div className="modal__head">
        <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>Log Send — {campaign.name}</h3>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body" style={{ display:'flex', flexDirection:'column', gap:14 }}>
        <div>
          <label className="form-label">Recipient</label>
          <div style={{ display:'flex', gap:0, borderRadius:'var(--radius)', border:'1px solid var(--gw-border)', overflow:'hidden', marginTop:4 }}>
            {[['contact','CRM Contact'],['cold-lead','Cold Lead'],['manual','Enter Manually']].map(([v,l]) => (
              <button key={v} onClick={() => setRecipientMode(v)}
                style={{ flex:1, padding:'7px 0', fontSize:12, fontWeight:700, cursor:'pointer', border:'none',
                  background: recipientMode === v ? 'var(--gw-azure)' : '#fff',
                  color:      recipientMode === v ? '#fff' : 'var(--gw-mist)' }}>{l}</button>
            ))}
          </div>
        </div>

        {recipientMode === 'contact' && (
          <div className="form-group" style={{ margin:0 }}>
            <SearchDropdown items={contactOpts} value={form.contact_id} onSelect={id => { set('contact_id', id); checkHistory(id) }} placeholder="Search contacts…"/>
            {warning && <div style={{ marginTop:6, padding:'6px 10px', background:'#fef3c7', borderRadius:6, fontSize:12, color:'#92400e', fontWeight:600 }}>⚠ {warning}</div>}
          </div>
        )}
        {recipientMode === 'cold-lead' && coldLeadOpts.length > 0 && (
          <div className="form-group" style={{ margin:0 }}>
            <SearchDropdown items={coldLeadOpts} value={form.cold_lead_id} onSelect={id => set('cold_lead_id', id)} placeholder="Search cold call leads…"/>
          </div>
        )}
        {recipientMode === 'cold-lead' && coldLeadOpts.length === 0 && (
          <div style={{ fontSize:12, color:'var(--gw-mist)', padding:'8px 0' }}>No cold call leads loaded. Use CRM Contact instead.</div>
        )}
        {recipientMode === 'manual' && (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            <input className="form-control" placeholder="Full name" value={form.recipient_name} onChange={e => set('recipient_name', e.target.value)}/>
            <input className="form-control" placeholder="Mailing address" value={form.recipient_address} onChange={e => set('recipient_address', e.target.value)}/>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 80px 90px', gap:8 }}>
              <input className="form-control" placeholder="City" value={form.recipient_city} onChange={e => set('recipient_city', e.target.value)}/>
              <input className="form-control" placeholder="ST" value={form.recipient_state} onChange={e => set('recipient_state', e.target.value)}/>
              <input className="form-control" placeholder="Zip" value={form.recipient_zip} onChange={e => set('recipient_zip', e.target.value)}/>
            </div>
          </div>
        )}

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Channel</label>
            <select className="form-control" value={form.channel} onChange={e => set('channel', e.target.value)}>
              {CHANNEL_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Date Sent</label>
            <input type="datetime-local" className="form-control" value={form.sent_at} onChange={e => set('sent_at', e.target.value)}/>
          </div>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Response</label>
            <select className="form-control" value={form.response} onChange={e => set('response', e.target.value)}>
              {RESPONSE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ margin:0 }}>
            <label className="form-label">Agent</label>
            <select className="form-control" value={form.agent_id || ''} onChange={e => set('agent_id', e.target.value)}>
              <option value="">— Unassigned —</option>
              {(agents || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        {form.response === 'interested' && (
          <div style={{ padding:'8px 12px', background:'var(--gw-green-light)', borderRadius:6, fontSize:12, color:'var(--gw-green)', fontWeight:600 }}>
            ✓ A high-priority follow-up task will be created automatically.
          </div>
        )}

        <div className="form-group" style={{ margin:0 }}>
          <label className="form-label">Notes</label>
          <textarea className="form-control" rows={2} placeholder="Call notes, voicemail, context…" value={form.notes} onChange={e => set('notes', e.target.value)}/>
        </div>

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Log Send'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

// ── Bulk log modal ────────────────────────────────────────────────────────────
function BulkLogModal({ campaign, contacts, agents, activeAgent, onSave, onClose }) {
  const [search,     setSearch]     = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [selected,   setSelected]   = useState(new Set())
  const [form, setForm] = useState({
    channel:  campaign.channel || 'mail',
    sent_at:  new Date().toISOString().slice(0, 16),
    agent_id: activeAgent?.id || '',
  })
  const [saving, setSaving] = useState(false)
  const cbAllRef = useRef(null)

  const filtered = useMemo(() => {
    return (contacts || []).filter(c => {
      if (typeFilter && c.type !== typeFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return `${c.first_name} ${c.last_name}`.toLowerCase().includes(q) ||
               (c.email || '').toLowerCase().includes(q) ||
               (c.phone || '').includes(q)
      }
      return true
    })
  }, [contacts, search, typeFilter])

  useEffect(() => {
    if (!cbAllRef.current) return
    cbAllRef.current.indeterminate = selected.size > 0 && selected.size < filtered.length
  }, [selected.size, filtered.length])

  const toggle = (id) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const submit = async () => {
    if (!selected.size) return
    setSaving(true)
    const recipients = [...selected].map(id => ({ contact_id: id }))
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:      'batch_log',
        campaign_id: campaign.id,
        recipients,
        channel:  form.channel,
        sent_at:  new Date(form.sent_at).toISOString(),
        agent_id: form.agent_id || null,
      }),
    })
    const data = await res.json()
    setSaving(false)
    if (!res.ok) { pushToast(data.error || 'Batch log failed', 'error'); return }
    onSave(data.sends || [])
    const msg = `${data.count} send${data.count !== 1 ? 's' : ''} logged${data.skipped ? ` (${data.skipped} suppressed)` : ''}`
    pushToast(msg)
  }

  return (
    <Modal open={true} onClose={onClose} width={580}>
      <div className="modal__head">
        <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>Bulk Log — {campaign.name}</h3>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body" style={{ display:'flex', flexDirection:'column', gap:12 }}>

        <div style={{ display:'flex', gap:8 }}>
          <input className="form-control" style={{ flex:1 }} placeholder="Search contacts…" value={search} onChange={e => setSearch(e.target.value)}/>
          <select className="form-control" style={{ width:130 }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All Types</option>
            {CONTACT_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
          </select>
        </div>

        <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', maxHeight:260, overflowY:'auto' }}>
          <div style={{ padding:'8px 12px', borderBottom:'1px solid var(--gw-border)', display:'flex', alignItems:'center', gap:8, background:'var(--gw-bone)', position:'sticky', top:0, zIndex:1 }}>
            <input type="checkbox" ref={cbAllRef}
              checked={selected.size > 0 && selected.size === filtered.length}
              onChange={() => setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map(c => c.id)))}
            />
            <span style={{ fontSize:12, fontWeight:700, color:'var(--gw-mist)' }}>
              {selected.size > 0 ? `${selected.size} selected` : `${filtered.length} contacts`}
            </span>
          </div>
          {filtered.length === 0 && (
            <div style={{ padding:28, textAlign:'center', fontSize:13, color:'var(--gw-mist)' }}>No contacts match filters</div>
          )}
          {filtered.map(c => (
            <div key={c.id}
              onClick={() => toggle(c.id)}
              style={{ padding:'8px 12px', borderBottom:'1px solid var(--gw-border)', display:'flex', alignItems:'center', gap:10, cursor:'pointer', background: selected.has(c.id) ? '#f0f7ff' : '#fff' }}>
              <input type="checkbox" checked={selected.has(c.id)} onChange={() => {}} onClick={e => e.stopPropagation()}/>
              <div style={{ flex:1 }}>
                <span style={{ fontWeight:600, fontSize:13 }}>{c.first_name} {c.last_name}</span>
                {c.type && <span style={{ marginLeft:6, fontSize:11, background:'var(--gw-bone)', color:'var(--gw-mist)', padding:'1px 6px', borderRadius:8, fontWeight:600 }}>{c.type}</span>}
                {(c.owner_address || c.email) && (
                  <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:1 }}>{c.owner_address || c.email}</div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
          <div>
            <label className="form-label">Channel</label>
            <select className="form-control" value={form.channel} onChange={e => setForm(p=>({...p,channel:e.target.value}))}>
              {CHANNEL_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label">Date Sent</label>
            <input type="datetime-local" className="form-control" value={form.sent_at} onChange={e => setForm(p=>({...p,sent_at:e.target.value}))}/>
          </div>
          <div>
            <label className="form-label">Agent</label>
            <select className="form-control" value={form.agent_id} onChange={e => setForm(p=>({...p,agent_id:e.target.value}))}>
              <option value="">— Unassigned —</option>
              {(agents||[]).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div style={{ fontSize:12, color:'var(--gw-mist)' }}>
            Suppressed contacts will be skipped automatically.
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" onClick={submit} disabled={saving || !selected.size}>
              {saving ? 'Logging…' : `Log ${selected.size || 0} Send${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ── Email blast panel ─────────────────────────────────────────────────────────
function EmailBlastPanel({ campaign, contacts, agents, activeAgent, onSent, onCancel }) {
  const [subject, setSubject]     = useState(campaign.email_subject || '')
  const [body,    setBody]        = useState(campaign.email_body    || '')
  const [agentId, setAgentId]     = useState(activeAgent?.id || '')
  const [search,  setSearch]      = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [selected, setSelected]   = useState(new Set())
  const [preview,  setPreview]    = useState(false)
  const [sending,  setSending]    = useState(false)
  const cbAllRef = useRef(null)

  const eligible = useMemo(() => (contacts || []).filter(c => c.email), [contacts])

  const filtered = useMemo(() => {
    return eligible.filter(c => {
      if (typeFilter && c.type !== typeFilter) return false
      if (search) {
        const q = search.toLowerCase()
        return `${c.first_name} ${c.last_name}`.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)
      }
      return true
    })
  }, [eligible, search, typeFilter])

  useEffect(() => {
    if (!cbAllRef.current) return
    cbAllRef.current.indeterminate = selected.size > 0 && selected.size < filtered.length
  }, [selected.size, filtered.length])

  const toggle = (id) => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const applyMerge = (text, c) =>
    text
      .replace(/\{\{first_name\}\}/g, c?.first_name || '')
      .replace(/\{\{last_name\}\}/g,  c?.last_name  || '')
      .replace(/\{\{full_name\}\}/g,  `${c?.first_name||''} ${c?.last_name||''}`.trim())

  const previewContact = [...selected].map(id => filtered.find(c => c.id === id)).filter(Boolean)[0] || filtered[0]

  const send = async () => {
    if (!subject.trim() || !body.trim()) { pushToast('Subject and body are required', 'error'); return }
    if (!selected.size) { pushToast('Select at least one recipient', 'error'); return }
    setSending(true)
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:      'send_email_blast',
        campaign_id: campaign.id,
        contact_ids: [...selected],
        subject, body,
        agent_id: agentId || null,
      }),
    })
    const data = await res.json()
    setSending(false)
    if (!res.ok) { pushToast(data.error || 'Send failed', 'error'); return }
    const msg = `Sent to ${data.sent} contact${data.sent !== 1 ? 's' : ''}${data.skipped > 0 ? ` · ${data.skipped} skipped` : ''}`
    pushToast(msg)
    onSent?.(data)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ padding:'10px 14px', background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:'var(--radius)', fontSize:12, color:'#065f46' }}>
        <strong>Email Blast</strong> — emails are sent individually with merge field personalization. Suppressed contacts are automatically skipped.
        Merge fields: <code style={{fontSize:11}}>{'{{first_name}}'}</code> <code style={{fontSize:11}}>{'{{last_name}}'}</code> <code style={{fontSize:11}}>{'{{full_name}}'}</code>
      </div>

      <div className="form-group" style={{ margin:0 }}>
        <label className="form-label">Subject</label>
        <input className="form-control" placeholder="e.g. {{first_name}}, we have a deal for you" value={subject} onChange={e => setSubject(e.target.value)}/>
      </div>

      <div className="form-group" style={{ margin:0 }}>
        <label className="form-label">Body</label>
        <textarea className="form-control" rows={6} placeholder="Hi {{first_name}},&#10;&#10;…" value={body} onChange={e => setBody(e.target.value)}/>
      </div>

      {preview && previewContact && (
        <div style={{ background:'#f8fafc', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:14 }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--gw-azure)', marginBottom:6, textTransform:'uppercase', letterSpacing:.5 }}>
            Preview — {previewContact.first_name} {previewContact.last_name} ({previewContact.email})
          </div>
          <div style={{ fontWeight:700, fontSize:13, marginBottom:8, borderBottom:'1px solid var(--gw-border)', paddingBottom:8 }}>
            {applyMerge(subject, previewContact) || <span style={{ color:'var(--gw-mist)', fontStyle:'italic' }}>No subject</span>}
          </div>
          <div style={{ fontSize:13, color:'var(--gw-ink)', whiteSpace:'pre-wrap', lineHeight:1.6 }}>
            {applyMerge(body, previewContact) || <span style={{ color:'var(--gw-mist)', fontStyle:'italic' }}>No body</span>}
          </div>
        </div>
      )}

      <div style={{ display:'flex', gap:8 }}>
        <input className="form-control" style={{ flex:1 }} placeholder="Filter recipients by name or email…" value={search} onChange={e => setSearch(e.target.value)}/>
        <select className="form-control" style={{ width:130 }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All Types</option>
          {CONTACT_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
        </select>
        <select className="form-control" style={{ width:150 }} value={agentId} onChange={e => setAgentId(e.target.value)}>
          <option value="">— Agent —</option>
          {(agents||[]).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      <div style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', maxHeight:220, overflowY:'auto' }}>
        <div style={{ padding:'7px 12px', borderBottom:'1px solid var(--gw-border)', background:'var(--gw-bone)', display:'flex', alignItems:'center', gap:8, position:'sticky', top:0 }}>
          <input type="checkbox" ref={cbAllRef}
            checked={selected.size > 0 && selected.size === filtered.length}
            onChange={() => setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map(c => c.id)))}
          />
          <span style={{ fontSize:12, fontWeight:700, color:'var(--gw-mist)' }}>
            {selected.size > 0 ? `${selected.size} selected` : `${filtered.length} contacts with email`}
          </span>
        </div>
        {filtered.length === 0 && (
          <div style={{ padding:24, textAlign:'center', fontSize:13, color:'var(--gw-mist)' }}>No contacts with email addresses match</div>
        )}
        {filtered.map(c => (
          <div key={c.id} onClick={() => toggle(c.id)}
            style={{ padding:'7px 12px', borderBottom:'1px solid var(--gw-border)', display:'flex', alignItems:'center', gap:10, cursor:'pointer', background: selected.has(c.id) ? '#f0f7ff' : '#fff' }}>
            <input type="checkbox" checked={selected.has(c.id)} onChange={() => {}} onClick={e => e.stopPropagation()}/>
            <div style={{ flex:1 }}>
              <span style={{ fontWeight:600, fontSize:13 }}>{c.first_name} {c.last_name}</span>
              {c.type && <span style={{ marginLeft:6, fontSize:11, background:'var(--gw-bone)', color:'var(--gw-mist)', padding:'1px 6px', borderRadius:8, fontWeight:600 }}>{c.type}</span>}
              <span style={{ marginLeft:8, fontSize:11, color:'var(--gw-mist)' }}>{c.email}</span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display:'flex', gap:8, justifyContent:'space-between', alignItems:'center' }}>
        <button className="btn btn--ghost btn--sm" onClick={() => setPreview(p => !p)}>
          <Icon name="eye" size={13}/> {preview ? 'Hide Preview' : 'Preview Email'}
        </button>
        <div style={{ display:'flex', gap:8 }}>
          {onCancel && <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>}
          <button className="btn btn--primary" onClick={send} disabled={sending || !selected.size || !subject.trim() || !body.trim()}>
            <Icon name="send" size={13}/> {sending ? 'Sending…' : `Send to ${selected.size || 0}`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Campaign detail drawer ────────────────────────────────────────────────────
function CampaignDrawer({ campaign, contacts, agents, activeAgent, coldLeads, properties, onUpdate, onClose }) {
  const [tab,          setTab]          = useState('sends')
  const [sends,        setSends]        = useState([])
  const [suppressions, setSuppressions] = useState([])
  const [analytics,    setAnalytics]    = useState(null)
  const [loading,      setLoading]      = useState(false)
  const [logOpen,      setLogOpen]      = useState(false)
  const [bulkOpen,     setBulkOpen]     = useState(false)
  const [editOpen,     setEditOpen]     = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [generatingQR, setGeneratingQR] = useState(false)
  const [addSupp,      setAddSupp]      = useState(false)
  const [suppForm,     setSuppForm]     = useState({ full_name:'', address:'', reason:'dnc', notes:'' })
  const [confirmDel,   setConfirmDel]   = useState(null)

  // Send log filters
  const [logFilter, setLogFilter] = useState({ response: '', channel: '', agent_id: '' })

  useEffect(() => { loadSends(); loadAnalytics() }, [campaign.id])
  useEffect(() => { if (tab === 'suppression') loadSuppressions() }, [tab])

  const loadSends = async () => {
    setLoading(true)
    const res  = await fetch(`/api/campaigns?action=list_sends&campaign_id=${campaign.id}&limit=500`)
    const data = await res.json()
    setSends(data.sends || [])
    setLoading(false)
  }

  const loadAnalytics = async () => {
    const res  = await fetch(`/api/campaigns?action=campaign_analytics&campaign_id=${campaign.id}`)
    const data = await res.json()
    setAnalytics(data.analytics || null)
  }

  const loadSuppressions = async () => {
    const res  = await fetch(`/api/campaigns?action=list_suppressions`)
    const data = await res.json()
    setSuppressions(data.suppressions || [])
  }

  const generateQR = async () => {
    setGeneratingQR(true)
    const res  = await fetch('/api/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'generate_qr', campaign_id: campaign.id }),
    })
    const data = await res.json()
    setGeneratingQR(false)
    if (!res.ok || data.error) { pushToast(data.error || 'QR generation failed', 'error'); return }
    onUpdate(data.campaign)
    pushToast('QR code generated')
  }

  const deleteSend = async (id) => {
    await fetch('/api/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_send', id }),
    })
    setSends(p => p.filter(s => s.id !== id))
    loadAnalytics()
    pushToast('Send removed')
  }

  const updateResponse = async (send, response) => {
    const res  = await fetch('/api/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_send', id: send.id, response }),
    })
    const data = await res.json()
    setSends(p => p.map(s => s.id === send.id ? data.send : s))
    loadAnalytics()
    if (response === 'interested') pushToast('Follow-up task created', 'info')
  }

  const addSuppression = async () => {
    const res = await fetch('/api/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add_suppression', ...suppForm, agent_id: activeAgent?.id }),
    })
    const data = await res.json()
    if (!res.ok) { pushToast(data.error, 'error'); return }
    setSuppressions(p => [data.suppression, ...p])
    setSuppForm({ full_name:'', address:'', reason:'dnc', notes:'' })
    setAddSupp(false)
    pushToast('Added to suppression list')
  }

  const removeSupp = async (id) => {
    await fetch('/api/campaigns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'remove_suppression', id }),
    })
    setSuppressions(p => p.filter(s => s.id !== id))
    pushToast('Removed from suppression list')
  }

  const findContact = id => contacts?.find(c => c.id === id)
  const findAgent   = id => agents?.find(a => a.id === id)

  const filteredSends = useMemo(() => {
    return sends.filter(s => {
      if (logFilter.response && s.response !== logFilter.response) return false
      if (logFilter.channel  && s.channel  !== logFilter.channel)  return false
      if (logFilter.agent_id && s.agent_id !== logFilter.agent_id) return false
      return true
    })
  }, [sends, logFilter])

  const hasFilter = logFilter.response || logFilter.channel || logFilter.agent_id

  const responseRate   = analytics ? analytics.response_rate   : 0
  const conversionRate = analytics ? analytics.conversion_rate : 0

  const tabs = [
    ['sends',       `Send Log${sends.length > 0 ? ` (${sends.length})` : ''}`],
    ['analytics',   'Analytics'],
    ['compose',     campaign.channel === 'email' ? 'Email Blast' : 'Compose'],
    ['suppression', 'Suppression'],
  ]

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
      {/* Header */}
      <div style={{ padding:'20px 24px 0', borderBottom:'1px solid var(--gw-border)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
              <h2 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>{campaign.name}</h2>
              <StatusBadge status={campaign.status}/>
              <ChannelBadge channel={campaign.channel || 'mail'}/>
            </div>
            {campaign.description && <div style={{ fontSize:13, color:'var(--gw-mist)', marginTop:4 }}>{campaign.description}</div>}
            {campaign.property_types?.length > 0 && (
              <div style={{ display:'flex', gap:5, marginTop:6, flexWrap:'wrap' }}>
                {campaign.property_types.map(t => (
                  <span key={t} style={{ padding:'2px 8px', borderRadius:8, fontSize:11, fontWeight:700, background:'#dbeafe', color:'#1d4ed8' }}>{t}</span>
                ))}
              </div>
            )}
          </div>
          <div style={{ display:'flex', gap:6, flexWrap:'wrap', flexShrink:0 }}>
            {campaign.qr_code_url
              ? <a href={campaign.qr_code_url} target="_blank" rel="noopener noreferrer" className="btn btn--ghost btn--sm">
                  <Icon name="qr-code" size={13}/> QR Code
                </a>
              : (campaign.channel === 'mail' || !campaign.channel) &&
                <button className="btn btn--ghost btn--sm" onClick={generateQR} disabled={generatingQR}>
                  <Icon name="qr-code" size={13}/> {generatingQR ? 'Generating…' : 'Generate QR'}
                </button>
            }
            {campaign.tracking_url && (
              <a href={campaign.tracking_url} target="_blank" rel="noopener noreferrer" className="btn btn--ghost btn--sm">
                <Icon name="link" size={13}/> Link
              </a>
            )}
            <button className="btn btn--ghost btn--sm" onClick={() => setEditOpen(true)}>
              <Icon name="edit" size={13}/> Edit
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => setBulkOpen(true)}>
              <Icon name="users" size={13}/> Bulk Log
            </button>
            <button className="btn btn--primary btn--sm" onClick={() => setLogOpen(true)}>
              <Icon name="plus" size={13}/> Log Send
            </button>
          </div>
        </div>

        {/* Stats */}
        <div style={{ display:'flex', gap:10, marginBottom:14, flexWrap:'wrap' }}>
          <StatCard value={analytics?.total       ?? sends.length} label="Total Sends"/>
          <StatCard value={analytics?.responded   ?? 0}            label="Responded" color={analytics?.responded > 0 ? 'var(--gw-azure)' : undefined}/>
          <StatCard value={`${responseRate}%`}   label="Response Rate" sub="avg ~5–15%" color={responseRate > 12 ? 'var(--gw-green)' : undefined}/>
          <StatCard value={`${conversionRate}%`} label="Conversion" color={conversionRate > 0 ? '#7c3aed' : undefined}/>
          <StatCard value={analytics?.converted  ?? 0}             label="Deals" color={analytics?.converted > 0 ? '#059669' : undefined}/>
        </div>

        {/* Tabs */}
        <div style={{ display:'flex', gap:0, borderBottom:'1px solid transparent' }}>
          {tabs.map(([v, l]) => (
            <button key={v} onClick={() => setTab(v)}
              style={{ padding:'8px 16px', fontSize:13, fontWeight:600, cursor:'pointer', border:'none', background:'transparent',
                borderBottom: tab === v ? '2.5px solid var(--gw-azure)' : '2.5px solid transparent',
                color: tab === v ? 'var(--gw-azure)' : 'var(--gw-mist)' }}>{l}</button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div style={{ flex:1, overflowY:'auto', padding:'16px 24px' }}>

        {/* ── Send Log ── */}
        {tab === 'sends' && (
          loading
            ? <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:32, fontSize:13 }}>Loading…</div>
            : (
              <div>
                {sends.length > 0 && (
                  <div style={{ display:'flex', gap:8, marginBottom:12, flexWrap:'wrap', alignItems:'center' }}>
                    <select className="form-control" style={{ width:140 }} value={logFilter.response} onChange={e => setLogFilter(p=>({...p,response:e.target.value}))}>
                      <option value="">All Responses</option>
                      {RESPONSE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <select className="form-control" style={{ width:130 }} value={logFilter.channel} onChange={e => setLogFilter(p=>({...p,channel:e.target.value}))}>
                      <option value="">All Channels</option>
                      {CHANNEL_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <select className="form-control" style={{ width:140 }} value={logFilter.agent_id} onChange={e => setLogFilter(p=>({...p,agent_id:e.target.value}))}>
                      <option value="">All Agents</option>
                      {(agents||[]).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    {hasFilter && (
                      <button className="btn btn--ghost btn--sm" onClick={() => setLogFilter({ response:'', channel:'', agent_id:'' })}>
                        Clear
                      </button>
                    )}
                    <div style={{ flex:1 }}/>
                    <button className="btn btn--ghost btn--sm" onClick={() => exportCSV(filteredSends, contacts, agents, campaign)}>
                      <Icon name="download" size={13}/> Export CSV
                    </button>
                    {hasFilter && (
                      <span style={{ fontSize:12, color:'var(--gw-mist)' }}>{filteredSends.length} of {sends.length}</span>
                    )}
                  </div>
                )}
                {filteredSends.length === 0
                  ? sends.length === 0
                    ? <EmptyState icon="mail" title="No sends yet" message="Click 'Log Send' to record outreach, or use 'Bulk Log' to add multiple at once." action={<button className="btn btn--primary btn--sm" onClick={()=>setLogOpen(true)}>Log Send</button>}/>
                    : <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:28, fontSize:13 }}>No sends match the current filters.</div>
                  : (
                    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
                      {filteredSends.map(s => {
                        const contact = s.contact_id ? findContact(s.contact_id) : null
                        const agent   = s.agent_id   ? findAgent(s.agent_id)     : null
                        const name    = contact ? `${contact.first_name} ${contact.last_name}` : s.recipient_name || '—'
                        const addr    = s.recipient_address || contact?.owner_address || ''
                        return (
                          <div key={s.id} style={{ padding:'10px 0', borderBottom:'1px solid var(--gw-border)', display:'grid', gridTemplateColumns:'1fr auto', gap:8, alignItems:'start' }}>
                            <div>
                              <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                                <span style={{ fontWeight:700, fontSize:13 }}>{name}</span>
                                <ChannelBadge channel={s.channel}/>
                                <ResponseBadge response={s.response}/>
                              </div>
                              {addr && (
                                <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>
                                  {addr}{s.recipient_city ? `, ${s.recipient_city}` : ''}{s.recipient_state ? ` ${s.recipient_state}` : ''}{s.recipient_zip ? ` ${s.recipient_zip}` : ''}
                                </div>
                              )}
                              <div style={{ display:'flex', gap:10, marginTop:4, fontSize:11, color:'var(--gw-mist)', flexWrap:'wrap' }}>
                                <span>{new Date(s.sent_at).toLocaleDateString()}</span>
                                {agent && <span>· {agent.name}</span>}
                                {s.notes && <span>· {s.notes}</span>}
                              </div>
                            </div>
                            <div style={{ display:'flex', gap:6, alignItems:'center', flexShrink:0 }}>
                              <select value={s.response} onChange={e => updateResponse(s, e.target.value)}
                                style={{ fontSize:11, padding:'3px 6px', borderRadius:6, border:'1px solid var(--gw-border)', cursor:'pointer', background:'#fff' }}>
                                {RESPONSE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                              <button className="btn btn--ghost btn--icon btn--sm" onClick={() => setConfirmDel(s.id)} title="Remove">
                                <Icon name="trash" size={13}/>
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                }
              </div>
            )
        )}

        {/* ── Analytics ── */}
        {tab === 'analytics' && (
          analytics && analytics.total > 0
            ? (
              <div style={{ display:'flex', flexDirection:'column', gap:24 }}>
                {/* Funnel */}
                <div>
                  <div className="eyebrow-label" style={{ marginBottom:10 }}>Conversion Funnel</div>
                  <FunnelChart analytics={analytics}/>
                </div>

                {/* Channel breakdown */}
                <div>
                  <div className="eyebrow-label" style={{ marginBottom:8 }}>Sends by Channel</div>
                  {Object.entries(analytics.by_channel || {}).map(([ch, n]) => (
                    <div key={ch} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                      <div style={{ width:90, flexShrink:0 }}><ChannelBadge channel={ch}/></div>
                      <div style={{ flex:1, height:8, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden' }}>
                        <div style={{ width:`${Math.round(n/analytics.total*100)}%`, height:'100%', background:'var(--gw-azure)', borderRadius:4 }}/>
                      </div>
                      <span style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', minWidth:28, textAlign:'right' }}>{n}</span>
                    </div>
                  ))}
                </div>

                {/* Response breakdown */}
                <div>
                  <div className="eyebrow-label" style={{ marginBottom:8 }}>Response Breakdown</div>
                  {Object.entries(analytics.by_response || {}).map(([r, n]) => (
                    <div key={r} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
                      <div style={{ width:90, flexShrink:0 }}><ResponseBadge response={r}/></div>
                      <div style={{ flex:1, height:8, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden' }}>
                        <div style={{ width:`${Math.round(n/analytics.total*100)}%`, height:'100%', background:'var(--gw-green)', borderRadius:4 }}/>
                      </div>
                      <span style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', minWidth:52, textAlign:'right' }}>
                        {n} ({Math.round(n/analytics.total*100)}%)
                      </span>
                    </div>
                  ))}
                </div>

                {/* Monthly volume */}
                {Object.keys(analytics.by_month || {}).length > 0 && (
                  <div>
                    <div className="eyebrow-label" style={{ marginBottom:8 }}>Monthly Volume</div>
                    {(() => {
                      const entries = Object.entries(analytics.by_month || {}).sort(([a],[b]) => a.localeCompare(b))
                      const maxVal  = Math.max(...entries.map(([,v]) => v))
                      return entries.map(([mo, n]) => (
                        <div key={mo} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:5 }}>
                          <span style={{ fontSize:12, fontWeight:700, minWidth:60, flexShrink:0 }}>{mo}</span>
                          <div style={{ flex:1, height:8, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden' }}>
                            <div style={{ width:`${Math.round(n/maxVal*100)}%`, height:'100%', background:'var(--gw-azure)', borderRadius:4 }}/>
                          </div>
                          <span style={{ fontSize:12, color:'var(--gw-mist)', minWidth:28, textAlign:'right' }}>{n}</span>
                        </div>
                      ))
                    })()}
                  </div>
                )}

                {/* Top zips */}
                {Object.keys(analytics.by_zip || {}).length > 0 && (
                  <div>
                    <div className="eyebrow-label" style={{ marginBottom:8 }}>Top Zip Codes</div>
                    {(() => {
                      const entries = Object.entries(analytics.by_zip || {}).sort((a,b) => b[1]-a[1]).slice(0, 10)
                      const maxVal  = entries[0]?.[1] || 1
                      return entries.map(([zip, n]) => (
                        <div key={zip} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:5 }}>
                          <span style={{ fontSize:12, fontWeight:700, minWidth:55, flexShrink:0 }}>{zip}</span>
                          <div style={{ flex:1, height:6, background:'var(--gw-bone)', borderRadius:4, overflow:'hidden' }}>
                            <div style={{ width:`${Math.round(n/maxVal*100)}%`, height:'100%', background:'var(--gw-azure)', borderRadius:4 }}/>
                          </div>
                          <span style={{ fontSize:12, color:'var(--gw-mist)', minWidth:20, textAlign:'right' }}>{n}</span>
                        </div>
                      ))
                    })()}
                  </div>
                )}

                {/* Benchmark */}
                <div style={{ padding:'12px 14px', background:'var(--gw-bone)', borderRadius:'var(--radius)', fontSize:12, lineHeight:1.6 }}>
                  <strong>Industry Benchmark:</strong> Direct mail typically 1–5% cold, 8–15% warm. Cold call connect rates ~5–10%.
                  {responseRate > 15 && <span style={{ color:'var(--gw-green)', fontWeight:700 }}> Your {responseRate}% is well above benchmark. 🏆</span>}
                  {responseRate > 8 && responseRate <= 15 && <span style={{ color:'var(--gw-green)', fontWeight:700 }}> Your {responseRate}% is above average. Keep it up!</span>}
                  {responseRate > 0 && responseRate <= 5 && <span style={{ color:'var(--gw-mist)' }}> Consider tightening your target list or updating your flyer.</span>}
                </div>
              </div>
            )
            : <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:40, fontSize:13 }}>No data yet — log some sends first.</div>
        )}

        {/* ── Compose / Email Blast ── */}
        {tab === 'compose' && (
          <EmailBlastPanel
            campaign={campaign}
            contacts={contacts}
            agents={agents}
            activeAgent={activeAgent}
            onSent={(result) => {
              loadSends()
              loadAnalytics()
              pushToast(`Blast complete: ${result.sent} sent${result.skipped ? `, ${result.skipped} skipped` : ''}`)
            }}
          />
        )}

        {/* ── Suppression List ── */}
        {tab === 'suppression' && (
          <div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
              <div style={{ fontSize:13, color:'var(--gw-mist)' }}>Global DNC / opt-out list. Applies across all campaigns.</div>
              <button className="btn btn--ghost btn--sm" onClick={() => setAddSupp(true)}>
                <Icon name="plus" size={13}/> Add Entry
              </button>
            </div>
            {addSupp && (
              <div style={{ background:'var(--gw-bone)', borderRadius:'var(--radius)', padding:14, marginBottom:14 }}>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, marginBottom:8 }}>
                  <input className="form-control" placeholder="Full name" value={suppForm.full_name} onChange={e => setSuppForm(p=>({...p,full_name:e.target.value}))}/>
                  <input className="form-control" placeholder="Address / email / phone" value={suppForm.address} onChange={e => setSuppForm(p=>({...p,address:e.target.value}))}/>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:8, marginBottom:8 }}>
                  <select className="form-control" value={suppForm.reason} onChange={e => setSuppForm(p=>({...p,reason:e.target.value}))}>
                    <option value="dnc">DNC</option>
                    <option value="opted-out">Opted Out</option>
                    <option value="deceased">Deceased</option>
                    <option value="returned-mail">Returned Mail</option>
                    <option value="other">Other</option>
                  </select>
                  <input className="form-control" placeholder="Notes (optional)" value={suppForm.notes} onChange={e => setSuppForm(p=>({...p,notes:e.target.value}))}/>
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  <button className="btn btn--ghost btn--sm" onClick={()=>setAddSupp(false)}>Cancel</button>
                  <button className="btn btn--primary btn--sm" onClick={addSuppression}>Add to List</button>
                </div>
              </div>
            )}
            {suppressions.length === 0
              ? <div style={{ textAlign:'center', color:'var(--gw-mist)', padding:32, fontSize:13 }}>No suppressed entries yet.</div>
              : suppressions.map(s => (
                <div key={s.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0', borderBottom:'1px solid var(--gw-border)' }}>
                  <div>
                    <span style={{ fontWeight:700, fontSize:13 }}>{s.full_name || s.address || s.email || s.phone || '—'}</span>
                    <span style={{ marginLeft:8, padding:'2px 8px', borderRadius:8, fontSize:11, fontWeight:700, background:'var(--gw-red-light)', color:'var(--gw-red)' }}>{s.reason}</span>
                    {s.notes && <span style={{ fontSize:11, color:'var(--gw-mist)', marginLeft:8 }}>{s.notes}</span>}
                  </div>
                  <button className="btn btn--ghost btn--icon btn--sm" onClick={()=>removeSupp(s.id)} title="Remove">
                    <Icon name="trash" size={13}/>
                  </button>
                </div>
              ))
            }
          </div>
        )}
      </div>

      {/* Modals */}
      {logOpen && (
        <LogSendModal
          campaign={campaign}
          contacts={contacts}
          agents={agents}
          activeAgent={activeAgent}
          coldLeads={coldLeads}
          onSave={send => { setSends(p => [send, ...p]); setLogOpen(false); loadAnalytics(); pushToast('Send logged') }}
          onClose={() => setLogOpen(false)}
        />
      )}
      {bulkOpen && (
        <BulkLogModal
          campaign={campaign}
          contacts={contacts}
          agents={agents}
          activeAgent={activeAgent}
          onSave={newSends => { setSends(p => [...newSends, ...p]); setBulkOpen(false); loadAnalytics() }}
          onClose={() => setBulkOpen(false)}
        />
      )}
      {editOpen && (
        <Modal open={true} onClose={() => setEditOpen(false)} width={560}>
          <div className="modal__head">
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>Edit Campaign</h3>
            <button className="drawer__close" onClick={() => setEditOpen(false)}><Icon name="x" size={18}/></button>
          </div>
          <div className="modal__body">
            <CampaignForm
              initial={campaign}
              agents={agents}
              properties={properties}
              activeAgent={activeAgent}
              saving={saving}
              onCancel={() => setEditOpen(false)}
              onSave={async form => {
                setSaving(true)
                const res  = await fetch('/api/campaigns', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'update_campaign', ...form }) })
                const data = await res.json()
                setSaving(false)
                if (!res.ok) { pushToast(data.error || 'Update failed', 'error'); return }
                onUpdate(data.campaign)
                setEditOpen(false)
                pushToast('Campaign updated')
              }}
            />
          </div>
        </Modal>
      )}
      {confirmDel && (
        <ConfirmDialog
          title="Remove Send"
          message="Remove this send record? This cannot be undone."
          onConfirm={() => { deleteSend(confirmDel); setConfirmDel(null) }}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function CampaignsPage({ db, setDb, activeAgent }) {
  const [campaigns,    setCampaigns]    = useState([])
  const [agents,       setAgents]       = useState([])
  const [contacts,     setContacts]     = useState([])
  const [coldLeads,    setColdLeads]    = useState([])
  const [properties,   setProperties]   = useState([])
  const [loading,      setLoading]      = useState(true)
  const [selected,     setSelected]     = useState(null)
  const [newOpen,      setNewOpen]      = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [search,       setSearch]       = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [chanFilter,   setChanFilter]   = useState('all')
  const [ready,        setReady]        = useState(true)

  useEffect(() => { loadAll() }, [])

  const loadAll = async () => {
    setLoading(true)
    const [campRes, agentsRes, contactsRes, propsRes] = await Promise.all([
      fetch('/api/campaigns?action=list_campaigns'),
      supabase.from('agents').select('id, name, initials, color').order('name'),
      supabase.from('contacts').select('id, first_name, last_name, email, phone, type, asset_types, owner_address, owner_city, owner_state, owner_zip').order('last_name'),
      supabase.from('properties').select('id, address, city, state, zip').order('address'),
    ])

    if (!campRes.ok) {
      const err = await campRes.json()
      if (err.error?.includes('does not exist') || err.error?.includes('relation')) setReady(false)
      setLoading(false)
      return
    }

    const campData = await campRes.json()
    setCampaigns(campData.campaigns || [])
    setAgents(agentsRes.data || [])
    setContacts(contactsRes.data || [])
    setProperties(propsRes.data || [])

    supabase.from('cold_call_leads').select('id, owner_name, contact_name, property_address, list_id').limit(500).then(({ data }) => {
      setColdLeads(data || [])
    })

    setLoading(false)
  }

  const createCampaign = async (form) => {
    setSaving(true)
    const res  = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create_campaign', ...form }),
    })
    const data = await res.json()
    setSaving(false)
    if (!res.ok || data.error) { pushToast(data.error || 'Failed to create campaign', 'error'); return }
    setCampaigns(p => [data.campaign, ...p])
    setNewOpen(false)
    setSelected(data.campaign)
    pushToast('Campaign created')
  }

  const updateCampaign = (updated) => {
    setCampaigns(p => p.map(c => c.id === updated.id ? updated : c))
    if (selected?.id === updated.id) setSelected(updated)
  }

  const deleteCampaign = async (id) => {
    await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_campaign', id }),
    })
    setCampaigns(p => p.filter(c => c.id !== id))
    if (selected?.id === id) setSelected(null)
    pushToast('Campaign deleted')
  }

  const filtered = campaigns.filter(c => {
    if (statusFilter !== 'all' && c.status   !== statusFilter)   return false
    if (chanFilter   !== 'all' && (c.channel || 'mail') !== chanFilter) return false
    if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const totalSends     = campaigns.reduce((n, c) => n + (c.total_sends     || 0), 0)
  const totalResponses = campaigns.reduce((n, c) => n + (c.total_responses || 0), 0)
  const overallRate    = totalSends > 0 ? Math.round(totalResponses / totalSends * 100) : 0

  if (!ready) {
    return (
      <div style={{ padding:40, maxWidth:560 }}>
        <h2 style={{ fontFamily:'var(--font-display)' }}>Campaign Tracking</h2>
        <p style={{ color:'var(--gw-mist)' }}>
          Run the following SQL in your <strong>Supabase SQL Editor</strong> to enable this feature, then click <em>Check Again</em>:
        </p>
        <pre style={{ background:'var(--gw-bone)', padding:16, borderRadius:8, fontSize:12, overflowX:'auto', whiteSpace:'pre-wrap' }}>
{`-- Core tables
CREATE TABLE IF NOT EXISTS mail_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  status text DEFAULT 'active',
  channel text DEFAULT 'mail',
  property_types text[] DEFAULT '{}',
  agent_id uuid,
  property_id uuid,
  qr_target text DEFAULT 'crm_landing',
  tracking_url text,
  qr_code_url text,
  bitly_id text,
  frequency_cap int DEFAULT 0,
  frequency_days int DEFAULT 30,
  email_subject text,
  email_body text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mail_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES mail_campaigns(id) ON DELETE CASCADE,
  contact_id uuid,
  cold_lead_id uuid,
  recipient_name text,
  recipient_address text,
  recipient_city text,
  recipient_state text,
  recipient_zip text,
  channel text DEFAULT 'mail',
  sent_at timestamptz DEFAULT now(),
  responded_at timestamptz,
  agent_id uuid,
  response text DEFAULT 'no-response',
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mail_suppressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid,
  full_name text,
  address text,
  email text,
  phone text,
  reason text DEFAULT 'dnc',
  notes text,
  agent_id uuid,
  created_at timestamptz DEFAULT now()
);`}
        </pre>
        <button className="btn btn--primary" onClick={loadAll}>Check Again</button>
      </div>
    )
  }

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>
      {/* ── Left: campaign list ── */}
      <div style={{ width: selected ? 380 : '100%', minWidth:300, flexShrink:0, display:'flex', flexDirection:'column', borderRight: selected ? '1px solid var(--gw-border)' : 'none', overflow:'hidden' }}>

        <div style={{ padding:'20px 24px 12px', borderBottom:'1px solid var(--gw-border)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
            <div>
              <h1 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:22 }}>Campaigns</h1>
              <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:2 }}>Mail · Cold Call · Email · SMS</div>
            </div>
            <button className="btn btn--primary btn--sm" onClick={() => setNewOpen(true)}>
              <Icon name="plus" size={13}/> New Campaign
            </button>
          </div>

          <div style={{ display:'flex', gap:10, marginBottom:12, flexWrap:'wrap' }}>
            <StatCard value={campaigns.length} label="Campaigns"/>
            <StatCard value={totalSends}        label="Total Sends"/>
            <StatCard value={`${overallRate}%`} label="Avg Response" color={overallRate > 12 ? 'var(--gw-green)' : undefined}/>
          </div>

          <div style={{ display:'flex', gap:8 }}>
            <input className="form-control" style={{ flex:1 }} placeholder="Search campaigns…" value={search} onChange={e => setSearch(e.target.value)}/>
            <select className="form-control" style={{ width:120 }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">All Statuses</option>
              {Object.entries(STATUS_CONFIG).map(([v,c]) => <option key={v} value={v}>{c.label}</option>)}
            </select>
            <select className="form-control" style={{ width:120 }} value={chanFilter} onChange={e => setChanFilter(e.target.value)}>
              <option value="all">All Channels</option>
              {CHANNEL_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'8px 0' }}>
          {loading
            ? <div style={{ textAlign:'center', padding:40, color:'var(--gw-mist)', fontSize:13 }}>Loading…</div>
            : filtered.length === 0
              ? <EmptyState icon="mail" title="No campaigns yet" message="Create your first campaign to start tracking mail, calls, and email outreach." action={<button className="btn btn--primary btn--sm" onClick={()=>setNewOpen(true)}>New Campaign</button>}/>
              : filtered.map(c => {
                const responseRate = c.total_sends > 0 ? Math.round(c.total_responses / c.total_sends * 100) : 0
                const agent = agents.find(a => a.id === c.agent_id)
                const chan  = CHANNEL_CONFIG[c.channel || 'mail']
                return (
                  <div key={c.id}
                    onClick={() => setSelected(selected?.id === c.id ? null : c)}
                    style={{
                      padding:'14px 20px',
                      cursor:'pointer',
                      borderBottom:'1px solid var(--gw-border)',
                      background: selected?.id === c.id ? '#f0f7ff' : '#fff',
                      borderLeft: selected?.id === c.id ? '3px solid var(--gw-azure)' : '3px solid transparent',
                    }}>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8 }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:7, flexWrap:'wrap' }}>
                          <span style={{ fontWeight:700, fontSize:14, color:'var(--gw-ink)' }}>{c.name}</span>
                          <StatusBadge status={c.status}/>
                          <span style={{ fontSize:10, fontWeight:700, background: chan.bg, color: chan.color, padding:'2px 7px', borderRadius:8 }}>
                            {chan.label}
                          </span>
                        </div>
                        {c.property_types?.length > 0 && (
                          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:3 }}>
                            {c.property_types.slice(0,3).map(t => t.charAt(0).toUpperCase()+t.slice(1)).join(' · ')}
                            {c.property_types.length > 3 && ` +${c.property_types.length-3}`}
                          </div>
                        )}
                        <div style={{ display:'flex', gap:12, marginTop:6, fontSize:12, color:'var(--gw-mist)', flexWrap:'wrap' }}>
                          <span><strong style={{ color:'var(--gw-ink)' }}>{c.total_sends || 0}</strong> sends</span>
                          <span><strong style={{ color: responseRate > 0 ? 'var(--gw-azure)' : 'var(--gw-mist)' }}>{responseRate}%</strong> response</span>
                          {agent && <span>· {agent.name}</span>}
                          {c.last_send_at && <span>· Last {new Date(c.last_send_at).toLocaleDateString()}</span>}
                        </div>
                      </div>
                      {c.frequency_cap > 0 && (
                        <span title={`Cap: ${c.frequency_cap} sends per ${c.frequency_days} days`}
                          style={{ fontSize:10, fontWeight:700, color:'var(--gw-mist)', background:'var(--gw-bone)', padding:'2px 6px', borderRadius:8, whiteSpace:'nowrap', flexShrink:0 }}>
                          cap {c.frequency_cap}/{c.frequency_days}d
                        </span>
                      )}
                    </div>
                  </div>
                )
              })
          }
        </div>
      </div>

      {/* ── Right: detail panel ── */}
      {selected && (
        <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}>
          <div style={{ padding:'10px 16px', borderBottom:'1px solid var(--gw-border)', display:'flex', justifyContent:'flex-end', gap:8 }}>
            <button className="btn btn--ghost btn--sm" style={{ color:'var(--gw-red)' }}
              onClick={() => {
                if (confirm(`Delete campaign "${selected.name}"? All send history will be lost.`)) deleteCampaign(selected.id)
              }}>
              <Icon name="trash" size={13}/> Delete
            </button>
            <button className="btn btn--ghost btn--icon btn--sm" onClick={() => setSelected(null)}>
              <Icon name="x" size={16}/>
            </button>
          </div>
          <div style={{ flex:1, overflow:'auto' }}>
            <CampaignDrawer
              campaign={selected}
              contacts={contacts}
              agents={agents}
              activeAgent={activeAgent}
              coldLeads={coldLeads}
              properties={properties}
              onUpdate={updateCampaign}
              onClose={() => setSelected(null)}
            />
          </div>
        </div>
      )}

      {/* New campaign modal */}
      {newOpen && (
        <Modal open={true} onClose={() => setNewOpen(false)} width={580}>
          <div className="modal__head">
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>New Campaign</h3>
            <button className="drawer__close" onClick={() => setNewOpen(false)}><Icon name="x" size={18}/></button>
          </div>
          <div className="modal__body">
            <CampaignForm
              agents={agents}
              properties={properties}
              activeAgent={activeAgent}
              saving={saving}
              onCancel={() => setNewOpen(false)}
              onSave={createCampaign}
            />
          </div>
        </Modal>
      )}
    </div>
  )
}
