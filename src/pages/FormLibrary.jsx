import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, pushToast, EmptyState, Modal } from '../components/UI.jsx'
import { OPERATING_STATES } from '../lib/constants.js'
import { templateEditorUrl } from '../lib/services/boldsign.js'
import BoldSignFrame from '../components/BoldSignFrame.jsx'

const TRANSACTION_TYPES = [
  { value: 'buyer',   label: 'Buyer Contract' },
  { value: 'seller',  label: 'Listing / Seller' },
  { value: 'lease',   label: 'Lease / Rental' },
  { value: 'general', label: 'General / Other' },
]

const BUCKET = 'form-packets'

const fileToBase64 = f => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = e => res(e.target.result.split(',')[1])
  r.onerror = rej
  r.readAsDataURL(f)
})

function formatBytes(b) {
  if (!b) return ''
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

function UploadModal({ packet, onClose, onSaved }) {
  const isNew = !packet?.id
  const blank = {
    state: '', transaction_type: 'buyer', name: '', description: '',
    boldsign_template_id: '', doc_type: '', field_tokens: [], active: true,
  }
  const [form, setForm]   = useState(packet ? { ...blank, ...packet, field_tokens: packet.field_tokens || [] } : blank)
  const [tokensText, setTokensText] = useState((packet?.field_tokens || []).join(', '))
  const [files, setFiles] = useState([])   // newly selected package PDFs (a template can hold several)
  const [saving, setSaving] = useState(false)
  const [editorBusy, setEditorBusy] = useState(false)
  const [editorUrl, setEditorUrl] = useState(null)   // set while the embedded BoldSign editor is open in-modal
  const [useTextTags, setUseTextTags] = useState(false)
  // Signer roles the template needs (BoldSign requires at least one at create
  // time — see buildInBoldSign). Default matches our convention: role 1 =
  // client, role 2 = agent.
  const [roles, setRoles] = useState([{ name: 'Seller' }, { name: 'Listing Agent' }])
  const fileRef = useRef()
  const savedFromEditorRef = useRef(false)   // guards against the editor firing "done" twice (message + redirect)

  // Takes an ALREADY-materialized array — the caller must Array.from() the live
  // FileList before resetting the input's value, or the files vanish (the state
  // updater runs after value='' has cleared the FileList).
  const addFiles   = (picked) => setFiles(p => [...p, ...(picked || [])])
  const removeFile = (i) => setFiles(p => p.filter((_, j) => j !== i))
  // Files already stored on an existing packet (multi-file, with single-file back-compat).
  const existingFiles = (Array.isArray(packet?.storage_paths) && packet.storage_paths.length)
    ? packet.storage_paths
    : (packet?.storage_path ? [{ path: packet.storage_path, name: packet.storage_path.split('/').pop() }] : [])

  // BoldSign's embedded editor is told to return here when finished. It's a tiny
  // same-origin page (public/boldsign-return.html) so the iframe doesn't reload
  // the whole CRM inside the popup, and BoldSignFrame can detect the return.
  const editorReturnUrl = `${window.location.origin}/boldsign-return.html`

  const setRoleName = (i, name) => setRoles(p => p.map((r, j) => j === i ? { name } : r))
  const addRole      = () => setRoles(p => [...p, { name: `Signer ${p.length + 1}` }])
  const removeRole    = (i) => setRoles(p => p.length > 1 ? p.filter((_, j) => j !== i) : p)

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  // Open BoldSign's editor in-app (iframe, not a new tab) so completion fires a
  // trustworthy postMessage event — see handleEditorDone. Rebuilding an existing
  // template reopens ITS edit URL (no new PDF); building fresh requires a PDF
  // and creates a brand-new BoldSign template.
  const buildInBoldSign = async () => {
    if (!form.state.trim()) { pushToast('State is required before building a template', 'error'); return }
    if (!form.name.trim())  { pushToast('Packet name is required before building a template', 'error'); return }
    const rebuilding = !!form.boldsign_template_id
    if (!rebuilding && !files.length) { pushToast('Add at least one PDF first', 'error'); return }
    savedFromEditorRef.current = false
    setEditorBusy(true)
    try {
      if (rebuilding) {
        const { url } = await templateEditorUrl({ templateId: form.boldsign_template_id, redirectUrl: editorReturnUrl })
        if (!url) { pushToast('BoldSign did not return an editor URL', 'error'); return }
        setEditorUrl(url)
        return
      }
      // Every selected PDF becomes part of the one template document, in order —
      // BoldSign merges them (listing agreement + disclosures + addenda → one packet).
      const templateTitle = form.name.trim() || files[0].name.replace(/\.pdf$/i, '')
      const documents = []
      for (const f of files) documents.push({ base64: await fileToBase64(f), name: f.name })
      const { url, templateId } = await templateEditorUrl({
        title: templateTitle, documentTitle: templateTitle,
        documents,
        redirectUrl: editorReturnUrl,
        useTextTags,
        roles: roles.map(r => r.name.trim()).filter(Boolean).map(name => ({ name })),
      })
      if (!url) { pushToast('BoldSign did not return an editor URL', 'error'); return }
      if (templateId) set('boldsign_template_id', templateId)
      setEditorUrl(url)
    } catch (e) { pushToast(e.message, 'error') } finally { setEditorBusy(false) }
  }

  // BoldSign posts a completion event from the embedded editor — save the
  // packet (with its new boldsign_template_id) back to Form Library right
  // away instead of relying on the admin to remember a separate Save click.
  const handleEditorDone = async () => {
    if (savedFromEditorRef.current) return   // the editor can signal done twice (postMessage + redirect) — save once
    savedFromEditorRef.current = true
    setEditorUrl(null)
    pushToast('Template saved in BoldSign — saving to Form Library…', 'success')
    await save()
  }
  const handleEditorError = () => {
    setEditorUrl(null)
    pushToast('BoldSign editor closed without finishing — no changes were saved', 'info')
  }

  const save = async () => {
    if (!form.state.trim()) { pushToast('State is required', 'error'); return }
    if (!form.name.trim())  { pushToast('Packet name is required', 'error'); return }
    if (isNew && !files.length) { pushToast('Add at least one PDF file', 'error'); return }
    setSaving(true)
    try {
      // Newly selected files replace the package; otherwise keep what's on file.
      let storagePaths = existingFiles
      if (files.length) {
        const uploaded = []
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          const path = `${form.state.trim().toUpperCase()}/${form.transaction_type}/${Date.now()}-${i}-${f.name}`
          const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, f, { upsert: true })
          if (upErr) { pushToast(upErr.message, 'error'); setSaving(false); return }
          uploaded.push({ path, name: f.name })
        }
        storagePaths = uploaded
      }
      const field_tokens = tokensText.split(',').map(s => s.trim()).filter(Boolean)
      const payload = {
        state: form.state.trim().toUpperCase(),
        transaction_type: form.transaction_type,
        name: form.name.trim(),
        description: form.description || null,
        storage_path:  storagePaths[0]?.path || null,   // primary/first (back-compat)
        storage_paths: storagePaths,
        // null-safe: a packet created without a doc_type / template id stores null,
        // and null.trim() would throw and silently abort the whole save.
        boldsign_template_id: (form.boldsign_template_id || '').trim() || null,
        doc_type: (form.doc_type || '').trim() || null,
        field_tokens,
        active: form.active,
      }
      const upsert = (p) => packet?.id
        ? supabase.from('form_packets').update(p).eq('id', packet.id).select()
        : supabase.from('form_packets').insert([p]).select()
      let { data, error } = await upsert(payload)
      // Graceful fallback if migration 0022 (storage_paths) hasn't been applied yet.
      if (error && (error.code === '42703' || error.code === 'PGRST204' || /storage_paths/.test(error.message || ''))) {
        const { storage_paths, ...legacy } = payload
        ;({ data, error } = await upsert(legacy))
      }
      if (error) { pushToast(`Couldn't save: ${error.message}`, 'error'); return }
      if (packet?.id && Array.isArray(data) && data.length === 0) {
        pushToast('Nothing was updated — the change did not persist.', 'error'); return
      }
      pushToast(isNew ? 'Form packet added' : 'Packet updated')
      onSaved()
    } catch (e) {
      console.error('[FormLibrary] save error:', e)
      pushToast(`Couldn't save: ${e.message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={editorUrl ? handleEditorError : onClose} width={editorUrl ? 900 : 480}>
      <div className="modal__head">
        <div>
          <div className="eyebrow-label">Form Library</div>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 20 }}>
            {editorUrl ? 'Build in BoldSign' : isNew ? 'Add Form Packet' : 'Edit Form Packet'}
          </h3>
        </div>
        <button className="drawer__close" onClick={editorUrl ? handleEditorError : onClose}><Icon name="x" size={18} /></button>
      </div>

      {editorUrl ? (
        <div className="modal__body" style={{ padding: 0, maxHeight: 'calc(90vh - 80px)', overflowY: 'auto' }}>
          <div style={{ padding: '10px 24px', fontSize: 12, color: 'var(--gw-mist)', borderBottom: '1px solid var(--gw-border)' }}>
            Place fields, then click <strong>Finish</strong> in BoldSign — the template saves back to this packet automatically.
          </div>
          <BoldSignFrame url={editorUrl} onDone={handleEditorDone} onError={handleEditorError} returnUrlMarker="boldsign-return" />
        </div>
      ) : (
      <>
      <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 'calc(90vh - 140px)', overflowY: 'auto' }}>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label required">State</label>
            <input className="form-control" value={form.state} onChange={e => set('state', e.target.value.toUpperCase())} placeholder="IA" maxLength={2} style={{ textTransform: 'uppercase' }} />
          </div>
          <div className="form-group">
            <label className="form-label required">Transaction Type</label>
            <select className="form-control" value={form.transaction_type} onChange={e => set('transaction_type', e.target.value)}>
              {TRANSACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label required">Packet Name</label>
          <input className="form-control" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Iowa Buyer Contract Package" />
        </div>
        <div className="form-group">
          <label className="form-label">Description</label>
          <textarea className="form-control form-control--textarea" value={form.description || ''} onChange={e => set('description', e.target.value)} placeholder="List the forms included in this packet…" rows={3} />
        </div>
        <div className="form-group">
          <label className="form-label">{existingFiles.length ? 'Replace PDFs (optional)' : 'Upload PDFs'}</label>
          <input ref={fileRef} type="file" accept=".pdf" multiple style={{ display: 'none' }} onChange={e => { const picked = Array.from(e.target.files || []); e.target.value = ''; addFiles(picked) }} />
          <div
            onClick={() => fileRef.current.click()}
            style={{ border: '2px dashed var(--gw-border)', borderRadius: 'var(--radius)', padding: '16px', textAlign: 'center', cursor: 'pointer', background: files.length ? 'var(--gw-green-light)' : 'var(--gw-bone)' }}
          >
            <span style={{ color: 'var(--gw-mist)', fontSize: 13 }}>
              {files.length ? 'Add more PDFs…' : (existingFiles.length ? 'Click to replace with new PDFs' : 'Click to choose one or more PDFs')}
            </span>
          </div>

          {/* Newly selected files (in the order they'll appear in the template). */}
          {files.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {files.map((f, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', marginBottom: 4, background: '#fff' }}>
                  <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--gw-azure)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{i + 1}</span>
                  <Icon name="document" size={14} style={{ color: 'var(--gw-green)', flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ color: 'var(--gw-mist)', fontSize: 11, flexShrink: 0 }}>{formatBytes(f.size)}</span>
                  <button type="button" className="btn btn--ghost btn--sm btn--icon" onClick={() => removeFile(i)}><Icon name="x" size={11}/></button>
                </div>
              ))}
              <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 2 }}>Multiple PDFs are combined into one template, in this order.</div>
            </div>
          )}

          {existingFiles.length > 0 && !files.length && (
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>
              {existingFiles.length} file{existingFiles.length > 1 ? 's' : ''} on file ({existingFiles.map(f => f.name).join(', ')}) — leave blank to keep, or select new ones to replace.
            </div>
          )}
        </div>

        {/* ── E-signature (BoldSign) ──────────────────────────────────────── */}
        <div style={{ borderTop: '1px solid var(--gw-border)', paddingTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
            E-Signature {form.boldsign_template_id && <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 8, fontSize: 10, fontWeight: 700, background: 'var(--gw-green-light)', color: 'var(--gw-green)' }}>Sendable</span>}
          </div>
          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginBottom: 10 }}>
            Link this packet to a BoldSign template to make it sendable from a deal's Signatures tab.
            Building uses the PDF(s) above — add several (e.g. a listing agreement + disclosures) and they're
            combined into one signable template.
          </div>

          {!form.boldsign_template_id && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginBottom: 4 }}>Signer roles (BoldSign requires at least one)</div>
              {roles.map((r, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                  <div style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--gw-azure)', color: '#fff', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 4 }}>{i + 1}</div>
                  <input className="form-control" style={{ flex: 1 }} value={r.name} onChange={e => setRoleName(i, e.target.value)} placeholder={`Role ${i + 1} name`}/>
                  {roles.length > 1 && (
                    <button type="button" className="btn btn--ghost btn--sm btn--icon" onClick={() => removeRole(i)}><Icon name="x" size={12}/></button>
                  )}
                </div>
              ))}
              <button type="button" className="btn btn--ghost btn--sm" onClick={addRole}>+ Add role</button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => buildInBoldSign()}
              disabled={editorBusy}
            >
              <Icon name="upload" size={13}/> {editorBusy ? 'Opening…' : form.boldsign_template_id ? 'Rebuild in BoldSign' : 'Build in BoldSign'}
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--gw-mist)', cursor: 'pointer' }}>
              <input type="checkbox" checked={useTextTags} onChange={e => setUseTextTags(e.target.checked)} style={{ width: 13, height: 13 }}/>
              PDF has text tags
            </label>
          </div>

          <div className="form-group">
            <label className="form-label">BoldSign Template ID</label>
            <input className="form-control" value={form.boldsign_template_id} onChange={e => set('boldsign_template_id', e.target.value)} placeholder="Pasted automatically after Build in BoldSign" />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Doc Type</label>
              <input className="form-control" value={form.doc_type} onChange={e => set('doc_type', e.target.value)} placeholder="listing_agreement" />
            </div>
            <div className="form-group">
              <label className="form-label">Active</label>
              <select className="form-control" value={form.active ? '1' : '0'} onChange={e => set('active', e.target.value === '1')}>
                <option value="1">Yes — sendable</option>
                <option value="0">No — hidden from send picker</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Field Tokens <span style={{ fontWeight: 400, color: 'var(--gw-mist)' }}>(optional — reference only)</span></label>
            <input className="form-control" value={tokensText} onChange={e => setTokensText(e.target.value)} placeholder="property_address, list_price, seller_name" />
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>
              You don't need to list fields here for prefill. At send time the CRM reads the template's own
              fields from BoldSign and auto-fills any whose <strong>field ID matches a CRM token</strong> (e.g.
              name a signature-block's neighboring text field <code>property_address</code>). This box is just a
              note to yourself of which tokens the template uses.
            </div>
          </div>

          <details style={{ fontSize: 11, color: 'var(--gw-mist)' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: 6 }}>Text tag syntax reference</summary>
            <div style={{ lineHeight: 1.7, marginTop: 6 }}>
              Type these directly into the source document (white text so they're invisible when signed) —
              BoldSign auto-places the field on upload when "PDF has text tags" is checked. Format:{' '}
              <code>{'{{fieldType|signerIndex|required|label|fieldId}}'}</code>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                <li><code>{'{{Signature|1|true|Sign|seller_signature}}'}</code> — signature, role 1, required</li>
                <li><code>{'{{Initial|1|true|Initials|seller_initials}}'}</code> — initials</li>
                <li><code>{'{{DateSigned|1|true}}'}</code> — auto-filled signing date</li>
                <li><code>{'{{Textbox|1|false|Address|property_address}}'}</code> — use a CRM token as the field ID to auto-prefill</li>
              </ul>
            </div>
          </details>
        </div>
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : isNew ? 'Add Packet' : 'Save Changes'}</button>
      </div>
      </>
      )}
    </Modal>
  )
}

export default function FormLibraryPage({ isAdmin }) {
  const [packets, setPackets]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [tableReady, setTableReady] = useState(true)
  const [modal, setModal]       = useState(null) // null | 'add' | {packet}
  const [filter, setFilter]     = useState({ state: '', type: '' })
  const [downloading, setDownloading] = useState({})

  useEffect(() => { load() }, [])

  const load = async () => {
    setLoading(true)
    const { data, error } = await supabase.from('form_packets').select('*').order('state').order('transaction_type')
    if (error) {
      if (error.message?.includes('relation') || error.code === '42P01') setTableReady(false)
      else pushToast(error.message, 'error')
    } else {
      setPackets(data || [])
    }
    setLoading(false)
  }

  const del = async (id) => {
    if (!window.confirm('Delete this form packet?')) return
    await supabase.from('form_packets').delete().eq('id', id)
    pushToast('Packet deleted', 'info')
    load()
  }

  const download = async (packet) => {
    // A packet can hold several files (package templates). Prefer the full list,
    // falling back to the single primary path.
    const items = (Array.isArray(packet.storage_paths) && packet.storage_paths.length)
      ? packet.storage_paths.filter(f => f?.path)
      : (packet.storage_path ? [{ path: packet.storage_path, name: packet.storage_path.split('/').pop() }] : [])
    if (!items.length) { pushToast('No file uploaded for this packet', 'error'); return }
    setDownloading(p => ({ ...p, [packet.id]: true }))
    try {
      // Trigger a real download per file (Content-Disposition via the `download`
      // option) instead of window.open — multiple window.open calls get killed by
      // the popup blocker, which is why only the first file used to open.
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(it.path, 300, { download: it.name || true })
        if (error) { pushToast(`Couldn't fetch ${it.name || 'a file'}: ${error.message}`, 'error'); continue }
        const a = document.createElement('a')
        a.href = data.signedUrl
        a.download = it.name || ''
        document.body.appendChild(a)
        a.click()
        a.remove()
        if (i < items.length - 1) await new Promise(r => setTimeout(r, 500))  // stagger so the browser doesn't drop rapid downloads
      }
    } finally {
      setDownloading(p => ({ ...p, [packet.id]: false }))
    }
  }

  const filtered = packets.filter(p =>
    (!filter.state || p.state === filter.state.toUpperCase()) &&
    (!filter.type  || p.transaction_type === filter.type)
  )

  const states = [...new Set(packets.map(p => p.state))].sort()

  if (!tableReady) return (
    <div style={{ padding: 32, maxWidth: 680 }}>
      <div style={{ background: 'var(--gw-bone)', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', padding: 24 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Setup required</div>
        <div style={{ fontSize: 13, color: 'var(--gw-mist)', marginBottom: 16 }}>Run this SQL in Supabase, then create a <code>form-packets</code> storage bucket (private).</div>
        <pre style={{ fontSize: 11, background: '#f1f3f5', padding: 14, borderRadius: 6, overflowX: 'auto' }}>{`create table if not exists form_packets (
  id                   uuid primary key default uuid_generate_v4(),
  state                text not null,
  transaction_type     text not null check (transaction_type in ('buyer','seller','lease','general')),
  name                 text not null,
  description          text,
  storage_path         text,
  boldsign_template_id text,
  doc_type             text,
  field_tokens         jsonb default '[]',
  active               boolean default true,
  created_at           timestamptz default now()
);
alter table form_packets enable row level security;
create policy "form_packets_all" on form_packets
  for all to authenticated using (true) with check (true);
create unique index if not exists uq_form_packets_boldsign_tid
  on form_packets(boldsign_template_id) where boldsign_template_id is not null;`}</pre>
        <button className="btn btn--secondary btn--sm" style={{ marginTop: 8 }} onClick={() => { setTableReady(true); load() }}>
          <Icon name="refresh" size={12} /> Retry
        </button>
      </div>
    </div>
  )

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--gw-ink)' }}>Form Library</div>
          <div style={{ fontSize: 13, color: 'var(--gw-mist)', marginTop: 2 }}>State-specific form packets — one click to get all required forms for a transaction.</div>
        </div>
        {isAdmin && (
          <button className="btn btn--primary btn--sm" onClick={() => setModal('add')}>
            <Icon name="plus" size={13} /> Add Packet
          </button>
        )}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <select className="form-control" style={{ maxWidth: 120, fontSize: 13 }} value={filter.state} onChange={e => setFilter(p => ({ ...p, state: e.target.value }))}>
          <option value="">All States</option>
          {states.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="form-control" style={{ maxWidth: 180, fontSize: 13 }} value={filter.type} onChange={e => setFilter(p => ({ ...p, type: e.target.value }))}>
          <option value="">All Types</option>
          {TRANSACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {(filter.state || filter.type) && (
          <button className="btn btn--ghost btn--sm" onClick={() => setFilter({ state: '', type: '' })}>Clear</button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ color: 'var(--gw-mist)', fontSize: 13 }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="document"
          title="No form packets yet"
          message={isAdmin
            ? 'Add your first packet — upload a PDF bundle for a state + transaction type.'
            : 'No form packets have been uploaded yet. Ask your admin to add them.'}
        />
      ) : (
        <div>
          {filtered.map(packet => {
            const typeLabel = TRANSACTION_TYPES.find(t => t.value === packet.transaction_type)?.label || packet.transaction_type
            return (
              <div key={packet.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', background: '#fff', marginBottom: 8 }}>
                <div style={{ width: 40, height: 40, borderRadius: 8, background: 'var(--gw-azure)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontWeight: 800, fontSize: 12, color: '#fff' }}>{packet.state}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--gw-ink)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {packet.name}
                    {packet.boldsign_template_id && (
                      <span style={{ padding: '1px 7px', borderRadius: 8, fontSize: 10, fontWeight: 700, background: packet.active ? 'var(--gw-green-light)' : 'var(--gw-bone)', color: packet.active ? 'var(--gw-green)' : 'var(--gw-mist)' }}>
                        {packet.active ? 'Sendable' : 'Sendable (disabled)'}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 2 }}>
                    {typeLabel}
                    {(() => {
                      const n = (Array.isArray(packet.storage_paths) && packet.storage_paths.length) || (packet.storage_path ? 1 : 0)
                      return n > 1 ? <span> · {n} files</span> : null
                    })()}
                    {packet.description && <span> · {packet.description}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {(() => {
                    const fileCount = (Array.isArray(packet.storage_paths) && packet.storage_paths.length) || (packet.storage_path ? 1 : 0)
                    return (
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={() => download(packet)}
                    disabled={!fileCount || downloading[packet.id]}
                    title={fileCount ? (fileCount > 1 ? `Download ${fileCount} forms` : 'Download PDF packet') : 'No file uploaded yet'}
                  >
                    <Icon name="download" size={12} />
                    {downloading[packet.id] ? 'Opening…' : 'Get Forms'}
                  </button>
                    )
                  })()}
                  {isAdmin && (
                    <>
                      <button className="btn btn--secondary btn--sm btn--icon" title="Edit" onClick={() => setModal(packet)}>
                        <Icon name="edit" size={12} />
                      </button>
                      <button className="btn btn--ghost btn--sm btn--icon" title="Delete" onClick={() => del(packet.id)}>
                        <Icon name="trash" size={12} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Upload / Edit modal */}
      {modal && (
        <UploadModal
          packet={modal === 'add' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}
    </div>
  )
}
