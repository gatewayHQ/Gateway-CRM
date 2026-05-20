/**
 * Gateway CRM — Campaigns / Mailings (v2)
 *
 * A clean, focused dashboard for tracking physical mail campaigns.
 *
 *  • Create a mailing → mints a unique QR token
 *  • Upload recipients via CSV/Excel, or pick from contacts DB
 *  • Generate QR code (copy URL or download SVG for Canva/print)
 *  • Configure landing page (property showcase, home valuation, or custom URL)
 *  • Track scans + lead captures in real time
 *  • Per-mailing analytics + agent-filtered org dashboard
 */

import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Modal, pushToast, EmptyState, ConfirmDialog } from '../components/UI.jsx'

const MAILING_TYPE_OPTS = [
  { value: 'postcard',    label: 'Postcard'    },
  { value: 'letter',      label: 'Letter'      },
  { value: 'flyer',       label: 'Flyer'       },
  { value: 'door-hanger', label: 'Door Hanger' },
  { value: 'other',       label: 'Other'       },
]

const LANDING_OPTS = [
  { value: 'property',  label: 'Property Showcase', sub: 'Show the linked property + capture interest' },
  { value: 'valuation', label: 'Home Valuation',    sub: 'Ask "what\'s your home worth?" + capture seller leads' },
  { value: 'custom',    label: 'Custom URL',        sub: 'Redirect to any URL you control' },
]

const STATUS_CONFIG = {
  draft:    { label: 'Draft',    bg: 'var(--gw-bone)',        color: 'var(--gw-mist)'  },
  active:   { label: 'Active',   bg: '#dbeafe',               color: '#1d4ed8'         },
  sent:     { label: 'Sent',     bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  archived: { label: 'Archived', bg: '#f3f4f6',               color: '#6b7280'         },
}

function StatusBadge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.draft
  return <span style={{ padding:'2px 9px', borderRadius:10, fontSize:11, fontWeight:700, background:c.bg, color:c.color }}>{c.label}</span>
}

function StatCard({ value, label, sub, color }) {
  return (
    <div style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:'14px 18px', minWidth:120 }}>
      <div style={{ fontSize:28, fontWeight:800, color: color || 'var(--gw-ink)', fontFamily:'var(--font-display)', lineHeight:1 }}>{value}</div>
      <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginTop:3 }}>{label}</div>
      {sub && <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:1 }}>{sub}</div>}
    </div>
  )
}

// ─── QR code utilities ────────────────────────────────────────────────────────

function qrImageUrl(token, opts = {}) {
  const { size = 400, format = 'png', margin = 1 } = opts
  const target = `${window.location.origin}/m/${token}`
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&format=${format}&margin=${margin}&data=${encodeURIComponent(target)}`
}

function shortUrl(token) {
  return `${window.location.origin}/m/${token}`
}

// ─── CSV parser (handles quoted fields with commas/newlines) ──────────────────

function parseCSV(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++ }
      else if (c === '"') { inQuotes = false }
      else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { row.push(field); field = '' }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && next === '\n') i++
        row.push(field); rows.push(row); row = []; field = ''
      }
      else field += c
    }
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim()))
}

function autoMapColumns(headers) {
  // Best-guess mapping of CSV column headers → recipient fields
  const map = {}
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i])
    if (map.recipient_name === undefined && /^(name|fullname|recipient|contact)$/.test(h)) map.recipient_name = i
    if (map.first_name === undefined && /^firstname$/.test(h)) map.first_name = i
    if (map.last_name === undefined && /^lastname$/.test(h)) map.last_name = i
    if (map.address_line1 === undefined && /^(address|street|addr|address1|addressline1|streetaddress)$/.test(h)) map.address_line1 = i
    if (map.address_line2 === undefined && /^(address2|addressline2|unit|apt|suite)$/.test(h)) map.address_line2 = i
    if (map.city === undefined && /^city$/.test(h)) map.city = i
    if (map.state === undefined && /^(state|st|province)$/.test(h)) map.state = i
    if (map.zip === undefined && /^(zip|zipcode|postal|postalcode)$/.test(h)) map.zip = i
  }
  return map
}

// ─── API helper ───────────────────────────────────────────────────────────────

async function api(action, payload = {}, method = 'POST') {
  if (method === 'GET') {
    const qs = new URLSearchParams({ action, ...payload }).toString()
    const r = await fetch(`/api/campaigns?${qs}`)
    return r.json()
  }
  const r = await fetch('/api/campaigns', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  return r.json()
}

// ─── New / Edit Mailing form ──────────────────────────────────────────────────

function MailingForm({ initial, agents, properties, onSave, onCancel, saving }) {
  const [form, setForm] = useState(() => ({
    name:               initial?.name               || '',
    description:        initial?.description        || '',
    agent_id:           initial?.agent_id           || '',
    property_id:        initial?.property_id        || '',
    mailing_type:       initial?.mailing_type       || 'postcard',
    landing_type:       initial?.landing_type       || 'property',
    landing_custom_url: initial?.landing_custom_url || '',
    send_date:          initial?.send_date          || '',
    status:             initial?.status             || 'draft',
  }))
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const submit = (e) => {
    e.preventDefault()
    if (!form.name.trim()) return pushToast('Name is required', 'error')
    if (form.landing_type === 'property' && !form.property_id) {
      return pushToast('Select a property for property-showcase landing, or change landing type', 'error')
    }
    if (form.landing_type === 'custom' && !form.landing_custom_url?.trim()) {
      return pushToast('Provide a custom URL or pick a different landing type', 'error')
    }
    onSave(form)
  }

  return (
    <form onSubmit={submit} style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div>
        <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Mailing Name *</label>
        <input className="input" value={form.name} onChange={e => set('name', e.target.value)}
               placeholder="e.g. Just Sold — 123 Oak St (June Postcard)" autoFocus />
      </div>

      <div>
        <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Description</label>
        <textarea className="input" rows={2} value={form.description} onChange={e => set('description', e.target.value)}
                  placeholder="Optional notes — target neighborhood, design version, etc." />
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
        <div>
          <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Mailing Type</label>
          <select className="input" value={form.mailing_type} onChange={e => set('mailing_type', e.target.value)}>
            {MAILING_TYPE_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Send Date</label>
          <input className="input" type="date" value={form.send_date} onChange={e => set('send_date', e.target.value)} />
        </div>
      </div>

      <div>
        <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Assigned Agent</label>
        <select className="input" value={form.agent_id} onChange={e => set('agent_id', e.target.value)}>
          <option value="">Unassigned</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>

      <div>
        <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', display:'block', marginBottom:6 }}>
          Landing Page (where the QR sends people)
        </label>
        <div style={{ display:'grid', gap:6 }}>
          {LANDING_OPTS.map(o => (
            <label key={o.value}
                   style={{ display:'flex', gap:10, padding:'10px 12px', border:'1px solid var(--gw-border)',
                            borderRadius:8, cursor:'pointer',
                            background: form.landing_type === o.value ? '#eff6ff' : '#fff',
                            borderColor: form.landing_type === o.value ? 'var(--gw-azure)' : 'var(--gw-border)' }}>
              <input type="radio" checked={form.landing_type === o.value} onChange={() => set('landing_type', o.value)} />
              <div>
                <div style={{ fontWeight:700, fontSize:13 }}>{o.label}</div>
                <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{o.sub}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {form.landing_type === 'property' && (
        <div>
          <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Property to Showcase *</label>
          <select className="input" value={form.property_id} onChange={e => set('property_id', e.target.value)}>
            <option value="">— select a property —</option>
            {properties.map(p => (
              <option key={p.id} value={p.id}>
                {p.address}{p.city ? `, ${p.city}` : ''}{p.state ? `, ${p.state}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {form.landing_type === 'custom' && (
        <div>
          <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Destination URL *</label>
          <input className="input" type="url" value={form.landing_custom_url}
                 onChange={e => set('landing_custom_url', e.target.value)}
                 placeholder="https://yourdomain.com/special-offer" />
        </div>
      )}

      <div>
        <label style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)' }}>Status</label>
        <select className="input" value={form.status} onChange={e => set('status', e.target.value)}>
          <option value="draft">Draft</option>
          <option value="active">Active (ready to print)</option>
          <option value="sent">Sent (in the mail)</option>
          <option value="archived">Archived</option>
        </select>
      </div>

      <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:8 }}>
        <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? 'Saving…' : (initial ? 'Save Changes' : 'Create Mailing')}
        </button>
      </div>
    </form>
  )
}

// ─── Recipient picker / importer ──────────────────────────────────────────────

function RecipientImporter({ mailingId, contacts, onDone, onCancel }) {
  const [mode, setMode] = useState('database') // 'database' | 'csv' | 'manual'
  const [picked, setPicked] = useState(new Set())
  const [search, setSearch] = useState('')

  // CSV state
  const [csvRows, setCsvRows] = useState(null)
  const [csvHeaders, setCsvHeaders] = useState([])
  const [csvMap, setCsvMap] = useState({})
  const [csvHasHeader, setCsvHasHeader] = useState(true)

  // Manual state
  const [manual, setManual] = useState({ recipient_name:'', address_line1:'', city:'', state:'', zip:'' })

  const [saving, setSaving] = useState(false)

  const filteredContacts = useMemo(() => {
    if (!search.trim()) return contacts.slice(0, 200)
    const q = search.toLowerCase()
    return contacts.filter(c =>
      `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.owner_address || '').toLowerCase().includes(q)
    ).slice(0, 200)
  }, [contacts, search])

  const onFile = async (file) => {
    if (!file) return
    const text = await file.text()
    const rows = parseCSV(text)
    if (rows.length === 0) return pushToast('CSV looks empty', 'error')
    setCsvRows(rows)
    setCsvHeaders(rows[0])
    setCsvMap(autoMapColumns(rows[0]))
  }

  const submitDatabase = async () => {
    if (picked.size === 0) return pushToast('Pick at least one contact', 'error')
    setSaving(true)
    const recipients = contacts.filter(c => picked.has(c.id)).map(c => ({
      contact_id:     c.id,
      recipient_name: [c.first_name, c.last_name].filter(Boolean).join(' '),
      address_line1:  c.owner_address || null,
      city:           c.owner_city    || null,
      state:          c.owner_state   || null,
      zip:            c.owner_zip     || null,
      source:         'database',
    }))
    const res = await api('add_recipients', { mailing_id: mailingId, recipients })
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    pushToast(`Added ${res.count} recipient${res.count === 1 ? '' : 's'}`)
    onDone(res.count)
  }

  const submitCSV = async () => {
    if (!csvRows) return
    const dataRows = csvHasHeader ? csvRows.slice(1) : csvRows
    const recipients = dataRows.map(r => {
      const get = key => csvMap[key] !== undefined ? (r[csvMap[key]] || '').trim() : ''
      const first = get('first_name')
      const last  = get('last_name')
      const fullName = get('recipient_name') || [first, last].filter(Boolean).join(' ')
      return {
        recipient_name: fullName || null,
        address_line1:  get('address_line1') || null,
        address_line2:  get('address_line2') || null,
        city:           get('city')          || null,
        state:          get('state')         || null,
        zip:            get('zip')           || null,
        source:         'csv_import',
      }
    }).filter(r => r.recipient_name || r.address_line1)
    if (recipients.length === 0) return pushToast('No usable rows — check column mapping', 'error')
    setSaving(true)
    const res = await api('add_recipients', { mailing_id: mailingId, recipients })
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    pushToast(`Imported ${res.count} recipient${res.count === 1 ? '' : 's'}`)
    onDone(res.count)
  }

  const submitManual = async () => {
    if (!manual.recipient_name?.trim() && !manual.address_line1?.trim()) {
      return pushToast('Provide at least a name or address', 'error')
    }
    setSaving(true)
    const res = await api('add_recipients', { mailing_id: mailingId, recipients: [{ ...manual, source: 'manual' }] })
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    pushToast('Added recipient')
    onDone(1)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'flex', gap:6, borderBottom:'1px solid var(--gw-border)', paddingBottom:8 }}>
        {[
          { id:'database', label:'From CRM Contacts', icon:'contacts' },
          { id:'csv',      label:'Upload CSV',         icon:'upload'   },
          { id:'manual',   label:'Add Manually',       icon:'plus'     },
        ].map(t => (
          <button key={t.id} type="button"
                  className={`btn ${mode === t.id ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => setMode(t.id)}
                  style={{ fontSize:12 }}>
            <Icon name={t.icon} size={12} /> {t.label}
          </button>
        ))}
      </div>

      {mode === 'database' && (
        <>
          <input className="input" placeholder="Search contacts by name, email, or address…"
                 value={search} onChange={e => setSearch(e.target.value)} />
          <div style={{ maxHeight:360, overflowY:'auto', border:'1px solid var(--gw-border)', borderRadius:8 }}>
            {filteredContacts.length === 0
              ? <div style={{ padding:20, textAlign:'center', color:'var(--gw-mist)', fontSize:13 }}>No matching contacts</div>
              : filteredContacts.map(c => (
                  <label key={c.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 12px', borderBottom:'1px solid var(--gw-border)', cursor:'pointer' }}>
                    <input type="checkbox" checked={picked.has(c.id)}
                           onChange={e => setPicked(p => { const s = new Set(p); e.target.checked ? s.add(c.id) : s.delete(c.id); return s })} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:600, fontSize:13 }}>{c.first_name} {c.last_name}</div>
                      <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
                        {c.owner_address ? `${c.owner_address}${c.owner_city ? `, ${c.owner_city}` : ''}${c.owner_state ? `, ${c.owner_state}` : ''}` : (c.email || c.phone || '—')}
                      </div>
                    </div>
                  </label>
                ))
            }
          </div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div style={{ fontSize:12, color:'var(--gw-mist)' }}>{picked.size} selected</div>
            <div style={{ display:'flex', gap:8 }}>
              <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
              <button type="button" className="btn btn--primary" disabled={saving || picked.size === 0} onClick={submitDatabase}>
                {saving ? 'Adding…' : `Add ${picked.size} Recipient${picked.size === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        </>
      )}

      {mode === 'csv' && (
        <>
          {!csvRows ? (
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              <label style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, padding:'40px 20px', border:'2px dashed var(--gw-border)', borderRadius:8, cursor:'pointer' }}>
                <Icon name="upload" size={32} color="var(--gw-mist)" />
                <div style={{ fontSize:13, fontWeight:600 }}>Drop a CSV file here, or click to browse</div>
                <div style={{ fontSize:11, color:'var(--gw-mist)' }}>Expected columns: name, address, city, state, zip</div>
                <input type="file" accept=".csv,text/csv" style={{ display:'none' }} onChange={e => onFile(e.target.files?.[0])} />
              </label>
              <div style={{ fontSize:11, color:'var(--gw-mist)' }}>
                Tip: export from Excel as CSV (UTF-8). Column order doesn't matter — we'll auto-map common headers.
              </div>
            </div>
          ) : (
            <>
              <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12 }}>
                <input type="checkbox" checked={csvHasHeader} onChange={e => setCsvHasHeader(e.target.checked)} />
                First row is a header
              </label>
              <div style={{ display:'grid', gridTemplateColumns:'160px 1fr', gap:6 }}>
                {['recipient_name','address_line1','address_line2','city','state','zip'].map(field => (
                  <React.Fragment key={field}>
                    <div style={{ fontSize:12, fontWeight:600, alignSelf:'center' }}>
                      {field === 'recipient_name' ? 'Name' :
                       field === 'address_line1'  ? 'Address' :
                       field === 'address_line2'  ? 'Address 2 (apt/unit)' :
                       field[0].toUpperCase() + field.slice(1)}
                    </div>
                    <select className="input" value={csvMap[field] ?? ''} onChange={e => setCsvMap(m => ({ ...m, [field]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                      <option value="">— none —</option>
                      {csvHeaders.map((h, i) => <option key={i} value={i}>{h}</option>)}
                    </select>
                  </React.Fragment>
                ))}
              </div>
              <div style={{ fontSize:12, color:'var(--gw-mist)' }}>
                Preview: {(csvHasHeader ? csvRows.length - 1 : csvRows.length).toLocaleString()} rows
              </div>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <button type="button" className="btn btn--ghost" onClick={() => { setCsvRows(null); setCsvHeaders([]); setCsvMap({}) }}>← Pick a different file</button>
                <div style={{ display:'flex', gap:8 }}>
                  <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
                  <button type="button" className="btn btn--primary" disabled={saving} onClick={submitCSV}>
                    {saving ? 'Importing…' : 'Import Recipients'}
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {mode === 'manual' && (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <input className="input" placeholder="Recipient name"
                   value={manual.recipient_name} onChange={e => setManual(m => ({ ...m, recipient_name: e.target.value }))} />
            <input className="input" placeholder="Street address"
                   value={manual.address_line1} onChange={e => setManual(m => ({ ...m, address_line1: e.target.value }))} />
            <input className="input" placeholder="City"
                   value={manual.city} onChange={e => setManual(m => ({ ...m, city: e.target.value }))} />
            <input className="input" placeholder="State"
                   value={manual.state} onChange={e => setManual(m => ({ ...m, state: e.target.value }))} />
            <input className="input" placeholder="ZIP" style={{ gridColumn:'1 / -1' }}
                   value={manual.zip} onChange={e => setManual(m => ({ ...m, zip: e.target.value }))} />
          </div>
          <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
            <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn--primary" disabled={saving} onClick={submitManual}>
              {saving ? 'Adding…' : 'Add Recipient'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Mailing detail drawer ────────────────────────────────────────────────────

function MailingDetail({ mailing, agents, properties, contacts, onClose, onUpdate, onDelete }) {
  const [tab, setTab] = useState('overview') // overview | recipients | scans | leads | edit
  const [recipients, setRecipients] = useState([])
  const [scans, setScans] = useState([])
  const [leads, setLeads] = useState([])
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [importerOpen, setImporterOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [saving, setSaving] = useState(false)

  const refresh = async () => {
    setLoading(true)
    const [r, s, l, a] = await Promise.all([
      api('recipients', { mailing_id: mailing.id }, 'GET'),
      api('scans',      { mailing_id: mailing.id }, 'GET'),
      api('leads',      { mailing_id: mailing.id }, 'GET'),
      api('analytics',  { mailing_id: mailing.id }, 'GET'),
    ])
    setRecipients(r.recipients || [])
    setScans(s.scans || [])
    setLeads(l.leads || [])
    setAnalytics(a)
    setLoading(false)
  }

  useEffect(() => { refresh() /* eslint-disable-next-line */ }, [mailing.id])

  const property = properties.find(p => p.id === mailing.property_id)
  const agent    = agents.find(a => a.id === mailing.agent_id)

  const copyUrl = async () => {
    await navigator.clipboard.writeText(shortUrl(mailing.qr_token))
    pushToast('Tracking URL copied')
  }

  const downloadQR = (format = 'png') => {
    const url = qrImageUrl(mailing.qr_token, { size: 1000, format, margin: 2 })
    const a = document.createElement('a')
    a.href = url
    a.download = `mailing-${mailing.qr_token}.${format}`
    a.target = '_blank'
    a.click()
  }

  const removeRecipient = async (id) => {
    const res = await api('remove_recipient', { id })
    if (res.error) return pushToast(res.error, 'error')
    refresh()
  }

  const setResponse = async (recipientId, response_type) => {
    const res = await api('update_recipient', { id: recipientId, response_type, responded: !!response_type })
    if (res.error) return pushToast(res.error, 'error')
    setRecipients(rs => rs.map(r => r.id === recipientId ? res.recipient : r))
  }

  const saveEdit = async (form) => {
    setSaving(true)
    const res = await api('update', { id: mailing.id, ...form })
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    onUpdate(res.mailing)
    setTab('overview')
    pushToast('Mailing updated')
  }

  const exportRecipientsCSV = () => {
    const headers = ['Name','Address','City','State','Zip','Scans','Responded','Response Type']
    const rows = recipients.map(r => [
      r.recipient_name || '', r.address_line1 || '', r.city || '', r.state || '', r.zip || '',
      r.scan_count || 0, r.responded ? 'Yes' : 'No', r.response_type || '',
    ])
    const csv = [headers, ...rows].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${mailing.name.replace(/[^a-z0-9]/gi, '_')}-recipients.csv`
    a.click()
  }

  return (
    <Modal open={true} onClose={onClose} width={920}>
      <div className="modal__head" style={{ alignItems:'flex-start' }}>
        <div style={{ flex:1 }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>{mailing.name}</h3>
            <StatusBadge status={mailing.status} />
          </div>
          {mailing.description && <div style={{ fontSize:13, color:'var(--gw-mist)', marginTop:4 }}>{mailing.description}</div>}
          <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:6, display:'flex', gap:14, flexWrap:'wrap' }}>
            {agent && <span><Icon name="user" size={11} /> {agent.name}</span>}
            {property && <span><Icon name="building" size={11} /> {property.address}{property.city ? `, ${property.city}` : ''}</span>}
            {mailing.send_date && <span><Icon name="calendar" size={11} /> {mailing.send_date}</span>}
            <span><Icon name="layers" size={11} /> {mailing.mailing_type}</span>
          </div>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>

      <div style={{ display:'flex', gap:4, borderBottom:'1px solid var(--gw-border)', padding:'0 20px' }}>
        {[
          { id:'overview',   label:'Overview'                                                    },
          { id:'recipients', label:`Recipients (${analytics?.recipients_total ?? recipients.length})` },
          { id:'scans',      label:`Scans (${analytics?.total_scans ?? scans.length})` },
          { id:'leads',      label:`Leads (${analytics?.total_leads ?? leads.length})` },
          { id:'edit',       label:'Edit' },
        ].map(t => (
          <button key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{ padding:'10px 14px', background:'none', border:'none', cursor:'pointer',
                           fontSize:13, fontWeight:600,
                           color: tab === t.id ? 'var(--gw-azure)' : 'var(--gw-mist)',
                           borderBottom: tab === t.id ? '2px solid var(--gw-azure)' : '2px solid transparent' }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding:20, maxHeight:'70vh', overflowY:'auto' }}>
        {loading && tab === 'overview' && <div style={{ color:'var(--gw-mist)' }}>Loading…</div>}

        {tab === 'overview' && !loading && (
          <div style={{ display:'grid', gridTemplateColumns:'320px 1fr', gap:24 }}>
            <div>
              <div style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:12, padding:16, textAlign:'center' }}>
                <img src={qrImageUrl(mailing.qr_token, { size: 400 })}
                     alt="QR code"
                     style={{ width:'100%', maxWidth:280, height:'auto', display:'block', margin:'0 auto' }} />
                <div style={{ fontFamily:'monospace', fontSize:13, marginTop:8, padding:'6px 10px',
                              background:'var(--gw-bone)', borderRadius:6, wordBreak:'break-all' }}>
                  {shortUrl(mailing.qr_token)}
                </div>
                <div style={{ display:'flex', gap:6, marginTop:10, justifyContent:'center', flexWrap:'wrap' }}>
                  <button className="btn btn--ghost" style={{ fontSize:12 }} onClick={copyUrl}>
                    <Icon name="copy" size={12} /> Copy URL
                  </button>
                  <button className="btn btn--ghost" style={{ fontSize:12 }} onClick={() => downloadQR('png')}>
                    <Icon name="download" size={12} /> PNG
                  </button>
                  <button className="btn btn--ghost" style={{ fontSize:12 }} onClick={() => downloadQR('svg')}>
                    <Icon name="download" size={12} /> SVG
                  </button>
                </div>
              </div>
              <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:8, textAlign:'center' }}>
                Drop the SVG into Canva or Vistaprint for crisp printing at any size.
              </div>
            </div>

            <div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10 }}>
                <StatCard value={analytics?.recipients_total ?? '—'} label="Mailed" />
                <StatCard value={analytics?.total_scans ?? '—'}      label="Scans" color="var(--gw-azure)" />
                <StatCard value={analytics?.unique_scanners ?? '—'}  label="Unique" sub="(approx.)" />
                <StatCard value={analytics?.total_leads ?? '—'}      label="Leads" color="var(--gw-green)" />
              </div>

              <div style={{ marginTop:18 }}>
                <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginBottom:8 }}>Scan Rate</div>
                <div style={{ background:'var(--gw-bone)', borderRadius:6, height:10, overflow:'hidden' }}>
                  <div style={{ width:`${Math.min(100, (analytics?.scan_rate || 0) * 100)}%`, height:'100%',
                                background:'linear-gradient(90deg, var(--gw-azure), var(--gw-green))' }} />
                </div>
                <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:4 }}>
                  {Math.round((analytics?.scan_rate || 0) * 100)}% of recipients scanned the QR
                </div>
              </div>

              {analytics?.timeline?.length > 0 && (
                <div style={{ marginTop:18 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'var(--gw-ink)', marginBottom:8 }}>Scan Activity</div>
                  <div style={{ display:'flex', alignItems:'flex-end', gap:2, height:80 }}>
                    {(() => {
                      const max = Math.max(1, ...analytics.timeline.map(t => t.count))
                      return analytics.timeline.map(t => (
                        <div key={t.date} style={{ flex:1, background:'var(--gw-azure)', borderRadius:'2px 2px 0 0',
                                                   height:`${(t.count / max) * 100}%`, minHeight:2 }}
                             title={`${t.date}: ${t.count} scan${t.count === 1 ? '' : 's'}`} />
                      ))
                    })()}
                  </div>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'var(--gw-mist)', marginTop:4 }}>
                    <span>{analytics.timeline[0]?.date}</span>
                    <span>{analytics.timeline[analytics.timeline.length - 1]?.date}</span>
                  </div>
                </div>
              )}

              <div style={{ marginTop:18, display:'flex', gap:8 }}>
                <button className="btn btn--ghost" onClick={() => window.open(`/lp/${mailing.landing_type === 'valuation' ? 'valuation' : 'property'}/${mailing.id}`, '_blank')}>
                  <Icon name="external" size={12} /> Preview Landing Page
                </button>
                <button className="btn btn--ghost" onClick={() => setConfirmDelete(true)} style={{ marginLeft:'auto', color:'var(--gw-red)' }}>
                  <Icon name="trash" size={12} /> Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {tab === 'recipients' && (
          <>
            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:12 }}>
              <div style={{ fontSize:13, color:'var(--gw-mist)' }}>
                {recipients.length} recipient{recipients.length === 1 ? '' : 's'}
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button className="btn btn--ghost" onClick={exportRecipientsCSV} disabled={recipients.length === 0}>
                  <Icon name="download" size={12} /> Export CSV
                </button>
                <button className="btn btn--primary" onClick={() => setImporterOpen(true)}>
                  <Icon name="plus" size={12} /> Add Recipients
                </button>
              </div>
            </div>
            {recipients.length === 0 ? (
              <EmptyState title="No recipients yet"
                          message="Add contacts from the CRM, upload a CSV/Excel file, or enter them manually."
                          action={<button className="btn btn--primary" onClick={() => setImporterOpen(true)}>Add Recipients</button>} />
            ) : (
              <div style={{ border:'1px solid var(--gw-border)', borderRadius:8, overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead style={{ background:'var(--gw-bone)' }}>
                    <tr>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Name</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Address</th>
                      <th style={{ padding:'8px 12px', textAlign:'center', fontSize:11, textTransform:'uppercase' }}>Scans</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Response</th>
                      <th style={{ padding:'8px 12px', width:30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.map(r => (
                      <tr key={r.id} style={{ borderTop:'1px solid var(--gw-border)' }}>
                        <td style={{ padding:'8px 12px', fontWeight:600 }}>{r.recipient_name || '—'}</td>
                        <td style={{ padding:'8px 12px', color:'var(--gw-mist)' }}>
                          {[r.address_line1, r.city, r.state, r.zip].filter(Boolean).join(', ') || '—'}
                        </td>
                        <td style={{ padding:'8px 12px', textAlign:'center' }}>
                          {r.scan_count > 0
                            ? <span style={{ color:'var(--gw-azure)', fontWeight:700 }}>{r.scan_count}</span>
                            : <span style={{ color:'var(--gw-mist)' }}>0</span>}
                        </td>
                        <td style={{ padding:'8px 12px' }}>
                          <select value={r.response_type || ''} onChange={e => setResponse(r.id, e.target.value)}
                                  style={{ padding:'3px 6px', fontSize:12, border:'1px solid var(--gw-border)', borderRadius:6 }}>
                            <option value="">No response</option>
                            <option value="lead_captured">Lead captured</option>
                            <option value="called">Called us</option>
                            <option value="emailed">Emailed us</option>
                            <option value="interested">Interested</option>
                            <option value="not_interested">Not interested</option>
                            <option value="converted">Converted</option>
                          </select>
                        </td>
                        <td style={{ padding:'8px 12px' }}>
                          <button className="btn btn--ghost" style={{ padding:4 }} onClick={() => removeRecipient(r.id)} title="Remove">
                            <Icon name="x" size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === 'scans' && (
          <>
            {scans.length === 0 ? (
              <EmptyState title="No scans yet"
                          message="When recipients scan the QR code on your mailer, the events will appear here." />
            ) : (
              <div style={{ border:'1px solid var(--gw-border)', borderRadius:8, overflow:'hidden' }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                  <thead style={{ background:'var(--gw-bone)' }}>
                    <tr>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>When</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Country</th>
                      <th style={{ padding:'8px 12px', textAlign:'left', fontSize:11, textTransform:'uppercase' }}>Device</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scans.map(s => (
                      <tr key={s.id} style={{ borderTop:'1px solid var(--gw-border)' }}>
                        <td style={{ padding:'8px 12px' }}>{new Date(s.scanned_at).toLocaleString()}</td>
                        <td style={{ padding:'8px 12px' }}>{s.country || '—'}</td>
                        <td style={{ padding:'8px 12px', color:'var(--gw-mist)', fontSize:11 }}>
                          {(s.user_agent || '').slice(0, 80) || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {tab === 'leads' && (
          <>
            {leads.length === 0 ? (
              <EmptyState title="No leads captured yet"
                          message="When someone fills out the form on the landing page, they'll appear here." />
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {leads.map(l => (
                  <div key={l.id} style={{ border:'1px solid var(--gw-border)', borderRadius:8, padding:12 }}>
                    <div style={{ display:'flex', justifyContent:'space-between' }}>
                      <div style={{ fontWeight:700 }}>{l.name || 'Anonymous'}</div>
                      <div style={{ fontSize:11, color:'var(--gw-mist)' }}>{new Date(l.created_at).toLocaleString()}</div>
                    </div>
                    <div style={{ fontSize:12, color:'var(--gw-mist)', marginTop:4, display:'flex', gap:14, flexWrap:'wrap' }}>
                      {l.email && <span><Icon name="mail" size={11} /> {l.email}</span>}
                      {l.phone && <span><Icon name="phone" size={11} /> {l.phone}</span>}
                      {l.property_address && <span><Icon name="building" size={11} /> {l.property_address}</span>}
                    </div>
                    {l.message && <div style={{ marginTop:6, fontSize:13, color:'var(--gw-ink)' }}>{l.message}</div>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'edit' && (
          <MailingForm initial={mailing} agents={agents} properties={properties}
                       saving={saving} onSave={saveEdit} onCancel={() => setTab('overview')} />
        )}
      </div>

      {importerOpen && (
        <Modal open={true} onClose={() => setImporterOpen(false)} width={640}>
          <div className="modal__head">
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>Add Recipients</h3>
            <button className="drawer__close" onClick={() => setImporterOpen(false)}><Icon name="x" size={18} /></button>
          </div>
          <div style={{ padding:20 }}>
            <RecipientImporter
              mailingId={mailing.id}
              contacts={contacts}
              onDone={() => { setImporterOpen(false); refresh() }}
              onCancel={() => setImporterOpen(false)}
            />
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete mailing?"
          message={`This will permanently delete "${mailing.name}" along with all ${recipients.length} recipients, ${scans.length} scans, and ${leads.length} captured leads. This cannot be undone.`}
          confirmText="Delete"
          danger
          onConfirm={async () => {
            const res = await api('delete', { id: mailing.id })
            if (res.error) return pushToast(res.error, 'error')
            pushToast('Mailing deleted')
            onDelete(mailing.id)
            onClose()
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </Modal>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function CampaignsPage({ db, isAdmin }) {
  const agents     = db?.agents     || []
  const properties = db?.properties || []

  const [mailings, setMailings]     = useState([])
  const [contacts, setContacts]     = useState([])
  const [loading,  setLoading]      = useState(true)
  const [selected, setSelected]     = useState(null)
  const [creating, setCreating]     = useState(false)
  const [saving,   setSaving]       = useState(false)
  const [dashboard, setDashboard]   = useState(null)
  const [setupNeeded, setSetupNeeded] = useState(false)

  // Filters
  const [search, setSearch]         = useState('')
  const [statusFilter, setStatus]   = useState('all')
  const [agentFilter, setAgentF]    = useState('all')
  const [sort, setSort]             = useState('newest')

  const loadAll = async () => {
    setLoading(true)
    const [mRes, dRes, cRes] = await Promise.all([
      api('list', {}, 'GET'),
      api('dashboard', {}, 'GET'),
      supabase.from('contacts').select('id, first_name, last_name, email, phone, owner_address, owner_city, owner_state, owner_zip').order('last_name'),
    ])
    if (mRes.error && /does not exist|relation/i.test(mRes.error)) {
      setSetupNeeded(true)
      setLoading(false)
      return
    }
    setMailings(mRes.mailings || [])
    setDashboard(dRes?.error ? null : dRes)
    setContacts(cRes.data || [])
    setLoading(false)
  }

  useEffect(() => { loadAll() }, [])

  const createMailing = async (form) => {
    setSaving(true)
    const res = await api('create', form)
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    setMailings(m => [res.mailing, ...m])
    setCreating(false)
    setSelected(res.mailing)
    pushToast('Mailing created — add recipients next')
  }

  const updateMailing = (updated) => {
    setMailings(m => m.map(x => x.id === updated.id ? updated : x))
    if (selected?.id === updated.id) setSelected(updated)
  }

  const handleDelete = (id) => {
    setMailings(m => m.filter(x => x.id !== id))
    setSelected(null)
  }

  const filtered = useMemo(() => {
    let out = mailings
    if (statusFilter !== 'all') out = out.filter(m => m.status === statusFilter)
    if (agentFilter !== 'all')  out = out.filter(m => m.agent_id === agentFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      out = out.filter(m => m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q))
    }
    if (sort === 'newest')      out = [...out].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    else if (sort === 'oldest') out = [...out].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    else if (sort === 'scans')  out = [...out].sort((a, b) => (b.scan_count || 0) - (a.scan_count || 0))
    else if (sort === 'leads')  out = [...out].sort((a, b) => (b.lead_count || 0) - (a.lead_count || 0))
    else if (sort === 'recipients') out = [...out].sort((a, b) => (b.recipient_count || 0) - (a.recipient_count || 0))
    return out
  }, [mailings, statusFilter, agentFilter, search, sort])

  if (setupNeeded) {
    return (
      <div style={{ padding:40, maxWidth:780 }}>
        <h2 style={{ fontFamily:'var(--font-display)', margin:0 }}>Campaign Tracking — Setup</h2>
        <p style={{ color:'var(--gw-mist)', marginTop:8 }}>
          The mailings tables haven't been created yet. Run the migration once in your Supabase SQL editor — it's in <code>src/lib/schema.sql</code> under the <strong>MAILINGS (v2)</strong> section.
        </p>
        <button className="btn btn--primary" onClick={loadAll} style={{ marginTop:16 }}>
          I've run the migration — Reload
        </button>
      </div>
    )
  }

  if (loading) return <div style={{ padding:40 }}>Loading mailings…</div>

  return (
    <div style={{ padding:'24px 32px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
        <div>
          <h1 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:28 }}>Mail Campaigns</h1>
          <div style={{ color:'var(--gw-mist)', fontSize:13, marginTop:4 }}>
            Track postcards, flyers, and direct mail with per-piece QR codes
          </div>
        </div>
        <button className="btn btn--primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} /> New Mailing
        </button>
      </div>

      {dashboard && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)', gap:10, marginBottom:20 }}>
          <StatCard value={dashboard.total_mailings}    label="Total Mailings" />
          <StatCard value={dashboard.active_mailings}   label="Active / Sent"   color="var(--gw-azure)" />
          <StatCard value={(dashboard.total_recipients || 0).toLocaleString()} label="Pieces Mailed" />
          <StatCard value={dashboard.total_scans_30d}   label="Scans (30d)"     color="var(--gw-green)" />
          <StatCard value={dashboard.total_leads_30d}   label="Leads (30d)"     color="#7c3aed" />
        </div>
      )}

      <div style={{ display:'flex', gap:8, marginBottom:14, flexWrap:'wrap' }}>
        <input className="input" placeholder="Search mailings…" value={search}
               onChange={e => setSearch(e.target.value)} style={{ flex:1, minWidth:200 }} />
        <select className="input" value={statusFilter} onChange={e => setStatus(e.target.value)} style={{ width:160 }}>
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="sent">Sent</option>
          <option value="archived">Archived</option>
        </select>
        {isAdmin && (
          <select className="input" value={agentFilter} onChange={e => setAgentF(e.target.value)} style={{ width:180 }}>
            <option value="all">All agents</option>
            {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        <select className="input" value={sort} onChange={e => setSort(e.target.value)} style={{ width:170 }}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="scans">Most scans</option>
          <option value="leads">Most leads</option>
          <option value="recipients">Most recipients</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title={mailings.length === 0 ? 'No mailings yet' : 'No mailings match these filters'}
                    message={mailings.length === 0 ? 'Create your first mailing to get a unique trackable QR code.' : 'Try clearing the filters.'}
                    action={mailings.length === 0 && <button className="btn btn--primary" onClick={() => setCreating(true)}>Create First Mailing</button>} />
      ) : (
        <div style={{ display:'grid', gap:10 }}>
          {filtered.map(m => {
            const agent    = agents.find(a => a.id === m.agent_id)
            const property = properties.find(p => p.id === m.property_id)
            return (
              <div key={m.id} onClick={() => setSelected(m)}
                   style={{ background:'#fff', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)',
                            padding:'14px 18px', cursor:'pointer', display:'grid',
                            gridTemplateColumns:'1fr 100px 100px 100px 110px', gap:14, alignItems:'center' }}>
                <div>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ fontWeight:700, fontSize:15 }}>{m.name}</div>
                    <StatusBadge status={m.status} />
                  </div>
                  <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:4, display:'flex', gap:12, flexWrap:'wrap' }}>
                    {agent && <span>{agent.name}</span>}
                    {property && <span>· {property.address}</span>}
                    {m.send_date && <span>· {m.send_date}</span>}
                    <span>· {m.mailing_type}</span>
                  </div>
                </div>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:18, fontWeight:700 }}>{(m.recipient_count || 0).toLocaleString()}</div>
                  <div style={{ fontSize:10, color:'var(--gw-mist)', textTransform:'uppercase' }}>Mailed</div>
                </div>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:18, fontWeight:700, color:'var(--gw-azure)' }}>{m.scan_count || 0}</div>
                  <div style={{ fontSize:10, color:'var(--gw-mist)', textTransform:'uppercase' }}>Scans</div>
                </div>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontSize:18, fontWeight:700, color:'var(--gw-green)' }}>{m.lead_count || 0}</div>
                  <div style={{ fontSize:10, color:'var(--gw-mist)', textTransform:'uppercase' }}>Leads</div>
                </div>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', gap:6 }}>
                  <img src={qrImageUrl(m.qr_token, { size: 60 })} alt=""
                       style={{ width:36, height:36, border:'1px solid var(--gw-border)', borderRadius:4 }} />
                  <Icon name="chevronRight" size={16} color="var(--gw-mist)" />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {creating && (
        <Modal open={true} onClose={() => setCreating(false)} width={560}>
          <div className="modal__head">
            <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:18 }}>New Mailing</h3>
            <button className="drawer__close" onClick={() => setCreating(false)}><Icon name="x" size={18} /></button>
          </div>
          <div style={{ padding:20 }}>
            <MailingForm
              agents={agents}
              properties={properties}
              saving={saving}
              onSave={createMailing}
              onCancel={() => setCreating(false)}
            />
          </div>
        </Modal>
      )}

      {selected && (
        <MailingDetail
          mailing={selected}
          agents={agents}
          properties={properties}
          contacts={contacts}
          onClose={() => setSelected(null)}
          onUpdate={updateMailing}
          onDelete={handleDelete}
        />
      )}
    </div>
  )
}
