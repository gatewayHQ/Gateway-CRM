import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Icon, Badge, Drawer, EmptyState, ConfirmDialog, Modal, pushToast } from '../components/UI.jsx'

const MERGE_TAGS = ['{{firstName}}','{{lastName}}','{{agentName}}','{{propertyAddress}}','{{dealValue}}']

function TemplateDrawer({ open, onClose, template, agents, onSave }) {
  const blank = { name:'', subject:'', body:'', category:'follow-up', agent_id:'' }
  const [form, setForm] = useState(template || blank)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState(false)

  React.useEffect(() => { setForm(template || blank); setErrors({}) }, [template, open])
  const set = (k, v) => setForm(p => ({...p, [k]: v}))

  const previewBody = (form.body||'')
    .replace(/{{firstName}}/g, 'Jane').replace(/{{lastName}}/g, 'Smith')
    .replace(/{{agentName}}/g, 'Your Name').replace(/{{propertyAddress}}/g, '123 Main St')
    .replace(/{{dealValue}}/g, '$450,000')

  const save = async () => {
    const e = {}
    if (!form.name.trim()) e.name = true
    if (!form.subject.trim()) e.subject = true
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    let error
    if (template?.id) {
      ({ error } = await supabase.from('templates').update(form).eq('id', template.id))
    } else {
      ({ error } = await supabase.from('templates').insert([form]))
    }
    setSaving(false)
    if (error) { pushToast(error.message, 'error'); return }
    pushToast(template?.id ? 'Template updated' : 'Template created')
    onSave(); onClose()
  }

  return (
    <Drawer open={open} onClose={onClose} title={template?.id ? 'Edit Template' : 'New Template'} width={560}>
      <div className="drawer__body">
        <div className="form-group"><label className="form-label required">Template Name</label><input className={`form-control${errors.name?' error':''}`} value={form.name} onChange={e=>set('name',e.target.value)} placeholder="e.g. Initial Buyer Introduction" /></div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Category</label><select className="form-control" value={form.category} onChange={e=>set('category',e.target.value)}>{['intro','follow-up','offer','closing','nurture'].map(c=><option key={c} value={c}>{c.charAt(0).toUpperCase()+c.slice(1)}</option>)}</select></div>
          <div className="form-group"><label className="form-label">Agent</label><select className="form-control" value={form.agent_id||''} onChange={e=>set('agent_id',e.target.value)}><option value="">Any Agent</option>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
        </div>
        <div className="form-group"><label className="form-label required">Subject Line</label><input className={`form-control${errors.subject?' error':''}`} value={form.subject} onChange={e=>set('subject',e.target.value)} placeholder="e.g. Welcome to Gateway — Next Steps" /></div>
        <div className="form-group">
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
            <label className="form-label" style={{ margin:0 }}>Body</label>
            <button className="btn btn--ghost btn--sm" onClick={() => setPreview(p=>!p)}><Icon name="eye" size={12} /> {preview?'Edit':'Preview'}</button>
          </div>
          {preview ? (
            <div style={{ background:'var(--gw-bone)', border:'1px solid var(--gw-border)', borderRadius:'var(--radius)', padding:12, fontSize:13, lineHeight:1.7, whiteSpace:'pre-wrap', minHeight:160 }}>{previewBody || <span style={{ color:'var(--gw-mist)' }}>No content yet</span>}</div>
          ) : (
            <textarea className="form-control form-control--textarea" style={{ minHeight:160 }} value={form.body||''} onChange={e=>set('body',e.target.value)} placeholder="Write your email template here. Use merge tags to personalize." />
          )}
          <div style={{ marginTop:8, display:'flex', gap:6, flexWrap:'wrap' }}>
            {MERGE_TAGS.map(tag => (
              <span key={tag} className="merge-tag" onClick={() => set('body', (form.body||'') + tag)}>{tag}</span>
            ))}
          </div>
          <div className="form-hint">Click a merge tag to insert it. Preview shows how it looks with sample data.</div>
        </div>
      </div>
      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving}>{saving?'Saving…':'Save Template'}</button>
      </div>
    </Drawer>
  )
}

export function ComposeModal({ ctx, db, activeAgent, onClose }) {
  const [to, setTo] = useState(ctx?.to || '')
  const [subject, setSubject] = useState(ctx?.subject || '')
  const [body, setBody] = useState(ctx?.body || '')
  const [sending, setSending] = useState(false)

  const resolveBody = (b) => b
    .replace(/{{firstName}}/g, ctx?.contactName?.split(' ')[0] || 'there')
    .replace(/{{lastName}}/g, ctx?.contactName?.split(' ')[1] || '')
    .replace(/{{agentName}}/g, activeAgent?.name || '')
    .replace(/{{propertyAddress}}/g, ctx?.propertyAddress || '')
    .replace(/{{dealValue}}/g, ctx?.dealValue || '')

  const send = async () => {
    setSending(true)
    if (ctx?.templateId) {
      await supabase.from('templates').update({ usage_count: supabase.rpc('increment', { x: 1 }) }).eq('id', ctx.templateId)
    }
    await new Promise(r => setTimeout(r, 800))
    setSending(false)
    pushToast(`Email sent to ${to}`)
    onClose()
  }

  return (
    <Modal open={true} onClose={onClose} width={600}>
      <div className="modal__head">
        <div><div className="eyebrow-label">New Message</div><h3 style={{ margin:0, fontFamily:'var(--font-display)', fontSize:20 }}>Compose Email</h3></div>
        <button className="drawer__close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <div className="modal__body" style={{ padding:0 }}>
        <div style={{ borderBottom:'1px solid var(--gw-border)' }}>
          <div className="compose-field"><label>To</label><input value={to} onChange={e=>setTo(e.target.value)} placeholder="recipient@email.com" /></div>
          <div className="compose-field"><label>From</label><input value={activeAgent?.email||''} readOnly style={{ color:'var(--gw-mist)' }} /></div>
          <div className="compose-field"><label>Subject</label><input value={subject} onChange={e=>setSubject(e.target.value)} placeholder="Subject line…" /></div>
        </div>
        <div style={{ padding:'0 24px' }}>
          <textarea className="compose-body" value={resolveBody(body)} onChange={e=>setBody(e.target.value)} placeholder="Write your message here…" />
        </div>
      </div>
      <div className="modal__foot">
        <button className="btn btn--secondary" onClick={onClose}>Discard</button>
        <button className="btn btn--primary" onClick={send} disabled={sending || !to}><Icon name="send" size={13} />{sending?'Sending…':'Send Email'}</button>
      </div>
    </Modal>
  )
}

export default function TemplatesPage({ db, setDb, activeAgent, openCompose }) {
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [filterCat, setFilterCat] = useState('')

  const templates = db.templates || []
  const agents = db.agents || []

  const filtered = templates.filter(t => !filterCat || t.category === filterCat)

  const reload = async () => {
    const { data } = await supabase.from('templates').select('*').order('created_at', { ascending: false })
    setDb(p => ({ ...p, templates: data || [] }))
  }

  const del = async (id) => {
    await supabase.from('templates').delete().eq('id', id)
    pushToast('Template deleted', 'info')
    setConfirm(null); reload()
  }

  const duplicate = async (t) => {
    const { id, created_at, ...rest } = t
    await supabase.from('templates').insert([{ ...rest, name: `${t.name} (copy)`, usage_count: 0 }])
    pushToast('Template duplicated')
    reload()
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div><div className="page-title">Email Templates</div><div className="page-sub">{templates.length} templates</div></div>
        <div style={{ display:'flex', gap:8 }}>
          <button className="btn btn--secondary" onClick={() => openCompose({})}><Icon name="mail" size={14} /> Compose</button>
          <button className="btn btn--primary" onClick={() => { setEditing(null); setDrawer(true) }}><Icon name="plus" size={14} /> New Template</button>
        </div>
      </div>

      <div className="filters-bar">
        <select className="filter-select" value={filterCat} onChange={e=>setFilterCat(e.target.value)}><option value="">All Categories</option>{['intro','follow-up','offer','closing','nurture'].map(c=><option key={c} value={c}>{c.charAt(0).toUpperCase()+c.slice(1)}</option>)}</select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="mail" title="No templates yet" message="Create reusable email templates to speed up your communications." action={<button className="btn btn--primary" onClick={() => setDrawer(true)}><Icon name="plus" size={14} /> Create Template</button>} />
      ) : (
        <div className="template-grid">
          {filtered.map(t => (
            <div key={t.id} className="template-card">
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                <Badge variant={t.category}>{t.category}</Badge>
                <span style={{ fontSize:11, color:'var(--gw-mist)' }}>{t.usage_count||0} uses</span>
              </div>
              <div className="template-card__name">{t.name}</div>
              <div className="template-card__subject">"{t.subject}"</div>
              <div className="template-card__body">{t.body}</div>
              <div className="template-card__foot">
                <div style={{ display:'flex', gap:4 }}>
                  <button className="btn btn--ghost btn--icon btn--sm" title="Use template" onClick={() => openCompose({ subject: t.subject, body: t.body, templateId: t.id })}><Icon name="send" size={13} /></button>
                  <button className="btn btn--ghost btn--icon btn--sm" title="Duplicate" onClick={() => duplicate(t)}><Icon name="copy" size={13} /></button>
                  <button className="btn btn--ghost btn--icon btn--sm" title="Edit" onClick={() => { setEditing(t); setDrawer(true) }}><Icon name="edit" size={13} /></button>
                  <button className="btn btn--ghost btn--icon btn--sm" title="Delete" onClick={() => setConfirm(t.id)}><Icon name="trash" size={13} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <TemplateDrawer open={drawer} onClose={() => setDrawer(false)} template={editing} agents={agents} onSave={reload} />
      {confirm && <ConfirmDialog message="Delete this template?" onConfirm={() => del(confirm)} onCancel={() => setConfirm(null)} />}
    </div>
  )
}
