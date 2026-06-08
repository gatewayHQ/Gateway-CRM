import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Icon, Drawer, pushToast } from '../../components/UI.jsx'

const COLORS = ['#2d3561','#4a6fa5','#2e7d5e','#c9a84c','#6b4fa5','#c0392b','#d4820a','#1a1a2e']
const BLANK  = { name: '', initials: '', role: '', email: '', phone: '', color: '#2d3561', photo_url: '', bio: '',
                 default_split_pct: 70, no_brokerage_split: false, is_admin: false }
const BIO_MAX = 600

const autoInitials = (name) =>
  name.trim().split(/\s+/).map(w => w[0] || '').join('').toUpperCase().slice(0, 2)

export default function AgentDrawer({ open, onClose, agent, onSave }) {
  const [form,   setForm]   = useState(BLANK)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => {
    setForm(agent ? { ...BLANK, ...agent } : BLANK)
    setErrors({})
  }, [agent, open])

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const uploadHeadshot = async (file) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { pushToast('Please choose an image file', 'error'); return }
    setUploading(true)
    try {
      const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase()
      const path = `agents/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
      const { error } = await supabase.storage
        .from('campaign-images').upload(path, file, { contentType: file.type, upsert: false })
      if (error) throw error
      const { data: { publicUrl } } = supabase.storage.from('campaign-images').getPublicUrl(path)
      set('photo_url', publicUrl)
    } catch (e) {
      pushToast(e.message || 'Upload failed — try again', 'error')
    } finally {
      setUploading(false)
    }
  }

  const save = async () => {
    const e = {}
    if (!form.name.trim())  e.name  = true
    if (!form.email.trim()) e.email = true
    setErrors(e)
    if (Object.keys(e).length) return

    setSaving(true)
    const payload = {
      ...form,
      initials: form.initials || autoInitials(form.name),
      default_split_pct: Number(form.default_split_pct) || 0,
      no_brokerage_split: !!form.no_brokerage_split,
      is_admin: !!form.is_admin,
    }
    const doSave = (p) => agent?.id
      ? supabase.from('agents').update(p).eq('id', agent.id)
      : supabase.from('agents').insert([p])

    let { error } = await doSave(payload)

    // Graceful fallback if migration 0004/0005 columns haven't run yet: strip
    // the newer fields and save the rest so the agent isn't blocked.
    let droppedNew = false
    if (error?.message?.includes('schema cache') || /column|default_split_pct|no_brokerage_split|is_admin/i.test(error?.message || '')) {
      const { phone, photo_url, bio, default_split_pct, no_brokerage_split, is_admin, ...base } = payload
      ;({ error } = await doSave(base))
      if (!error) droppedNew = true
    }
    setSaving(false)

    if (error) { pushToast(error.message, 'error'); return }
    pushToast(droppedNew
      ? 'Saved — run DB migration 0004 to store bio, photo & phone'
      : (agent?.id ? 'Agent updated' : 'Agent added'))
    onSave()
    onClose()
  }

  const previewInitials = form.initials || autoInitials(form.name) || '?'

  return (
    <Drawer open={open} onClose={onClose} title={agent?.id ? 'Edit Agent' : 'Add Agent'} width={400}>
      <div className="drawer__body">
        {/* Headshot — what shows on QR landing pages */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          {form.photo_url ? (
            <img src={form.photo_url} alt="Headshot preview"
                 style={{ width: 84, height: 84, borderRadius: 16, objectFit: 'cover' }} />
          ) : (
            <div style={{ width: 84, height: 84, borderRadius: 16, background: form.color,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 30, fontWeight: 700, color: '#fff' }}>
              {previewInitials}
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                 onChange={e => uploadHeadshot(e.target.files?.[0])} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn--secondary btn--sm" disabled={uploading}
                    onClick={() => fileRef.current?.click()}>
              <Icon name="upload" size={12} /> {uploading ? 'Uploading…' : form.photo_url ? 'Replace headshot' : 'Upload headshot'}
            </button>
            {form.photo_url && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => set('photo_url', '')}>
                Remove
              </button>
            )}
          </div>
          <div className="form-hint" style={{ textAlign: 'center' }}>Shown on your QR landing pages</div>
        </div>

        <div className="form-group">
          <label className="form-label required">Full Name</label>
          <input className={`form-control${errors.name ? ' error' : ''}`} value={form.name}
            onChange={e => set('name', e.target.value)} placeholder="Jane Smith" />
        </div>
        <div className="form-group">
          <label className="form-label">Initials</label>
          <input className="form-control" value={form.initials}
            onChange={e => set('initials', e.target.value.toUpperCase().slice(0, 2))}
            placeholder="Auto-generated" maxLength={2} />
          <div className="form-hint">Used when no headshot is set. Leave blank to auto-generate.</div>
        </div>
        <div className="form-group">
          <label className="form-label">Role / Title</label>
          <input className="form-control" value={form.role}
            onChange={e => set('role', e.target.value)} placeholder="Lead Agent, Buyer's Advisor…" />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label required">Email</label>
            <input className={`form-control${errors.email ? ' error' : ''}`} type="email" value={form.email}
              onChange={e => set('email', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Phone</label>
            <input className="form-control" type="tel" value={form.phone || ''}
              onChange={e => set('phone', e.target.value)} placeholder="(555) 000-0000" />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Bio</label>
          <textarea className="form-control form-control--textarea" rows={4} maxLength={BIO_MAX}
            value={form.bio || ''} onChange={e => set('bio', e.target.value)}
            placeholder="A few sentences clients will see on your landing pages — your focus, experience, and what makes working with you great." />
          <div className="form-hint">{(form.bio || '').length}/{BIO_MAX} · Appears in the “Meet your advisor” section.</div>
        </div>

        {/* ── Commission & access ─────────────────────────────────────────── */}
        <div style={{ borderTop: '1px solid var(--gw-border)', margin: '4px 0 16px', paddingTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gw-ink)', marginBottom: 12 }}>Commission & Access</div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!form.no_brokerage_split}
              onChange={e => set('no_brokerage_split', e.target.checked)} />
            <span>Keeps <strong>100%</strong> — no brokerage split (capped / special arrangement)</span>
          </label>

          {!form.no_brokerage_split && (
            <div className="form-group">
              <label className="form-label">Default commission split (%)</label>
              <input className="form-control" type="number" min="0" max="100" step="1"
                value={form.default_split_pct} onChange={e => set('default_split_pct', e.target.value)} />
              <div className="form-hint">This agent's share; the brokerage keeps the rest. Pre-fills the commission editor.</div>
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 4, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!form.is_admin}
              onChange={e => set('is_admin', e.target.checked)} />
            <span><strong>Office admin</strong> — can view every agent's deals, documents, signatures & commissions</span>
          </label>
        </div>

        <div className="form-group">
          <label className="form-label">Avatar Color</label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {COLORS.map(c => (
              <div key={c} onClick={() => set('color', c)} style={{
                width: 28, height: 28, borderRadius: 6, background: c, cursor: 'pointer',
                border: form.color === c ? '3px solid var(--gw-ink)' : '3px solid transparent',
                transition: 'border 150ms',
              }} />
            ))}
          </div>
          <div className="form-hint">Used for the initials badge when there’s no headshot.</div>
        </div>
      </div>

      <div className="drawer__foot">
        <button className="btn btn--secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" onClick={save} disabled={saving || uploading}>
          {saving ? 'Saving…' : 'Save Agent'}
        </button>
      </div>
    </Drawer>
  )
}
