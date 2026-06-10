import React, { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, pushToast } from '../../components/UI.jsx'
import { normalizePhone } from '../../lib/phone.js'
import { CONTACT_TYPES, CONTACT_STATUSES, CONTACT_SOURCES } from '../../lib/enums.js'

function parseCSV(text) {
  const rows = []
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const row = []
    let cur = '', inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') inQ = !inQ
      else if (ch === ',' && !inQ) { row.push(cur.trim()); cur = '' }
      else cur += ch
    }
    row.push(cur.trim())
    rows.push(row)
  }
  return rows
}

const IMPORT_FIELDS = ['first_name','last_name','email','phone','type','source','status','notes','assigned_agent']
const IMPORT_LABELS = { first_name: 'First Name', last_name: 'Last Name', email: 'Email', phone: 'Phone', type: 'Type', source: 'Source', status: 'Status', notes: 'Notes', assigned_agent: 'Agent Name' }

export default function CSVImportModal({ onClose, onImported, agents, activeAgent, existingContacts = [] }) {
  const [step, setStep] = useState(1)        // 1=upload  2=map  3=preview  4=importing
  const [headers, setHeaders] = useState([])
  const [rows, setRows] = useState([])
  const [mapping, setMapping] = useState({})
  const [progress, setProgress] = useState(0)
  const [errors, setErrors] = useState([])
  const [defaultAgentId, setDefaultAgentId] = useState(activeAgent?.id || '')
  const [skipDuplicates, setSkipDuplicates] = useState(true)

  const handleFile = (file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const parsed = parseCSV(e.target.result)
      if (parsed.length < 2) { pushToast('File must have a header row and at least one data row.', 'error'); return }
      const hdrs = parsed[0]
      setHeaders(hdrs)
      setRows(parsed.slice(1))
      // Auto-map by header name
      const auto = {}
      hdrs.forEach((h, i) => {
        const norm = h.toLowerCase().replace(/\s+/g, '_')
        const match = IMPORT_FIELDS.find(f => f === norm || f.replace('_', '') === norm.replace('_', ''))
        if (match) auto[match] = i
      })
      setMapping(auto)
      setStep(2)
    }
    reader.readAsText(file)
  }

  const resolveAgentId = (nameStr) => {
    if (!nameStr) return defaultAgentId || null
    const norm = nameStr.toLowerCase().trim()
    const exact = agents.find(a => a.name.toLowerCase() === norm)
    if (exact) return exact.id
    const partial = agents.find(a =>
      a.name.toLowerCase().split(' ')[0] === norm ||
      a.name.toLowerCase().includes(norm)
    )
    return partial ? partial.id : (defaultAgentId || null)
  }

  const getFirstName = (row) =>
    mapping.first_name !== undefined ? (row[mapping.first_name] || '').trim() : ''

  const validRows  = rows.filter(row => getFirstName(row) !== '')
  const blankCount = rows.length - validRows.length

  // Duplicate detection: by email (preferred) or normalized phone
  const existingEmails = new Set(existingContacts.map(c => (c.email || '').toLowerCase()).filter(Boolean))
  const existingPhones = new Set(existingContacts.map(c => normalizePhone(c.phone)).filter(Boolean))

  const duplicates = skipDuplicates ? validRows.filter(row => {
    const email = mapping.email !== undefined ? (row[mapping.email] || '').toLowerCase().trim() : ''
    const phone = mapping.phone !== undefined ? normalizePhone(row[mapping.phone]) : null
    return (email && existingEmails.has(email)) || (phone && existingPhones.has(phone))
  }).length : 0

  const rowsToImport = skipDuplicates
    ? validRows.filter(row => {
        const email = mapping.email !== undefined ? (row[mapping.email] || '').toLowerCase().trim() : ''
        const phone = mapping.phone !== undefined ? normalizePhone(row[mapping.phone]) : null
        return !((email && existingEmails.has(email)) || (phone && existingPhones.has(phone)))
      })
    : validRows

  const preview = rowsToImport.slice(0, 5).map(row => {
    const obj = {}
    IMPORT_FIELDS.forEach(f => { if (mapping[f] !== undefined) obj[f] = row[mapping[f]] || '' })
    return obj
  })

  const doImport = async () => {
    setStep(4); setProgress(0); setErrors([])
    const validTypes   = CONTACT_TYPES
    const validSources = CONTACT_SOURCES
    const validStatus  = CONTACT_STATUSES
    const CHUNK = 50
    let done = 0
    const errs = []

    for (let i = 0; i < rowsToImport.length; i += CHUNK) {
      const chunk = rowsToImport.slice(i, i + CHUNK).map(row => {
        const r = {}
        IMPORT_FIELDS.forEach(f => { if (mapping[f] !== undefined) r[f] = (row[mapping[f]] || '').trim() })
        return {
          first_name: r.first_name || '(Unknown)',
          last_name:  r.last_name  || '',
          email:      r.email || null,
          phone:      r.phone ? (normalizePhone(r.phone) || r.phone) : null,
          type:       validTypes.includes(r.type?.toLowerCase())     ? r.type.toLowerCase()   : 'buyer',
          source:     validSources.includes(r.source?.toLowerCase()) ? r.source.toLowerCase() : 'other',
          status:     validStatus.includes(r.status?.toLowerCase())  ? r.status.toLowerCase() : 'active',
          notes:      r.notes || null,
          assigned_agent_id: resolveAgentId(r.assigned_agent),
          tags: [],
        }
      })
      const { error } = await supabase.from('contacts').insert(chunk)
      if (error) errs.push(`Rows ${i + 1}–${i + CHUNK}: ${error.message}`)
      done += chunk.length
      setProgress(Math.round(done / rowsToImport.length * 100))
    }

    setErrors(errs)
    if (errs.length === 0) {
      const notes = []
      if (blankCount)  notes.push(`${blankCount} blank skipped`)
      if (duplicates)  notes.push(`${duplicates} duplicate${duplicates !== 1 ? 's' : ''} skipped`)
      pushToast(`${rowsToImport.length} contact${rowsToImport.length !== 1 ? 's' : ''} imported${notes.length ? ` (${notes.join(', ')})` : ''}`)
      onImported?.()
      onClose()
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,14,28,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 900, padding: 24 }}>
      <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 560, boxShadow: 'var(--shadow-modal)', display: 'flex', flexDirection: 'column', maxHeight: '90vh' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--gw-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <div>
            <div className="eyebrow-label">Contacts</div>
            <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 20 }}>Import CSV</h3>
          </div>
          <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
        </div>

        {step === 1 && (
          <div style={{ padding: 24, flex: 1, overflowY: 'auto' }}>
            <p style={{ fontSize: 13, color: 'var(--gw-mist)', lineHeight: 1.6, marginTop: 0 }}>
              Upload a CSV with contacts. First row must be headers. Supported columns:{' '}
              <strong>first_name, last_name, email, phone, type, source, status, notes</strong>.
            </p>
            <label
              style={{ display: 'block', border: '2px dashed var(--gw-border)', borderRadius: 'var(--radius)', padding: '36px 24px', textAlign: 'center', cursor: 'pointer', transition: 'all 150ms' }}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--gw-azure)' }}
              onDragLeave={(e) => { e.currentTarget.style.borderColor = 'var(--gw-border)' }}
              onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }}
            >
              <Icon name="upload" size={28} style={{ color: 'var(--gw-border)', marginBottom: 10 }} />
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Drop CSV here or click to browse</div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)' }}>CSV files only</div>
              <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => handleFile(e.target.files[0])} />
            </label>
          </div>
        )}

        {step === 2 && (
          <div style={{ padding: 24, flex: 1, overflowY: 'auto' }}>
            <p style={{ fontSize: 13, color: 'var(--gw-mist)', marginTop: 0, lineHeight: 1.6 }}>
              Map your CSV columns to CRM fields. <strong>{rows.length} rows</strong> detected.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
              {IMPORT_FIELDS.map(field => (
                <React.Fragment key={field}>
                  <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 600 }}>
                    {IMPORT_LABELS[field]}
                    {['first_name','last_name'].includes(field) && <span style={{ color: 'var(--gw-red)', marginLeft: 2 }}>*</span>}
                  </div>
                  <select className="form-control" style={{ fontSize: 12 }} value={mapping[field] ?? ''} onChange={(e) => setMapping(p => ({ ...p, [field]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                    <option value="">— Skip —</option>
                    {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                  </select>
                </React.Fragment>
              ))}
            </div>

            <div style={{ background: 'var(--gw-bone)', borderRadius: 'var(--radius)', padding: '12px 14px', marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Default Agent</div>
              <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginBottom: 8 }}>
                Contacts without an agent column go to this agent.
              </div>
              <select className="form-control" style={{ fontSize: 12 }} value={defaultAgentId} onChange={(e) => setDefaultAgentId(e.target.value)}>
                {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'var(--gw-bone)', borderRadius: 'var(--radius)', cursor: 'pointer', marginBottom: 20 }}>
              <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
              <span style={{ fontSize: 12 }}>
                <strong>Skip duplicates</strong> — match by email or phone against existing contacts
              </span>
            </label>

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn--secondary" onClick={() => setStep(1)}>Back</button>
              <button className="btn btn--primary" onClick={() => setStep(3)} disabled={mapping.first_name === undefined}>Preview →</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div style={{ padding: 24, flex: 1, overflowY: 'auto' }}>
            <p style={{ fontSize: 13, color: 'var(--gw-mist)', marginTop: 0 }}>
              Importing <strong>{rowsToImport.length} contacts</strong>
              {blankCount  > 0 && <span style={{ color: 'var(--gw-amber)' }}> · {blankCount} blank skipped</span>}
              {duplicates  > 0 && <span style={{ color: 'var(--gw-amber)' }}> · {duplicates} duplicate{duplicates !== 1 ? 's' : ''} skipped</span>}
            </p>
            <div style={{ overflowX: 'auto', marginBottom: 20 }}>
              <table className="import-preview-table">
                <thead>
                  <tr>{IMPORT_FIELDS.filter(f => mapping[f] !== undefined).map(f => <th key={f}>{IMPORT_LABELS[f]}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.map((row, i) => (
                    <tr key={i}>{IMPORT_FIELDS.filter(f => mapping[f] !== undefined).map(f => <td key={f}>{row[f] || '—'}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn--secondary" onClick={() => setStep(2)}>Back</button>
              <button className="btn btn--primary" onClick={doImport}>
                <Icon name="import" size={13} /> Import {rowsToImport.length} Contacts
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div style={{ padding: 40, textAlign: 'center', flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16 }}>Importing…</div>
            <div style={{ height: 8, background: 'var(--gw-border)', borderRadius: 4, marginBottom: 12, overflow: 'hidden' }}>
              <div style={{ width: `${progress}%`, height: '100%', background: 'var(--gw-azure)', borderRadius: 4, transition: 'width 200ms ease' }} />
            </div>
            <div style={{ fontSize: 13, color: 'var(--gw-mist)' }}>{progress}% complete</div>
            {errors.length > 0 && (
              <div style={{ marginTop: 16, textAlign: 'left' }}>
                {errors.map((e, i) => <div key={i} style={{ fontSize: 12, color: 'var(--gw-red)', marginBottom: 4 }}>{e}</div>)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
