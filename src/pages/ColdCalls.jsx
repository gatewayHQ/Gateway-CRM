import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Modal, pushToast } from '../components/UI.jsx'

// ── SQL shown when tables are missing ─────────────────────────────────────
const SQL_SETUP = `create table if not exists cold_call_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  agent_id uuid references agents(id) on delete set null,
  created_at timestamptz default now()
);
create table if not exists cold_call_leads (
  id uuid primary key default gen_random_uuid(),
  list_id uuid references cold_call_lists(id) on delete cascade,
  property_address text, town text, state text,
  prop_type text, unit_count int,
  owner_name text, owner_address text,
  owner_city text, owner_state text, owner_zip text,
  contact_name text, age int,
  phones jsonb default '[]',
  emails jsonb default '[]',
  remarks text,
  status text default 'new',
  call_notes text, called_at timestamptz, callback_date date,
  contact_id uuid references contacts(id) on delete set null,
  agent_id uuid references agents(id) on delete set null,
  created_at timestamptz default now()
);
alter table cold_call_lists enable row level security;
create policy "auth_all" on cold_call_lists for all to authenticated using (true) with check (true);
alter table cold_call_leads enable row level security;
create policy "auth_all" on cold_call_leads for all to authenticated using (true) with check (true);`

// ── Status config ──────────────────────────────────────────────────────────
const STATUS = {
  new:       { label: 'New',       bg: 'var(--gw-bone)',        color: 'var(--gw-mist)' },
  called:    { label: 'Called',    bg: '#e8f4fd',               color: 'var(--gw-azure)' },
  callback:  { label: 'Callback',  bg: '#fff3cd',               color: '#856404' },
  dnc:       { label: 'DNC',       bg: 'var(--gw-red-light)',   color: 'var(--gw-red)' },
  converted: { label: 'Converted', bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
}

function StatusBadge({ status }) {
  const s = STATUS[status] || STATUS.new
  return <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700, background:s.bg, color:s.color, whiteSpace:'nowrap' }}>{s.label}</span>
}

// ── Auto-detect CSV vs TSV, parse to rows ─────────────────────────────────
function parseFile(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (!lines.length) return []
  const tabs   = (lines[0].match(/\t/g) || []).length
  const commas = (lines[0].match(/,/g)  || []).length
  const delim  = tabs > commas ? '\t' : ','
  return lines.map(line => {
    if (delim === '\t') return line.split('\t').map(c => c.trim())
    const row = []; let cur = '', inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') { inQ = !inQ }
      else if (ch === ',' && !inQ) { row.push(cur.trim()); cur = '' }
      else { cur += ch }
    }
    row.push(cur.trim())
    return row
  })
}

// ── Column auto-mapper ─────────────────────────────────────────────────────
const AUTO_MAP = {
  'address':'property_address','property address':'property_address',
  'town':'town','city':'town',
  'state':'state',
  'type':'prop_type','property type':'prop_type','prop type':'prop_type',
  'number of unit':'unit_count','number of units':'unit_count','units':'unit_count',
  'owner name':'owner_name','owner':'owner_name',
  'owner address':'owner_address',
  'owner city':'owner_city',
  'owner state':'owner_state',
  'owner zip':'owner_zip','zipcode':'owner_zip','zip':'owner_zip','state,zipcode':'owner_zip',
  'contact name':'contact_name','contact':'contact_name','name':'contact_name',
  'age':'age',
  'phone 1':'phone1','phone1':'phone1','phone':'phone1','phone number':'phone1',
  'phone 2':'phone2','phone2':'phone2',
  'phone 3':'phone3','phone3':'phone3',
  'email 1':'email1','email1':'email1','email':'email1','email address':'email1',
  'email 2':'email2','email2':'email2',
  'remarks':'remarks','notes':'remarks','comments':'remarks',
}

const FIELD_LABELS = {
  property_address:'Property Address', town:'Town/City', state:'State',
  prop_type:'Property Type', unit_count:'Unit Count',
  owner_name:'Owner Name', owner_address:'Owner Address',
  owner_city:'Owner City', owner_state:'Owner State', owner_zip:'Owner Zip',
  contact_name:'Contact Name', age:'Age',
  phone1:'Phone 1', phone2:'Phone 2', phone3:'Phone 3',
  email1:'Email 1', email2:'Email 2',
  remarks:'Remarks', _skip:'— Skip —',
}

const autoMap = h => AUTO_MAP[h.toLowerCase().trim()] || '_skip'

// ── Upload Modal ──────────────────────────────────────────────────────────
function UploadModal({ open, onClose, agents, activeAgent, onUploaded }) {
  const [step, setStep]           = useState(1)
  const [rows, setRows]           = useState([])
  const [headers, setHeaders]     = useState([])
  const [mapping, setMapping]     = useState({})
  const [listName, setListName]   = useState('')
  const [listAgent, setListAgent] = useState(activeAgent?.id || '')
  const [dragOver, setDragOver]   = useState(false)
  const [fileName, setFileName]   = useState('')
  const [importing, setImporting] = useState(false)
  const [progress, setProgress]   = useState(0)
  const fileRef = useRef()

  useEffect(() => {
    if (!open) { setStep(1); setRows([]); setHeaders([]); setMapping({}); setListName(''); setProgress(0); setFileName('') }
    if (open) setListAgent(activeAgent?.id || '')
  }, [open])

  const loadFile = (f) => {
    if (!f) return
    const reader = new FileReader()
    reader.onload = e => {
      const parsed = parseFile(e.target.result)
      if (parsed.length < 2) { pushToast('File needs headers + at least one row', 'error'); return }
      const hdrs = parsed[0]
      const data = parsed.slice(1).filter(r => r.some(c => c.trim()))
      setHeaders(hdrs); setRows(data); setFileName(f.name)
      const m = {}; hdrs.forEach(h => { m[h] = autoMap(h) })
      setMapping(m)
      setListName(f.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '))
      setStep(2)
    }
    reader.readAsText(f)
  }

  const runImport = async () => {
    if (!listName.trim()) { pushToast('Enter a list name', 'error'); return }
    const assignedAgent = listAgent || activeAgent?.id
    if (!assignedAgent) { pushToast('No active agent — please refresh and sign in again', 'error'); return }
    setImporting(true); setStep(4)
    const { data: list, error: le } = await supabase
      .from('cold_call_lists').insert([{ name: listName.trim(), agent_id: assignedAgent }]).select().single()
    if (le) { pushToast('Failed: ' + le.message, 'error'); setImporting(false); return }

    const getVal = (row, field) => {
      const hdr = Object.keys(mapping).find(k => mapping[k] === field)
      if (!hdr) return null
      const idx = headers.indexOf(hdr)
      return idx >= 0 ? (row[idx] || '').trim() || null : null
    }

    const importLeads = rows.map(row => ({
      list_id: list.id,
      property_address: getVal(row,'property_address'),
      town: getVal(row,'town'), state: getVal(row,'state'),
      prop_type: getVal(row,'prop_type'),
      unit_count: getVal(row,'unit_count') ? parseInt(getVal(row,'unit_count')) || null : null,
      owner_name: getVal(row,'owner_name'), owner_address: getVal(row,'owner_address'),
      owner_city: getVal(row,'owner_city'), owner_state: getVal(row,'owner_state'), owner_zip: getVal(row,'owner_zip'),
      contact_name: getVal(row,'contact_name'),
      age: getVal(row,'age') ? parseInt(getVal(row,'age')) || null : null,
      phones: [getVal(row,'phone1'), getVal(row,'phone2'), getVal(row,'phone3')].filter(Boolean),
      emails: [getVal(row,'email1'), getVal(row,'email2')].filter(Boolean),
      remarks: getVal(row,'remarks'), status: 'new', agent_id: assignedAgent,
    }))

    // Duplicate detection — flag leads whose phone matches an existing contact
    const dupePhoneSet = new Set()
    const allImportPhones = importLeads.flatMap(l => l.phones).map(p => p.replace(/\D/g,''))
    if (allImportPhones.length > 0) {
      const { data: existingContacts } = await supabase.from('contacts').select('phones')
      for (const c of (existingContacts || [])) {
        for (const p of (c.phones || [])) { dupePhoneSet.add(p.replace(/\D/g,'')) }
      }
    }
    let dupeCount = 0
    const leads = importLeads.map(l => {
      const isDupe = (l.phones || []).some(p => dupePhoneSet.has(p.replace(/\D/g,'')))
      if (isDupe) dupeCount++
      return isDupe ? { ...l, remarks: l.remarks ? `${l.remarks} [Possible duplicate]` : '[Possible duplicate]' } : l
    })

    let done = 0
    for (let i = 0; i < leads.length; i += 50) {
      const { error } = await supabase.from('cold_call_leads').insert(leads.slice(i, i + 50))
      if (error) { pushToast('Import error: ' + error.message, 'error'); break }
      done += Math.min(50, leads.length - i)
      setProgress(Math.round(done / leads.length * 100))
    }
    setImporting(false)
    pushToast(dupeCount > 0 ? `Imported ${done} leads — ${dupeCount} flagged as possible duplicates` : `Imported ${done} leads`)
    onUploaded(); onClose()
  }

  if (!open) return null

  return (
    <Modal open={open} onClose={onClose} width={600}>
      <div className="modal__head">
        <div><div className="eyebrow-label">Cold Call Lists</div>
          <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>
            {['','Upload File','Name List','Map Columns','Importing…'][step]}
          </h3>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body">
        <div style={{ display:'flex', marginBottom:20 }}>
          {['Upload','Name','Map','Import'].map((s,i) => (
            <div key={s} style={{ flex:1, textAlign:'center', fontSize:11, fontWeight:700, padding:'6px 0',
              background: step===i+1 ? 'var(--gw-slate)' : step>i+1 ? 'var(--gw-green)' : 'var(--gw-bone)',
              color: step>=i+1 ? '#fff' : 'var(--gw-mist)',
              borderRight: i<3 ? '1px solid #fff' : 'none' }}>{s}</div>
          ))}
        </div>

        {step === 1 && (
          <div onDragOver={e=>{e.preventDefault();setDragOver(true)}} onDragLeave={()=>setDragOver(false)}
            onDrop={e=>{e.preventDefault();setDragOver(false);loadFile(e.dataTransfer.files[0])}}
            onClick={() => fileRef.current.click()}
            style={{ border:`2px dashed ${dragOver?'var(--gw-azure)':'var(--gw-border)'}`, borderRadius:'var(--radius)', padding:'40px 24px', textAlign:'center', cursor:'pointer', background:dragOver?'var(--gw-sky)':'transparent', transition:'all 150ms' }}>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{display:'none'}} onChange={e=>loadFile(e.target.files[0])} />
            <Icon name="upload" size={28} style={{color:'var(--gw-border)',marginBottom:10}}/>
            <div style={{fontSize:14,fontWeight:600}}>Drop your file or click to browse</div>
            <div style={{fontSize:12,color:'var(--gw-mist)',marginTop:4}}>CSV or TSV — both formats work automatically</div>
          </div>
        )}

        {step === 2 && (
          <div>
            <div style={{fontSize:13,color:'var(--gw-mist)',marginBottom:16}}><strong>{rows.length}</strong> leads detected in <strong>{fileName}</strong></div>
            <div className="form-group"><label className="form-label required">List Name</label>
              <input className="form-control" value={listName} onChange={e=>setListName(e.target.value)} placeholder="e.g. Carroll IA Multifamily Q1" /></div>
            <div className="form-group"><label className="form-label">Assign To Agent</label>
              <select className="form-control" value={listAgent} onChange={e=>setListAgent(e.target.value)}>
                {agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select></div>
          </div>
        )}

        {step === 3 && (
          <div>
            <div style={{fontSize:12,color:'var(--gw-mist)',marginBottom:12}}>Confirm column mapping. Phone 4–8 and Email 3+ are skipped automatically.</div>
            <div style={{maxHeight:360,overflowY:'auto'}}>
              {headers.map(h => (
                <div key={h} style={{display:'flex',alignItems:'center',gap:12,marginBottom:8}}>
                  <div style={{flex:'0 0 180px',fontSize:12,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={h}>{h}</div>
                  <span style={{fontSize:12,color:'var(--gw-mist)'}}>→</span>
                  <select className="form-control" style={{flex:1,fontSize:12}} value={mapping[h]||'_skip'} onChange={e=>setMapping(p=>({...p,[h]:e.target.value}))}>
                    {Object.entries(FIELD_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
              ))}
            </div>
            {rows[0] && (
              <div style={{marginTop:10,padding:'8px 12px',background:'var(--gw-bone)',borderRadius:'var(--radius)',fontSize:11,color:'var(--gw-mist)'}}>
                First row preview: {headers.slice(0,4).map(h=>rows[0][headers.indexOf(h)]).filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div style={{textAlign:'center',padding:'32px 0'}}>
            <div style={{fontSize:14,fontWeight:600,marginBottom:16}}>{importing ? 'Importing leads…' : 'Done!'}</div>
            <div style={{height:8,background:'var(--gw-border)',borderRadius:4,maxWidth:300,margin:'0 auto',overflow:'hidden'}}>
              <div style={{width:`${progress}%`,height:'100%',background:'var(--gw-green)',borderRadius:4,transition:'width 300ms'}}/>
            </div>
            <div style={{fontSize:12,color:'var(--gw-mist)',marginTop:8}}>{progress}%</div>
          </div>
        )}
      </div>
      <div className="modal__foot">
        {step === 2 && <><button className="btn btn--secondary" onClick={()=>setStep(1)}>Back</button><button className="btn btn--primary" onClick={()=>setStep(3)} disabled={!listName.trim()}>Next: Map Columns</button></>}
        {step === 3 && <><button className="btn btn--secondary" onClick={()=>setStep(2)}>Back</button><button className="btn btn--primary" onClick={runImport}>Import {rows.length} Leads</button></>}
        {step === 4 && !importing && <button className="btn btn--primary" onClick={onClose}>Done</button>}
      </div>
    </Modal>
  )
}

// ── Convert Lead → Contact ────────────────────────────────────────────────
function ConvertModal({ lead, agents, activeAgent, onClose, onConverted }) {
  const parts = (lead?.contact_name || '').trim().split(/\s+/)
  const [form, setForm] = useState({
    first_name: parts[0] || '',
    last_name:  parts.slice(1).join(' ') || '',
    phone:      (lead?.phones || [])[0] || '',
    email:      (lead?.emails || [])[0] || '',
    type: 'investor', status: 'active', source: 'cold call',
    assigned_agent_id: lead?.agent_id || activeAgent?.id || '',
    notes: [
      lead?.property_address && `Property: ${[lead.property_address, lead.town, lead.state].filter(Boolean).join(', ')}`,
      lead?.prop_type && `Type: ${lead.prop_type}${lead.unit_count ? ` · ${lead.unit_count} units` : ''}`,
      lead?.owner_name && `Owner/Entity: ${lead.owner_name}`,
      lead?.call_notes && `Call notes: ${lead.call_notes}`,
    ].filter(Boolean).join('\n'),
    tags: ['cold call'],
  })
  const [saving, setSaving] = useState(false)
  const set = (k, v) => setForm(p => ({...p, [k]: v}))

  const save = async () => {
    if (!form.first_name.trim()) { pushToast('First name required', 'error'); return }
    setSaving(true)
    const contactPayload = {
      first_name: form.first_name, last_name: form.last_name,
      phones: form.phone ? [form.phone] : [],
      emails: form.email ? [form.email] : [],
      type: form.type, status: form.status, source: form.source,
      assigned_agent_id: form.assigned_agent_id || null,
      notes: form.notes, tags: form.tags,
    }
    const { data, error } = await supabase.from('contacts').insert([contactPayload]).select().single()
    if (error) { setSaving(false); pushToast(error.message, 'error'); return }

    // Create linked property
    if (lead?.property_address) {
      await supabase.from('properties').insert([{
        address: [lead.property_address, lead.town, lead.state].filter(Boolean).join(', '),
        type: lead.prop_type || 'residential',
        details: { category: lead.prop_type || 'residential', unit_count: lead.unit_count || null },
        linked_contact_id: data.id, status: 'active',
      }])
    }

    // Log call notes as activity on contact timeline
    if (lead?.call_notes?.trim()) {
      await supabase.from('activities').insert([{
        contact_id: data.id,
        agent_id: form.assigned_agent_id || null,
        type: 'call', body: lead.call_notes,
      }])
    }

    await supabase.from('cold_call_leads').update({ status: 'converted', contact_id: data.id }).eq('id', lead.id)
    setSaving(false)
    pushToast(`Contact created: ${form.first_name} ${form.last_name}`)
    onConverted(data)
  }

  return (
    <Modal open={true} onClose={onClose} width={500}>
      <div className="modal__head">
        <div><div className="eyebrow-label">Cold Call</div><h3 style={{margin:0,fontFamily:'var(--font-display)',fontSize:20}}>Convert to Contact</h3></div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body">
        <div style={{background:'var(--gw-sky)',border:'1px solid #c5d9f5',borderRadius:'var(--radius)',padding:'10px 14px',marginBottom:16,fontSize:12}}>
          <strong>{lead?.property_address || 'No address'}</strong>
          {(lead?.town || lead?.state) && <span style={{color:'var(--gw-mist)'}}>, {[lead.town,lead.state].filter(Boolean).join(', ')}</span>}
          {lead?.prop_type && <span style={{marginLeft:8,background:'var(--gw-azure)',color:'#fff',padding:'1px 7px',borderRadius:8,fontSize:10,fontWeight:700}}>{lead.prop_type}{lead.unit_count?` · ${lead.unit_count} units`:''}</span>}
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label required">First Name</label><input className="form-control" value={form.first_name} onChange={e=>set('first_name',e.target.value)}/></div>
          <div className="form-group"><label className="form-label">Last Name</label><input className="form-control" value={form.last_name} onChange={e=>set('last_name',e.target.value)}/></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Phone</label><input className="form-control" value={form.phone} onChange={e=>set('phone',e.target.value)}/></div>
          <div className="form-group"><label className="form-label">Email</label><input className="form-control" type="email" value={form.email} onChange={e=>set('email',e.target.value)}/></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Type</label>
            <select className="form-control" value={form.type} onChange={e=>set('type',e.target.value)}>
              {['buyer','seller','investor','landlord','tenant'].map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
            </select></div>
          <div className="form-group"><label className="form-label">Agent</label>
            <select className="form-control" value={form.assigned_agent_id} onChange={e=>set('assigned_agent_id',e.target.value)}>
              <option value="">Unassigned</option>
              {agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
            </select></div>
        </div>
        <div className="form-group"><label className="form-label">Notes</label><textarea className="form-control form-control--textarea" value={form.notes} onChange={e=>set('notes',e.target.value)}/></div>
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Create Contact'}</button>
      </div>
    </Modal>
  )
}

// ── Power Dialer ──────────────────────────────────────────────────────────
function PowerDialer({ leads, startIndex, agents, activeAgent, onClose, onUpdate }) {
  const [idx, setIdx]             = useState(startIndex || 0)
  const [notes, setNotes]         = useState('')
  const [saving, setSaving]       = useState(false)
  const [showConvert, setShowConvert] = useState(false)
  const [showCallback, setShowCallback] = useState(false)
  const [callbackDate, setCallbackDate] = useState('')
  const [script, setScript]       = useState('')
  const [scriptLoading, setScriptLoading] = useState(false)
  const [showScript, setShowScript] = useState(false)

  const lead = leads[idx]

  useEffect(() => {
    setNotes(lead?.call_notes || '')
    setCallbackDate(lead?.callback_date || '')
    setShowCallback(false)
    setShowConvert(false)
    setScript('')
    setShowScript(false)
  }, [lead?.id])

  const generateScript = async () => {
    setScriptLoading(true); setShowScript(true)
    const ctx = [
      `Property: ${[lead.property_address, lead.town, lead.state].filter(Boolean).join(', ')}`,
      lead.prop_type ? `Type: ${lead.prop_type}${lead.unit_count ? `, ${lead.unit_count} units` : ''}` : '',
      lead.owner_name ? `Owner/Entity: ${lead.owner_name}` : '',
      lead.contact_name ? `Contact name: ${lead.contact_name}` : '',
      lead.age ? `Age: ${lead.age}` : '',
      lead.remarks ? `List notes: ${lead.remarks}` : '',
      lead.call_count > 0 ? `Prior call attempts: ${lead.call_count}` : 'First call attempt',
      notes ? `Previous call notes: ${notes}` : '',
      `Agent name: ${activeAgent?.name || 'your agent'}`,
    ].filter(Boolean).join('\n')

    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: `You are a real estate cold calling coach specializing in investment properties. Write natural, conversational scripts that don't sound robotic. Keep it concise and practical.`,
          messages: [{ role: 'user', content: `Generate a cold call script for this lead:\n\n${ctx}\n\nInclude: opening, reason for calling, 2-3 key questions, one common objection + response, and a closing to schedule follow-up. Use plain text with clear section labels.` }],
          max_tokens: 800,
        }),
      })
      const data = await res.json()
      setScript(data.content?.[0]?.text || 'Could not generate script.')
    } catch (e) {
      setScript('Error generating script: ' + e.message)
    }
    setScriptLoading(false)
  }

  const copyText = (t) => { navigator.clipboard.writeText(t); pushToast('Copied') }

  const saveNotes = async () => {
    if (!lead) return
    await supabase.from('cold_call_leads').update({ call_notes: notes }).eq('id', lead.id)
    onUpdate(lead.id, { call_notes: notes })
  }

  const advance = () => {
    let next = idx + 1
    while (next < leads.length && leads[next]?.status === 'dnc') next++
    if (next < leads.length) setIdx(next)
    else { pushToast('End of list — great work!'); onClose() }
  }

  const updateStatus = async (status, extra = {}) => {
    setSaving(true)
    const patch = { status, call_notes: notes, called_at: new Date().toISOString(), ...extra }
    if (status === 'called') patch.call_count = (lead.call_count || 0) + 1
    await supabase.from('cold_call_leads').update(patch).eq('id', lead.id)
    if (status === 'callback' && extra.callback_date) {
      await supabase.from('tasks').insert([{
        title: `Callback: ${lead.contact_name || lead.property_address || 'Cold Call Lead'}`,
        type: 'call', priority: 'high',
        due_date: `${extra.callback_date}T09:00`,
        agent_id: activeAgent?.id || null,
        notes: notes || null,
        completed: false,
      }])
      pushToast('Callback task created')
    }
    onUpdate(lead.id, patch)
    setSaving(false)
    if (status !== 'converted') advance()
  }

  const total    = leads.length
  const dialable = leads.filter(l => l.status !== 'dnc').length
  const done     = leads.filter(l => ['called','callback','converted','dnc'].includes(l.status)).length

  if (!lead) return (
    <div style={OVERLAY}>
      <div style={CARD}>
        <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:16,padding:40}}>
          <div style={{fontSize:18,fontWeight:700}}>All leads dialed!</div>
          <button className="btn btn--primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )

  const phones = (lead.phones || []).slice(0, 3)
  const emails = (lead.emails || []).slice(0, 2)

  return (
    <div style={OVERLAY}>
      <div style={CARD}>
        {/* Header */}
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'14px 20px',borderBottom:'1px solid var(--gw-border)'}}>
          <div style={{fontSize:12,color:'var(--gw-mist)',fontWeight:600}}>
            Lead {idx+1} of {total} &nbsp;·&nbsp;
            <span style={{color:'var(--gw-azure)'}}>{done} dialed</span> &nbsp;·&nbsp;
            <span style={{color:'var(--gw-green)'}}>{leads.filter(l=>l.status==='converted').length} converted</span>
          </div>
          <button className="btn btn--ghost btn--icon" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div style={{height:3,background:'var(--gw-border)'}}>
          <div style={{width:`${(done/Math.max(total,1))*100}%`,height:'100%',background:'var(--gw-azure)',transition:'width 300ms'}}/>
        </div>

        <div style={{flex:1,overflowY:'auto',padding:20}}>
          {/* Property */}
          <div style={{background:'var(--gw-sky)',borderRadius:'var(--radius)',padding:'12px 14px',marginBottom:16}}>
            <div style={{fontSize:15,fontWeight:700}}>{lead.property_address || '—'}</div>
            <div style={{fontSize:12,color:'var(--gw-mist)',marginTop:2}}>
              {[lead.town,lead.state].filter(Boolean).join(', ')}
              {lead.prop_type && <span style={{marginLeft:8,background:'var(--gw-azure)',color:'#fff',padding:'1px 7px',borderRadius:8,fontSize:10,fontWeight:700}}>{lead.prop_type}{lead.unit_count?` · ${lead.unit_count} units`:''}</span>}
            </div>
            {lead.owner_name && <div style={{fontSize:12,marginTop:4}}><span style={{color:'var(--gw-mist)'}}>Owner: </span><strong>{lead.owner_name}</strong></div>}
          </div>

          {/* Contact */}
          <div style={{marginBottom:14}}>
            <div style={{fontSize:14,fontWeight:700}}>{lead.contact_name || 'Unknown'}{lead.age?<span style={{fontSize:11,color:'var(--gw-mist)',marginLeft:6}}>age {lead.age}</span>:''}</div>
            {lead.owner_address && <div style={{fontSize:12,color:'var(--gw-mist)',marginTop:2}}>{[lead.owner_address,lead.owner_city,lead.owner_state,lead.owner_zip].filter(Boolean).join(', ')}</div>}
          </div>

          {/* Phones */}
          <div style={{marginBottom:14}}>
            {phones.length === 0 ? <div style={{fontSize:12,color:'var(--gw-mist)'}}>No phone numbers on file</div> : phones.map((p,i) => (
              <div key={i} style={{display:'flex',alignItems:'center',gap:8,marginBottom:7,padding:'6px 8px',borderRadius:'var(--radius)',background:i===0?'#fffbe6':'transparent',border:i===0?'1px solid #ffe58f':'1px solid transparent'}}>
                <span style={{fontSize:13}}>{i===0?'⭐':'📞'}</span>
                <div style={{fontSize:15,fontWeight:700,fontFamily:'var(--font-mono)',flex:1,letterSpacing:'0.02em'}}>{p}</div>
                {i===0 && <span style={{fontSize:10,color:'#a67c00',fontWeight:600,background:'#fff1a8',padding:'1px 6px',borderRadius:8}}>Best</span>}
                <button className="btn btn--ghost btn--sm" onClick={()=>copyText(p)} style={{fontSize:11}}><Icon name="copy" size={11}/></button>
                <a href={`tel:${p.replace(/\D/g,'')}`} className="btn btn--primary btn--sm" style={{fontSize:11,textDecoration:'none'}}><Icon name="phone" size={11}/> Call</a>
              </div>
            ))}
          </div>

          {/* Emails */}
          {emails.length > 0 && (
            <div style={{marginBottom:14}}>
              {emails.map((e,i) => (
                <div key={i} style={{display:'flex',alignItems:'center',gap:8,marginBottom:4,fontSize:13}}>
                  <Icon name="mail" size={13} style={{color:'var(--gw-mist)',flexShrink:0}}/>
                  <span style={{flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{e}</span>
                  <button className="btn btn--ghost btn--sm" style={{fontSize:11}} onClick={()=>copyText(e)}><Icon name="copy" size={11}/></button>
                </div>
              ))}
            </div>
          )}

          {/* Remarks */}
          {lead.remarks && (
            <div style={{fontSize:12,color:'var(--gw-mist)',marginBottom:14,padding:'8px 10px',background:'var(--gw-bone)',borderRadius:'var(--radius)',lineHeight:1.5}}>{lead.remarks}</div>
          )}

          {/* AI Script */}
          <div style={{marginBottom:12}}>
            <button className="btn btn--ghost btn--sm" style={{fontSize:11,width:'100%',justifyContent:'center'}} onClick={generateScript} disabled={scriptLoading}>
              {scriptLoading ? '✦ Generating script…' : showScript ? '✦ Regenerate Script' : '✦ Generate Call Script'}
            </button>
            {showScript && script && (
              <div style={{marginTop:8,background:'#f8f9ff',border:'1px solid #c5cff5',borderRadius:'var(--radius)',padding:'10px 12px',fontSize:12,lineHeight:1.7,whiteSpace:'pre-wrap',maxHeight:220,overflowY:'auto',color:'var(--gw-ink)'}}>
                {scriptLoading ? 'Writing script…' : script}
              </div>
            )}
          </div>

          {/* Notes */}
          <div className="form-group" style={{marginBottom:8}}>
            <label className="form-label">Call Notes</label>
            <textarea className="form-control form-control--textarea" style={{minHeight:80,fontSize:13}}
              value={notes} onChange={e=>setNotes(e.target.value)} onBlur={saveNotes}
              placeholder="What happened on this call…"/>
          </div>

          {showCallback && (
            <div className="form-group">
              <label className="form-label">Callback Date</label>
              <input className="form-control" type="date" value={callbackDate} onChange={e=>setCallbackDate(e.target.value)}/>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div style={{padding:'12px 16px',borderTop:'1px solid var(--gw-border)',display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:8}}>
          <button className="btn btn--secondary" style={{flexDirection:'column',alignItems:'center',gap:4,padding:'10px 0',fontSize:12,display:'flex'}}
            onClick={()=>updateStatus('called')} disabled={saving}>
            <Icon name="check" size={16}/>Called
          </button>
          <button className="btn btn--secondary"
            style={{flexDirection:'column',alignItems:'center',gap:4,padding:'10px 0',fontSize:12,display:'flex',borderColor:showCallback?'var(--gw-amber)':'',color:showCallback?'#856404':''}}
            onClick={()=>{ if (!showCallback) { setShowCallback(true) } else { updateStatus('callback',{callback_date:callbackDate||null}) } }} disabled={saving}>
            <Icon name="calendar" size={16}/>{showCallback?'Set Date':'Callback'}
          </button>
          <button className="btn btn--secondary" style={{flexDirection:'column',alignItems:'center',gap:4,padding:'10px 0',fontSize:12,display:'flex',borderColor:'var(--gw-red)',color:'var(--gw-red)'}}
            onClick={()=>updateStatus('dnc')} disabled={saving}>
            <Icon name="x" size={16}/>DNC
          </button>
          <button className="btn btn--primary" style={{flexDirection:'column',alignItems:'center',gap:4,padding:'10px 0',fontSize:12,display:'flex'}}
            onClick={()=>{ saveNotes(); setShowConvert(true) }} disabled={saving}>
            <Icon name="contacts" size={16}/>Convert
          </button>
        </div>

        {/* Prev / Next */}
        <div style={{padding:'8px 16px',borderTop:'1px solid var(--gw-border)',display:'flex',gap:8}}>
          <button className="btn btn--ghost btn--sm" style={{flex:1}} onClick={()=>setIdx(i=>Math.max(0,i-1))} disabled={idx===0}>← Prev</button>
          <button className="btn btn--ghost btn--sm" style={{flex:1}} onClick={advance} disabled={idx>=leads.length-1}>Next →</button>
        </div>
      </div>

      {showConvert && (
        <ConvertModal
          lead={{...lead, call_notes:notes}} agents={agents} activeAgent={activeAgent}
          onClose={()=>setShowConvert(false)}
          onConverted={(c)=>{ onUpdate(lead.id,{status:'converted',contact_id:c.id}); setShowConvert(false); advance() }}
        />
      )}
    </div>
  )
}

const OVERLAY = { position:'fixed', inset:0, background:'rgba(0,0,0,0.65)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center' }
const CARD    = { background:'#fff', borderRadius:12, width:'100%', maxWidth:480, maxHeight:'90vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.3)' }

// ── Main Page ─────────────────────────────────────────────────────────────
export default function ColdCallsPage({ db, activeAgent }) {
  const [lists, setLists]             = useState([])
  const [selected, setSelected]       = useState(null)
  const [leads, setLeads]             = useState([])
  const [loadingLeads, setLoadingLeads] = useState(false)
  const [filterStatus, setFilterStatus] = useState('all')
  const [uploadOpen, setUploadOpen]   = useState(false)
  const [dialer, setDialer]           = useState(false)
  const [dialerStart, setDialerStart] = useState(0)
  const [convertLead, setConvertLead] = useState(null)
  const [filterAgent, setFilterAgent] = useState('all')
  const [ready, setReady]             = useState(true)

  const agents = db?.agents || []

  useEffect(() => { loadLists() }, [])

  const loadLists = async () => {
    const { data, error } = await supabase.from('cold_call_lists').select('*').order('created_at', { ascending: false })
    if (error?.code === '42P01') { setReady(false); return }
    const rows = data || []
    setLists(rows)
    if (rows.length && !selected) setSelected(rows[0])
  }

  useEffect(() => {
    if (!selected) return
    setLoadingLeads(true)
    supabase.from('cold_call_leads').select('*').eq('list_id', selected.id).order('created_at', { ascending: true })
      .then(({ data }) => { setLeads(data || []); setLoadingLeads(false) })
  }, [selected?.id])

  const updateLead = (id, patch) => setLeads(p => p.map(l => l.id === id ? {...l, ...patch} : l))

  const deleteList = async (list) => {
    await supabase.from('cold_call_lists').delete().eq('id', list.id)
    setLists(p => p.filter(l => l.id !== list.id))
    if (selected?.id === list.id) {
      const rest = lists.filter(l => l.id !== list.id)
      setSelected(rest[0] || null); setLeads([])
    }
    pushToast('List deleted', 'info')
  }

  const filtered = leads
    .filter(l => filterStatus === 'all' || l.status === filterStatus)
    .filter(l => filterAgent === 'all' || l.agent_id === filterAgent)

  const stats = {
    total:     leads.length,
    called:    leads.filter(l => l.status === 'called').length,
    callback:  leads.filter(l => l.status === 'callback').length,
    converted: leads.filter(l => l.status === 'converted').length,
    dnc:       leads.filter(l => l.status === 'dnc').length,
  }
  const donePct = stats.total > 0 ? Math.round((stats.called + stats.converted + stats.dnc + stats.callback) / stats.total * 100) : 0

  if (!ready) return (
    <div className="page-content">
      <div className="page-header"><div><div className="page-title">Cold Call Lists</div></div>
        <button className="btn btn--primary" onClick={()=>setReady(true)}><Icon name="refresh" size={14}/> Retry</button>
      </div>
      <div className="card" style={{padding:24}}>
        <div style={{fontWeight:600,marginBottom:8}}>Run this SQL in Supabase → SQL Editor first:</div>
        <pre style={{background:'#1a1a2e',color:'#c9a84c',padding:14,borderRadius:'var(--radius)',fontSize:11,overflowX:'auto',lineHeight:1.6,maxHeight:300,overflowY:'auto'}}>{SQL_SETUP}</pre>
        <button className="btn btn--secondary btn--sm" style={{marginTop:10}} onClick={()=>{navigator.clipboard.writeText(SQL_SETUP);pushToast('SQL copied')}}>
          <Icon name="copy" size={12}/> Copy SQL
        </button>
      </div>
    </div>
  )

  return (
    <div className="page-content" style={{display:'flex',flexDirection:'column',overflow:'hidden',height:'100%',paddingBottom:0}}>
      <div className="page-header">
        <div><div className="page-title">Cold Call Lists</div><div className="page-sub">{lists.length} lists</div></div>
        <button className="btn btn--primary" onClick={()=>setUploadOpen(true)}><Icon name="upload" size={14}/> Upload List</button>
      </div>

      <div style={{display:'flex',flex:1,gap:0,overflow:'hidden',border:'1px solid var(--gw-border)',borderRadius:'var(--radius)',background:'#fff',minHeight:0}}>

        {/* Sidebar */}
        <div style={{width:220,flexShrink:0,borderRight:'1px solid var(--gw-border)',overflowY:'auto',background:'var(--gw-bone)'}}>
          {lists.length === 0
            ? <div style={{padding:24,textAlign:'center',color:'var(--gw-mist)',fontSize:13}}>No lists yet.<br/>Upload a CSV to start.</div>
            : lists.map(list => {
                const isActive = selected?.id === list.id
                const agent = agents.find(a => a.id === list.agent_id)
                return (
                  <div key={list.id} onClick={()=>setSelected(list)} style={{
                    padding:'12px 14px', borderBottom:'1px solid var(--gw-border)', cursor:'pointer',
                    background: isActive ? '#fff' : 'transparent',
                    borderLeft: isActive ? '3px solid var(--gw-azure)' : '3px solid transparent', transition:'all 120ms'}}>
                    <div style={{fontSize:13,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:2}}>{list.name}</div>
                    {agent && <div style={{fontSize:11,color:'var(--gw-mist)'}}>{agent.name}</div>}
                    <div style={{fontSize:10,color:'var(--gw-mist)',marginTop:3}}>{new Date(list.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>
                    {isActive && stats.total > 0 && (
                      <div style={{marginTop:6}}>
                        <div style={{height:3,background:'var(--gw-border)',borderRadius:2,overflow:'hidden'}}>
                          <div style={{width:`${donePct}%`,height:'100%',background:'var(--gw-azure)',borderRadius:2}}/>
                        </div>
                        <div style={{fontSize:10,color:'var(--gw-mist)',marginTop:2}}>{donePct}% dialed</div>
                      </div>
                    )}
                    <button className="btn btn--ghost btn--icon btn--sm" style={{marginTop:4,opacity:0.4}}
                      onClick={e=>{e.stopPropagation();deleteList(list)}}><Icon name="trash" size={11}/></button>
                  </div>
                )
              })
          }
        </div>

        {/* Leads panel */}
        <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
          {!selected
            ? <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',color:'var(--gw-mist)',fontSize:13}}>Select a list or upload a new one</div>
            : <>
              {/* List header */}
              <div style={{padding:'10px 16px',borderBottom:'1px solid var(--gw-border)',display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                <div style={{fontSize:14,fontWeight:700,flex:1,minWidth:0,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{selected.name}</div>
                <div style={{display:'flex',gap:5,fontSize:11,flexShrink:0}}>
                  <span style={{background:'var(--gw-bone)',padding:'2px 7px',borderRadius:8,color:'var(--gw-mist)'}}>{stats.total} total</span>
                  <span style={{background:'#e8f4fd',color:'var(--gw-azure)',padding:'2px 7px',borderRadius:8}}>{stats.called} called</span>
                  <span style={{background:'#fff3cd',color:'#856404',padding:'2px 7px',borderRadius:8}}>{stats.callback} callback</span>
                  <span style={{background:'var(--gw-green-light)',color:'var(--gw-green)',padding:'2px 7px',borderRadius:8}}>{stats.converted} converted</span>
                </div>
                {agents.length > 1 && (
                  <select className="form-control" style={{width:'auto',fontSize:11,padding:'3px 8px',height:28}} value={filterAgent} onChange={e=>setFilterAgent(e.target.value)}>
                    <option value="all">All Agents</option>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                )}
                <button className="btn btn--primary btn--sm"
                  onClick={()=>{ const i=leads.findIndex(l=>l.status==='new'); setDialerStart(i>=0?i:0); setDialer(true) }}
                  disabled={leads.filter(l=>l.status==='new').length===0}>
                  <Icon name="phone" size={13}/> Power Dialer
                </button>
              </div>

              {/* Status filter tabs */}
              <div style={{padding:'8px 14px',borderBottom:'1px solid var(--gw-border)',display:'flex',gap:4,flexWrap:'wrap'}}>
                {['all','new','called','callback','converted','dnc'].map(s => (
                  <button key={s} onClick={()=>setFilterStatus(s)} style={{
                    padding:'3px 10px',border:'1px solid',borderRadius:10,fontSize:11,fontWeight:600,cursor:'pointer',
                    background: filterStatus===s ? 'var(--gw-slate)' : 'transparent',
                    color:      filterStatus===s ? '#fff' : 'var(--gw-mist)',
                    borderColor:filterStatus===s ? 'var(--gw-slate)' : 'var(--gw-border)'}}>
                    {s==='all'?'All':STATUS[s]?.label} ({s==='all'?leads.length:leads.filter(l=>l.status===s).length})
                  </button>
                ))}
              </div>

              {/* Table */}
              <div style={{flex:1,overflowY:'auto'}}>
                {loadingLeads
                  ? <div style={{padding:24,color:'var(--gw-mist)',fontSize:13}}>Loading leads…</div>
                  : filtered.length === 0
                    ? <div style={{padding:40,textAlign:'center',color:'var(--gw-mist)',fontSize:13}}>No leads in this filter.</div>
                    : <table style={{width:'100%',borderCollapse:'collapse'}}>
                        <thead>
                          <tr style={{background:'var(--gw-bone)',borderBottom:'1px solid var(--gw-border)',position:'sticky',top:0}}>
                            {['Contact','Property','Type','Phones','Status',''].map(h=>(
                              <th key={h} style={{padding:'8px 12px',textAlign:'left',fontSize:11,fontWeight:700,color:'var(--gw-mist)',whiteSpace:'nowrap'}}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map(lead => (
                            <tr key={lead.id} style={{borderBottom:'1px solid var(--gw-border)'}}
                              onMouseEnter={e=>e.currentTarget.style.background='var(--gw-sky)'}
                              onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                              <td style={{padding:'9px 12px',fontSize:13}}>
                                <div style={{fontWeight:600}}>{lead.contact_name||'—'}</div>
                                {lead.owner_name&&<div style={{fontSize:11,color:'var(--gw-mist)',marginTop:1}}>{lead.owner_name}</div>}
                              </td>
                              <td style={{padding:'9px 12px',fontSize:12}}>
                                <div>{lead.property_address||'—'}</div>
                                {(lead.town||lead.state)&&<div style={{fontSize:11,color:'var(--gw-mist)'}}>{[lead.town,lead.state].filter(Boolean).join(', ')}</div>}
                              </td>
                              <td style={{padding:'9px 12px',fontSize:12,color:'var(--gw-mist)'}}>
                                {lead.prop_type||'—'}{lead.unit_count&&<div style={{fontSize:11}}>{lead.unit_count}u</div>}
                              </td>
                              <td style={{padding:'9px 12px'}}>
                                {(lead.phones||[]).slice(0,2).map((p,i)=><div key={i} style={{fontFamily:'var(--font-mono)',fontSize:11,marginBottom:1}}>{i===0&&lead.phones.length>0?'⭐ ':''}{p}</div>)}
                              </td>
                              <td style={{padding:'9px 12px'}}>
                                <StatusBadge status={lead.status}/>
                                {(lead.call_count > 0) && <span style={{marginLeft:5,background:'var(--gw-azure)',color:'#fff',padding:'1px 6px',borderRadius:8,fontSize:10,fontWeight:700}}>{lead.call_count}×</span>}
                              </td>
                              <td style={{padding:'9px 12px'}}>
                                <div style={{display:'flex',gap:4}}>
                                  <button className="btn btn--ghost btn--icon btn--sm" title="Open in dialer"
                                    onClick={()=>{ setDialerStart(leads.indexOf(lead)); setDialer(true) }}>
                                    <Icon name="phone" size={13}/>
                                  </button>
                                  {!['converted','dnc'].includes(lead.status) && (
                                    <button className="btn btn--ghost btn--icon btn--sm" title="Convert to contact"
                                      onClick={()=>setConvertLead(lead)}>
                                      <Icon name="contacts" size={13}/>
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                }
              </div>
            </>
          }
        </div>
      </div>

      {uploadOpen && (
        <UploadModal open={uploadOpen} onClose={()=>setUploadOpen(false)} agents={agents} activeAgent={activeAgent}
          onUploaded={()=>{ loadLists(); if(selected) { supabase.from('cold_call_leads').select('*').eq('list_id',selected.id).order('created_at',{ascending:true}).then(({data})=>setLeads(data||[])) } }} />
      )}
      {dialer && (
        <PowerDialer leads={leads} startIndex={dialerStart} agents={agents} activeAgent={activeAgent}
          onClose={()=>setDialer(false)} onUpdate={updateLead} />
      )}
      {convertLead && (
        <ConvertModal lead={convertLead} agents={agents} activeAgent={activeAgent}
          onClose={()=>setConvertLead(null)}
          onConverted={(c)=>{ updateLead(convertLead.id,{status:'converted',contact_id:c.id}); setConvertLead(null) }} />
      )}
    </div>
  )
}
