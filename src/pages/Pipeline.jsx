import React, { useState, useRef, useMemo, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatCurrency, formatDate, STAGE_LABELS, STAGE_ORDER, getKeyDateUrgency, getNearestKeyDate } from '../lib/helpers.js'
import { Icon, Badge, Avatar, Drawer, Modal, EmptyState, ConfirmDialog, SearchDropdown, pushToast } from '../components/UI.jsx'

const DEFAULT_STEPS_RESIDENTIAL = [
  'Title Search Ordered',
  'Earnest Money Deposited',
  'Home Inspection Scheduled',
  'Inspection Report Reviewed',
  'Appraisal Ordered',
  'Appraisal Report Received',
  'Financing Conditionally Approved',
  'Financing Fully Approved',
  'Final Walkthrough Scheduled',
  'Closing Disclosure Reviewed',
  'Closing Documents Signed',
  'Keys & Possession Transferred',
]

const DEFAULT_STEPS_COMMERCIAL = [
  'Title Search Ordered',
  'Earnest Money Deposited',
  'Environmental Due Diligence (Phase I)',
  'Property Inspection Ordered',
  'Inspection Report Reviewed',
  'Survey Ordered',
  'Survey Received & Approved',
  'Zoning & Entitlements Verified',
  'Financing Commitment Received',
  'Lease Review (if applicable)',
  'Closing Disclosure Reviewed',
  'Closing Documents Signed',
  'Keys & Possession Transferred',
]

const CHECKLIST_STAGES = ['under-contract','closed']

const DEFAULT_KEY_DATE_TYPES = ['Closing','Financing Contingency','Inspection','HUD Approval','Appraisal','Lease Start Date','Possession Date']

function ChecklistTab({ deal }) {
  const [steps, setSteps]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [newTitle, setNewTitle] = useState('')
  const [adding, setAdding]     = useState(false)
  const [ready, setReady]       = useState(true)

  const defaultSteps = deal?.prop_category === 'commercial' ? DEFAULT_STEPS_COMMERCIAL : DEFAULT_STEPS_RESIDENTIAL

  React.useEffect(() => {
    if (!deal?.id) return
    loadSteps()
  }, [deal?.id])

  const loadSteps = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('transaction_steps')
      .select('*')
      .eq('deal_id', deal.id)
      .order('sort_order', { ascending: true })
    if (error) { setReady(false); setLoading(false); return }
    if (data.length === 0 && CHECKLIST_STAGES.includes(deal.stage)) {
      await autoCreate()
    } else {
      setSteps(data)
    }
    setLoading(false)
  }

  const autoCreate = async () => {
    const rows = defaultSteps.map((title, i) => ({ deal_id: deal.id, title, completed: false, sort_order: i }))
    const { data } = await supabase.from('transaction_steps').insert(rows).select()
    setSteps(data || [])
    pushToast(`${deal?.prop_category === 'commercial' ? 'Commercial' : 'Residential'} closing checklist created`, 'info')
  }

  const toggle = async (step) => {
    const now = new Date().toISOString()
    const patch = { completed: !step.completed, completed_at: !step.completed ? now : null }
    await supabase.from('transaction_steps').update(patch).eq('id', step.id)
    setSteps(p => p.map(s => s.id === step.id ? { ...s, ...patch } : s))
  }

  const addStep = async () => {
    if (!newTitle.trim()) return
    setAdding(true)
    const { data, error } = await supabase.from('transaction_steps').insert([{
      deal_id: deal.id, title: newTitle.trim(), completed: false, sort_order: steps.length,
    }]).select().single()
    setAdding(false)
    if (error) { pushToast(error.message, 'error'); return }
    setSteps(p => [...p, data])
    setNewTitle('')
  }

  const removeStep = async (id) => {
    await supabase.from('transaction_steps').delete().eq('id', id)
    setSteps(p => p.filter(s => s.id !== id))
  }

  if (!ready) return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--gw-mist)' }}>
      <Icon name="alert" size={20} style={{ marginBottom: 8 }} />
      <div style={{ fontSize: 13 }}>transaction_steps table not found.</div>
      <div style={{ fontSize: 12, marginTop: 4 }}>Run the SQL from the setup guide to enable checklists.</div>
    </div>
  )

  if (loading) return <div style={{ padding: 24, color: 'var(--gw-mist)', fontSize: 13 }}>Loading checklist…</div>

  const doneCount = steps.filter(s => s.completed).length
  const pct       = steps.length > 0 ? Math.round(doneCount / steps.length * 100) : 0

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      {/* Progress bar */}
      {steps.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            <span>{doneCount}/{steps.length} complete</span>
            <span style={{ color: pct === 100 ? 'var(--gw-green)' : 'var(--gw-mist)' }}>{pct}%</span>
          </div>
          <div style={{ height: 6, background: 'var(--gw-border)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? 'var(--gw-green)' : 'var(--gw-azure)', borderRadius: 3, transition: 'width 300ms ease' }} />
          </div>
        </div>
      )}

      {/* Steps */}
      {steps.length === 0 && !CHECKLIST_STAGES.includes(deal.stage) && (
        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--gw-mist)', fontSize: 13 }}>
          Checklist auto-creates when this deal reaches <strong>Under Contract</strong>.<br />
          {deal?.prop_category === 'commercial' ? 'Commercial closing steps will be loaded.' : 'Residential closing steps will be loaded.'}<br />
          Or add steps manually below.
        </div>
      )}

      {steps.map(step => (
        <div key={step.id} onClick={() => toggle(step)}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 'var(--radius)', cursor: 'pointer', marginBottom: 3, transition: 'background 120ms' }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--gw-bone)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          <div style={{ width: 20, height: 20, borderRadius: 4, border: `2px solid ${step.completed ? 'var(--gw-green)' : 'var(--gw-border)'}`, background: step.completed ? 'var(--gw-green)' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 150ms' }}>
            {step.completed && <Icon name="check" size={11} style={{ color: '#fff' }} />}
          </div>
          <span style={{ flex: 1, fontSize: 13, textDecoration: step.completed ? 'line-through' : 'none', color: step.completed ? 'var(--gw-mist)' : 'var(--gw-ink)' }}>
            {step.title}
          </span>
          {step.completed && step.completed_at && (
            <span style={{ fontSize: 10, color: 'var(--gw-mist)', whiteSpace: 'nowrap' }}>
              {new Date(step.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </span>
          )}
          <button className="btn btn--ghost btn--icon" style={{ padding: 2, opacity: 0.4 }}
            onClick={e => { e.stopPropagation(); removeStep(step.id) }}>
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}

      {/* Add custom step */}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <input className="form-control" style={{ flex: 1, fontSize: 13 }}
          placeholder="Add a step…"
          value={newTitle} onChange={e => setNewTitle(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addStep()}
          disabled={adding} />
        <button className="btn btn--secondary btn--sm" onClick={addStep} disabled={adding || !newTitle.trim()}>
          Add
        </button>
      </div>
    </div>
  )
}

function KeyDatesTab({ deal, onSave }) {
  const [dates, setDates]         = useState([])
  const [saving, setSaving]       = useState(false)
  const [saveErr, setSaveErr]     = useState(null)
  const [newType, setNewType]     = useState('')
  const [customType, setCustomType] = useState('')
  const [showCustom, setShowCustom] = useState(false)

  React.useEffect(() => {
    if (!deal?.id) return
    const existing = deal.comp_data?.key_dates
    if (existing && existing.length > 0) {
      setDates(existing)
    } else {
      setDates(DEFAULT_KEY_DATE_TYPES.map(type => ({ type, date: '' })))
    }
  }, [deal?.id])

  const persist = async (updated) => {
    setSaving(true)
    setSaveErr(null)
    const comp_data = { ...(deal.comp_data || {}), key_dates: updated }
    const { error } = await supabase.from('deals').update({ comp_data, updated_at: new Date().toISOString() }).eq('id', deal.id)
    setSaving(false)
    if (error) { setSaveErr(error.message); return }
    if (onSave) onSave()
  }

  const updateDate = (i, date) => {
    const updated = dates.map((d, idx) => idx === i ? { ...d, date } : d)
    setDates(updated)
    persist(updated)
  }

  const addRow = (type) => {
    const t = type.trim()
    if (!t || dates.some(d => d.type.toLowerCase() === t.toLowerCase())) return
    const updated = [...dates, { type: t, date: '' }]
    setDates(updated)
    persist(updated)
    setNewType(''); setCustomType(''); setShowCustom(false)
  }

  const removeRow = (i) => {
    const updated = dates.filter((_, idx) => idx !== i)
    setDates(updated)
    persist(updated)
  }

  const usedTypes = new Set(dates.map(d => d.type))
  const availableTypes = DEFAULT_KEY_DATE_TYPES.filter(t => !usedTypes.has(t))

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 12, color: saveErr ? 'var(--gw-red)' : 'var(--gw-mist)' }}>
          {saving ? 'Saving…' : saveErr ? `Save failed: ${saveErr}` : 'Changes auto-saved'}
        </div>
      </div>

      {dates.map((row, i) => (
        <div key={row.type} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ flex: '0 0 160px', fontSize: 13, fontWeight: 600, color: 'var(--gw-ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {row.type}
          </div>
          <input
            type="date"
            className="form-control"
            style={{ flex: 1, fontSize: 13 }}
            value={row.date || ''}
            onChange={e => updateDate(i, e.target.value)}
          />
          <button className="btn btn--ghost btn--icon btn--sm" title="Remove" onClick={() => removeRow(i)} style={{ opacity: 0.5 }}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}

      {/* Add date row */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--gw-border)', paddingTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--gw-mist)', marginBottom: 8 }}>Add Date</div>
        {!showCustom ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {availableTypes.map(t => (
              <button key={t} className="btn btn--secondary btn--sm" style={{ fontSize: 11 }} onClick={() => addRow(t)}>
                + {t}
              </button>
            ))}
            <button className="btn btn--secondary btn--sm" style={{ fontSize: 11 }} onClick={() => setShowCustom(true)}>
              + Custom…
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="form-control"
              style={{ flex: 1, fontSize: 13 }}
              placeholder="Date type name…"
              value={customType}
              onChange={e => setCustomType(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addRow(customType)}
              autoFocus
            />
            <button className="btn btn--primary btn--sm" onClick={() => addRow(customType)} disabled={!customType.trim()}>Add</button>
            <button className="btn btn--secondary btn--sm" onClick={() => { setShowCustom(false); setCustomType('') }}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  )
}

const BUCKET = 'deal-documents'

function formatBytes(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DocumentsTab({ deal }) {
  const [files, setFiles]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [uploading, setUploading] = useState(false)
  const [bucketReady, setBucketReady] = useState(true)
  const [dragOver, setDragOver]   = useState(false)
  const fileRef                   = React.useRef()

  React.useEffect(() => { if (deal?.id) loadFiles() }, [deal?.id])

  const loadFiles = async () => {
    setLoading(true)
    const { data, error } = await supabase.storage.from(BUCKET).list(`deal-${deal.id}`, { sortBy: { column: 'created_at', order: 'desc' } })
    if (error?.message?.includes('not found') || error?.message?.includes('does not exist')) {
      setBucketReady(false); setLoading(false); return
    }
    setFiles((data || []).filter(f => f.name !== '.emptyFolderPlaceholder'))
    setLoading(false)
  }

  const upload = async (file) => {
    if (!file) return
    if (file.size > 50 * 1024 * 1024) { pushToast('File must be under 50 MB', 'error'); return }
    setUploading(true)
    const path = `deal-${deal.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false })
    setUploading(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(`${file.name} uploaded`)
    loadFiles()
  }

  const download = async (fileName) => {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(`deal-${deal.id}/${fileName}`, 60)
    if (error) { pushToast('Could not create download link', 'error'); return }
    const a = document.createElement('a')
    a.href = data.signedUrl; a.download = fileName; a.target = '_blank'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  const remove = async (fileName) => {
    const { error } = await supabase.storage.from(BUCKET).remove([`deal-${deal.id}/${fileName}`])
    if (error) { pushToast(error.message, 'error'); return }
    pushToast('File deleted', 'info')
    setFiles(p => p.filter(f => f.name !== fileName))
  }

  if (!bucketReady) return (
    <div style={{ padding: 20 }}>
      <div style={{ background: '#fff8ec', border: '1px solid var(--gw-amber)', borderRadius: 'var(--radius)', padding: 16, fontSize: 13, lineHeight: 1.7 }}>
        <strong>Storage bucket setup required.</strong><br />
        In your <strong>Supabase dashboard → Storage</strong>, create a private bucket named <code style={{ background: 'var(--gw-bone)', padding: '1px 5px', borderRadius: 3 }}>deal-documents</code>, then add this RLS policy:
        <pre style={{ background: 'var(--gw-slate)', color: '#e2e8f0', padding: 10, borderRadius: 6, fontSize: 11, marginTop: 8, overflowX: 'auto' }}>
{`create policy "agents_deal_docs"
on storage.objects for all to authenticated
using  (bucket_id = 'deal-documents')
with check (bucket_id = 'deal-documents');`}
        </pre>
        <button className="btn btn--secondary btn--sm" style={{ marginTop: 8 }} onClick={() => { setBucketReady(true); loadFiles() }}>
          <Icon name="refresh" size={12} /> Retry
        </button>
      </div>
    </div>
  )

  if (loading) return <div style={{ padding: 24, fontSize: 13, color: 'var(--gw-mist)' }}>Loading files…</div>

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
      {/* Drop zone */}
      <div
        style={{ border: `2px dashed ${dragOver ? 'var(--gw-azure)' : 'var(--gw-border)'}`, borderRadius: 'var(--radius)', padding: '20px 16px', textAlign: 'center', cursor: 'pointer', marginBottom: 16, background: dragOver ? 'var(--gw-sky)' : 'transparent', transition: 'all 150ms' }}
        onClick={() => fileRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); upload(e.dataTransfer.files[0]) }}>
        <input ref={fileRef} type="file" style={{ display: 'none' }} onChange={e => upload(e.target.files[0])} />
        {uploading ? (
          <div style={{ fontSize: 13, color: 'var(--gw-azure)', fontWeight: 600 }}>Uploading…</div>
        ) : (
          <>
            <Icon name="upload" size={22} style={{ color: 'var(--gw-border)', marginBottom: 6 }} />
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gw-ink)' }}>Drop a file or click to upload</div>
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 3 }}>PDF, Word, images — max 50 MB · Stored securely in Supabase</div>
          </>
        )}
      </div>

      {/* File list */}
      {files.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--gw-mist)', fontSize: 13, padding: '16px 0' }}>
          No documents yet. Upload contracts, inspections, or any deal files.
        </div>
      ) : (
        files.map(file => {
          const ext = file.name.split('.').pop().toUpperCase()
          const displayName = file.name.replace(/^\d+-/, '')
          return (
            <div key={file.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', marginBottom: 6, background: '#fff' }}>
              <div style={{ width: 34, height: 34, borderRadius: 6, background: 'var(--gw-sky)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 9, fontWeight: 700, color: 'var(--gw-azure)', letterSpacing: '0.03em' }}>
                {ext.slice(0, 4)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={displayName}>{displayName}</div>
                <div style={{ fontSize: 11, color: 'var(--gw-mist)' }}>
                  {formatBytes(file.metadata?.size)}
                  {file.created_at && <> · {new Date(file.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</>}
                </div>
              </div>
              <button className="btn btn--ghost btn--icon btn--sm" title="Download" onClick={() => download(file.name)}>
                <Icon name="download" size={13} />
              </button>
              <button className="btn btn--ghost btn--icon btn--sm" title="Delete" onClick={() => remove(file.name)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          )
        })
      )}
    </div>
  )
}

const DS_STATUS = {
  sent:      { bg: '#e8f4fd', color: 'var(--gw-azure)' },
  delivered: { bg: '#fff3cd', color: '#856404' },
  completed: { bg: 'var(--gw-green-light)', color: 'var(--gw-green)' },
  declined:  { bg: 'var(--gw-red-light)',   color: 'var(--gw-red)' },
  voided:    { bg: 'var(--gw-bone)',         color: 'var(--gw-mist)' },
}

const FIELD_TYPES = {
  signature: { label: 'Sign Here', color: '#2563eb', bg: '#dbeafe' },
  initials:  { label: 'Initials',  color: '#7c3aed', bg: '#ede9fe' },
  date:      { label: 'Date',      color: '#059669', bg: '#d1fae5' },
}

// Document-level annotation tools (not tied to a signer)
const ANNOTATION_TYPES = {
  highlight:     { label: 'Highlight',     color: '#d97706', bg: 'rgba(253,224,71,0.45)', w: 160, h: 14 },
  strikethrough: { label: 'Strike-through', color: '#dc2626', bg: 'rgba(220,38,38,0.7)',  w: 160, h: 3  },
  checkbox:      { label: 'Checkbox',       color: '#1a2236', bg: 'rgba(26,34,54,0.06)',  w: 18,  h: 18 },
}

// Per-signer accent colors for multi-signer field placement
const SIGNER_COLORS = ['#2563eb','#d97706','#dc2626','#0891b2']
const SIGNER_BGS    = ['#dbeafe','#fef3c7','#fee2e2','#cffafe']

const PDF_SCALE = 1.3

// allFields = flat array of all signers' tabs, each with signerIndex for color-coding
// docAnnotations = document-level highlight/strikethrough marks (not per-signer)
function PDFPlacer({ file, fileUrl, allFields, onPlace, onRemove, activeTool, setActiveTool, activeSignerIndex, docAnnotations, onPlaceAnnotation, onRemoveAnnotation }) {
  const [pages,   setPages]   = React.useState([])
  const [loading, setLoading] = React.useState(true)
  const canvasRefs = React.useRef({})

  React.useEffect(() => { loadPDF() }, [])
  React.useEffect(() => { if (pages.length > 0) renderPages() }, [pages])

  const loadPDF = async () => {
    setLoading(true)
    if (!window.pdfjsLib) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
        s.onload = resolve; s.onerror = reject
        document.head.appendChild(s)
      })
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
    }
    let buf
    if (file) { buf = await file.arrayBuffer() }
    else { buf = await fetch(fileUrl).then(r => r.arrayBuffer()) }
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise
    const list = []
    for (let i = 1; i <= pdf.numPages; i++) {
      const pageObj  = await pdf.getPage(i)
      const viewport = pageObj.getViewport({ scale: PDF_SCALE })
      list.push({ pageObj, viewport })
    }
    setPages(list)
    setLoading(false)
  }

  const renderPages = async () => {
    for (let i = 0; i < pages.length; i++) {
      const canvas = canvasRefs.current[i]
      if (!canvas) continue
      const { pageObj, viewport } = pages[i]
      canvas.width  = viewport.width
      canvas.height = viewport.height
      await pageObj.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
    }
  }

  const handleClick = (e, pageIndex) => {
    if (!activeTool) return
    const rect    = e.currentTarget.getBoundingClientRect()
    const xCanvas = e.clientX - rect.left
    const yCanvas = e.clientY - rect.top
    // Annotation tools are document-level, not per-signer
    if (ANNOTATION_TYPES[activeTool]) {
      const ann = ANNOTATION_TYPES[activeTool]
      onPlaceAnnotation({
        id: Date.now(), type: activeTool,
        page: pageIndex + 1, pageIndex,
        xCanvas: xCanvas - ann.w / 2,
        yCanvas: yCanvas - ann.h / 2,
        xPosition: String(Math.round((xCanvas - ann.w / 2) / PDF_SCALE)),
        yPosition: String(Math.round((yCanvas - ann.h / 2) / PDF_SCALE)),
        width: ann.w, height: ann.h,
      })
    } else {
      onPlace({
        id: Date.now(), type: activeTool,
        page: pageIndex + 1,
        xPosition: String(Math.round(xCanvas / PDF_SCALE)),
        yPosition: String(Math.round(yCanvas / PDF_SCALE)),
        xCanvas, yCanvas, pageIndex,
        signerIndex: activeSignerIndex,
      })
    }
  }

  if (loading) return <div style={{ padding:'40px 0', textAlign:'center', color:'var(--gw-mist)', fontSize:13 }}>Loading PDF…</div>

  return (
    <div>
      <div style={{ display:'flex', gap:6, marginBottom:6, alignItems:'center', flexWrap:'wrap' }}>
        <span style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--gw-mist)', flexBasis:'100%' }}>Signature Fields</span>
        {Object.entries(FIELD_TYPES).map(([key, { label }]) => {
          const color = SIGNER_COLORS[activeSignerIndex] || SIGNER_COLORS[0]
          const bg    = SIGNER_BGS[activeSignerIndex]    || SIGNER_BGS[0]
          const active = activeTool === key
          return (
            <button key={key} onClick={() => setActiveTool(active ? null : key)}
              style={{ padding:'5px 12px', borderRadius:'var(--radius)', fontSize:12, fontWeight:700, cursor:'pointer', border:`2px solid ${active?color:'var(--gw-border)'}`, background:active?bg:'#fff', color:active?color:'var(--gw-mist)' }}>
              + {label}
            </button>
          )
        })}
      </div>
      <div style={{ display:'flex', gap:6, marginBottom:10, alignItems:'center', flexWrap:'wrap' }}>
        <span style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.07em', color:'var(--gw-mist)', flexBasis:'100%' }}>Document Markup</span>
        {Object.entries(ANNOTATION_TYPES).map(([key, { label, color, bg }]) => {
          const active = activeTool === key
          return (
            <button key={key} onClick={() => setActiveTool(active ? null : key)}
              style={{ padding:'5px 12px', borderRadius:'var(--radius)', fontSize:12, fontWeight:700, cursor:'pointer', border:`2px solid ${active?color:'var(--gw-border)'}`, background:active?bg:'#fff', color:active?color:'var(--gw-mist)' }}>
              {key === 'highlight' ? '🖊 ' : key === 'strikethrough' ? '—— ' : '☐ '}{label}
            </button>
          )
        })}
        <span style={{ fontSize:11, color:'var(--gw-mist)', marginLeft:4 }}>
          {activeTool ? (ANNOTATION_TYPES[activeTool] ? 'Click to mark area' : 'Click PDF to place') : 'Select a tool above'}
        </span>
        {(allFields.length + (docAnnotations?.length||0)) > 0 && (
          <span style={{ marginLeft:'auto', fontSize:11, fontWeight:700 }}>
            {allFields.length} field{allFields.length !== 1 ? 's' : ''}
            {(docAnnotations?.length||0) > 0 && ` · ${docAnnotations.length} mark${docAnnotations.length !== 1 ? 's' : ''}`}
          </span>
        )}
      </div>
      <div style={{ maxHeight:420, overflowY:'auto', overflowX:'auto', background:'#e5e7eb', borderRadius:'var(--radius)', padding:12, display:'flex', flexDirection:'column', alignItems:'flex-start', gap:12 }}>
        {pages.map((_, i) => (
          <div key={i} style={{ position:'relative' }}>
            <div style={{ fontSize:10, color:'#6b7280', marginBottom:4, textAlign:'center' }}>Page {i + 1}</div>
            <canvas ref={el => { if (el) canvasRefs.current[i] = el }} style={{ display:'block', boxShadow:'0 2px 8px rgba(0,0,0,0.2)' }}/>
            <div style={{ position:'absolute', inset:0, cursor:activeTool?'crosshair':'default', marginTop:18 }} onClick={e => handleClick(e, i)}/>
            {allFields.filter(f => f.pageIndex === i).map(f => {
              const color = SIGNER_COLORS[f.signerIndex] || SIGNER_COLORS[0]
              const bg    = SIGNER_BGS[f.signerIndex]    || SIGNER_BGS[0]
              const ft    = FIELD_TYPES[f.type]
              const dim   = f.signerIndex !== activeSignerIndex
              return (
                <div key={f.id} style={{ position:'absolute', left:f.xCanvas - 42, top:f.yCanvas - 10 + 18, display:'flex', alignItems:'center', gap:3, background:bg, border:`1.5px solid ${color}`, borderRadius:3, padding:'2px 6px', fontSize:10, fontWeight:700, color, whiteSpace:'nowrap', zIndex:10, pointerEvents:'auto', opacity: dim ? 0.4 : 1 }}>
                  {ft?.label}
                  <span onClick={e => { e.stopPropagation(); onRemove(f.id) }} style={{ cursor:'pointer', fontSize:12, lineHeight:1, opacity:0.6, marginLeft:1 }}>×</span>
                </div>
              )
            })}
            {/* Document annotations (highlight / strikethrough) */}
            {(docAnnotations||[]).filter(a => a.pageIndex === i).map(a => {
              const ann = ANNOTATION_TYPES[a.type]
              return (
                <div key={a.id} style={{
                  position:'absolute',
                  left: a.xCanvas, top: a.yCanvas + 18,
                  width: a.width, height: a.height,
                  background: ann?.bg,
                  border: `${a.type === 'checkbox' ? 2 : 1}px solid ${ann?.color}`,
                  borderRadius: a.type === 'highlight' ? 2 : 0,
                  zIndex: 9, pointerEvents:'auto', cursor:'default',
                  display:'flex', alignItems:'center', justifyContent: a.type === 'checkbox' ? 'center' : 'flex-end',
                }}>
                  {a.type === 'checkbox'
                    ? <span onClick={e => { e.stopPropagation(); onRemoveAnnotation(a.id) }} style={{ fontSize:9, cursor:'pointer', color: ann?.color, lineHeight:1, opacity:0.7 }}>×</span>
                    : <span onClick={e => { e.stopPropagation(); onRemoveAnnotation(a.id) }} style={{ fontSize:10, cursor:'pointer', color: ann?.color, lineHeight:1, padding:'0 2px', opacity:0.8 }}>×</span>
                  }
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

function SendSignatureModal({ deal, contacts, dealFiles, activeAgent, onClose, onSent }) {
  const contact     = contacts?.find(c => c.id === deal?.contact_id)
  const defaultName = `${contact?.first_name || ''} ${contact?.last_name || ''}`.trim()
  const defaultEmail= (contact?.emails || [])[0] || ''

  const [step,          setStep]        = React.useState(1)
  const [subject,       setSubject]     = React.useState(`Please sign: ${deal?.title || 'Document'}`)
  const [file,          setFile]        = React.useState(null)
  const [pickedFile,    setPickedFile]  = React.useState('')
  const [fileUrl,       setFileUrl]     = React.useState(null)
  const [activeTool,    setActiveTool]  = React.useState('signature')
  const [activeSignerI, setActiveSignerI] = React.useState(0)
  const [agentSigns,    setAgentSigns]  = React.useState(false)
  const [agentTabs,     setAgentTabs]   = React.useState([])
  const [docAnnotations, setDocAnnotations] = React.useState([])
  const [sending,       setSending]     = React.useState(false)
  const [dragOver,      setDragOver]    = React.useState(false)
  const [autoDetecting, setAutoDetecting] = React.useState(false)
  const [autoResult,    setAutoResult]  = React.useState(null)   // { docType, label, signerTabs }
  const [useAnchorTabs, setUseAnchorTabs] = React.useState(false)
  const fileRef = React.useRef()

  // Each signer has name, email, tabs[]
  const [signers, setSigners] = React.useState([
    { id: 1, name: defaultName, email: defaultEmail, tabs: [] }
  ])

  const addSigner    = () => setSigners(p => [...p, { id: Date.now(), name:'', email:'', tabs:[] }])
  const removeSigner = (id) => setSigners(p => p.filter(s => s.id !== id))
  const updateSigner = (id, k, v) => setSigners(p => p.map(s => s.id===id ? {...s,[k]:v} : s))

  // All signers including optional agent (always last, routingOrder 2)
  // agentTabs is kept in its own state so placeField can update it independently
  const allSigners = React.useMemo(() => {
    const clients = signers.map(s => ({ ...s, routingOrder: 1 }))
    if (agentSigns && activeAgent) {
      clients.push({ id:'agent', name: activeAgent.name, email: activeAgent.email, routingOrder: 2, tabs: agentTabs })
    }
    return clients
  }, [signers, agentSigns, activeAgent, agentTabs])

  // Flat list of all tabs across all signers (for PDFPlacer)
  const allFields = allSigners.flatMap((s, i) => (s.tabs || []).map(t => ({ ...t, signerIndex: i })))

  const placeField = (field) => {
    const isAgent = agentSigns && activeSignerI === signers.length
    if (isAgent) {
      setAgentTabs(p => [...p, field])
    } else {
      setSigners(p => p.map((s, i) => {
        if (i !== activeSignerI) return s
        return { ...s, tabs: [...(s.tabs || []), field] }
      }))
    }
  }

  const removeField = (fieldId) => {
    setSigners(p => p.map(s => ({ ...s, tabs: (s.tabs || []).filter(t => t.id !== fieldId) })))
    setAgentTabs(p => p.filter(t => t.id !== fieldId))
  }

  const toBase64 = f => new Promise((res, rej) => {
    const r = new FileReader(); r.onload = e => res(e.target.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(f)
  })

  const docName = file ? file.name : (pickedFile ? pickedFile.replace(/^\d+-/, '') : '')

  const autoDetect = async () => {
    if (!docName) { pushToast('Select a document first', 'error'); return }
    const invalid = signers.find(s => !s.name.trim() || !s.email.trim())
    if (invalid) { pushToast('Fill in all signer names and emails first', 'error'); return }
    setAutoDetecting(true)
    try {
      const signerRoles = allSigners.map((s, i) => ({
        name: s.name, email: s.email, routingOrder: s.routingOrder,
        role: i === 0 ? '' : i === allSigners.length - 1 && agentSigns ? 'agent' : '',
      }))
      const resp = await fetch('/api/docusign', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'analyze', documentName: docName, signers: signerRoles }),
      })
      const data = await resp.json()
      if (data.error) { pushToast(data.error, 'error'); return }
      setAutoResult(data)
      setUseAnchorTabs(true)
    } catch (err) {
      pushToast('Auto-detect failed: ' + err.message, 'error')
    } finally {
      setAutoDetecting(false)
    }
  }

  const goToStep2 = async () => {
    const invalid = signers.find(s => !s.name.trim() || !s.email.trim())
    if (invalid) { pushToast('All signers need a name and email', 'error'); return }
    if (!file && !pickedFile) { pushToast('Select or upload a document', 'error'); return }
    if (pickedFile && !fileUrl) {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(`deal-${deal.id}/${pickedFile}`, 300)
      if (error) { pushToast('Could not load document', 'error'); return }
      setFileUrl(data.signedUrl)
    }
    setStep(2)
  }

  // Burn highlight/strikethrough annotations into PDF pages using canvas + jsPDF
  const buildAnnotatedBase64 = async (srcFile, srcUrl, annotations) => {
    if (!window.jspdf) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script')
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
        s.onload = resolve; s.onerror = reject
        document.head.appendChild(s)
      })
    }
    const { jsPDF } = window.jspdf
    let buf
    if (srcFile) { buf = await srcFile.arrayBuffer() }
    else { buf = await fetch(srcUrl).then(r => r.arrayBuffer()) }

    const pdfDoc = await window.pdfjsLib.getDocument({ data: buf }).promise
    const doc    = new jsPDF({ unit: 'pt', compress: true })
    let firstPage = true

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page     = await pdfDoc.getPage(pageNum)
      const viewport = page.getViewport({ scale: 2 })
      const canvas   = document.createElement('canvas')
      canvas.width   = viewport.width
      canvas.height  = viewport.height
      const ctx      = canvas.getContext('2d')
      await page.render({ canvasContext: ctx, viewport }).promise

      for (const a of annotations.filter(ann => ann.page === pageNum)) {
        const sx = 2, sy = 2  // scale factor (viewport scale = 2)
        if (a.type === 'highlight') {
          ctx.fillStyle = 'rgba(255, 235, 59, 0.42)'
          ctx.fillRect(a.xCanvas * sx, a.yCanvas * sy, a.width * sx, a.height * sy)
        } else if (a.type === 'strikethrough') {
          ctx.strokeStyle = 'rgba(220, 38, 38, 0.85)'
          ctx.lineWidth   = 3
          const midY = (a.yCanvas + a.height / 2) * sy
          ctx.beginPath()
          ctx.moveTo(a.xCanvas * sx, midY)
          ctx.lineTo((a.xCanvas + a.width) * sx, midY)
          ctx.stroke()
        } else if (a.type === 'checkbox') {
          ctx.strokeStyle = '#1a2236'
          ctx.lineWidth   = 2
          ctx.strokeRect(a.xCanvas * sx, a.yCanvas * sy, a.width * sx, a.height * sy)
        }
      }

      const imgData  = canvas.toDataURL('image/jpeg', 0.92)
      const pdfW     = viewport.width  * 0.75
      const pdfH     = viewport.height * 0.75
      if (!firstPage) doc.addPage([pdfW, pdfH])
      else { doc.internal.pageSize.width = pdfW; doc.internal.pageSize.height = pdfH; firstPage = false }
      doc.addImage(imgData, 'JPEG', 0, 0, pdfW, pdfH, '', 'FAST')
    }

    return doc.output('datauristring').split(',')[1]
  }

  const send = async () => {
    if (!useAnchorTabs && allFields.length === 0) { pushToast('Place at least one field on the PDF', 'error'); return }
    setSending(true)

    // When anchor tabs bypass step 2, the signed URL may not have been fetched yet.
    // Resolve it now before trying to read the file.
    let resolvedFileUrl = fileUrl
    if (!file && pickedFile && !resolvedFileUrl) {
      const { data: urlData, error: urlErr } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(`deal-${deal.id}/${pickedFile}`, 300)
      if (urlErr) { pushToast('Could not load document', 'error'); setSending(false); return }
      resolvedFileUrl = urlData.signedUrl
      setFileUrl(resolvedFileUrl)
    }

    let base64, finalDocName
    if (!useAnchorTabs && docAnnotations.length > 0) {
      try {
        base64        = await buildAnnotatedBase64(file, resolvedFileUrl, docAnnotations)
        finalDocName  = file ? file.name : pickedFile.replace(/^\d+-/, '')
      } catch (err) {
        pushToast('Could not process annotations: ' + err.message, 'error')
        setSending(false); return
      }
    } else if (file) { base64 = await toBase64(file); finalDocName = file.name }
    else { const blob = await fetch(resolvedFileUrl).then(r => r.blob()); base64 = await toBase64(blob); finalDocName = pickedFile.replace(/^\d+-/, '') }

    // When using anchor tabs, tabs[] is empty — server applies them from doc-type detection
    const signerPayload = allSigners.map((s, i) => {
      if (useAnchorTabs && autoResult?.signerTabs) {
        const st = autoResult.signerTabs.find(t => t.signerIndex === i)
        return { name: s.name, email: s.email, routingOrder: s.routingOrder, tabs: st?.tabs || [] }
      }
      return { name: s.name, email: s.email, routingOrder: s.routingOrder, tabs: s.tabs || [] }
    })

    const resp = await fetch('/api/docusign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'send', emailSubject: subject,
        documentBase64: base64, documentName: finalDocName,
        signers: signerPayload,
        useAnchorTabs,
      }),
    })
    const data = await resp.json()
    setSending(false)
    if (data.error) { pushToast(data.error, 'error'); return }

    await supabase.from('docusign_envelopes').insert([{
      deal_id: deal.id, envelope_id: data.envelopeId,
      signer_name:  allSigners.map(s=>s.name).join(', '),
      signer_email: allSigners.map(s=>s.email).join(', '),
      document_name: finalDocName, subject, status: data.status || 'sent',
    }])
    pushToast(`Sent to ${allSigners.length} signer${allSigners.length>1?'s':''} for signature`)
    onSent()
  }

  return (
    <Modal open={true} onClose={onClose} width={step === 2 && !useAnchorTabs ? 740 : 500}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">
            {useAnchorTabs ? 'DocuSign · Auto-fields' : `DocuSign · Step ${step} of 2`}
          </div>
          <h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>
            {step===1 ? 'Set Up Signers' : useAnchorTabs ? 'Send for Signature' : 'Place Signature Fields'}
          </h3>
        </div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18}/></button>
      </div>
      <div className="modal__body">

        {step === 1 && <>
          {/* Email subject */}
          <div className="form-group">
            <label className="form-label">Email Subject</label>
            <input className="form-control" value={subject} onChange={e=>setSubject(e.target.value)}/>
          </div>

          {/* Signers */}
          <div className="form-group">
            <label className="form-label required">Signers <span style={{fontSize:11,fontWeight:400,color:'var(--gw-mist)'}}>— sign in parallel (same step)</span></label>
            {signers.map((s, i) => (
              <div key={s.id} style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8 }}>
                <div style={{ width:22, height:22, borderRadius:'50%', background:SIGNER_COLORS[i]||SIGNER_COLORS[0], display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:700, flexShrink:0 }}>{i+1}</div>
                <input className="form-control" style={{ flex:1 }} placeholder="Full name" value={s.name} onChange={e=>updateSigner(s.id,'name',e.target.value)}/>
                <input className="form-control" style={{ flex:1 }} placeholder="Email" type="email" value={s.email} onChange={e=>updateSigner(s.id,'email',e.target.value)}/>
                {signers.length > 1 && <button className="btn btn--ghost btn--icon btn--sm" onClick={()=>removeSigner(s.id)}><Icon name="x" size={13}/></button>}
              </div>
            ))}
            <button className="btn btn--secondary btn--sm" onClick={addSigner} style={{marginTop:2}}>+ Add another signer</button>
          </div>

          {/* Agent signs last */}
          {activeAgent && (
            <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', marginBottom:16, background:'var(--gw-bone)' }}>
              <input type="checkbox" id="agentSigns" checked={agentSigns} onChange={e=>setAgentSigns(e.target.checked)} style={{width:15,height:15,cursor:'pointer'}}/>
              <label htmlFor="agentSigns" style={{ fontSize:13, cursor:'pointer', flex:1 }}>
                <strong>I need to sign as well</strong> — {activeAgent.name} signs <em>after</em> the client{signers.length>1?'s':''}
              </label>
              {agentSigns && <div style={{ width:22, height:22, borderRadius:'50%', background:SIGNER_COLORS[signers.length]||'#6b7280', display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:700 }}>{signers.length+1}</div>}
            </div>
          )}

          {/* Document */}
          <div className="form-group">
            <label className="form-label required">Document (PDF)</label>
            {dealFiles.length > 0 && (
              <div style={{ marginBottom:10 }}>
                <div style={{ fontSize:11, color:'var(--gw-mist)', marginBottom:6 }}>Pick from deal documents:</div>
                {dealFiles.map(f => {
                  const name = f.name.replace(/^\d+-/,'')
                  const picked = pickedFile === f.name
                  return (
                    <div key={f.name} onClick={()=>{ setPickedFile(picked?'':f.name); if(!picked){setFile(null);setFileUrl(null)} }}
                      style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', border:`1px solid ${picked?'var(--gw-azure)':'var(--gw-border)'}`, borderRadius:'var(--radius)', marginBottom:4, cursor:'pointer', background:picked?'var(--gw-sky)':'#fff' }}>
                      <Icon name="file" size={13} style={{ color:'var(--gw-mist)', flexShrink:0 }}/>
                      <span style={{ fontSize:12, flex:1, fontWeight:picked?700:400 }}>{name}</span>
                      {picked && <Icon name="check" size={13} style={{ color:'var(--gw-azure)' }}/>}
                    </div>
                  )
                })}
                <div style={{ fontSize:11, color:'var(--gw-mist)', margin:'8px 0 4px' }}>— or upload a different file —</div>
              </div>
            )}
            <div style={{ border:`2px dashed ${dragOver?'var(--gw-azure)':file?'var(--gw-green)':'var(--gw-border)'}`, borderRadius:'var(--radius)', padding:'14px 16px', textAlign:'center', cursor:'pointer', background:dragOver?'var(--gw-sky)':file?'var(--gw-green-light)':'transparent', transition:'all 150ms' }}
              onClick={()=>fileRef.current.click()}
              onDragOver={e=>{e.preventDefault();setDragOver(true)}}
              onDragLeave={()=>setDragOver(false)}
              onDrop={e=>{e.preventDefault();setDragOver(false);setFile(e.dataTransfer.files[0]);setPickedFile('');setFileUrl(null);setAutoResult(null);setUseAnchorTabs(false)}}>
              <input ref={fileRef} type="file" accept=".pdf" style={{display:'none'}} onChange={e=>{setFile(e.target.files[0]);setPickedFile('');setFileUrl(null);setAutoResult(null);setUseAnchorTabs(false)}}/>
              {file ? <div style={{fontSize:12,fontWeight:600,color:'var(--gw-green)'}}>{file.name}</div>
                : <><Icon name="upload" size={18} style={{color:'var(--gw-border)',marginBottom:4}}/><div style={{fontSize:12}}>Drop PDF or click to browse</div></>}
            </div>
          </div>

          {/* ── Auto-detect signature fields ─────────────────────────────── */}
          {(file || pickedFile) && (
            <div style={{ marginTop:4 }}>
              {!autoResult && (
                <button className="btn btn--secondary btn--sm" style={{ width:'100%', justifyContent:'center' }}
                  onClick={autoDetect} disabled={autoDetecting}>
                  {autoDetecting
                    ? '⟳ Detecting fields…'
                    : '✦ Auto-detect Signature Fields'}
                </button>
              )}
              {autoResult && (
                <div style={{ border:'1.5px solid var(--gw-green)', borderRadius:'var(--radius)', padding:'12px 14px', background:'var(--gw-green-light)' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                    <div>
                      <span style={{ fontWeight:700, fontSize:13, color:'var(--gw-ink)' }}>✓ Detected: {autoResult.label}</span>
                      {autoResult.confidence < 1 && <span style={{ fontSize:11, color:'var(--gw-mist)', marginLeft:6 }}>(partial match)</span>}
                    </div>
                    <button onClick={() => { setAutoResult(null); setUseAnchorTabs(false) }}
                      style={{ background:'none', border:'none', cursor:'pointer', fontSize:16, color:'var(--gw-mist)', lineHeight:1 }}>×</button>
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', gap:3, marginBottom:10 }}>
                    {autoResult.signerTabs?.map((st, i) => (
                      <div key={i} style={{ fontSize:12 }}>
                        <span style={{ width:16, height:16, borderRadius:'50%', background:SIGNER_COLORS[i]||SIGNER_COLORS[0], display:'inline-flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:10, marginRight:6 }}>{i+1}</span>
                        <strong>{allSigners[i]?.name || `Signer ${i+1}`}</strong>
                        <span style={{ color:'var(--gw-mist)', marginLeft:6 }}>({st.role})</span>
                        <span style={{ marginLeft:8, color:'var(--gw-ink)' }}>
                          {st.tabs.filter(t=>t.type==='signature').length} sig ·{' '}
                          {st.tabs.filter(t=>t.type==='initials').length} initials ·{' '}
                          {st.tabs.filter(t=>t.type==='date').length} date
                        </span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                    <div style={{ flex:1, fontSize:11, color:'var(--gw-mist)' }}>
                      DocuSign will find these fields in your document automatically — no manual placement needed.
                    </div>
                    <button className="btn btn--ghost btn--sm" onClick={()=>setUseAnchorTabs(false)} style={{ whiteSpace:'nowrap', fontSize:11 }}>
                      Place manually instead
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>}

        {step === 2 && <>
          {/* Signer tabs — switch to place fields for each */}
          <div style={{ display:'flex', gap:6, marginBottom:12, flexWrap:'wrap' }}>
            {allSigners.map((s, i) => (
              <button key={s.id || i} onClick={()=>{ setActiveSignerI(i); setActiveTool('signature') }}
                style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 12px', border:`2px solid ${activeSignerI===i?SIGNER_COLORS[i]||SIGNER_COLORS[0]:'var(--gw-border)'}`, borderRadius:'var(--radius)', fontSize:12, fontWeight:700, cursor:'pointer', background:activeSignerI===i?(SIGNER_BGS[i]||SIGNER_BGS[0]):'#fff', color:activeSignerI===i?(SIGNER_COLORS[i]||SIGNER_COLORS[0]):'var(--gw-mist)' }}>
                <span style={{ width:16, height:16, borderRadius:'50%', background:SIGNER_COLORS[i]||'#6b7280', display:'inline-flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:10 }}>{i+1}</span>
                {s.name || `Signer ${i+1}`}
                {s.routingOrder === 2 && <span style={{fontSize:10,opacity:0.7}}>(signs last)</span>}
                {(s.tabs||[]).length > 0 && <span style={{fontSize:10,background:SIGNER_COLORS[i]||'#6b7280',color:'#fff',borderRadius:8,padding:'0 5px'}}>{s.tabs.length}</span>}
              </button>
            ))}
          </div>
          <PDFPlacer
            file={file} fileUrl={fileUrl}
            allFields={allFields}
            onPlace={placeField}
            onRemove={removeField}
            activeTool={activeTool}
            setActiveTool={setActiveTool}
            activeSignerIndex={activeSignerI}
            docAnnotations={docAnnotations}
            onPlaceAnnotation={a => setDocAnnotations(p => [...p, a])}
            onRemoveAnnotation={id => setDocAnnotations(p => p.filter(a => a.id !== id))}
          />
        </>}
      </div>
      <div className="modal__foot">
        {step===1 && <>
          <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
          {useAnchorTabs
            ? <button className="btn btn--primary" onClick={send} disabled={sending}>
                {sending ? 'Sending…' : `Send for Signature (${autoResult?.totalTabs || 0} auto-fields)`}
              </button>
            : <button className="btn btn--primary" onClick={goToStep2}>Next: Place Fields</button>
          }
        </>}
        {step===2 && <>
          <button className="btn btn--secondary" onClick={()=>setStep(1)}>Back</button>
          <button className="btn btn--primary" onClick={send} disabled={sending||allFields.length===0}>
            {sending ? 'Sending…' : `Send to ${allSigners.length} Signer${allSigners.length>1?'s':''}${allFields.length>0?` · ${allFields.length} fields`:''}`}
          </button>
        </>}
      </div>
    </Modal>
  )
}

function SignaturesTab({ deal, contacts, activeAgent }) {
  const [envelopes,   setEnvelopes]   = React.useState([])
  const [loading,     setLoading]     = React.useState(true)
  const [tableReady,  setTableReady]  = React.useState(true)
  const [notifReady,  setNotifReady]  = React.useState(true)
  const [sendOpen,    setSendOpen]    = React.useState(false)
  const [dealFiles,   setDealFiles]   = React.useState([])
  const [downloading, setDownloading] = React.useState({})

  React.useEffect(() => {
    if (!deal?.id) return
    loadEnvelopes()
    loadDealFiles()

    // Realtime subscription — auto-update status when webhook fires
    const channel = supabase.channel(`sig-envelopes-${deal.id}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'docusign_envelopes',
        filter: `deal_id=eq.${deal.id}`,
      }, payload => {
        setEnvelopes(prev => prev.map(e => e.id === payload.new.id ? { ...e, ...payload.new } : e))
        if (payload.new.status === 'completed' && payload.old?.status !== 'completed') {
          loadDealFiles() // signed copy should now be in storage
          pushToast('Document fully signed — signed copy saved to Documents tab', 'success')
        }
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [deal?.id])

  const loadEnvelopes = async () => {
    setLoading(true)
    const { data, error } = await supabase.from('docusign_envelopes').select('*').eq('deal_id', deal.id).order('created_at', { ascending: false })
    if (error?.code === '42P01') { setTableReady(false); setLoading(false); return }
    setEnvelopes(data || [])
    setLoading(false)
  }

  const loadDealFiles = async () => {
    const { data } = await supabase.storage.from(BUCKET).list(`deal-${deal.id}`, { sortBy: { column: 'created_at', order: 'desc' } })
    setDealFiles((data || []).filter(f => f.name !== '.emptyFolderPlaceholder'))
  }

  const refreshStatus = async (env) => {
    const res = await fetch('/api/docusign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', envelopeId: env.envelope_id }),
    })
    const data = await res.json()
    if (data.error) { pushToast(data.error, 'error'); return }
    const patch = { status: data.status, completed_at: data.completedDateTime || null }
    await supabase.from('docusign_envelopes').update(patch).eq('id', env.id)
    setEnvelopes(prev => prev.map(e => e.id === env.id ? { ...e, ...patch } : e))
    pushToast(`Status: ${data.status}`, 'info')
  }

  const downloadSigned = async (env) => {
    setDownloading(p => ({ ...p, [env.id]: true }))

    // First check if the signed copy was saved to storage by the webhook
    const signedFile = dealFiles.find(f => f.name.includes('signed-') && f.name.includes(env.envelope_id?.slice(0, 8) || ''))
      || dealFiles.find(f => f.name.includes('signed-'))

    if (signedFile) {
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(`deal-${deal.id}/${signedFile.name}`, 120)
      if (data?.signedUrl) {
        window.open(data.signedUrl, '_blank')
        setDownloading(p => ({ ...p, [env.id]: false }))
        return
      }
    }

    // Fall back: download directly from DocuSign API
    const res = await fetch('/api/docusign', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'download', envelopeId: env.envelope_id }),
    })
    const data = await res.json()
    setDownloading(p => ({ ...p, [env.id]: false }))
    if (data.error) { pushToast(data.error, 'error'); return }

    // Trigger browser download
    const link = document.createElement('a')
    link.href = `data:application/pdf;base64,${data.base64}`
    link.download = `signed-${env.document_name || 'document.pdf'}`
    link.click()
  }

  if (!tableReady) return (
    <div style={{ padding:20 }}>
      <div style={{ background:'#fff8ec', border:'1px solid var(--gw-amber)', borderRadius:'var(--radius)', padding:16, fontSize:13, lineHeight:1.7 }}>
        <strong>Run this SQL in your Supabase dashboard:</strong>
        <pre style={{ background:'var(--gw-slate)', color:'#e2e8f0', padding:10, borderRadius:6, fontSize:11, marginTop:8, overflowX:'auto' }}>
{`create table if not exists docusign_envelopes (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid references deals(id) on delete cascade,
  envelope_id   text not null,
  signer_name   text,
  signer_email  text,
  document_name text,
  subject       text,
  status        text default 'sent',
  sent_at       timestamptz default now(),
  completed_at  timestamptz,
  created_at    timestamptz default now()
);
alter table docusign_envelopes enable row level security;
create policy "agents_envelopes" on docusign_envelopes
  for all to authenticated using (true) with check (true);

-- Also run this for agent notifications:
create table if not exists agent_notifications (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid references agents(id) on delete cascade,
  deal_id      uuid references deals(id) on delete set null,
  envelope_id  text,
  title        text,
  message      text,
  type         text default 'document_signed',
  read         boolean default false,
  created_at   timestamptz default now()
);
alter table agent_notifications enable row level security;
create policy "agent_notifications_policy" on agent_notifications
  for all to authenticated using (true) with check (true);`}
        </pre>
        <button className="btn btn--secondary btn--sm" style={{ marginTop:8 }} onClick={() => { setTableReady(true); loadEnvelopes() }}>
          <Icon name="refresh" size={12}/> Retry
        </button>
      </div>
    </div>
  )

  return (
    <div style={{ padding:16, overflowY:'auto', flex:1 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
        <div style={{ fontSize:13, color:'var(--gw-mist)' }}>{envelopes.length} document{envelopes.length !== 1 ? 's' : ''} sent</div>
        <button className="btn btn--primary btn--sm" onClick={() => setSendOpen(true)}>
          <Icon name="send" size={13}/> Send for Signature
        </button>
      </div>

      {loading
        ? <div style={{ fontSize:13, color:'var(--gw-mist)' }}>Loading…</div>
        : envelopes.length === 0
          ? <div style={{ textAlign:'center', color:'var(--gw-mist)', fontSize:13, padding:'32px 0' }}>No documents sent yet.<br/>Click "Send for Signature" to get started.</div>
          : envelopes.map(env => {
              const sc        = DS_STATUS[env.status] || DS_STATUS.sent
              const completed = env.status === 'completed'
              return (
                <div key={env.id} style={{ border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', marginBottom:8, background:'#fff', overflow:'hidden' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px' }}>
                    <Icon name="file" size={18} style={{ color:'var(--gw-mist)', flexShrink:0 }}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{env.document_name || 'Document'}</div>
                      <div style={{ fontSize:11, color:'var(--gw-mist)', marginTop:2 }}>
                        To: {env.signer_name} · {new Date(env.sent_at || env.created_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}
                        {completed && env.completed_at && (
                          <span> · Signed {new Date(env.completed_at).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}</span>
                        )}
                      </div>
                    </div>
                    <span style={{ padding:'2px 8px', borderRadius:10, fontSize:11, fontWeight:700, background:sc.bg, color:sc.color, flexShrink:0, textTransform:'capitalize' }}>{env.status}</span>
                    <button className="btn btn--ghost btn--icon btn--sm" title="Refresh status" onClick={() => refreshStatus(env)}>
                      <Icon name="refresh" size={12}/>
                    </button>
                  </div>
                  {completed && (
                    <div style={{ borderTop:'1px solid var(--gw-border)', padding:'8px 12px', background:'var(--gw-green-light)', display:'flex', alignItems:'center', gap:8 }}>
                      <Icon name="check" size={13} style={{ color:'var(--gw-green)', flexShrink:0 }}/>
                      <span style={{ fontSize:12, color:'var(--gw-green)', flex:1, fontWeight:600 }}>Fully signed — copy saved to Documents tab</span>
                      <button
                        className="btn btn--sm"
                        style={{ background:'var(--gw-green)', color:'#fff', border:'none', fontSize:11 }}
                        onClick={() => downloadSigned(env)}
                        disabled={downloading[env.id]}
                      >
                        {downloading[env.id] ? 'Downloading…' : 'Download Signed PDF'}
                      </button>
                    </div>
                  )}
                </div>
              )
            })
      }

      {sendOpen && (
        <SendSignatureModal
          deal={deal} contacts={contacts} dealFiles={dealFiles} activeAgent={activeAgent}
          onClose={() => setSendOpen(false)}
          onSent={() => { setSendOpen(false); loadEnvelopes() }}
        />
      )}
    </div>
  )
}

function DealDrawer({ open, onClose, deal, agents, contacts, properties, activeAgent, onSave }) {
  const blank = { title:'', contact_id:'', property_id:'', agent_id:'', stage:'lead', value:'', probability:0, expected_close_date:'', notes:'', prop_category:'residential', prop_subtype:'', comp_data:{} }
  const [form, setForm]     = useState(deal || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [tab, setTab]       = useState('details')

  React.useEffect(() => {
    setForm(deal ? { ...blank, ...deal, expected_close_date: deal.expected_close_date ? deal.expected_close_date.slice(0,10) : '', comp_data: deal.comp_data || {} } : blank)
    setErrors({})
    setTab('details')
  }, [deal, open])

  const set  = (k, v) => setForm(p => ({...p, [k]: v}))
  const setCD = (k, v) => setForm(p => ({...p, comp_data: {...(p.comp_data||{}), [k]: v}}))
  const cd = form.comp_data || {}

  const COMM_SUBTYPES = ['multifamily','office','land','retail','industrial','mixed-use']

  const save = async () => {
    const e = {}
    if (!form.title.trim()) e.title = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    try {
      // Explicit whitelist — never spread full form object (prevents unknown-column schema errors)
      const payload = {
        title:               form.title.trim(),
        stage:               form.stage,
        value:               form.value !== '' && form.value !== null ? Number(form.value) : null,
        probability:         Number(form.probability) || 0,
        expected_close_date: form.expected_close_date || null,
        contact_id:          form.contact_id   || null,
        property_id:         form.property_id  || null,
        agent_id:            form.agent_id     || null,
        notes:               form.notes        || null,
        prop_category:       form.prop_category || null,
        prop_subtype:        form.prop_subtype  || null,
        comp_data:           form.comp_data     || null,
      }
      let error
      if (deal?.id) {
        ;({ error } = await supabase.from('deals').update(payload).eq('id', deal.id))
      } else {
        ;({ error } = await supabase.from('deals').insert([payload]))
      }
      if (error) { pushToast(error.message, 'error'); return }
      pushToast(deal?.id ? 'Deal updated' : 'Deal added')
      await onSave()
      onClose()
    } catch(err) {
      console.error('[DealDrawer] save error:', err)
      pushToast('Something went wrong.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const isExisting = !!deal?.id

  return (
    <Drawer open={open} onClose={onClose} title={deal?.id ? (form.title || 'Edit Deal') : 'Add Deal'} width={500}>
      {/* Tab bar — only for existing deals */}
      {isExisting && (
        <div className="drawer-tabs">
          {[['details','Details'],['dates','Key Dates'],['checklist','Checklist'],['documents','Documents'],['signatures','Signatures']].map(([id, label]) => (
            <button key={id} className={`drawer-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Details tab */}
      {tab === 'details' && (
        <>
          <div className="drawer__body">
            <div className="form-group"><label className="form-label required">Deal Title</label><input className={`form-control${errors.title?' error':''}`} value={form.title} onChange={e=>set('title',e.target.value)} placeholder="e.g. 123 Main St Purchase" /></div>

            {/* Residential / Commercial toggle */}
            <div className="form-group">
              <label className="form-label">Property Category</label>
              <div style={{ display:'flex', gap:0, border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', overflow:'hidden' }}>
                {['residential','commercial'].map(cat => (
                  <button key={cat} type="button" onClick={() => { set('prop_category', cat); if (cat==='residential') set('prop_subtype','') }}
                    style={{ flex:1, padding:'7px 0', border:'none', cursor:'pointer', fontFamily:'var(--font-body)', fontSize:12, fontWeight:600, transition:'all 150ms',
                      background: form.prop_category === cat ? 'var(--gw-slate)' : '#fff',
                      color:      form.prop_category === cat ? '#fff'            : 'var(--gw-mist)' }}>
                    {cat.charAt(0).toUpperCase()+cat.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Commercial subtype */}
            {form.prop_category === 'commercial' && (
              <div className="form-group">
                <label className="form-label">Commercial Type</label>
                <select className="form-control" value={form.prop_subtype||''} onChange={e=>set('prop_subtype',e.target.value)}>
                  <option value="">— Select type —</option>
                  {COMM_SUBTYPES.map(t=><option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
                </select>
              </div>
            )}

            <div className="form-group"><label className="form-label">Stage</label><select className="form-control" value={form.stage} onChange={e=>set('stage',e.target.value)}>{STAGE_ORDER.map(s=><option key={s} value={s}>{STAGE_LABELS[s]}</option>)}</select></div>
            <div className="form-row">
              <div className="form-group"><label className="form-label">Sale / Deal Value</label><input className="form-control" type="number" value={form.value||''} onChange={e=>set('value',e.target.value)} placeholder="0" /></div>
              <div className="form-group"><label className="form-label">Probability %</label><input className="form-control" type="number" min="0" max="100" value={form.probability||0} onChange={e=>set('probability',e.target.value)} /></div>
            </div>
            <div className="form-group"><label className="form-label">Expected Close Date</label><input className="form-control" type="date" value={form.expected_close_date||''} onChange={e=>set('expected_close_date',e.target.value)} /></div>
            <div className="form-group"><label className="form-label">Contact</label><SearchDropdown items={contacts} value={form.contact_id} onSelect={v=>set('contact_id',v)} placeholder="Search contacts…" labelKey={c=>`${c.first_name} ${c.last_name}`} /></div>
            <div className="form-group"><label className="form-label">Property</label><SearchDropdown items={properties} value={form.property_id} onSelect={v=>set('property_id',v)} placeholder="Search properties…" labelKey="address" /></div>
            <div className="form-group"><label className="form-label">Assigned Agent</label><select className="form-control" value={form.agent_id||''} onChange={e=>set('agent_id',e.target.value)}><option value="">Unassigned</option>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></div>

            {/* ── Comp Data ─────────────────────────────────────── */}
            <div style={{ borderTop:'1px solid var(--gw-border)', paddingTop:14, marginTop:4 }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.08em', color:'var(--gw-mist)', marginBottom:12 }}>Comp Data</div>

              {form.prop_category === 'residential' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Beds</label><input className="form-control" type="number" value={cd.beds||''} onChange={e=>setCD('beds',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Baths</label><input className="form-control" type="number" step="0.5" value={cd.baths||''} onChange={e=>setCD('baths',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Garage</label>
                      <select className="form-control" value={cd.garage??''} onChange={e=>setCD('garage',e.target.value)}>
                        <option value="">—</option><option value="0">No Garage</option><option value="1">1 Car</option><option value="2">2 Car</option><option value="3">3+ Car</option>
                      </select>
                    </div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'multifamily' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Total Units</label><input className="form-control" type="number" value={cd.total_units||''} onChange={e=>setCD('total_units',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / Unit</label><input className="form-control" type="number" value={cd.price_per_unit||''} onChange={e=>setCD('price_per_unit',e.target.value)} /></div>
                  </div>
                  <div className="form-group"><label className="form-label">Unit Mix</label><input className="form-control" value={cd.unit_mix||''} onChange={e=>setCD('unit_mix',e.target.value)} placeholder="e.g. 10×1BR, 5×2BR" /></div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">City / County</label><input className="form-control" value={cd.city||''} onChange={e=>setCD('city',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Sq Ft (total)</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'land' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Acres</label><input className="form-control" type="number" step="0.01" value={cd.acres||''} onChange={e=>setCD('acres',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Status</label>
                      <select className="form-control" value={cd.land_status||''} onChange={e=>setCD('land_status',e.target.value)}>
                        <option value="">—</option><option value="raw">Raw Land</option><option value="developed">Developed</option><option value="ready">Ready to Build</option>
                      </select>
                    </div>
                    <div className="form-group"><label className="form-label">Zoning</label><input className="form-control" value={cd.zoning||''} onChange={e=>setCD('zoning',e.target.value)} placeholder="R-1, C-2…" /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'office' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / SF</label><input className="form-control" type="number" step="0.01" value={cd.price_per_sf||''} onChange={e=>setCD('price_per_sf',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Class</label>
                      <select className="form-control" value={cd.class||''} onChange={e=>setCD('class',e.target.value)}>
                        <option value="">—</option><option value="A">Class A</option><option value="B">Class B</option><option value="C">Class C</option>
                      </select>
                    </div>
                    <div className="form-group"><label className="form-label">Floors</label><input className="form-control" type="number" value={cd.floors||''} onChange={e=>setCD('floors',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'retail' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / SF</label><input className="form-control" type="number" step="0.01" value={cd.price_per_sf||''} onChange={e=>setCD('price_per_sf',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Frontage (ft)</label><input className="form-control" type="number" value={cd.frontage||''} onChange={e=>setCD('frontage',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Parking Spaces</label><input className="form-control" type="number" value={cd.parking||''} onChange={e=>setCD('parking',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && form.prop_subtype === 'industrial' && (
                <>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Sq Ft</label><input className="form-control" type="number" value={cd.sqft||''} onChange={e=>setCD('sqft',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Price / SF</label><input className="form-control" type="number" step="0.01" value={cd.price_per_sf||''} onChange={e=>setCD('price_per_sf',e.target.value)} /></div>
                  </div>
                  <div className="form-row">
                    <div className="form-group"><label className="form-label">Clear Height (ft)</label><input className="form-control" type="number" value={cd.clear_height||''} onChange={e=>setCD('clear_height',e.target.value)} /></div>
                    <div className="form-group"><label className="form-label">Loading Docks</label><input className="form-control" type="number" value={cd.loading_docks||''} onChange={e=>setCD('loading_docks',e.target.value)} /></div>
                  </div>
                </>
              )}

              {form.prop_category === 'commercial' && !form.prop_subtype && (
                <div style={{ fontSize:12, color:'var(--gw-mist)', textAlign:'center', padding:'8px 0' }}>Select a commercial type above to enter comp data.</div>
              )}
            </div>

            <div className="form-group" style={{ marginTop:4 }}><label className="form-label">Notes</label><textarea className="form-control form-control--textarea" value={form.notes||''} onChange={e=>set('notes',e.target.value)} /></div>
          </div>
          <div className="drawer__foot">
            <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Deal'}</button>
          </div>
        </>
      )}

      {/* Key Dates tab */}
      {tab === 'dates' && isExisting && (
        <KeyDatesTab deal={deal} onSave={onSave} />
      )}

      {/* Checklist tab */}
      {tab === 'checklist' && isExisting && (
        <ChecklistTab deal={deal} />
      )}

      {/* Documents tab */}
      {tab === 'documents' && isExisting && (
        <DocumentsTab deal={deal} />
      )}

      {/* Signatures tab */}
      {tab === 'signatures' && isExisting && (
        <SignaturesTab deal={deal} contacts={contacts} activeAgent={activeAgent} />
      )}
    </Drawer>
  )
}

const AUTO_TASKS = {
  qualified:        { title: d => `Schedule showing — ${d.title}`,            type: 'showing',   priority: 'high',   daysOut: 2 },
  showing:          { title: d => `Send post-showing follow-up — ${d.title}`, type: 'follow-up', priority: 'medium', daysOut: 1 },
  offer:            { title: d => `Prepare & submit offer — ${d.title}`,      type: 'document',  priority: 'high',   daysOut: 2 },
  'under-contract': { title: d => `Order inspection — ${d.title}`,            type: 'follow-up', priority: 'high',   daysOut: 5 },
  closed:           { title: d => `Request referral — ${d.title}`,            type: 'follow-up', priority: 'low',    daysOut: 7 },
}

export default function PipelinePage({ db, setDb, activeAgent, isAdmin, dealAgentIds }) {
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState(null)
  const [defaultStage, setDefaultStage] = useState('lead')
  const [confirm, setConfirm] = useState(null)
  const [dragging, setDragging] = useState(null)
  const [dragOver, setDragOver] = useState(null)
  const [agentFilter, setAgentFilter] = useState('all')

  const deals      = db.deals      || []
  const agents     = db.agents     || []
  const contacts   = db.contacts   || []
  const properties = db.properties || []

  // O(1) lookups — built once per data change, not per-card in render loop
  const contactMap  = useMemo(() => Object.fromEntries(contacts.map(c => [c.id, c])),   [contacts])
  const agentMap    = useMemo(() => Object.fromEntries(agents.map(a => [a.id, a])),     [agents])
  const propertyMap = useMemo(() => Object.fromEntries(properties.map(p => [p.id, p])), [properties])

  // Filter deals for admin view (by agent) or show all
  const visibleDeals = useMemo(() => {
    if (!isAdmin || agentFilter === 'all') return deals
    return deals.filter(d => d.agent_id === agentFilter)
  }, [deals, isAdmin, agentFilter])

  // Single-pass O(n) grouping — replaces repeated stageDeals()/stageValue() calls per render
  const { stageGroups, stageTotals, totalValue } = useMemo(() => {
    const groups = Object.fromEntries(STAGE_ORDER.map(s => [s, []]))
    const totals = Object.fromEntries(STAGE_ORDER.map(s => [s, 0]))
    let total = 0
    visibleDeals.forEach(d => {
      if (groups[d.stage]) {
        groups[d.stage].push(d)
        totals[d.stage] += d.value || 0
        total += d.value || 0
      }
    })
    return { stageGroups: groups, stageTotals: totals, totalValue: total }
  }, [visibleDeals])

  const reload = useCallback(async () => {
    let q = supabase.from('deals').select('*').order('created_at', { ascending: false })
    if (!isAdmin && dealAgentIds?.length) q = q.in('agent_id', dealAgentIds)
    const { data } = await q
    setDb(p => ({ ...p, deals: data || [] }))
  }, [setDb, isAdmin, dealAgentIds])

  const del = useCallback(async (id) => {
    // Nullify deal_id on tasks before deletion to avoid FK constraint failures
    await supabase.from('tasks').update({ deal_id: null }).eq('deal_id', id)
    const { error } = await supabase.from('deals').delete().eq('id', id)
    if (error) { pushToast(error.message, 'error'); setConfirm(null); return }
    pushToast('Deal deleted', 'info')
    setConfirm(null); reload()
  }, [reload])

  // updated_at omitted — handled by DB trigger
  const moveStage = useCallback(async (dealId, newStage) => {
    await supabase.from('deals').update({ stage: newStage }).eq('id', dealId)
    setDb(p => ({ ...p, deals: p.deals.map(d => d.id === dealId ? { ...d, stage: newStage } : d) }))
    pushToast(`Moved to ${STAGE_LABELS[newStage]}`)

    const auto = AUTO_TASKS[newStage]
    if (!auto) return
    const deal = deals.find(d => d.id === dealId)
    if (!deal) return
    const due = new Date()
    due.setDate(due.getDate() + auto.daysOut)
    due.setHours(9, 0, 0, 0)
    const { data: newTask } = await supabase.from('tasks').insert([{
      title: auto.title(deal),
      type: auto.type,
      priority: auto.priority,
      due_date: due.toISOString(),
      agent_id: deal.agent_id || null,
      contact_id: deal.contact_id || null,
      deal_id: dealId,
      completed: false,
    }]).select().single()
    if (newTask) {
      setDb(p => ({ ...p, tasks: [newTask, ...(p.tasks || [])] }))
      pushToast(`Task auto-created: ${newTask.title}`, 'info')
    }
  }, [setDb, deals])

  return (
    <div className="page-content" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header">
        <div>
          <div className="page-title">Pipeline{isAdmin ? ' — Admin View' : ''}</div>
          <div className="page-sub">{visibleDeals.length} deal{visibleDeals.length !== 1 ? 's' : ''} · {formatCurrency(totalValue)} total value</div>
        </div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {isAdmin && (
            <select
              value={agentFilter}
              onChange={e => setAgentFilter(e.target.value)}
              className="form-control"
              style={{ fontSize:13, minWidth:160 }}
            >
              <option value="all">All Agents</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          {!isAdmin && (
            <button className="btn btn--primary" onClick={() => { setEditing(null); setDefaultStage('lead'); setDrawer(true) }}>
              <Icon name="plus" size={14} /> Add Deal
            </button>
          )}
        </div>
      </div>

      {deals.length === 0 ? (
        <EmptyState icon="pipeline" title="No deals yet" message="Add your first deal to start tracking your pipeline." action={<button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> Add Deal</button>} />
      ) : (
        <div className="kanban-board">
          {STAGE_ORDER.map(stage => (
            <div key={stage} className="kanban-col">
              <div className="kanban-col__head">
                <div>
                  <div className="kanban-col__label">{STAGE_LABELS[stage]}</div>
                  {stageTotals[stage] > 0 && <div style={{ fontSize:10, color:'var(--gw-mist)', marginTop:1 }}>{formatCurrency(stageTotals[stage])}</div>}
                </div>
                <span className="kanban-col__count">{stageGroups[stage].length}</span>
              </div>
              <div
                className={`kanban-col__body${dragOver === stage ? ' drag-over' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragOver(stage) }}
                onDragLeave={() => setDragOver(null)}
                onDrop={e => { e.preventDefault(); if (dragging && dragging !== stage) moveStage(dragging, stage); setDragOver(null); setDragging(null) }}
              >
                {stageGroups[stage].map(deal => {
                  const contact    = contactMap[deal.contact_id]
                  const agent      = agentMap[deal.agent_id]
                  const dealProp   = deal.property_id ? propertyMap[deal.property_id] : null
                  const coAgIds    = dealProp?.details?.co_agent_ids || []
                  const allAgents  = [deal.agent_id, ...coAgIds].filter(Boolean)
                    .map(id => agentMap[id]).filter(Boolean)
                    .filter((a, i, arr) => arr.findIndex(x => x.id === a.id) === i)
                  const overdue    = deal.expected_close_date && new Date(deal.expected_close_date) < new Date() && stage !== 'closed' && stage !== 'lost'
                  const urgency    = getKeyDateUrgency(deal)
                  const nearestKD  = urgency ? getNearestKeyDate(deal) : null
                  const cardBorder = urgency === 'urgent' ? '2px solid #ef4444' : urgency === 'warning' ? '2px solid #f59e0b' : undefined
                  const cardBg     = urgency === 'urgent' ? '#fef2f2' : urgency === 'warning' ? '#fffbeb' : undefined
                  return (
                    <div key={deal.id} className={`deal-card${dragging === deal.id ? ' dragging' : ''}`}
                      style={{ border: cardBorder, background: cardBg }}
                      draggable
                      onDragStart={() => setDragging(deal.id)}
                      onDragEnd={() => { setDragging(null); setDragOver(null) }}
                      onClick={() => { setEditing(deal); setDrawer(true) }}
                    >
                      {urgency && nearestKD && (
                        <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:5, fontSize:10, fontWeight:700, color: urgency === 'urgent' ? '#dc2626' : '#d97706' }}>
                          <span style={{ fontSize:11 }}>⚠</span>
                          <span>{nearestKD.type}: {nearestKD.daysUntil === 0 ? 'Today' : nearestKD.daysUntil === 1 ? 'Tomorrow' : `${nearestKD.daysUntil} days`}</span>
                        </div>
                      )}
                      <div className="deal-card__title">{deal.title}</div>
                      {isAdmin && agent && (
                        <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:2 }}>
                          <Avatar agent={agent} size={14} />
                          <span style={{ fontSize:10, color:'var(--gw-mist)' }}>{agent.name}</span>
                        </div>
                      )}
                      {contact && <div className="deal-card__contact">{contact.first_name} {contact.last_name}</div>}
                      {deal.value > 0 && <div className="deal-card__value">{formatCurrency(deal.value)}</div>}
                      <div className="deal-card__meta">
                        <div style={{ fontSize:11, color: overdue ? 'var(--gw-red)' : 'var(--gw-mist)' }}>
                          {deal.expected_close_date ? formatDate(deal.expected_close_date) : ''}
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                          {deal.probability > 0 && <span style={{ fontSize:10, color:'var(--gw-mist)' }}>{deal.probability}%</span>}
                          <div style={{ display:'flex', alignItems:'center' }}>
                            {allAgents.slice(0, 3).map((a, i) => (
                              <div key={a.id} style={{ marginLeft: i > 0 ? -5 : 0, zIndex: 10 - i, position: 'relative' }}>
                                <Avatar agent={a} size={20} />
                              </div>
                            ))}
                          </div>
                          {!isAdmin && <button className="btn btn--ghost btn--icon" style={{ padding:2 }} onClick={e=>{e.stopPropagation(); setConfirm(deal.id)}}><Icon name="trash" size={11} /></button>}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {!isAdmin && (
                  <button className="btn btn--ghost" style={{ width:'100%', justifyContent:'center', fontSize:12, marginTop:'auto', borderStyle:'dashed', border:'1px dashed var(--gw-border)' }}
                    onClick={() => { setEditing(null); setDefaultStage(stage); setDrawer(true) }}>
                    <Icon name="plus" size={13} /> Add deal
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <DealDrawer open={drawer} onClose={() => setDrawer(false)} deal={editing ? editing : { stage: defaultStage }} agents={agents} contacts={contacts} properties={properties} activeAgent={activeAgent} onSave={reload} />
      {confirm && <ConfirmDialog message="This will permanently delete this deal." onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
    </div>
  )
}
