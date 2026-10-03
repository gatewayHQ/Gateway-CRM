// Import a mailing's recipients from a CSV.

import React, { useMemo, useState } from 'react'
import { Icon, pushToast } from '../../components/UI.jsx'
import { autoMapColumns, parseCSV } from './csvImport.js'
import { api } from '../../lib/services/campaignsApi.js'

// ─── Recipient picker / importer ──────────────────────────────────────────────

export function RecipientImporter({ mailingId, contacts, onDone, onCancel }) {
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

  // Deal Machine neighbor lookup state
  const [dmAddress, setDmAddress]       = useState('')
  const [dmRadius, setDmRadius]         = useState(500)
  const [dmResults, setDmResults]       = useState(null)
  const [dmPicked, setDmPicked]         = useState(new Set())
  const [dmLoading, setDmLoading]       = useState(false)
  const [dmSetupNeeded, setDmSetupNeeded] = useState(false)

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

  const searchDealMachine = async () => {
    if (!dmAddress.trim()) return pushToast('Enter a center address first', 'error')
    setDmLoading(true)
    setDmResults(null)
    setDmSetupNeeded(false)
    try {
      const data = await api('deal_machine', { address: dmAddress, radius: dmRadius })
      if (data.setup) { setDmSetupNeeded(true); return }
      if (data.error) { pushToast(data.error, 'error'); return }
      const props = data.properties || []
      setDmResults(props)
      setDmPicked(new Set(props.map((_, i) => i)))
      if (props.length === 0) pushToast('No property records found in that radius', 'error')
    } catch (err) {
      pushToast('Search failed: ' + err.message, 'error')
    } finally {
      setDmLoading(false)
    }
  }

  const submitDealMachine = async () => {
    if (!dmResults || dmPicked.size === 0) return pushToast('Select at least one property', 'error')
    const recipients = dmResults
      .filter((_, i) => dmPicked.has(i))
      .map(p => ({
        recipient_name: p.owner_name || null,
        address_line1:  p.address_line1 || null,
        city:           p.city  || null,
        state:          p.state || null,
        zip:            p.zip   || null,
        source:         'deal_machine',
      }))
      .filter(r => r.recipient_name || r.address_line1)
    if (recipients.length === 0) return pushToast('No usable records selected', 'error')
    setSaving(true)
    const res = await api('add_recipients', { mailing_id: mailingId, recipients })
    setSaving(false)
    if (res.error) return pushToast(res.error, 'error')
    pushToast(`Imported ${res.count} neighbor${res.count === 1 ? '' : 's'} from Deal Machine`)
    onDone(res.count)
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
      <div style={{ display:'flex', gap:6, borderBottom:'1px solid var(--gw-border)', paddingBottom:8, flexWrap:'wrap' }}>
        {[
          { id:'database',    label:'From CRM Contacts', icon:'contacts' },
          { id:'csv',         label:'Upload CSV',         icon:'upload'   },
          { id:'manual',      label:'Add Manually',       icon:'plus'     },
          { id:'dealmachine', label:'Neighbor Lookup',    icon:'map-pin'  },
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

      {mode === 'dealmachine' && (
        <>
          {dmSetupNeeded ? (
            <div style={{ background:'#fffbeb', border:'1px solid #fcd34d', borderRadius:8, padding:16 }}>
              <div style={{ fontWeight:700, fontSize:13, color:'#92400e', marginBottom:6 }}>Deal Machine API not configured</div>
              <div style={{ fontSize:12, color:'#78350f', lineHeight:1.6 }}>
                To use neighbor lookup, add your Deal Machine API key to Vercel:
              </div>
              <ol style={{ fontSize:12, color:'#78350f', marginTop:8, lineHeight:1.8, paddingLeft:18 }}>
                <li>Go to <strong>Deal Machine app → Account → Integrations → API</strong> to get your key</li>
                <li>In <strong>Vercel → Project → Settings → Environment Variables</strong>, add <code>DEAL_MACHINE_API_KEY</code></li>
                <li>Redeploy, then come back here</li>
              </ol>
              <button type="button" className="btn btn--ghost" onClick={onCancel} style={{ marginTop:10 }}>Close</button>
            </div>
          ) : (
            <>
              <div style={{ fontSize:12, color:'var(--gw-mist)', lineHeight:1.5 }}>
                Paste a center address (e.g. a property you just sold) and we'll pull the surrounding owner names + mailing addresses from Deal Machine — ready to import as recipients.
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:8, alignItems:'flex-end' }}>
                <div>
                  <label style={{ fontSize:11, fontWeight:700, color:'var(--gw-ink)', display:'block', marginBottom:4 }}>Center Address</label>
                  <input className="input" value={dmAddress} onChange={e => setDmAddress(e.target.value)}
                         placeholder="123 Main St, Oakland CA 94612"
                         onKeyDown={e => e.key === 'Enter' && searchDealMachine()} />
                </div>
                <div>
                  <label style={{ fontSize:11, fontWeight:700, color:'var(--gw-ink)', display:'block', marginBottom:4 }}>Radius</label>
                  <select className="input" value={dmRadius} onChange={e => setDmRadius(Number(e.target.value))} style={{ width:130 }}>
                    <option value={200}>200 ft (~1 blk)</option>
                    <option value={500}>500 ft</option>
                    <option value={1000}>1,000 ft</option>
                    <option value={2640}>½ mile</option>
                    <option value={5280}>1 mile</option>
                  </select>
                </div>
              </div>
              <button type="button" className="btn btn--primary" disabled={dmLoading} onClick={searchDealMachine}
                      style={{ alignSelf:'flex-start' }}>
                {dmLoading ? 'Searching…' : '🔍 Find Neighbors'}
              </button>

              {dmResults !== null && (
                <>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <div style={{ fontSize:12, color:'var(--gw-mist)' }}>
                      {dmResults.length} properties found · {dmPicked.size} selected
                    </div>
                    <div style={{ display:'flex', gap:6 }}>
                      <button type="button" className="btn btn--ghost" style={{ fontSize:11 }}
                              onClick={() => setDmPicked(new Set(dmResults.map((_, i) => i)))}>
                        Select all
                      </button>
                      <button type="button" className="btn btn--ghost" style={{ fontSize:11 }}
                              onClick={() => setDmPicked(new Set())}>
                        Deselect all
                      </button>
                    </div>
                  </div>
                  {dmResults.length > 0 && (
                    <div style={{ maxHeight:320, overflowY:'auto', border:'1px solid var(--gw-border)', borderRadius:8 }}>
                      {dmResults.map((p, i) => (
                        <label key={i} style={{ display:'flex', alignItems:'flex-start', gap:10, padding:'8px 12px',
                                                borderBottom:'1px solid var(--gw-border)', cursor:'pointer' }}>
                          <input type="checkbox" checked={dmPicked.has(i)} style={{ marginTop:2 }}
                                 onChange={e => setDmPicked(s => {
                                   const n = new Set(s)
                                   e.target.checked ? n.add(i) : n.delete(i)
                                   return n
                                 })} />
                          <div style={{ flex:1, minWidth:0 }}>
                            <div style={{ fontWeight:600, fontSize:13 }}>{p.owner_name || '(Owner unknown)'}</div>
                            <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:1 }}>
                              {[p.address_line1, p.city, p.state, p.zip].filter(Boolean).join(', ') || '—'}
                            </div>
                            {p.property_type && (
                              <div style={{ fontSize:10, color:'var(--gw-mist)', marginTop:1 }}>{p.property_type}{p.estimated_value ? ` · est. ${Number(p.estimated_value).toLocaleString('en-US', { style:'currency', currency:'USD', maximumFractionDigits:0 })}` : ''}</div>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                  <div style={{ display:'flex', justifyContent:'space-between' }}>
                    <button type="button" className="btn btn--ghost" onClick={() => setDmResults(null)}>← New search</button>
                    <div style={{ display:'flex', gap:8 }}>
                      <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
                      <button type="button" className="btn btn--primary" disabled={saving || dmPicked.size === 0} onClick={submitDealMachine}>
                        {saving ? 'Importing…' : `Import ${dmPicked.size} Recipient${dmPicked.size === 1 ? '' : 's'}`}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {dmResults === null && !dmLoading && (
                <div style={{ display:'flex', justifyContent:'flex-end' }}>
                  <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
