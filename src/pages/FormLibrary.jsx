import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, pushToast, EmptyState, Modal } from '../components/UI.jsx'

const TRANSACTION_TYPES = [
  { value: 'buyer',   label: 'Buyer Contract' },
  { value: 'seller',  label: 'Listing / Seller' },
  { value: 'lease',   label: 'Lease / Rental' },
  { value: 'general', label: 'General / Other' },
]

const CATEGORIES = [
  { value: 'state_packet',   label: 'State Packets',    blurb: 'Official, state-specific transaction forms.' },
  { value: 'agent_resource', label: 'Agent Resources',  blurb: 'Scripts, marketing collateral, training docs.' },
]

const BUCKET = 'form-packets'

function formatBytes(b) {
  if (!b) return ''
  if (b < 1024) return `${b} B`
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1048576).toFixed(1)} MB`
}

function UploadModal({ packet, onClose, onSaved, defaultCategory = 'state_packet' }) {
  const isNew = !packet?.id
  const blank = { state: '', transaction_type: 'buyer', name: '', description: '', category: defaultCategory }
  const [form, setForm]   = useState(packet ? { ...blank, ...packet } : blank)
  const [file, setFile]   = useState(null)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef()

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))
  const isStatePacket = form.category === 'state_packet'

  const save = async () => {
    if (isStatePacket && !form.state.trim()) { pushToast('State is required', 'error'); return }
    if (!form.name.trim())  { pushToast('Name is required', 'error'); return }
    if (isNew && !file)     { pushToast('Upload a PDF file', 'error'); return }
    setSaving(true)
    try {
      let storage_path = form.storage_path || null
      if (file) {
        const folder = isStatePacket
          ? `${form.state.trim().toUpperCase()}/${form.transaction_type}`
          : `_resources/${form.transaction_type || 'general'}`
        const path = `${folder}/${Date.now()}-${file.name}`
        const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true })
        if (upErr) { pushToast(upErr.message, 'error'); setSaving(false); return }
        storage_path = path
      }
      const payload = {
        state: isStatePacket ? form.state.trim().toUpperCase() : 'XX',
        transaction_type: form.transaction_type || 'general',
        name: form.name.trim(),
        description: form.description || null,
        category: form.category || 'state_packet',
        storage_path,
      }
      let error
      if (packet?.id) {
        ;({ error } = await supabase.from('form_packets').update(payload).eq('id', packet.id))
      } else {
        ;({ error } = await supabase.from('form_packets').insert([payload]))
      }
      if (error) { pushToast(error.message, 'error'); return }
      pushToast(isNew ? 'Form packet added' : 'Packet updated')
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? 'Add Document' : 'Edit Document'} width={480}>
      <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-group">
          <label className="form-label required">Category</label>
          <select className="form-control" value={form.category} onChange={e => set('category', e.target.value)}>
            {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>
            {CATEGORIES.find(c => c.value === form.category)?.blurb}
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className={`form-label${isStatePacket ? ' required' : ''}`}>State</label>
            <input className="form-control" value={form.state} onChange={e => set('state', e.target.value.toUpperCase())} placeholder={isStatePacket ? 'IA' : 'optional'} maxLength={2} style={{ textTransform: 'uppercase' }} disabled={!isStatePacket} />
          </div>
          <div className="form-group">
            <label className="form-label required">{isStatePacket ? 'Transaction Type' : 'Use Case'}</label>
            <select className="form-control" value={form.transaction_type} onChange={e => set('transaction_type', e.target.value)}>
              {TRANSACTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </div>
        <div className="form-group">
          <label className="form-label required">Name</label>
          <input className="form-control" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Iowa Buyer Contract Package" />
        </div>
        <div className="form-group">
          <label className="form-label">Description</label>
          <textarea className="form-control form-control--textarea" value={form.description || ''} onChange={e => set('description', e.target.value)} placeholder="List the forms included in this packet…" rows={3} />
        </div>
        <div className="form-group">
          <label className="form-label">{packet?.storage_path ? 'Replace PDF (optional)' : 'Upload PDF'}</label>
          <input ref={fileRef} type="file" accept=".pdf" style={{ display: 'none' }} onChange={e => setFile(e.target.files[0])} />
          <div
            onClick={() => fileRef.current.click()}
            style={{ border: '2px dashed var(--gw-border)', borderRadius: 'var(--radius)', padding: '16px', textAlign: 'center', cursor: 'pointer', background: file ? 'var(--gw-green-light)' : 'var(--gw-bone)' }}
          >
            {file
              ? <><Icon name="document" size={16} style={{ color: 'var(--gw-green)', verticalAlign: 'middle', marginRight: 6 }} />{file.name} <span style={{ color: 'var(--gw-mist)', fontSize: 11 }}>({formatBytes(file.size)})</span></>
              : <span style={{ color: 'var(--gw-mist)', fontSize: 13 }}>{packet?.storage_path ? 'Click to replace PDF' : 'Click to choose PDF'}</span>
            }
          </div>
          {packet?.storage_path && !file && (
            <div style={{ fontSize: 11, color: 'var(--gw-mist)', marginTop: 4 }}>Current file on file — leave blank to keep it.</div>
          )}
        </div>
      </div>
      <div style={{ padding: '12px 24px 20px', borderTop: '1px solid var(--gw-border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : isNew ? 'Add Packet' : 'Save Changes'}</button>
      </div>
    </Modal>
  )
}

export default function FormLibraryPage({ isAdmin }) {
  const [packets, setPackets]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [tableReady, setTableReady] = useState(true)
  const [modal, setModal]       = useState(null) // null | 'add' | {packet}
  const [filter, setFilter]     = useState({ state: '', type: '' })
  const [category, setCategory] = useState('state_packet')
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
    if (!packet.storage_path) { pushToast('No file uploaded for this packet', 'error'); return }
    setDownloading(p => ({ ...p, [packet.id]: true }))
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(packet.storage_path, 300)
    setDownloading(p => ({ ...p, [packet.id]: false }))
    if (error) { pushToast(error.message, 'error'); return }
    window.open(data.signedUrl, '_blank')
  }

  const inCategory = packets.filter(p => (p.category || 'state_packet') === category)
  const filtered = inCategory.filter(p =>
    (!filter.state || p.state === filter.state.toUpperCase()) &&
    (!filter.type  || p.transaction_type === filter.type)
  )

  const states = [...new Set(inCategory.map(p => p.state))].filter(s => s && s !== 'XX').sort()
  const categoryCounts = CATEGORIES.reduce((acc, c) => {
    acc[c.value] = packets.filter(p => (p.category || 'state_packet') === c.value).length
    return acc
  }, {})

  if (!tableReady) return (
    <div style={{ padding: 32, maxWidth: 680 }}>
      <div style={{ background: 'var(--gw-bone)', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', padding: 24 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Setup required</div>
        <div style={{ fontSize: 13, color: 'var(--gw-mist)', marginBottom: 16 }}>Run this SQL in Supabase, then create a <code>form-packets</code> storage bucket (private).</div>
        <pre style={{ fontSize: 11, background: '#f1f3f5', padding: 14, borderRadius: 6, overflowX: 'auto' }}>{`create table if not exists form_packets (
  id               uuid primary key default uuid_generate_v4(),
  state            text not null,
  transaction_type text not null check (transaction_type in ('buyer','seller','lease','general')),
  name             text not null,
  description      text,
  storage_path     text,
  category         text not null default 'state_packet'
                     check (category in ('state_packet','agent_resource')),
  created_at       timestamptz default now()
);
alter table form_packets enable row level security;
create policy "form_packets_all" on form_packets
  for all to authenticated using (true) with check (true);`}</pre>
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
          <div style={{ fontSize: 13, color: 'var(--gw-mist)', marginTop: 2 }}>Official state packets and agent-only resources — one click to download.</div>
        </div>
        {isAdmin && (
          <button className="btn btn--primary btn--sm" onClick={() => setModal('add')}>
            <Icon name="plus" size={13} /> Add Packet
          </button>
        )}
      </div>

      {/* Category tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--gw-border)', marginBottom: 14 }}>
        {CATEGORIES.map(c => (
          <button key={c.value} onClick={() => { setCategory(c.value); setFilter({ state: '', type: '' }) }}
            style={{
              padding: '8px 14px', border: 'none', background: 'transparent', cursor: 'pointer',
              fontSize: 13, fontWeight: 600,
              borderBottom: `2px solid ${category === c.value ? 'var(--gw-azure)' : 'transparent'}`,
              color: category === c.value ? 'var(--gw-ink)' : 'var(--gw-mist)',
              marginBottom: -1,
            }}>
            {c.label}
            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--gw-mist)', fontWeight: 500 }}>
              {categoryCounts[c.value] || 0}
            </span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        {category === 'state_packet' && (
          <select className="form-control" style={{ maxWidth: 120, fontSize: 13 }} value={filter.state} onChange={e => setFilter(p => ({ ...p, state: e.target.value }))}>
            <option value="">All States</option>
            {states.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
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
          title={category === 'agent_resource' ? 'No agent resources yet' : 'No form packets yet'}
          message={isAdmin
            ? (category === 'agent_resource'
                ? 'Upload agent-only documents — scripts, marketing collateral, training PDFs.'
                : 'Add your first packet — upload a PDF bundle for a state + transaction type.')
            : 'Nothing here yet. Ask your admin to add documents.'}
        />
      ) : (
        <div>
          {filtered.map(packet => {
            const typeLabel = TRANSACTION_TYPES.find(t => t.value === packet.transaction_type)?.label || packet.transaction_type
            const isResource = (packet.category || 'state_packet') === 'agent_resource'
            return (
              <div key={packet.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', border: '1px solid var(--gw-border)', borderRadius: 'var(--radius)', background: '#fff', marginBottom: 8 }}>
                <div style={{ width: 40, height: 40, borderRadius: 8, background: isResource ? 'var(--gw-mist)' : 'var(--gw-azure)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <span style={{ fontWeight: 800, fontSize: 12, color: '#fff' }}>{isResource ? '★' : packet.state}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--gw-ink)' }}>{packet.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--gw-mist)', marginTop: 2 }}>
                    {typeLabel}
                    {packet.description && <span> · {packet.description}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={() => download(packet)}
                    disabled={!packet.storage_path || downloading[packet.id]}
                    title={packet.storage_path ? 'Download PDF packet' : 'No file uploaded yet'}
                  >
                    <Icon name="download" size={12} />
                    {downloading[packet.id] ? 'Opening…' : 'Get Forms'}
                  </button>
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
          defaultCategory={category}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}
    </div>
  )
}
